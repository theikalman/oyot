//! Backups on a schedule (ADR 0026): the task that makes them, and the
//! settings that shape it.
//!
//! The scheduler is a Rust task rather than a timer in the webview: a backup
//! needs nothing from the webview, and a hidden page's timers are throttled
//! or stopped. It does not sleep until a target time either. Every few
//! minutes it asks `schedule::next_run` whether a backup is owed, with the
//! clock as it reads then.
//!
//! A scheduled backup is the same operation as a manual one (`run_backup`),
//! with two additions: it is skipped when the library has not changed since
//! the last backup to the same place, and after it succeeds, older scheduled
//! backups there are pruned.

use super::backup::{
    begin, now_ms, partial_path, preferences, run_backup, BackupState, Delivery, Running,
    STATUS_EVENT,
};
use super::backup_remote::account_label;
use crate::backup::format::suggested_filename;
use crate::backup::history::{self, NewAttempt};
use crate::backup::remote::{Account, BackupProvider, Providers};
use crate::backup::schedule::{self, Frequency, Next, Schedule, Stored, FOLDER, MAX_KEEP};
use crate::backup::snapshot::{library_fingerprint, open_snapshot};
use crate::db::{AppState, DB_FILE};
use chrono::{DateTime, Local};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

/// How long after launch the first check waits, so startup has settled
/// before a backup that fell due while the app was closed begins.
const STARTUP_DELAY: Duration = Duration::from_secs(2 * 60);

/// How often the scheduler looks at the clock. Also the first retry's delay.
const CHECK_EVERY: Duration = Duration::from_secs(5 * 60);

/// Start the scheduler for the life of the process.
pub fn start_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        loop {
            if let Err(e) = run_if_due(&app).await {
                warn_log!("[backup] scheduled backup: {e}");
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// Make the scheduled backup, if one is owed.
async fn run_if_due(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let backup = app.state::<BackupState>();
    let providers = app.state::<Providers>();

    if !is_due(&state)? {
        return Ok(());
    }
    // A backup the user started is running: this one waits for the next
    // check, which is also when it will know whether that one covered it.
    let Some(_running) = Running::claim(&backup.running) else {
        return Ok(());
    };
    if !is_due(&state)? {
        return Ok(());
    }
    let schedule = {
        let db = state.db.lock();
        schedule::load(&db)?
    };
    run_scheduled(app, &state, &providers, &schedule).await
}

fn is_due(state: &AppState) -> Result<bool, String> {
    let db = state.db.lock();
    let schedule = schedule::load(&db)?;
    let attempts = history::scheduled_attempts(&db)?;
    Ok(schedule::next_run(&Local::now(), &schedule, &attempts) == Next::Now)
}

// --- where it goes ---------------------------------------------------------

/// Where a schedule's backups go, found out now.
enum Place {
    Folder {
        folder: PathBuf,
        /// The folder's name, which is all the page is ever told of it.
        name: String,
    },
    Provider {
        provider: Arc<dyn BackupProvider>,
        account: Account,
    },
}

enum Resolved {
    Ready(Place),
    /// Nothing can run, for a reason the page shows. No attempt is recorded:
    /// this is a state the schedule is in, not something that went wrong.
    Paused(String),
    /// Finding out failed. Recorded as a failed attempt, so it is retried
    /// and shows in the history like any other failure.
    Failed {
        destination: String,
        error: String,
    },
}

async fn resolve(schedule: &Schedule, providers: &Providers) -> Resolved {
    match schedule.destination.as_deref() {
        None => Resolved::Paused("Choose where scheduled backups go.".to_string()),
        Some(FOLDER) => {
            if !cfg!(desktop) {
                return Resolved::Paused(
                    "Scheduled backups to a folder are only available on a computer.".to_string(),
                );
            }
            match &schedule.folder {
                Some(folder) => Resolved::Ready(Place::Folder {
                    name: folder_name(folder),
                    folder: folder.clone(),
                }),
                None => Resolved::Paused("Choose a folder for scheduled backups.".to_string()),
            }
        }
        Some(id) => {
            // A database shared by builds with and without a provider's
            // credentials can name one this build does not have.
            let Ok(provider) = providers.get(id) else {
                return Resolved::Paused(
                    "Where scheduled backups go is not available in this version of Oyot. \
                     Choose another place."
                        .to_string(),
                );
            };
            match provider.account().await {
                Ok(Some(account)) => Resolved::Ready(Place::Provider { provider, account }),
                Ok(None) => Resolved::Paused(format!(
                    "{} is no longer linked. Link it again to resume scheduled backups.",
                    provider.name()
                )),
                Err(error) => Resolved::Failed {
                    destination: provider.id().to_string(),
                    error,
                },
            }
        }
    }
}

fn folder_name(folder: &Path) -> String {
    folder
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| folder.to_string_lossy().into_owned())
}

// --- making one ------------------------------------------------------------

async fn run_scheduled(
    app: &AppHandle,
    state: &AppState,
    providers: &Providers,
    schedule: &Schedule,
) -> Result<(), String> {
    let place = match resolve(schedule, providers).await {
        Resolved::Ready(place) => place,
        Resolved::Paused(_) => return Ok(()),
        Resolved::Failed { destination, error } => {
            let label = providers
                .get(&destination)
                .map(|p| p.name().to_string())
                .unwrap_or_else(|_| destination.clone());
            let attempt = begin(
                app,
                state,
                &NewAttempt {
                    scheduled: true,
                    destination: &destination,
                    label: &label,
                    target: None,
                    started_at: now_ms(),
                },
            )?;
            finish(app, state, attempt, Err(&error));
            return Ok(());
        }
    };

    let started = Local::now();
    match place {
        Place::Folder { folder, name } => {
            to_folder(app, state, schedule, &started, &folder, &name).await
        }
        Place::Provider { provider, account } => {
            to_provider(app, state, schedule, &started, provider, &account).await
        }
    }
}

async fn to_folder(
    app: &AppHandle,
    state: &AppState,
    schedule: &Schedule,
    started: &DateTime<Local>,
    folder: &Path,
    name: &str,
) -> Result<(), String> {
    let tag = {
        let db = state.db.lock();
        device_tag(&db)?
    };
    let file_name = free_name(folder, started, &tag);
    let label = format!("{name}/{file_name}");
    let target = history::target_for_folder(folder);
    let attempt = begin(
        app,
        state,
        &NewAttempt {
            scheduled: true,
            destination: FOLDER,
            label: &label,
            target: Some(&target),
            started_at: started.timestamp_millis(),
        },
    )?;

    if !folder.is_dir() {
        let error = format!(
            "The folder \"{name}\" could not be found. Connect the drive it is on, or choose \
             another folder."
        );
        finish(app, state, attempt, Err(&error));
        return Ok(());
    }

    if schedule.skip_unchanged {
        match unchanged(app, state, &target).await {
            Ok(Some((fingerprint, last))) if still_in_folder(folder, &last) => {
                finish(app, state, attempt, Ok(Finished::Skipped(&fingerprint)));
                return Ok(());
            }
            Ok(_) => {}
            Err(error) => {
                finish(app, state, attempt, Err(&error));
                return Ok(());
            }
        }
    }

    // Anything this device left half-written here by a run that never
    // finished. Only this device's: the tag is in the name.
    remove_stale_partials(folder, &tag);
    let delivery = Delivery::Folder(folder.join(&file_name));
    if run_backup(app, state, attempt, started, delivery)
        .await
        .is_ok()
    {
        prune_folder(app, state, folder, &target, schedule.keep, attempt);
    }
    Ok(())
}

async fn to_provider(
    app: &AppHandle,
    state: &AppState,
    schedule: &Schedule,
    started: &DateTime<Local>,
    provider: Arc<dyn BackupProvider>,
    account: &Account,
) -> Result<(), String> {
    let label = account_label(provider.name(), account);
    let target = history::target_for_provider(provider.id(), &account.email);
    let attempt = begin(
        app,
        state,
        &NewAttempt {
            scheduled: true,
            destination: provider.id(),
            label: &label,
            target: Some(&target),
            started_at: started.timestamp_millis(),
        },
    )?;

    if schedule.skip_unchanged {
        match unchanged(app, state, &target).await {
            // Matched on the history alone; now make sure that backup is
            // still there, whole. Asking costs a request, so only when it
            // matters.
            Ok(Some((fingerprint, last))) => {
                let still_there = match provider.list().await {
                    Ok(listed) => listed.iter().any(|backup| {
                        backup.id == last.location
                            && backup.size.is_some()
                            && backup.size == last.size_bytes
                    }),
                    // Not knowing is not proof: back up.
                    Err(e) => {
                        warn_log!("[backup] could not list backups to check the last one: {e}");
                        false
                    }
                };
                if still_there {
                    finish(app, state, attempt, Ok(Finished::Skipped(&fingerprint)));
                    return Ok(());
                }
            }
            Ok(None) => {}
            Err(error) => {
                finish(app, state, attempt, Err(&error));
                return Ok(());
            }
        }
    }

    let delivery = Delivery::Provider(provider.clone());
    if run_backup(app, state, attempt, started, delivery)
        .await
        .is_ok()
    {
        prune_provider(
            app,
            state,
            provider.as_ref(),
            &target,
            schedule.keep,
            attempt,
        )
        .await;
    }
    Ok(())
}

/// How a scheduled attempt ended, when not by `run_backup`.
enum Finished<'a> {
    /// Nothing had changed; the fingerprint the library still has.
    Skipped(&'a str),
}

fn finish(app: &AppHandle, state: &AppState, attempt: i64, outcome: Result<Finished, &str>) {
    {
        let db = state.db.lock();
        let recorded = match outcome {
            Ok(Finished::Skipped(fingerprint)) => {
                history::skip(&db, attempt, now_ms(), fingerprint)
            }
            Err(error) => history::fail(&db, attempt, now_ms(), error),
        };
        if let Err(e) = recorded {
            warn_log!("[backup] {e}");
        }
    }
    let _ = app.emit(STATUS_EVENT, ());
}

/// The newest backup at a target, as far as skipping needs it.
struct Last {
    location: String,
    size_bytes: Option<u64>,
}

/// When the library is exactly as the newest backup at `target` holds it,
/// and that backup was whole: the library's fingerprint, and where that
/// backup is, for the caller to make sure it is still there. `None` means
/// back up.
async fn unchanged(
    app: &AppHandle,
    state: &AppState,
    target: &str,
) -> Result<Option<(String, Last)>, String> {
    let last = {
        let db = state.db.lock();
        history::last_success_at(&db, target)?
    };
    let Some(history::LastAtTarget {
        fingerprint: Some(recorded),
        location: Some(location),
        size_bytes,
        complete: true,
        ..
    }) = last
    else {
        return Ok(None);
    };
    let preferences = preferences(app);
    let db_path = state.data_dir.join(DB_FILE);
    let fingerprint = tauri::async_runtime::spawn_blocking(move || {
        let conn = open_snapshot(&db_path)?;
        library_fingerprint(&conn, &preferences)
    })
    .await
    .unwrap_or_else(|e| Err(format!("checking for changes stopped unexpectedly: {e}")))?;
    if fingerprint != recorded {
        return Ok(None);
    }
    let last = Last {
        location,
        size_bytes: size_bytes.and_then(|size| u64::try_from(size).ok()),
    };
    Ok(Some((fingerprint, last)))
}

// --- the folder ------------------------------------------------------------

/// A short id for this device, in the names of the files it writes to a
/// folder that another device may share.
fn device_tag(db: &Connection) -> Result<String, String> {
    let user_id: String = db
        .query_row("SELECT user_id FROM identity LIMIT 1", [], |row| row.get(0))
        .map_err(|e| format!("could not read this device's identity: {e}"))?;
    let tag: String = user_id
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(8)
        .collect::<String>()
        .to_ascii_lowercase();
    if tag.is_empty() {
        Err("this device's identity is empty".to_string())
    } else {
        Ok(tag)
    }
}

/// `oyot-backup-YYYY-MM-DD-HHmm-<device>.zip`, numbered when that is taken.
/// The device's tag keeps two computers backing up to one shared folder from
/// ever choosing the same name.
fn scheduled_file_name(started: &DateTime<Local>, tag: &str, n: u32) -> String {
    let base = suggested_filename(started);
    let stem = base.trim_end_matches(".zip");
    if n <= 1 {
        format!("{stem}-{tag}.zip")
    } else {
        format!("{stem}-{tag}-{n}.zip")
    }
}

/// The first scheduled file name not already used in `folder`.
fn free_name(folder: &Path, started: &DateTime<Local>, tag: &str) -> String {
    (1..100)
        .map(|n| scheduled_file_name(started, tag, n))
        .find(|name| {
            let path = folder.join(name);
            !path.exists() && !partial_path(&path).exists()
        })
        .unwrap_or_else(|| scheduled_file_name(started, tag, 100))
}

/// Whether `location` is a backup this app would have written to `folder`:
/// directly in it, and named as backups are. Pruning removes nothing else,
/// whatever the history says.
fn is_backup_in(folder: &Path, location: &str) -> bool {
    let path = Path::new(location);
    let named = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("oyot-backup-") && name.ends_with(".zip"));
    named && path.parent() == Some(folder)
}

fn remove_stale_partials(folder: &Path, tag: &str) {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    let mine = format!("-{tag}");
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.starts_with(".oyot-backup-")
            && name.ends_with(".zip.partial")
            && name.contains(&mine)
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Remove this device's oldest scheduled backups in the folder beyond the
/// newest `keep` (ADR 0026, decision 5). `made` is the backup just made.
fn prune_folder(
    app: &AppHandle,
    state: &AppState,
    folder: &Path,
    target: &str,
    keep: u32,
    made: i64,
) {
    if let Err(e) = prune_folder_in(&state.db, folder, target, keep, made) {
        warn_log!("[backup] pruning: {e}");
    }
    let _ = app.emit(STATUS_EVENT, ());
}

fn prune_folder_in(
    db: &Db,
    folder: &Path,
    target: &str,
    keep: u32,
    made: i64,
) -> Result<(), String> {
    // A folder that has gone since the backup landed says nothing about
    // what is in it: its files are not gone, only out of reach.
    if !folder.is_dir() {
        return Ok(());
    }
    let stored = history::scheduled_at(&db.lock(), target)?;
    let present = forget_missing(db, stored, made, |s| in_folder(folder, &s.location))?;
    for backup in schedule::to_prune(&present, keep) {
        match std::fs::remove_file(&backup.location) {
            Ok(()) => forget(db, backup.id)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => forget(db, backup.id)?,
            Err(e) => warn_log!("[backup] could not remove an old backup: {e}"),
        }
    }
    Ok(())
}

/// Whether a recorded backup is still in the folder. One that is not a file
/// this app would have written there counts as gone: it is forgotten, and
/// never removed. When the file cannot be looked at, that is not known, and
/// the answer is an error rather than a guess.
fn in_folder(folder: &Path, location: &str) -> Result<bool, String> {
    if !is_backup_in(folder, location) {
        return Ok(false);
    }
    match std::fs::metadata(location) {
        Ok(meta) => Ok(meta.is_file()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("could not check an older backup: {e}")),
    }
}

/// Whether the backup a skip would rely on is still in the folder, whole.
fn still_in_folder(folder: &Path, last: &Last) -> bool {
    is_backup_in(folder, &last.location)
        && std::fs::metadata(&last.location)
            .is_ok_and(|m| m.is_file() && Some(m.len()) == last.size_bytes)
}

// --- a provider ------------------------------------------------------------

/// Remove this device's oldest scheduled backups at the linked account
/// beyond the newest `keep`, for good rather than to the bin, where they
/// would go on filling the account. `made` is the backup just made.
async fn prune_provider(
    app: &AppHandle,
    state: &AppState,
    provider: &dyn BackupProvider,
    target: &str,
    keep: u32,
    made: i64,
) {
    if let Err(e) = prune_provider_in(&state.db, provider, target, keep, made).await {
        warn_log!("[backup] pruning: {e}");
    }
    let _ = app.emit(STATUS_EVENT, ());
}

async fn prune_provider_in(
    db: &Db,
    provider: &dyn BackupProvider,
    target: &str,
    keep: u32,
    made: i64,
) -> Result<(), String> {
    // Another account may have been linked while the backup ran. Its view of
    // the files says nothing about the first account's.
    let same_account = matches!(
        provider.account().await,
        Ok(Some(account)) if history::target_for_provider(provider.id(), &account.email) == target
    );
    if !same_account {
        return Ok(());
    }
    // Without the list, nothing is known to be gone, and pruning waits.
    let listed: HashSet<String> = provider
        .list()
        .await
        .map_err(|e| format!("the backups could not be listed: {e}"))?
        .into_iter()
        .map(|backup| backup.id)
        .collect();

    let stored = history::scheduled_at(&db.lock(), target)?;
    let present = forget_missing(db, stored, made, |s| Ok(listed.contains(&s.location)))?;
    for backup in schedule::to_prune(&present, keep) {
        match provider.purge(&backup.location).await {
            Ok(()) => forget(db, backup.id)?,
            Err(e) => warn_log!("[backup] could not remove an old backup: {e}"),
        }
    }
    Ok(())
}

// --- pruning, shared ---------------------------------------------------------

type Db = parking_lot::Mutex<Connection>;

/// Forget the backups that are no longer there, so they do not hold places
/// among the ones kept; the user may have deleted some themselves. Returns
/// the rest.
///
/// Nothing is forgotten on a guess. When `present` cannot tell for one of
/// them, the whole prune stops before anything is forgotten. And the backup
/// just made, `made`, is never in doubt: a listing taken straight after an
/// upload need not show it yet.
fn forget_missing(
    db: &Db,
    stored: Vec<Stored>,
    made: i64,
    present: impl Fn(&Stored) -> Result<bool, String>,
) -> Result<Vec<Stored>, String> {
    let mut here = Vec::new();
    let mut gone = Vec::new();
    for backup in stored {
        if backup.id == made || present(&backup)? {
            here.push(backup);
        } else {
            gone.push(backup);
        }
    }
    for backup in gone {
        forget(db, backup.id)?;
    }
    Ok(here)
}

fn forget(db: &Db, id: i64) -> Result<(), String> {
    history::forget(&db.lock(), id)
}

// --- settings ----------------------------------------------------------------

/// The schedule, as the settings page shows it.
#[derive(Debug, Serialize)]
pub struct ScheduleView {
    pub frequency: Frequency,
    /// Minutes after local midnight.
    pub time_of_day: u16,
    /// 0 is Monday.
    pub weekday: u8,
    /// `folder`, or a provider's id.
    pub destination: Option<String>,
    /// What to call it: the folder's name, or the provider and its account.
    pub destination_label: Option<String>,
    /// The chosen folder's name. Its path stays here.
    pub folder_label: Option<String>,
    pub skip_unchanged: bool,
    pub keep: u32,
    /// When the next scheduled backup is due, in epoch milliseconds. `None`
    /// when the schedule is off or paused.
    pub next_run_at: Option<i64>,
    /// A backup is owed now, and starts within a few minutes.
    pub due: bool,
    /// Why scheduled backups cannot run, when the schedule is on and they
    /// cannot.
    pub paused: Option<String>,
    /// Scheduled attempts that have failed in a row, and the last one's
    /// error. Zero when the schedule is off or paused.
    pub failures: usize,
    pub last_error: Option<String>,
    /// Whether this device can back up to a folder on a schedule.
    pub folders_supported: bool,
    pub suggestion_dismissed: bool,
}

async fn view(app: &AppHandle) -> Result<ScheduleView, String> {
    let state = app.state::<AppState>();
    let providers = app.state::<Providers>();
    let (schedule, attempts, last_failure) = {
        let db = state.db.lock();
        (
            schedule::load(&db)?,
            history::scheduled_attempts(&db)?,
            history::last_scheduled_failure(&db)?,
        )
    };
    let on = schedule.frequency != Frequency::Off;
    // Only looked into while the schedule is on. Finding out whether an
    // account is linked reads the keychain, which on a Mac can ask the user,
    // and every launch reads this view.
    let resolved = if on {
        Some(resolve(&schedule, &providers).await)
    } else {
        None
    };

    let destination_label = match (&resolved, schedule.destination.as_deref()) {
        (Some(Resolved::Ready(Place::Folder { name, .. })), _) => Some(name.clone()),
        (Some(Resolved::Ready(Place::Provider { provider, account })), _) => {
            Some(account_label(provider.name(), account))
        }
        (_, Some(FOLDER)) => schedule.folder.as_deref().map(folder_name),
        (resolved, Some(id)) => Some(match (providers.get(id), resolved) {
            (Ok(provider), Some(Resolved::Paused(_))) => {
                format!("{} (not linked)", provider.name())
            }
            (Ok(provider), _) => provider.name().to_string(),
            (Err(_), _) => "Not available".to_string(),
        }),
        (_, None) => None,
    };

    let paused = match resolved {
        Some(Resolved::Paused(reason)) => Some(reason),
        _ => None,
    };
    let now = Local::now();
    let next = if paused.is_some() {
        Next::Off
    } else {
        schedule::next_run(&now, &schedule, &attempts)
    };
    let failures = if on && paused.is_none() {
        schedule
            .current_failures(&attempts, now.timestamp_millis())
            .count()
    } else {
        0
    };

    Ok(ScheduleView {
        frequency: schedule.frequency,
        time_of_day: schedule.time_of_day,
        weekday: schedule.weekday,
        destination_label,
        folder_label: schedule.folder.as_deref().map(folder_name),
        destination: schedule.destination,
        skip_unchanged: schedule.skip_unchanged,
        keep: schedule.keep,
        next_run_at: match next {
            Next::Off => None,
            Next::Now => Some(now.timestamp_millis()),
            Next::At(at) => Some(at),
        },
        due: next == Next::Now,
        paused,
        failures,
        last_error: last_failure
            .filter(|_| failures > 0)
            .and_then(|record| record.error),
        folders_supported: cfg!(desktop),
        suggestion_dismissed: schedule.suggestion_dismissed,
    })
}

#[tauri::command]
pub async fn get_backup_schedule(app: AppHandle) -> Result<ScheduleView, String> {
    view(&app).await
}

/// Everything the page sets on a schedule. The folder is not among it: only
/// `choose_backup_folder`, through a dialog Rust opens, sets that.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleSettings {
    pub frequency: Frequency,
    pub time_of_day: u16,
    pub weekday: u8,
    pub destination: Option<String>,
    pub skip_unchanged: bool,
    pub keep: u32,
}

/// Whether saving `settings` over `current` chooses a destination: points
/// the schedule somewhere new, or turns it on. Only then is the destination
/// checked. One already saved is otherwise kept as it is, even when it
/// cannot be used now (an account unlinked since, or a provider this build
/// lacks), so such a schedule can still be edited, or turned off.
fn chooses_destination(current: &Schedule, settings: &ScheduleSettings) -> bool {
    settings.destination != current.destination
        || (settings.frequency != Frequency::Off && current.frequency == Frequency::Off)
}

#[tauri::command]
pub async fn set_backup_schedule(
    app: AppHandle,
    state: State<'_, AppState>,
    providers: State<'_, Providers>,
    settings: ScheduleSettings,
) -> Result<ScheduleView, String> {
    if settings.time_of_day >= 24 * 60 {
        return Err("that is not a time of day".to_string());
    }
    if settings.weekday > 6 {
        return Err("that is not a day of the week".to_string());
    }
    if !(1..=MAX_KEEP).contains(&settings.keep) {
        return Err(format!("keep between 1 and {MAX_KEEP} scheduled backups"));
    }

    let current = {
        let db = state.db.lock();
        schedule::load(&db)?
    };
    let on = settings.frequency != Frequency::Off;
    let choosing = chooses_destination(&current, &settings);
    match settings.destination.as_deref() {
        None if on => return Err("choose where scheduled backups go first".to_string()),
        None => {}
        Some(_) if !choosing => {}
        Some(FOLDER) => {
            if !cfg!(desktop) {
                return Err("a folder can only be chosen on a computer".to_string());
            }
            if current.folder.is_none() {
                return Err("choose a folder first".to_string());
            }
        }
        Some(id) => {
            let provider = providers.get(id)?;
            // ADR 0025: a provider is not somewhere a schedule can be pointed
            // before an account is linked.
            if on && provider.account().await?.is_none() {
                return Err(format!("link an account to {} first", provider.name()));
            }
        }
    }

    let mut next = Schedule {
        frequency: settings.frequency,
        time_of_day: settings.time_of_day,
        weekday: settings.weekday,
        destination: settings.destination,
        skip_unchanged: settings.skip_unchanged,
        keep: settings.keep,
        // Turning it on answers the suggestion to.
        suggestion_dismissed: current.suggestion_dismissed || on,
        ..current.clone()
    };
    current.stamp_changes(&mut next, now_ms());
    {
        let db = state.db.lock();
        schedule::save(&db, &next)?;
    }
    let _ = app.emit(STATUS_EVENT, ());
    view(&app).await
}

/// Let the user pick the folder scheduled backups go to, and make it where
/// they go. `None` when they close the dialog.
#[cfg(desktop)]
#[tauri::command]
pub async fn choose_backup_folder(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<ScheduleView>, String> {
    use tauri_plugin_dialog::DialogExt;

    // Blocking, which is why this command is async: see create_local_backup.
    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let folder = picked
        .into_path()
        .map_err(|e| format!("could not use that folder: {e}"))?;
    {
        let db = state.db.lock();
        let current = schedule::load(&db)?;
        let mut next = Schedule {
            folder: Some(folder),
            destination: Some(FOLDER.to_string()),
            ..current.clone()
        };
        current.stamp_changes(&mut next, now_ms());
        schedule::save(&db, &next)?;
    }
    let _ = app.emit(STATUS_EVENT, ());
    view(&app).await.map(Some)
}

/// A phone cannot keep a folder chosen once (ADR 0026, decision 6).
#[cfg(not(desktop))]
#[tauri::command]
pub async fn choose_backup_folder(
    _app: AppHandle,
    _state: State<'_, AppState>,
) -> Result<Option<ScheduleView>, String> {
    Err("a folder can only be chosen on a computer".to_string())
}

/// The suggestion to turn scheduled backups on has been answered: do not
/// show it again.
#[tauri::command]
pub fn dismiss_backup_suggestion(state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock();
    let schedule = Schedule {
        suggestion_dismissed: true,
        ..schedule::load(&db)?
    };
    schedule::save(&db, &schedule)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::remote::{Cancel, OpenUrl, Progress, RemoteBackup, UploadMeta};
    use crate::backup::test_support::{library, scratch};
    use crate::backup::writer::BackupSummary;
    use async_trait::async_trait;
    use chrono::TimeZone;

    fn summary(size_bytes: u64) -> BackupSummary {
        BackupSummary {
            document_count: 3,
            attachment_count: 0,
            skipped_attachments: 0,
            skipped_documents: Vec::new(),
            size_bytes,
            fingerprint: "f".repeat(64),
            device_name: "Desk".to_string(),
        }
    }

    /// A backup recorded in the history, as a run would record it.
    fn record(db: &Db, scheduled: bool, target: &str, location: &str) -> i64 {
        let db = db.lock();
        let id = history::start(
            &db,
            &NewAttempt {
                scheduled,
                destination: FOLDER,
                label: "backup",
                target: Some(target),
                started_at: 1,
            },
        )
        .unwrap();
        history::succeed(&db, id, 2, &summary(4), Some(location)).unwrap();
        id
    }

    /// Scheduled backups `1..=count` in the folder, oldest first, and the
    /// row of the newest, which stands for the one just made.
    fn scheduled_files(db: &Db, folder: &Path, target: &str, count: usize) -> (Vec<PathBuf>, i64) {
        let mut made = 0;
        let files = (1..=count)
            .map(|n| {
                let path = folder.join(format!("oyot-backup-2026-09-{n:02}-0200-tag.zip"));
                std::fs::write(&path, b"back").unwrap();
                made = record(db, true, target, path.to_str().unwrap());
                path
            })
            .collect();
        (files, made)
    }

    fn remaining(db: &Db, target: &str) -> Vec<String> {
        history::scheduled_at(&db.lock(), target)
            .unwrap()
            .into_iter()
            .map(|s| s.location)
            .collect()
    }

    #[test]
    fn prunes_the_oldest_scheduled_backups_in_the_folder_and_nothing_else() {
        let db = Db::new(library());
        let folder = scratch();
        let target = history::target_for_folder(&folder);
        let (files, made) = scheduled_files(&db, &folder, &target, 5);
        // Made by hand into the same folder, and files the app never made.
        let manual = folder.join("oyot-backup-2026-09-10-1200.zip");
        std::fs::write(&manual, b"mine").unwrap();
        record(&db, false, &target, manual.to_str().unwrap());
        let unrecorded = folder.join("oyot-backup-2026-01-01-0000-other.zip");
        std::fs::write(&unrecorded, b"theirs").unwrap();
        let unrelated = folder.join("notes.zip");
        std::fs::write(&unrelated, b"notes").unwrap();

        prune_folder_in(&db, &folder, &target, 3, made).unwrap();

        assert!(!files[0].exists());
        assert!(!files[1].exists());
        for kept in &files[2..] {
            assert!(kept.exists());
        }
        assert!(manual.exists());
        assert!(unrecorded.exists());
        assert!(unrelated.exists());
        assert_eq!(remaining(&db, &target).len(), 3);
        std::fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn a_backup_the_user_deleted_does_not_take_a_place_among_those_kept() {
        let db = Db::new(library());
        let folder = scratch();
        let target = history::target_for_folder(&folder);
        let (files, made) = scheduled_files(&db, &folder, &target, 4);
        // The user threw away the two after the oldest.
        std::fs::remove_file(&files[1]).unwrap();
        std::fs::remove_file(&files[2]).unwrap();

        prune_folder_in(&db, &folder, &target, 3, made).unwrap();

        // Only two are really there, so the oldest stays.
        assert!(files[0].exists());
        assert_eq!(
            remaining(&db, &target),
            vec![
                files[3].to_str().unwrap().to_string(),
                files[0].to_str().unwrap().to_string()
            ]
        );
        std::fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn a_folder_out_of_reach_is_neither_pruned_nor_forgotten() {
        let db = Db::new(library());
        let folder = scratch();
        let target = history::target_for_folder(&folder);
        let (_, made) = scheduled_files(&db, &folder, &target, 5);
        std::fs::remove_dir_all(&folder).unwrap();

        prune_folder_in(&db, &folder, &target, 1, made).unwrap();
        assert_eq!(remaining(&db, &target).len(), 5);
    }

    #[test]
    fn never_removes_a_file_outside_the_folder_whatever_the_history_says() {
        let db = Db::new(library());
        let folder = scratch();
        let elsewhere = scratch();
        let target = history::target_for_folder(&folder);
        let outside = elsewhere.join("oyot-backup-2026-01-01-0000-tag.zip");
        std::fs::write(&outside, b"not in the folder").unwrap();
        record(&db, true, &target, outside.to_str().unwrap());
        let (_, made) = scheduled_files(&db, &folder, &target, 3);

        prune_folder_in(&db, &folder, &target, 1, made).unwrap();
        assert!(outside.exists());
        assert!(!remaining(&db, &target).contains(&outside.to_str().unwrap().to_string()));
        std::fs::remove_dir_all(&folder).unwrap();
        std::fs::remove_dir_all(&elsewhere).unwrap();
    }

    #[test]
    fn a_file_that_cannot_be_looked_at_stops_the_prune_rather_than_being_forgotten() {
        let folder = scratch();
        // A name no file system accepts, standing in for a stat that fails
        // on a network folder: not "not found", just not known.
        let unreadable = folder.join("oyot-backup-2026-09-01-0200-\0tag.zip");
        assert!(in_folder(&folder, unreadable.to_str().unwrap()).is_err());
        let missing = folder.join("oyot-backup-2026-09-01-0200-tag.zip");
        assert_eq!(in_folder(&folder, missing.to_str().unwrap()), Ok(false));

        let db = Db::new(library());
        let target = history::target_for_folder(&folder);
        record(&db, true, &target, unreadable.to_str().unwrap());
        let (files, made) = scheduled_files(&db, &folder, &target, 3);
        assert!(prune_folder_in(&db, &folder, &target, 1, made).is_err());
        assert_eq!(remaining(&db, &target).len(), 4);
        assert!(files.iter().all(|f| f.exists()));
        std::fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn a_skip_relies_only_on_a_backup_still_whole_in_the_folder() {
        let folder = scratch();
        let path = folder.join("oyot-backup-2026-09-24-0200-tag.zip");
        std::fs::write(&path, b"four").unwrap();
        let last = |size| Last {
            location: path.to_str().unwrap().to_string(),
            size_bytes: size,
        };
        assert!(still_in_folder(&folder, &last(Some(4))));
        // Cut short, say by a drive pulled out before it was written.
        assert!(!still_in_folder(&folder, &last(Some(5))));
        assert!(!still_in_folder(&folder, &last(None)));
        std::fs::remove_file(&path).unwrap();
        assert!(!still_in_folder(&folder, &last(Some(4))));
        std::fs::remove_dir_all(&folder).unwrap();
    }

    struct FakeProvider {
        email: Option<String>,
        files: parking_lot::Mutex<Vec<String>>,
        list_fails: bool,
        purged: parking_lot::Mutex<Vec<String>>,
    }

    impl FakeProvider {
        fn new(email: &str, files: &[&str]) -> Self {
            FakeProvider {
                email: Some(email.to_string()),
                files: parking_lot::Mutex::new(files.iter().map(|f| f.to_string()).collect()),
                list_fails: false,
                purged: parking_lot::Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl BackupProvider for FakeProvider {
        fn id(&self) -> &'static str {
            "fake"
        }
        fn name(&self) -> &'static str {
            "Fake"
        }
        async fn account(&self) -> Result<Option<Account>, String> {
            Ok(self
                .email
                .clone()
                .map(|email| Account { email, name: None }))
        }
        async fn link(&self, _: OpenUrl<'_>, _: Cancel) -> Result<Account, String> {
            Err("not in a test".to_string())
        }
        async fn unlink(&self) -> Result<(), String> {
            Ok(())
        }
        async fn upload(
            &self,
            _: &Path,
            _: &UploadMeta,
            _: Progress<'_>,
        ) -> Result<RemoteBackup, String> {
            Err("not in a test".to_string())
        }
        async fn list(&self) -> Result<Vec<RemoteBackup>, String> {
            if self.list_fails {
                return Err("offline".to_string());
            }
            Ok(self
                .files
                .lock()
                .iter()
                .map(|id| RemoteBackup {
                    id: id.clone(),
                    name: format!("{id}.zip"),
                    size: Some(4),
                    created_at: 0,
                    device: None,
                    document_count: None,
                    attachment_count: None,
                })
                .collect())
        }
        async fn download(&self, _: &str, _: &Path, _: u64, _: Progress<'_>) -> Result<(), String> {
            Err("not in a test".to_string())
        }
        async fn delete(&self, id: &str) -> Result<(), String> {
            self.files.lock().retain(|f| f != id);
            Ok(())
        }
        async fn purge(&self, id: &str) -> Result<(), String> {
            self.files.lock().retain(|f| f != id);
            self.purged.lock().push(id.to_string());
            Ok(())
        }
    }

    #[tokio::test]
    async fn purges_the_oldest_scheduled_backups_at_the_same_account() {
        let db = Db::new(library());
        let target = history::target_for_provider("fake", "me@example.com");
        for id in ["a", "b", "c"] {
            record(&db, true, &target, id);
        }
        // Gone from the account already: the user deleted it there.
        record(&db, true, &target, "gone");
        let made = record(&db, true, &target, "d");
        let provider = FakeProvider::new("me@example.com", &["a", "b", "c", "d"]);

        prune_provider_in(&db, &provider, &target, 2, made)
            .await
            .unwrap();

        assert_eq!(*provider.purged.lock(), vec!["a", "b"]);
        assert_eq!(remaining(&db, &target), vec!["d", "c"]);
    }

    #[tokio::test]
    async fn the_backup_just_made_counts_even_before_the_list_shows_it() {
        let db = Db::new(library());
        let target = history::target_for_provider("fake", "me@example.com");
        for id in ["a", "b"] {
            record(&db, true, &target, id);
        }
        let made = record(&db, true, &target, "new");
        // Straight after the upload, the listing does not have it yet.
        let provider = FakeProvider::new("me@example.com", &["a", "b"]);

        prune_provider_in(&db, &provider, &target, 2, made)
            .await
            .unwrap();

        assert_eq!(*provider.purged.lock(), vec!["a"]);
        assert_eq!(remaining(&db, &target), vec!["new", "b"]);
    }

    #[tokio::test]
    async fn another_account_linked_meanwhile_is_not_pruned_from() {
        let db = Db::new(library());
        let target = history::target_for_provider("fake", "me@example.com");
        for id in ["a", "b", "c"] {
            record(&db, true, &target, id);
        }
        let provider = FakeProvider::new("someone-else@example.com", &[]);

        prune_provider_in(&db, &provider, &target, 1, 0)
            .await
            .unwrap();
        assert!(provider.purged.lock().is_empty());
        assert_eq!(remaining(&db, &target).len(), 3);
    }

    #[tokio::test]
    async fn without_the_list_nothing_is_pruned_or_forgotten() {
        let db = Db::new(library());
        let target = history::target_for_provider("fake", "me@example.com");
        for id in ["a", "b", "c"] {
            record(&db, true, &target, id);
        }
        let provider = FakeProvider {
            list_fails: true,
            ..FakeProvider::new("me@example.com", &["a", "b", "c"])
        };

        assert!(prune_provider_in(&db, &provider, &target, 1, 0)
            .await
            .is_err());
        assert!(provider.purged.lock().is_empty());
        assert_eq!(remaining(&db, &target).len(), 3);
    }

    fn started() -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 9, 24, 2, 0, 0).unwrap()
    }

    #[test]
    fn a_saved_destination_is_only_checked_again_when_chosen() {
        let current = Schedule {
            frequency: Frequency::Daily,
            destination: Some("gone-provider".to_string()),
            ..Schedule::default()
        };
        let settings = |frequency, destination: &str| ScheduleSettings {
            frequency,
            time_of_day: 120,
            weekday: 0,
            destination: Some(destination.to_string()),
            skip_unchanged: true,
            keep: 3,
        };
        // Editing it, or turning it off, keeps what is saved unchecked.
        assert!(!chooses_destination(
            &current,
            &settings(Frequency::Weekly, "gone-provider")
        ));
        assert!(!chooses_destination(
            &current,
            &settings(Frequency::Off, "gone-provider")
        ));
        // Pointing it somewhere new is checked.
        assert!(chooses_destination(
            &current,
            &settings(Frequency::Daily, FOLDER)
        ));
        // So is turning it back on.
        let off = Schedule {
            frequency: Frequency::Off,
            ..current
        };
        assert!(chooses_destination(
            &off,
            &settings(Frequency::Daily, "gone-provider")
        ));
    }

    #[test]
    fn names_files_after_the_device_so_shared_folders_never_collide() {
        assert_eq!(
            scheduled_file_name(&started(), "ab12cd34", 1),
            "oyot-backup-2026-09-24-0200-ab12cd34.zip"
        );
        assert_eq!(
            scheduled_file_name(&started(), "ab12cd34", 2),
            "oyot-backup-2026-09-24-0200-ab12cd34-2.zip"
        );
    }

    #[test]
    fn takes_the_next_number_when_a_name_is_used() {
        let dir = scratch();
        let first = scheduled_file_name(&started(), "t", 1);
        assert_eq!(free_name(&dir, &started(), "t"), first);
        std::fs::write(dir.join(&first), b"x").unwrap();
        assert_eq!(
            free_name(&dir, &started(), "t"),
            scheduled_file_name(&started(), "t", 2)
        );
        // A name half-written by someone is as taken as a finished one.
        std::fs::write(
            partial_path(&dir.join(scheduled_file_name(&started(), "t", 2))),
            b"x",
        )
        .unwrap();
        assert_eq!(
            free_name(&dir, &started(), "t"),
            scheduled_file_name(&started(), "t", 3)
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_device_tag_comes_from_its_identity() {
        let db = library();
        assert!(device_tag(&db).is_err());
        db.execute(
            "INSERT INTO identity (user_id, node_id, display_name)
                 VALUES ('AB12CD34-ef56-7890-abcd-ef1234567890', 'node', 'Desk')",
            [],
        )
        .unwrap();
        assert_eq!(device_tag(&db).unwrap(), "ab12cd34");
    }

    #[test]
    fn prunes_only_what_is_named_as_a_backup_directly_in_the_folder() {
        let folder = Path::new("/backups");
        assert!(is_backup_in(
            folder,
            "/backups/oyot-backup-2026-09-24-0200-ab12cd34.zip"
        ));
        assert!(!is_backup_in(folder, "/backups/notes.zip"));
        assert!(!is_backup_in(folder, "/backups/oyot-backup-2026.txt"));
        assert!(!is_backup_in(
            folder,
            "/backups/deeper/oyot-backup-2026-09-24-0200.zip"
        ));
        assert!(!is_backup_in(
            folder,
            "/elsewhere/oyot-backup-2026-09-24-0200.zip"
        ));
        assert!(!is_backup_in(folder, "/backups/../etc/oyot-backup-x.zip"));
    }

    #[test]
    fn clears_only_this_devices_half_written_files() {
        let dir = scratch();
        let mine = dir.join(".oyot-backup-2026-09-24-0200-mine1234.zip.partial");
        let theirs = dir.join(".oyot-backup-2026-09-24-0200-them5678.zip.partial");
        let finished = dir.join("oyot-backup-2026-09-24-0200-mine1234.zip");
        for path in [&mine, &theirs, &finished] {
            std::fs::write(path, b"x").unwrap();
        }
        remove_stale_partials(&dir, "mine1234");
        assert!(!mine.exists());
        assert!(theirs.exists());
        assert!(finished.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

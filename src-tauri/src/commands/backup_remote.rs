//! Backing up to a linked account, and importing a backup back from one
//! (ADR 0025).
//!
//! The provider is chosen by id and is otherwise invisible here: the same
//! archive is built for any of them, and a downloaded backup is checked and
//! imported exactly as a file picked from disk is. Tokens never leave Rust;
//! the webview sees an account's email and the list of backups, nothing more.

use super::backup::{
    begin, report, run_backup, staging_dir, start_session, BackupPreview, BackupState, Delivery,
    Running, BUSY, MAX_BACKUP_FILE_BYTES, STATUS_EVENT,
};
use crate::backup::history::{self, NewAttempt};
use crate::backup::reader::BackupReader;
use crate::backup::remote::{Account, Providers, RemoteBackup};
use crate::backup::staging::StagedFile;
use crate::db::AppState;
use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Serialize)]
pub struct ProviderView {
    pub id: &'static str,
    pub name: &'static str,
    /// The linked account, if any.
    pub account: Option<Account>,
    /// Why the link could not be read, when it could not: a locked keychain,
    /// say. Shown rather than treated as "not linked", which it is not.
    pub problem: Option<String>,
}

/// Every provider this build can back up to, and who each is linked to.
#[tauri::command]
pub async fn list_backup_providers(
    providers: State<'_, Providers>,
) -> Result<Vec<ProviderView>, String> {
    let mut views = Vec::new();
    for provider in providers.all() {
        let (account, problem) = match provider.account().await {
            Ok(account) => (account, None),
            Err(e) => (None, Some(e)),
        };
        views.push(ProviderView {
            id: provider.id(),
            name: provider.name(),
            account,
            problem,
        });
    }
    Ok(views)
}

/// Link an account: open the provider's sign-in in the system browser, and
/// wait for the user to finish there.
///
/// Starting another link cancels one still waiting, and so does
/// `cancel_backup_link`.
#[tauri::command]
pub async fn link_backup_provider(
    app: AppHandle,
    backup: State<'_, BackupState>,
    providers: State<'_, Providers>,
    provider: String,
) -> Result<Account, String> {
    use tauri_plugin_opener::OpenerExt;

    let provider = providers.get(&provider)?;
    let (cancel, cancelled) = tokio::sync::oneshot::channel();
    let attempt = backup.link_attempts.fetch_add(1, Ordering::AcqRel) + 1;
    // Replacing an earlier attempt drops its sender, which is what ends its
    // wait.
    *backup.linking.lock() = Some((attempt, cancel));

    let open = |url: &str| -> Result<(), String> {
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|e| format!("could not open the browser: {e}"))
    };
    let result = provider.link(&open, cancelled).await;

    {
        let mut slot = backup.linking.lock();
        if slot.as_ref().is_some_and(|(id, _)| *id == attempt) {
            *slot = None;
        }
    }
    // A schedule paused for want of an account resumes with this one.
    if result.is_ok() {
        let _ = app.emit(STATUS_EVENT, ());
    }
    result
}

/// Stop waiting for the browser.
#[tauri::command]
pub fn cancel_backup_link(backup: State<'_, BackupState>) {
    if let Some((_, cancel)) = backup.linking.lock().take() {
        let _ = cancel.send(());
    }
}

/// Unlink the account. Backups already stored with the provider stay there.
#[tauri::command]
pub async fn unlink_backup_provider(
    app: AppHandle,
    providers: State<'_, Providers>,
    provider: String,
) -> Result<(), String> {
    let result = providers.get(&provider)?.unlink().await;
    // A schedule backing up there is paused now, and the page should say so.
    let _ = app.emit(STATUS_EVENT, ());
    result
}

#[derive(Debug, Serialize)]
pub struct RemoteBackupResult {
    /// Where it went, as the confirmation and the history say it.
    pub destination_label: String,
    pub document_count: usize,
    pub attachment_count: usize,
    pub skipped_attachments: usize,
    pub skipped_documents: Vec<String>,
    pub size_bytes: u64,
    pub backup: RemoteBackup,
}

/// What the history and the page call a provider's linked account.
pub(super) fn account_label(provider: &str, account: &Account) -> String {
    format!("{provider} ({})", account.email)
}

/// Back up the whole library to the linked account. Recorded in the history
/// whatever the outcome.
#[tauri::command]
pub async fn create_remote_backup(
    app: AppHandle,
    state: State<'_, AppState>,
    backup: State<'_, BackupState>,
    providers: State<'_, Providers>,
    provider: String,
) -> Result<RemoteBackupResult, String> {
    let Some(_running) = Running::claim(&backup.running) else {
        return Err(BUSY.to_string());
    };
    let provider = providers.get(&provider)?;
    let account = provider
        .account()
        .await?
        .ok_or_else(|| format!("link an account to {} first", provider.name()))?;
    let label = account_label(provider.name(), &account);
    // Recorded so a scheduled backup to the same account can tell whether
    // this one already holds what it would back up. Never pruned: only
    // scheduled backups are.
    let target = history::target_for_provider(provider.id(), &account.email);

    let started = chrono::Local::now();
    let attempt = begin(
        &app,
        &state,
        &NewAttempt {
            scheduled: false,
            destination: provider.id(),
            label: &label,
            target: Some(&target),
            started_at: started.timestamp_millis(),
        },
    )?;
    let delivered = run_backup(
        &app,
        &state,
        attempt,
        &started,
        Delivery::Provider(provider),
    )
    .await?;
    let summary = delivered.summary;
    let uploaded = delivered
        .remote
        .ok_or("the backup was uploaded, but its details did not come back")?;
    Ok(RemoteBackupResult {
        destination_label: label,
        document_count: summary.document_count,
        attachment_count: summary.attachment_count,
        skipped_attachments: summary.skipped_attachments,
        skipped_documents: summary.skipped_documents,
        size_bytes: summary.size_bytes,
        backup: uploaded,
    })
}

/// The backups stored with the linked account, newest first.
#[tauri::command]
pub async fn list_remote_backups(
    providers: State<'_, Providers>,
    provider: String,
) -> Result<Vec<RemoteBackup>, String> {
    providers.get(&provider)?.list().await
}

/// Download one backup, check all of it, and open it for import, exactly as
/// a file picked from disk is opened.
#[tauri::command]
pub async fn open_remote_backup(
    app: AppHandle,
    state: State<'_, AppState>,
    backup: State<'_, BackupState>,
    providers: State<'_, Providers>,
    provider: String,
    backup_id: String,
) -> Result<BackupPreview, String> {
    // Held while the backup is fetched: a scheduled backup starting now
    // would prune at the same place, possibly the very backup coming down.
    let Some(_running) = Running::claim(&backup.running) else {
        return Err(BUSY.to_string());
    };
    let provider = providers.get(&provider)?;
    let staged = StagedFile::new(&staging_dir(&app)?, "import")?;

    let progress = |done: u64, total: u64| report(&app, "downloading", done, total);
    provider
        .download(&backup_id, staged.path(), MAX_BACKUP_FILE_BYTES, &progress)
        .await?;

    let (reader, staged) = tauri::async_runtime::spawn_blocking(move || {
        let reader = BackupReader::open(staged.path())?;
        Ok::<_, String>((reader, staged))
    })
    .await
    .unwrap_or_else(|e| Err(format!("reading the backup stopped unexpectedly: {e}")))?;

    start_session(&state, &backup, reader, staged)
}

/// Remove one backup from the linked account. Where the service has a bin,
/// it goes there, and can be taken back out.
#[tauri::command]
pub async fn delete_remote_backup(
    app: AppHandle,
    state: State<'_, AppState>,
    providers: State<'_, Providers>,
    provider: String,
    backup_id: String,
) -> Result<(), String> {
    let provider = providers.get(&provider)?;
    provider.delete(&backup_id).await?;
    // Gone, so neither something to prune nor proof that an unchanged
    // library is already backed up.
    let forgotten = {
        let db = state.db.lock();
        history::forget_location(&db, provider.id(), &backup_id)
    };
    if let Err(e) = forgotten {
        warn_log!("[backup] {e}");
    }
    let _ = app.emit(STATUS_EVENT, ());
    Ok(())
}

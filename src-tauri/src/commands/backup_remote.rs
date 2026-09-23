//! Backing up to a linked account, and importing a backup back from one
//! (ADR 0025).
//!
//! The provider is chosen by id and is otherwise invisible here: the same
//! archive is built for any of them, and a downloaded backup is checked and
//! imported exactly as a file picked from disk is. Tokens never leave Rust;
//! the webview sees an account's email and the list of backups, nothing more.

use super::backup::{
    build_staged, record_outcome, staging_dir, start_session, BackupPreview, BackupState, Running,
    MAX_BACKUP_FILE_BYTES, STATUS_EVENT,
};
use crate::backup::format::suggested_filename;
use crate::backup::history;
use crate::backup::reader::BackupReader;
use crate::backup::remote::{Account, Providers, RemoteBackup, UploadMeta};
use crate::backup::staging::StagedFile;
use crate::db::AppState;
use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, State};

/// Emitted while a backup moves to or from a provider, so the page can show
/// how far it has got.
const PROGRESS_EVENT: &str = "backup-progress";

#[derive(Clone, Serialize)]
struct ProgressEvent {
    /// `building`, `uploading` or `downloading`.
    phase: &'static str,
    done: u64,
    /// 0 when not known.
    total: u64,
}

fn report(app: &AppHandle, phase: &'static str, done: u64, total: u64) {
    let _ = app.emit(PROGRESS_EVENT, ProgressEvent { phase, done, total });
}

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

    let mut slot = backup.linking.lock();
    if slot.as_ref().is_some_and(|(id, _)| *id == attempt) {
        *slot = None;
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
    providers: State<'_, Providers>,
    provider: String,
) -> Result<(), String> {
    providers.get(&provider)?.unlink().await
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
        return Err("a backup is already running".to_string());
    };
    let provider = providers.get(&provider)?;
    let account = provider
        .account()
        .await?
        .ok_or_else(|| format!("link an account to {} first", provider.name()))?;
    let label = format!("{} ({})", provider.name(), account.email);

    let started = chrono::Local::now();
    let attempt = {
        let db = state.db.lock();
        history::start(
            &db,
            false,
            provider.id(),
            &label,
            started.timestamp_millis(),
        )?
    };
    let _ = app.emit(STATUS_EVENT, ());

    let outcome = async {
        report(&app, "building", 0, 0);
        let (staged, summary) =
            build_staged(&app, state.data_dir.clone(), started.timestamp_millis()).await?;
        let meta = UploadMeta {
            file_name: suggested_filename(&started),
            created_at: started.timestamp_millis(),
            device: summary.device_name.clone(),
            document_count: summary.document_count,
            attachment_count: summary.attachment_count,
        };
        let progress = |done: u64, total: u64| report(&app, "uploading", done, total);
        let uploaded = provider.upload(staged.path(), &meta, &progress).await?;
        Ok::<_, String>((summary, uploaded))
    }
    .await;
    record_outcome(
        &app,
        &state,
        attempt,
        outcome
            .as_ref()
            .map(|(summary, uploaded)| (summary, Some(uploaded.id.as_str())))
            .map_err(String::as_str),
    );

    let (summary, uploaded) = outcome?;
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
    providers: State<'_, Providers>,
    provider: String,
    backup_id: String,
) -> Result<(), String> {
    providers.get(&provider)?.delete(&backup_id).await
}

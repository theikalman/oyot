//! Backing up to a file the user picks, and importing one back.
//!
//! The same split as the export and the image picker: dialogs open here, the
//! location the user chose never crosses IPC in either direction, and the
//! webview receives only what it displays. What a backup is and how one is
//! checked lives in `crate::backup` (ADR 0024).
//!
//! An import is driven from the webview, because merging needs the editor's
//! schema (ADR 0013). This side opens and checks the file, then hands out one
//! checked document at a time from an open session, and stores the images
//! itself so their bytes never cross IPC.

use crate::backup::format::{suggested_filename, Limits, Preferences};
use crate::backup::history::{self, BackupRecord, BackupStatus, NewAttempt};
use crate::backup::reader::BackupReader;
use crate::backup::remote::{BackupProvider, RemoteBackup, UploadMeta};
use crate::backup::snapshot::open_snapshot;
use crate::backup::staging::{self, StagedFile};
use crate::backup::writer::{write_backup, BackupSummary};
use crate::commands::attachments::{
    held_attachments, store_checked_attachment, AttachmentDownloadedEvent,
};
use crate::commands::documents::DocSyncEntry;
use crate::db::{AppState, DB_FILE};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Serialize;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, FilePath};

/// Emitted whenever the history changes, so whatever shows "last backup" can
/// read it again.
pub(super) const STATUS_EVENT: &str = "backup-status-changed";

/// Emitted while a backup is built, and while one moves to or from a
/// provider, so the page can show how far it has got.
pub(super) const PROGRESS_EVENT: &str = "backup-progress";

#[derive(Clone, Serialize)]
struct ProgressEvent {
    /// `building`, `uploading` or `downloading`.
    phase: &'static str,
    done: u64,
    /// 0 when not known.
    total: u64,
}

pub(super) fn report(app: &AppHandle, phase: &'static str, done: u64, total: u64) {
    let _ = app.emit(PROGRESS_EVENT, ProgressEvent { phase, done, total });
}

/// Largest file we will copy in to check. A backup's entries are capped, so
/// anything much bigger than their total is not a backup, and is refused
/// before it is copied rather than after.
pub(super) const MAX_BACKUP_FILE_BYTES: u64 =
    Limits::STANDARD.max_total_bytes + Limits::STANDARD.max_json_bytes + 64 * 1024 * 1024;

/// Backup state that lives for the length of the process.
#[derive(Default)]
pub struct BackupState {
    /// Set for the length of one backup, so only one runs at a time.
    pub(super) running: AtomicBool,
    /// The backup open for import, if any. One at a time: opening another
    /// closes it.
    import: parking_lot::Mutex<Option<ImportSession>>,
    /// The account link in progress, and how to cancel it. Numbered, so an
    /// attempt that ends only clears its own slot.
    pub(super) linking: parking_lot::Mutex<Option<(u64, tokio::sync::oneshot::Sender<()>)>>,
    pub(super) link_attempts: AtomicU64,
}

/// A backup opened for import.
///
/// Field order matters. The reader holds the staged file open and is dropped
/// first, so the file can be removed after it; Windows refuses to remove a
/// file that is still open.
struct ImportSession {
    id: String,
    reader: BackupReader,
    _staged: StagedFile,
}

/// Held for the length of one backup, or of reading one in to restore, and
/// released however it ends. One at a time: a scheduled backup prunes, and
/// must not do it under a restore.
pub(super) struct Running<'a>(&'a AtomicBool);

/// Why a backup or a restore cannot start.
pub(super) const BUSY: &str = "a backup is already running. Try again when it has finished.";

impl<'a> Running<'a> {
    pub(super) fn claim(flag: &'a AtomicBool) -> Option<Self> {
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Running(flag))
    }
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

pub(super) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub(super) fn staging_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|dir| dir.join("backup"))
        .map_err(|e| format!("could not find a place to build the backup: {e}"))
}

/// Remove anything an earlier run left in the staging directory. Called at
/// startup, before anything can be staged.
pub fn clear_staging(app: &AppHandle) {
    if let Ok(dir) = staging_dir(app) {
        staging::clear(&dir);
    }
}

// --- backing up ------------------------------------------------------------

/// The preferences a backup carries, as they are now.
pub(super) fn preferences(app: &AppHandle) -> Preferences {
    Preferences {
        theme: super::config::get_theme(app.clone()),
    }
}

/// Build a backup of the whole library in staging. The staged file is removed
/// when the returned handle is dropped, delivered or not.
///
/// Off the async runtime: a large library is minutes of disk work, which
/// would otherwise hold one of the threads signaling runs on.
pub(super) async fn build_staged(
    app: &AppHandle,
    data_dir: PathBuf,
    created_at: i64,
) -> Result<(StagedFile, BackupSummary), String> {
    let staging = staging_dir(app)?;
    let preferences = preferences(app);
    tauri::async_runtime::spawn_blocking(move || {
        let staged = StagedFile::new(&staging, "backup")?;
        let conn = open_snapshot(&data_dir.join(DB_FILE))?;
        let summary = write_backup(&conn, &data_dir, &preferences, created_at, staged.path())?;
        Ok((staged, summary))
    })
    .await
    .unwrap_or_else(|e| Err(format!("the backup stopped unexpectedly: {e}")))
}

/// Finish an attempt's history row, and tell anything showing it. A failure
/// to record is logged rather than returned: the backup itself is the answer
/// the caller is waiting for.
fn record_outcome(
    app: &AppHandle,
    state: &AppState,
    attempt: i64,
    outcome: Result<(&BackupSummary, Option<&str>), &str>,
) {
    {
        let db = state.db.lock();
        let recorded = match outcome {
            Ok((summary, location)) => history::succeed(&db, attempt, now_ms(), summary, location),
            Err(e) => history::fail(&db, attempt, now_ms(), e),
        };
        if let Err(e) = recorded {
            warn_log!("[backup] {e}");
        }
    }
    let _ = app.emit(STATUS_EVENT, ());
}

#[derive(Debug, Serialize)]
pub struct LocalBackupResult {
    /// What the file is called, for the confirmation message.
    pub file_name: String,
    pub document_count: usize,
    pub attachment_count: usize,
    /// Images a live note embeds that could not be included.
    pub skipped_attachments: usize,
    /// Titles of documents whose content could not be included.
    pub skipped_documents: Vec<String>,
    pub size_bytes: u64,
}

/// Back up the whole library to a file the user picks.
///
/// Returns `None` when the user cancels the dialog, which records nothing.
/// Everything after the dialog is recorded in the history, success or not.
#[tauri::command]
pub async fn create_local_backup(
    app: AppHandle,
    state: State<'_, AppState>,
    backup: State<'_, BackupState>,
) -> Result<Option<LocalBackupResult>, String> {
    let Some(_running) = Running::claim(&backup.running) else {
        return Err(BUSY.to_string());
    };

    let started = chrono::Local::now();
    let suggested = suggested_filename(&started);

    // Blocking, which is why this command is async: Tauri runs an async
    // command off the main thread, which is where the plugin requires this
    // call to be.
    let Some(destination) = app
        .dialog()
        .file()
        .set_file_name(&suggested)
        .add_filter("Zip archive", &["zip"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let file_name = file_label(&destination).unwrap_or(suggested);

    let attempt = begin(
        &app,
        &state,
        &NewAttempt {
            scheduled: false,
            destination: LOCAL,
            label: &file_name,
            // A file saved somewhere once is not a place backups go again,
            // so it is neither compared with nor pruned.
            target: None,
            started_at: started.timestamp_millis(),
        },
    )?;
    let summary = run_backup(&app, &state, attempt, &started, Delivery::File(destination))
        .await?
        .summary;
    trace!(
        "[cmd] create_local_backup wrote {} documents and {} attachments",
        summary.document_count,
        summary.attachment_count
    );
    Ok(Some(LocalBackupResult {
        file_name,
        document_count: summary.document_count,
        attachment_count: summary.attachment_count,
        skipped_attachments: summary.skipped_attachments,
        skipped_documents: summary.skipped_documents,
        size_bytes: summary.size_bytes,
    }))
}

/// Where a backup is going.
pub(super) enum Delivery {
    /// A file the user just chose in a save dialog.
    File(FilePath),
    /// A new file in the scheduled folder, at this path. Never written over
    /// a file already there.
    Folder(PathBuf),
    /// The account linked at a provider.
    Provider(Arc<dyn BackupProvider>),
}

/// A backup that reached its destination.
pub(super) struct Delivered {
    pub summary: BackupSummary,
    /// Where it can be found again: its path in the folder, or the
    /// provider's id for it. `None` for a file saved through a dialog.
    pub location: Option<String>,
    /// The uploaded file, for a provider.
    pub remote: Option<RemoteBackup>,
}

/// The history's name for a file saved through a dialog.
pub(super) const LOCAL: &str = "local";

/// Record that a backup is starting, and tell anything showing the history.
pub(super) fn begin(
    app: &AppHandle,
    state: &AppState,
    attempt: &NewAttempt,
) -> Result<i64, String> {
    let id = {
        let db = state.db.lock();
        history::start(&db, attempt)?
    };
    let _ = app.emit(STATUS_EVENT, ());
    Ok(id)
}

/// Build a backup, deliver it, and finish the attempt's history row however
/// that goes. The one operation behind every backup, manual or scheduled
/// (ADR 0026, decision 1); the caller holds `Running`.
pub(super) async fn run_backup(
    app: &AppHandle,
    state: &AppState,
    attempt: i64,
    started: &chrono::DateTime<chrono::Local>,
    delivery: Delivery,
) -> Result<Delivered, String> {
    let outcome = async {
        report(app, "building", 0, 0);
        let (staged, summary) =
            build_staged(app, state.data_dir.clone(), started.timestamp_millis()).await?;
        match delivery {
            Delivery::File(destination) => {
                let handle = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    deliver(&handle, staged.path(), &destination)
                })
                .await
                .unwrap_or_else(|e| Err(format!("saving the backup stopped unexpectedly: {e}")))?;
                Ok(Delivered {
                    summary,
                    location: None,
                    remote: None,
                })
            }
            Delivery::Folder(path) => {
                let location = path.to_string_lossy().into_owned();
                tauri::async_runtime::spawn_blocking(move || deliver_new(staged.path(), &path))
                    .await
                    .unwrap_or_else(|e| {
                        Err(format!("saving the backup stopped unexpectedly: {e}"))
                    })?;
                Ok(Delivered {
                    summary,
                    location: Some(location),
                    remote: None,
                })
            }
            Delivery::Provider(provider) => {
                let meta = UploadMeta {
                    file_name: suggested_filename(started),
                    created_at: started.timestamp_millis(),
                    device: summary.device_name.clone(),
                    document_count: summary.document_count,
                    attachment_count: summary.attachment_count,
                };
                let progress = |done: u64, total: u64| report(app, "uploading", done, total);
                let uploaded = provider.upload(staged.path(), &meta, &progress).await?;
                Ok(Delivered {
                    summary,
                    location: Some(uploaded.id.clone()),
                    remote: Some(uploaded),
                })
            }
        }
    }
    .await;
    record_outcome(
        app,
        state,
        attempt,
        outcome
            .as_ref()
            .map(|delivered| (&delivered.summary, delivered.location.as_deref()))
            .map_err(String::as_str),
    );
    outcome
}

/// Put a finished backup where the user asked for it.
fn deliver(app: &AppHandle, staged: &Path, destination: &FilePath) -> Result<(), String> {
    match destination {
        FilePath::Path(path) => deliver_to_path(staged, path),
        FilePath::Url(_) => deliver_to_url(app, staged, destination),
    }
}

/// A plain path, which is what every desktop dialog returns. Written beside
/// the destination under another name and renamed over it, so the
/// destination is only ever the old file or the whole new one.
fn deliver_to_path(staged: &Path, destination: &Path) -> Result<(), String> {
    let partial = partial_path(destination);
    let result = (|| -> std::io::Result<()> {
        let mut input = File::open(staged)?;
        let mut output = File::create(&partial)?;
        std::io::copy(&mut input, &mut output)?;
        // Durable before it takes the real name: the point of a backup is
        // surviving whatever just went wrong.
        output.sync_all()?;
        drop(output);
        std::fs::rename(&partial, destination)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    // The name only: the error reaches the webview, and the folder is the
    // user's to know, not the page's.
    result.map_err(|e| format!("could not save {}: {e}", display_name(destination)))
}

/// Save a backup as a new file, never in place of one already there. For
/// the scheduled folder, which another device may share, and where a file
/// of the same name is someone else's.
///
/// Written beside it first, as `deliver_to_path` does, but the partial file
/// must be new too: two writers sharing one partial would interleave.
pub(super) fn deliver_new(staged: &Path, destination: &Path) -> Result<(), String> {
    let failed = |e: std::io::Error| format!("could not save {}: {e}", display_name(destination));
    let partial = partial_path(destination);
    let mut input = File::open(staged).map_err(failed)?;
    // A partial file that is already there is someone else's, and is left
    // alone: only one this call made is ever removed.
    let output = File::options()
        .write(true)
        .create_new(true)
        .open(&partial)
        .map_err(failed)?;
    let result = (|mut output: File| -> std::io::Result<()> {
        std::io::copy(&mut input, &mut output)?;
        output.sync_all()?;
        // Closed before the rename, which Windows refuses on an open file.
        drop(output);
        if destination.exists() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "a file with that name appeared while the backup was being saved",
            ));
        }
        std::fs::rename(&partial, destination)
    })(output);
    if result.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    result.map_err(failed)
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "the backup".to_string())
}

pub(super) fn partial_path(destination: &Path) -> PathBuf {
    let name = destination
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "oyot-backup.zip".to_string());
    destination.with_file_name(format!(".{name}.partial"))
}

/// A URL, which is what a phone's dialog returns: a content URI on Android, a
/// security-scoped file URL on iOS. Neither can be written beside and
/// renamed, so this writes in place, and a failure part way says so.
fn deliver_to_url(app: &AppHandle, staged: &Path, destination: &FilePath) -> Result<(), String> {
    use tauri_plugin_fs::{FsExt, OpenOptions};

    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    let mut output = app
        .fs()
        .open(destination.clone(), options)
        .map_err(|e| format!("could not open the chosen file: {e}"))?;
    let mut input =
        File::open(staged).map_err(|e| format!("could not read the finished backup: {e}"))?;
    std::io::copy(&mut input, &mut output)
        .and_then(|_| output.flush())
        .and_then(|_| output.sync_all())
        .map_err(|e| {
            format!("could not save the backup; the chosen file may hold only part of it: {e}")
        })
}

/// What to call a chosen file in the history and the confirmation: its name,
/// when one can be read out of what the dialog returned.
///
/// A content URI names a document by id, and for the common providers the id
/// ends in the path the user saw, percent-encoded. When it does not, the
/// caller falls back to the name the dialog suggested.
fn file_label(path: &FilePath) -> Option<String> {
    let name = match path {
        FilePath::Path(path) => path.file_name()?.to_string_lossy().into_owned(),
        FilePath::Url(url) => {
            let last = url.path_segments()?.next_back()?;
            let decoded = percent_encoding::percent_decode_str(last)
                .decode_utf8_lossy()
                .into_owned();
            decoded.rsplit(['/', ':']).next()?.to_string()
        }
    };
    let name = name.trim().to_string();
    (!name.is_empty() && name.to_ascii_lowercase().ends_with(".zip")).then_some(name)
}

// --- importing -------------------------------------------------------------

/// A checked backup, as the import preview shows it.
#[derive(Debug, Serialize)]
pub struct BackupPreview {
    /// Names the open session, so a page left over from an earlier import
    /// cannot act on this one.
    pub session_id: String,
    pub created_at: i64,
    pub source_device: String,
    pub app_version: String,
    pub document_count: usize,
    pub attachment_count: usize,
    /// Images in the backup that this device does not hold.
    pub new_attachment_count: usize,
    pub theme: Option<String>,
    /// Every document, tombstones included, shaped as this device's own sync
    /// manifest is, so the import can decide about each one by the same
    /// rules a peer's manifest is decided by.
    pub documents: Vec<DocSyncEntry>,
}

/// Let the user pick a backup, check all of it, and open it for import.
///
/// Returns `None` when the user cancels. Opening one closes any backup that
/// was already open.
#[tauri::command]
pub async fn open_local_backup(
    app: AppHandle,
    state: State<'_, AppState>,
    backup: State<'_, BackupState>,
) -> Result<Option<BackupPreview>, String> {
    let dialog = app.dialog().file();
    // Only desktop filters. Android matches by MIME type, and file managers
    // disagree about what a zip's is, so a filter there can make a backup
    // impossible to pick. The reader is what decides what the file is.
    #[cfg(desktop)]
    let dialog = dialog.add_filter("Oyot backup", &["zip"]);
    let Some(source) = dialog.blocking_pick_file() else {
        return Ok(None);
    };
    // Not while the dialog is open, which can be for as long as the user
    // likes, but while the file is read in.
    let Some(_running) = Running::claim(&backup.running) else {
        return Err(BUSY.to_string());
    };

    let staging = staging_dir(&app)?;
    let handle = app.clone();
    let (reader, staged) = tauri::async_runtime::spawn_blocking(move || {
        let staged = StagedFile::new(&staging, "import")?;
        copy_in(&handle, &source, staged.path())?;
        let reader = BackupReader::open(staged.path())?;
        Ok::<_, String>((reader, staged))
    })
    .await
    .unwrap_or_else(|e| Err(format!("reading the backup stopped unexpectedly: {e}")))?;

    start_session(&state, &backup, reader, staged).map(Some)
}

/// Hold a checked backup open for import, replacing any that was open, and
/// describe it for the preview.
pub(super) fn start_session(
    state: &AppState,
    backup: &BackupState,
    reader: BackupReader,
    staged: StagedFile,
) -> Result<BackupPreview, String> {
    let held = {
        let db = state.db.lock();
        held_attachments(&db, &state.data_dir)?
    };
    let session_id = uuid::Uuid::new_v4().to_string();
    let preview = match preview_of(&reader, &held, &session_id) {
        Ok(preview) => preview,
        Err(e) => {
            // The reader first, then the file it holds open.
            drop(reader);
            return Err(e);
        }
    };
    *backup.import.lock() = Some(ImportSession {
        id: session_id,
        reader,
        _staged: staged,
    });
    Ok(preview)
}

/// Copy the picked file into staging, so the import reads a file nothing
/// else can change or remove while it runs.
fn copy_in(app: &AppHandle, source: &FilePath, staged: &Path) -> Result<(), String> {
    let mut input = match source {
        FilePath::Path(path) => File::open(path),
        FilePath::Url(_) => {
            use tauri_plugin_fs::{FsExt, OpenOptions};
            let mut options = OpenOptions::new();
            options.read(true);
            app.fs().open(source.clone(), options)
        }
    }
    .map_err(|e| format!("could not open the backup: {e}"))?;

    let mut output =
        File::create(staged).map_err(|e| format!("could not copy the backup in: {e}"))?;
    let copied = std::io::copy(
        &mut (&mut input).take(MAX_BACKUP_FILE_BYTES + 1),
        &mut output,
    )
    .map_err(|e| format!("could not copy the backup in: {e}"))?;
    if copied > MAX_BACKUP_FILE_BYTES {
        return Err("this file is larger than a backup can be".to_string());
    }
    Ok(())
}

fn preview_of(
    reader: &BackupReader,
    held: &std::collections::HashSet<String>,
    session_id: &str,
) -> Result<BackupPreview, String> {
    let manifest = reader.manifest();
    let documents = reader
        .documents()
        .iter()
        .map(|doc| {
            // The manifest's checksum of the state is the content hash; the
            // sync layer spells it in base64.
            let content_hash = reader
                .content_hash(&doc.id)
                .map(|hex| hex::decode(hex).map(|bytes| BASE64.encode(bytes)))
                .transpose()
                .map_err(|e| format!("this backup is damaged: {e}"))?;
            Ok(DocSyncEntry {
                id: doc.id.clone(),
                doc_type: doc.doc_type.clone(),
                title: doc.title.clone(),
                created_at: doc.created_at,
                updated_at: doc.updated_at,
                title_updated_at: doc.title_updated_at,
                is_deleted: doc.is_deleted,
                deleted_at: doc.deleted_at,
                lifecycle_updated_at: doc.lifecycle_updated_at,
                pinned: doc.pinned,
                pinned_updated_at: doc.pinned_updated_at,
                content_hash,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    let new_attachment_count = reader
        .attachment_hashes()
        .iter()
        .filter(|hash| !held.contains(*hash))
        .count();

    Ok(BackupPreview {
        session_id: session_id.to_string(),
        created_at: manifest.created_at,
        source_device: manifest.source_device.display_name.clone(),
        app_version: manifest.app_version.clone(),
        document_count: manifest.document_count,
        attachment_count: manifest.attachment_count,
        new_attachment_count,
        theme: reader.preferences().and_then(|p| p.theme.clone()),
        documents,
    })
}

fn open_session<'a>(
    slot: &'a mut Option<ImportSession>,
    session_id: &str,
) -> Result<&'a mut ImportSession, String> {
    match slot {
        Some(session) if session.id == session_id => Ok(session),
        _ => Err("this backup is no longer open. Open it again to import it.".to_string()),
    }
}

/// One document's Yjs state from the open backup, as base64, checked against
/// its checksum as it is read. `None` for a document with no content.
#[tauri::command]
pub fn backup_session_read_state(
    backup: State<'_, BackupState>,
    session_id: String,
    doc_id: String,
) -> Result<Option<String>, String> {
    let mut slot = backup.import.lock();
    let session = open_session(&mut slot, &session_id)?;
    Ok(session
        .reader
        .read_state(&doc_id)?
        .map(|bytes| BASE64.encode(bytes)))
}

#[derive(Debug, Default, Serialize)]
pub struct AttachmentImportResult {
    pub imported: usize,
    pub already_here: usize,
    pub failed: usize,
}

/// Store every image in the open backup that this device does not hold.
///
/// Done here rather than through the webview: the bytes go straight from the
/// archive into the attachment store, which holds them to their hash and
/// sniffs their type like any other way in. An open editor is told each one
/// arrived, exactly as for an image pulled from a peer.
#[tauri::command]
pub async fn backup_session_import_attachments(
    app: AppHandle,
    session_id: String,
) -> Result<AttachmentImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let backup = app.state::<BackupState>();
        let held = {
            let db = state.db.lock();
            held_attachments(&db, &state.data_dir)?
        };

        let mut slot = backup.import.lock();
        let session = open_session(&mut slot, &session_id)?;
        let mut result = AttachmentImportResult::default();
        for hash in session.reader.attachment_hashes() {
            if held.contains(&hash) {
                result.already_here += 1;
                continue;
            }
            match session
                .reader
                .read_attachment(&hash)
                .and_then(|bytes| store_checked_attachment(&state, &bytes))
            {
                Ok(_) => {
                    result.imported += 1;
                    let _ = app.emit("attachment-downloaded", AttachmentDownloadedEvent { hash });
                }
                Err(e) => {
                    warn_log!("[backup] could not import {hash}: {e}");
                    result.failed += 1;
                }
            }
        }
        Ok(result)
    })
    .await
    .unwrap_or_else(|e| Err(format!("importing images stopped unexpectedly: {e}")))
}

/// Close the open backup and remove its staged copy. Closing one that is not
/// open is not an error: the page closes on every way out, including after a
/// failure that already closed it.
#[tauri::command]
pub fn close_backup_session(backup: State<'_, BackupState>, session_id: String) {
    let mut slot = backup.import.lock();
    if slot.as_ref().is_some_and(|s| s.id == session_id) {
        *slot = None;
    }
}

// --- status ------------------------------------------------------------------

#[tauri::command]
pub fn get_backup_status(
    state: State<'_, AppState>,
    backup: State<'_, BackupState>,
) -> Result<BackupStatus, String> {
    let mut status = {
        let db = state.db.lock();
        history::status(&db)?
    };
    status.running = backup.running.load(Ordering::Acquire);
    Ok(status)
}

#[tauri::command]
pub fn list_backup_history(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<BackupRecord>, String> {
    let db = state.db.lock();
    history::recent(&db, limit.unwrap_or(20).min(100))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> FilePath {
        FilePath::Url(s.parse().unwrap())
    }

    #[test]
    fn names_a_chosen_file_from_its_path() {
        let path = FilePath::Path(PathBuf::from(
            "/home/me/Backups/oyot-backup-2026-09-23-1530.zip",
        ));
        assert_eq!(
            file_label(&path).as_deref(),
            Some("oyot-backup-2026-09-23-1530.zip")
        );
    }

    #[test]
    fn names_a_chosen_file_from_an_android_content_uri() {
        let uri = url("content://com.android.externalstorage.documents/document/\
             primary%3ADownload%2Foyot-backup-2026-09-23-1530.zip");
        assert_eq!(
            file_label(&uri).as_deref(),
            Some("oyot-backup-2026-09-23-1530.zip")
        );
    }

    #[test]
    fn falls_back_when_a_uri_names_nothing_readable() {
        let opaque =
            url("content://com.google.android.apps.docs.storage/document/acc%3D1%3Bdoc%3D42");
        assert_eq!(file_label(&opaque), None);
    }

    #[test]
    fn delivers_by_renaming_a_whole_copy_over_the_destination() {
        let dir = crate::backup::test_support::scratch();
        let staged = dir.join("staged.zip");
        std::fs::write(&staged, b"the new backup").unwrap();
        let destination = dir.join("backup.zip");
        std::fs::write(&destination, b"an older backup").unwrap();

        deliver_to_path(&staged, &destination).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"the new backup");
        assert!(!partial_path(&destination).exists());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_failed_delivery_leaves_the_destination_and_no_partial_file() {
        let dir = crate::backup::test_support::scratch();
        let destination = dir.join("backup.zip");
        std::fs::write(&destination, b"an older backup").unwrap();

        // Nothing staged to copy.
        assert!(deliver_to_path(&dir.join("missing.zip"), &destination).is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), b"an older backup");
        assert!(!partial_path(&destination).exists());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_new_file_never_replaces_one_already_there() {
        let dir = crate::backup::test_support::scratch();
        let staged = dir.join("staged.zip");
        std::fs::write(&staged, b"the new backup").unwrap();

        let fresh = dir.join("fresh.zip");
        deliver_new(&staged, &fresh).unwrap();
        assert_eq!(std::fs::read(&fresh).unwrap(), b"the new backup");
        assert!(!partial_path(&fresh).exists());

        let taken = dir.join("taken.zip");
        std::fs::write(&taken, b"another device's backup").unwrap();
        assert!(deliver_new(&staged, &taken).is_err());
        assert_eq!(std::fs::read(&taken).unwrap(), b"another device's backup");
        assert!(!partial_path(&taken).exists());

        // Nor one mid-write, whose partial file is not shared, and is left
        // as it was.
        let busy = dir.join("busy.zip");
        std::fs::write(partial_path(&busy), b"half of something").unwrap();
        assert!(deliver_new(&staged, &busy).is_err());
        assert!(!busy.exists());
        assert_eq!(
            std::fs::read(partial_path(&busy)).unwrap(),
            b"half of something"
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_failed_save_names_the_file_not_where_it_is() {
        let dir = crate::backup::test_support::scratch();
        let error = deliver_to_path(&dir.join("missing.zip"), &dir.join("backup.zip")).unwrap_err();
        assert!(error.contains("backup.zip"), "{error}");
        assert!(!error.contains(&dir.display().to_string()), "{error}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_one_backup_runs_at_a_time() {
        let flag = AtomicBool::new(false);
        let first = Running::claim(&flag).unwrap();
        assert!(Running::claim(&flag).is_none());
        drop(first);
        assert!(Running::claim(&flag).is_some());
    }
}

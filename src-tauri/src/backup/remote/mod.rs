//! Backing up to somewhere other than this device (ADR 0025).
//!
//! A remote destination is a `BackupProvider`, and nothing outside this module
//! knows which one it is: the archive is built and checked exactly as for a
//! file on disk, the commands take a provider's id, and the settings page
//! lists whatever `Providers` holds. Adding a service is one implementation
//! and one line in `Providers::for_this_build`.

#[cfg(desktop)]
pub mod google_drive;
#[cfg(desktop)]
pub mod http;
#[cfg(desktop)]
pub mod oauth;
#[cfg(desktop)]
pub mod secrets;

use async_trait::async_trait;
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;

/// The account a provider is linked to, as the settings page shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Account {
    pub email: String,
    pub name: Option<String>,
}

/// A backup stored with a provider, described from what was recorded with it
/// on upload, so a list needs no download.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemoteBackup {
    /// The provider's own id for the file.
    pub id: String,
    pub name: String,
    pub size: Option<u64>,
    /// When the backup was taken, in epoch milliseconds.
    pub created_at: i64,
    /// The device that took it.
    pub device: Option<String>,
    pub document_count: Option<u64>,
    pub attachment_count: Option<u64>,
}

/// What is recorded alongside an uploaded backup.
#[derive(Debug, Clone)]
pub struct UploadMeta {
    pub file_name: String,
    pub created_at: i64,
    pub device: String,
    pub document_count: usize,
    pub attachment_count: usize,
}

/// Bytes done so far, and the total when it is known (0 when it is not).
pub type Progress<'a> = &'a (dyn Fn(u64, u64) + Send + Sync);

/// How a provider asks the user to sign in: by having this address opened in
/// their browser.
pub type OpenUrl<'a> = &'a (dyn Fn(&str) -> Result<(), String> + Send + Sync);

/// Sent by the user giving up on linking, or dropped when a newer attempt
/// replaces this one.
pub type Cancel = tokio::sync::oneshot::Receiver<()>;

#[async_trait]
pub trait BackupProvider: Send + Sync {
    /// Stable, used by the commands and recorded in the history.
    fn id(&self) -> &'static str;

    /// What the settings page calls it.
    fn name(&self) -> &'static str;

    /// The linked account, or `None` when nothing is linked. Answered from
    /// this device, without asking the service.
    async fn account(&self) -> Result<Option<Account>, String>;

    /// Link an account. The user signs in in their browser; this resolves
    /// when they finish, and fails when they decline, give up, or `cancel`
    /// fires.
    async fn link(&self, open_url: OpenUrl<'_>, cancel: Cancel) -> Result<Account, String>;

    /// Forget the account on this device and withdraw this app's access to
    /// it. Backups already stored there stay where they are.
    async fn unlink(&self) -> Result<(), String>;

    async fn upload(
        &self,
        file: &Path,
        meta: &UploadMeta,
        progress: Progress<'_>,
    ) -> Result<RemoteBackup, String>;

    /// Every backup this app has stored there, newest first.
    async fn list(&self) -> Result<Vec<RemoteBackup>, String>;

    /// Download one backup to `to`, refusing it past `limit` bytes.
    async fn download(
        &self,
        id: &str,
        to: &Path,
        limit: u64,
        progress: Progress<'_>,
    ) -> Result<(), String>;

    /// Remove one backup. Where the service has a bin, it goes there, and
    /// the user can take it back out. One that is already gone is not an
    /// error: gone is what was asked for.
    async fn delete(&self, id: &str) -> Result<(), String>;

    /// Remove one backup for good, past any bin. For pruning old scheduled
    /// backups, which would otherwise go on filling the user's storage from
    /// the bin. One that is already gone is not an error.
    async fn purge(&self, id: &str) -> Result<(), String>;
}

/// The providers this build can use.
#[derive(Default)]
pub struct Providers {
    list: Vec<Arc<dyn BackupProvider>>,
}

impl Providers {
    /// Every provider whose credentials were compiled into this build. A
    /// build without them simply offers backups to disk (ADR 0025,
    /// decision 1).
    pub fn for_this_build() -> Self {
        #[allow(unused_mut)]
        let mut list: Vec<Arc<dyn BackupProvider>> = Vec::new();
        #[cfg(desktop)]
        if let Some(drive) = google_drive::GoogleDrive::from_build() {
            list.push(Arc::new(drive));
        }
        Providers { list }
    }

    pub fn all(&self) -> &[Arc<dyn BackupProvider>] {
        &self.list
    }

    pub fn get(&self, id: &str) -> Result<Arc<dyn BackupProvider>, String> {
        self.list
            .iter()
            .find(|p| p.id() == id)
            .cloned()
            .ok_or_else(|| format!("this build of Oyot cannot back up to {id:?}"))
    }
}

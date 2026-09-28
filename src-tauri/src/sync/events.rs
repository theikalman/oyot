//! What the engine tells the page (ADR 0031, decisions 5, 7 and 9).
//!
//! The engine does not know whether a page is there. Under Tauri, `TauriEvents`
//! emits these to it; in a phone's background run there is none, and every
//! method falls through to doing nothing (ADR 0031, decision 8).

use super::protocol::ManifestEntry;

pub trait Events: Send + Sync {
    /// A peer created a document, or revived one this device had deleted.
    fn doc_created(&self, _entry: &ManifestEntry) {}
    fn doc_renamed(&self, _id: &str, _title: &str, _title_updated_at: i64) {}
    fn doc_pinned(&self, _id: &str, _pinned: bool, _pinned_updated_at: i64) {}
    fn doc_deleted(&self, _id: &str) {}
    /// A peer's update was merged into a document's stored state. The page
    /// applies it to the open copy, if it has one, and re-indexes it.
    fn doc_merged(&self, _id: &str, _update: &[u8]) {}
    fn attachment_downloaded(&self, _hash: &str) {}
}

/// No page to tell: a background run, and tests that do not listen.
pub struct NoEvents;

impl Events for NoEvents {}

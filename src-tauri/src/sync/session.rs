//! One connection's share of whole-set sync (ADR 0003), ported from
//! `DocSyncProtocol.ts`.
//!
//! Sans-IO: a session is handed messages and the time, and hands back what
//! to send and what to report. It never touches a socket or a clock, so two
//! of them can be run against each other in a test, timeouts included.
//!
//! What carried over unchanged (ADR 0031, decision 2): the two phases, the
//! live messages, the attachment exchange, four document pulls and two
//! images in flight, the timeouts and retry counts, and every `sync-need`
//! getting an answer (ADR 0006). What changed:
//!
//! - **`sync-complete`.** `sync-done` only says a side has decided what to
//!   pull. A side now also says when it has pulled it all, and a connection
//!   is synced only when both have, so a background run cannot stop while
//!   the other side is still pulling (ADR 0034).
//! - **Image pieces.** An image arrives in pieces (ADR 0032, decision 7),
//!   and every piece moves its deadline on, so a slow link that keeps
//!   delivering is not given up on halfway.

use super::protocol::{pin_stamp, AttachmentEntry, ManifestEntry, Message};
use super::reconcile::{reconcile, Reconciliation};
use std::collections::{HashMap, VecDeque};

/// Document pulls in flight at once, so a peer with hundreds of divergent
/// documents does not balloon memory or the send queue.
pub const MAX_IN_FLIGHT: usize = 4;
/// A `sync-need` with no answer in this long is retried once, then dropped;
/// the next connection's manifest picks it up.
pub const NEED_TIMEOUT_MS: i64 = 20_000;
const MAX_NEED_ATTEMPTS: u32 = 2;

pub const MAX_ATTACH_IN_FLIGHT: usize = 2;
/// How long to wait for an image, before its size is taken into account.
pub const ATTACH_TIMEOUT_MS: i64 = 30_000;
/// The slowest rate worth waiting through, in bytes per millisecond (50 KB/s).
const SLOWEST_USEFUL_RATE: u64 = 50;
const MAX_ATTACH_ATTEMPTS: u32 = 2;
/// The size of one piece of an image on the wire.
pub const PIECE_BYTES: usize = 256 * 1024;
/// The largest image this app stores (`commands::attachments::MAX_IMAGE_BYTES`).
/// A piece claiming a larger whole is refused before anything is buffered.
const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

/// Everything a session reads and changes. The app's is the database
/// (`repo.rs`); the tests' is in memory.
pub trait Repo {
    fn list_sync_state(&self) -> Result<Vec<ManifestEntry>, String>;
    /// A row for a document a peer has, created without content. Never
    /// changes a row that exists, except to clear a tombstone the peer has
    /// seen revived since.
    fn ensure_doc(&self, entry: &ManifestEntry) -> Result<(), String>;
    /// A peer's tombstone for a document this device never held.
    fn ensure_tombstone(&self, entry: &ManifestEntry) -> Result<(), String>;
    fn apply_rename(&self, id: &str, title: &str, at: i64) -> Result<bool, String>;
    fn apply_pin(&self, id: &str, pinned: bool, at: i64) -> Result<bool, String>;
    fn apply_delete(&self, id: &str, deleted_at: i64) -> Result<bool, String>;
    fn local_state_vector(&self, id: &str) -> Result<Vec<u8>, String>;
    /// What a peer at `sv` is missing; everything when `sv` is empty; `None`
    /// when that is nothing.
    fn compute_delta(&self, id: &str, sv: &[u8]) -> Result<Option<Vec<u8>>, String>;
    fn merge_delta(&self, id: &str, update: &[u8]) -> Result<(), String>;
    fn list_attachments(&self) -> Result<Vec<AttachmentEntry>, String>;
    fn has_attachment(&self, hash: &str) -> Result<bool, String>;
    fn read_attachment(&self, hash: &str) -> Result<Option<(String, Vec<u8>)>, String>;
    fn save_attachment(&self, hash: &str, mime: &str, bytes: &[u8]) -> Result<(), String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Reconciling,
    Transferring,
    Synced,
    Error,
}

/// What a session asks the connection to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Out {
    Send(Message),
    Phase(Phase),
    Progress {
        pending: usize,
        total: usize,
    },
    /// Both sides have everything they asked for.
    Synced {
        at: i64,
    },
}

#[derive(Debug)]
struct NeedItem {
    id: String,
    sv: Vec<u8>,
    attempts: u32,
}

// Carries its own attempt count, as NeedItem does. Counting attempts in the
// in-flight map did not work: a timeout removes the entry before requeueing,
// so the next read always missed and the count restarted at one.
#[derive(Debug)]
struct AttachItem {
    hash: String,
    attempts: u32,
    /// Bytes, as the peer's manifest announced them. Sets the deadline.
    size: Option<u64>,
}

#[derive(Debug)]
struct Incoming {
    mime: String,
    total: u64,
    bytes: Vec<u8>,
}

/// A flat 30 seconds gave a 10 MB photo the same budget as a thumbnail, so the
/// transfers that needed the time were the ones that timed out.
fn attach_timeout_for(size: Option<u64>) -> i64 {
    match size {
        Some(size) if size > 0 => ATTACH_TIMEOUT_MS.max(size.div_ceil(SLOWEST_USEFUL_RATE) as i64),
        _ => ATTACH_TIMEOUT_MS,
    }
}

#[derive(Debug, Default)]
pub struct Session {
    started: bool,
    local_done: bool,
    peer_done: bool,
    complete_sent: bool,
    peer_complete: bool,
    synced: bool,

    queue: VecDeque<NeedItem>,
    in_flight: HashMap<String, (NeedItem, i64)>,
    total: usize,
    settled: usize,

    attach_queue: VecDeque<AttachItem>,
    attach_in_flight: HashMap<String, (AttachItem, i64)>,
    incoming: HashMap<String, Incoming>,

    out: Vec<Out>,
}

impl Session {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether both sides have everything they asked for.
    pub fn is_synced(&self) -> bool {
        self.synced
    }

    /// Whether any image is still being fetched on this connection.
    pub fn has_images_pending(&self) -> bool {
        !self.attach_queue.is_empty() || !self.attach_in_flight.is_empty()
    }

    /// The earliest moment `tick` has something to do.
    pub fn next_deadline(&self) -> Option<i64> {
        self.in_flight
            .values()
            .map(|(_, at)| *at)
            .chain(self.attach_in_flight.values().map(|(_, at)| *at))
            .min()
    }

    /// Open the exchange: this device's manifest, and its images.
    pub fn start(&mut self, repo: &dyn Repo, _now: i64) -> Vec<Out> {
        if self.started {
            return Vec::new();
        }
        self.started = true;
        self.out.push(Out::Phase(Phase::Reconciling));
        match repo.list_sync_state() {
            Ok(docs) => self.send(Message::SyncManifest { docs }),
            Err(e) => {
                warn_log!("[sync] failed to send manifest: {e}");
                self.out.push(Out::Phase(Phase::Error));
            }
        }
        match repo.list_attachments() {
            Ok(items) if !items.is_empty() => self.send(Message::AttachManifest { items }),
            Ok(_) => {}
            Err(e) => warn_log!("[sync] failed to send attachment manifest: {e}"),
        }
        self.take()
    }

    pub fn handle(&mut self, repo: &dyn Repo, msg: Message, now: i64) -> Vec<Out> {
        match msg {
            Message::SyncManifest { docs } => self.on_manifest(repo, docs, now),
            Message::SyncNeed { id, sv } => self.on_need(repo, id, &sv),
            Message::SyncDelta { id, update } => self.on_delta(repo, &id, &update, now),
            Message::SyncNone { id } => self.on_none(&id, now),
            Message::SyncDone => {
                self.peer_done = true;
                self.maybe_finish(now);
            }
            Message::SyncComplete => {
                self.peer_complete = true;
                self.maybe_finish(now);
            }
            Message::DocCreated { entry } => {
                // Doubles as the revival signal: ensure_doc clears a local
                // tombstone the peer has seen revived since.
                if let Err(e) = repo.ensure_doc(&entry) {
                    warn_log!("[sync] could not record {}: {e}", entry.id);
                }
                // Pulled out of band, not counted against the finish gate.
                self.send(Message::SyncNeed {
                    id: entry.id,
                    sv: Vec::new(),
                });
            }
            Message::DocRenamed {
                id,
                title,
                title_updated_at,
            } => log_err(repo.apply_rename(&id, &title, title_updated_at), &id),
            Message::DocPinned {
                id,
                pinned,
                pinned_updated_at,
            } => log_err(repo.apply_pin(&id, pinned, pinned_updated_at), &id),
            Message::DocDeleted { id, deleted_at } => {
                log_err(repo.apply_delete(&id, deleted_at), &id)
            }
            Message::LiveUpdate { id, update } => {
                if let Err(e) = repo.merge_delta(&id, &update) {
                    warn_log!("[sync] live-update merge failed for {id}: {e}");
                }
            }
            Message::AttachManifest { items } => self.on_attach_manifest(repo, items, now),
            Message::AttachNeed { hash } => self.on_attach_need(repo, hash),
            Message::AttachPiece {
                hash,
                mime,
                offset,
                total,
                data,
            } => self.on_attach_piece(repo, hash, mime, offset, total, data, now),
            Message::AttachMissing { hash } => {
                self.incoming.remove(&hash);
                self.attach_in_flight.remove(&hash);
                self.attach_pump(now);
            }
            // The connection's business, not the exchange's.
            Message::Heartbeat
            | Message::PairRequest { .. }
            | Message::PairAccepted { .. }
            | Message::PairDeclined => {}
        }
        self.take()
    }

    /// Retry or give up on whatever has waited too long.
    pub fn tick(&mut self, now: i64) -> Vec<Out> {
        let late: Vec<String> = self
            .in_flight
            .iter()
            .filter(|(_, (_, at))| *at <= now)
            .map(|(id, _)| id.clone())
            .collect();
        for id in late {
            let Some((item, _)) = self.in_flight.remove(&id) else {
                continue;
            };
            if item.attempts < MAX_NEED_ATTEMPTS {
                self.queue.push_back(item);
                self.pump(now);
            } else {
                warn_log!(
                    "[sync] gave up pulling {id} after {} attempts",
                    item.attempts
                );
                self.settle(now);
            }
        }

        let late: Vec<String> = self
            .attach_in_flight
            .iter()
            .filter(|(_, (_, at))| *at <= now)
            .map(|(hash, _)| hash.clone())
            .collect();
        for hash in late {
            let Some((item, _)) = self.attach_in_flight.remove(&hash) else {
                continue;
            };
            if item.attempts < MAX_ATTACH_ATTEMPTS {
                self.attach_queue.push_back(item);
            } else {
                warn_log!(
                    "[sync] gave up pulling attachment {hash} after {} attempts",
                    item.attempts
                );
            }
        }
        self.attach_pump(now);
        self.take()
    }

    // --- phase 1 ---------------------------------------------------------

    fn on_manifest(&mut self, repo: &dyn Repo, remote: Vec<ManifestEntry>, now: i64) {
        let local: HashMap<String, ManifestEntry> = match repo.list_sync_state() {
            Ok(rows) => rows.into_iter().map(|e| (e.id.clone(), e)).collect(),
            Err(e) => {
                warn_log!("[sync] could not read this device's manifest: {e}");
                self.out.push(Out::Phase(Phase::Error));
                return;
            }
        };
        for entry in &remote {
            if let Err(e) = self.reconcile_entry(repo, entry, local.get(&entry.id)) {
                warn_log!("[sync] reconcile failed for {}: {e}", entry.id);
            }
        }

        self.total = self.queue.len() + self.in_flight.len();
        self.settled = 0;
        self.report_progress();
        self.pump(now);

        self.local_done = true;
        self.send(Message::SyncDone);
        self.maybe_finish(now);
    }

    fn reconcile_entry(
        &mut self,
        repo: &dyn Repo,
        entry: &ManifestEntry,
        local: Option<&ManifestEntry>,
    ) -> Result<(), String> {
        match reconcile(entry, local) {
            Reconciliation::RecordTombstone => repo.ensure_tombstone(entry)?,
            Reconciliation::Delete { deleted_at } => {
                repo.apply_delete(&entry.id, deleted_at)?;
            }
            Reconciliation::Create | Reconciliation::Revive => {
                repo.ensure_doc(entry)?;
                self.enqueue(entry.id.clone(), Vec::new());
            }
            Reconciliation::Update {
                rename,
                repin,
                pull,
            } => {
                if rename {
                    repo.apply_rename(&entry.id, &entry.title, entry.title_updated_at)?;
                }
                if repin {
                    repo.apply_pin(&entry.id, entry.pinned.unwrap_or(false), pin_stamp(entry))?;
                }
                if pull {
                    let sv = repo.local_state_vector(&entry.id)?;
                    self.enqueue(entry.id.clone(), sv);
                }
            }
            Reconciliation::StaleTombstone
            | Reconciliation::StaysDeleted
            | Reconciliation::UpToDate => {}
        }
        Ok(())
    }

    // --- phase 2 ---------------------------------------------------------

    fn enqueue(&mut self, id: String, sv: Vec<u8>) {
        if self.in_flight.contains_key(&id) || self.queue.iter().any(|q| q.id == id) {
            return;
        }
        self.queue.push_back(NeedItem {
            id,
            sv,
            attempts: 0,
        });
    }

    fn pump(&mut self, now: i64) {
        while self.in_flight.len() < MAX_IN_FLIGHT {
            let Some(mut item) = self.queue.pop_front() else {
                break;
            };
            item.attempts += 1;
            self.send(Message::SyncNeed {
                id: item.id.clone(),
                sv: item.sv.clone(),
            });
            self.in_flight
                .insert(item.id.clone(), (item, now + NEED_TIMEOUT_MS));
        }
    }

    fn on_need(&mut self, repo: &dyn Repo, id: String, sv: &[u8]) {
        match repo.compute_delta(&id, sv) {
            Ok(Some(update)) => self.send(Message::SyncDelta { id, update }),
            Ok(None) => self.send(Message::SyncNone { id }),
            Err(e) => {
                // Still answer, so the asker does not wait out its timeouts.
                warn_log!("[sync] computeDelta failed for {id}: {e}");
                self.send(Message::SyncNone { id });
            }
        }
    }

    fn on_none(&mut self, id: &str, now: i64) {
        if self.in_flight.remove(id).is_some() {
            self.settle(now);
        } else {
            self.pump(now);
        }
    }

    fn on_delta(&mut self, repo: &dyn Repo, id: &str, update: &[u8], now: i64) {
        let tracked = self.in_flight.remove(id).is_some();
        if let Err(e) = repo.merge_delta(id, update) {
            warn_log!("[sync] mergeDelta failed for {id}: {e}");
        }
        if tracked {
            self.settle(now);
        } else {
            self.pump(now);
        }
    }

    fn settle(&mut self, now: i64) {
        self.settled += 1;
        self.report_progress();
        self.pump(now);
        self.maybe_finish(now);
    }

    // --- images ----------------------------------------------------------

    fn is_attach_tracked(&self, hash: &str) -> bool {
        self.attach_in_flight.contains_key(hash) || self.attach_queue.iter().any(|q| q.hash == hash)
    }

    fn on_attach_manifest(&mut self, repo: &dyn Repo, items: Vec<AttachmentEntry>, now: i64) {
        for item in items {
            if self.is_attach_tracked(&item.hash) {
                continue;
            }
            match repo.has_attachment(&item.hash) {
                Ok(true) => continue,
                Ok(false) => {}
                Err(e) => {
                    warn_log!("[sync] hasAttachment({}) failed: {e}", item.hash);
                    continue;
                }
            }
            self.attach_queue.push_back(AttachItem {
                hash: item.hash,
                attempts: 0,
                size: Some(item.size),
            });
        }
        self.attach_pump(now);
    }

    /// Pull one image now: a peer has just said it holds one this device lacks.
    pub fn request_attachment(&mut self, hash: String, now: i64) -> Vec<Out> {
        if !self.is_attach_tracked(&hash) {
            self.attach_queue.push_back(AttachItem {
                hash,
                attempts: 0,
                size: None,
            });
            self.attach_pump(now);
        }
        self.take()
    }

    fn attach_pump(&mut self, now: i64) {
        while self.attach_in_flight.len() < MAX_ATTACH_IN_FLIGHT {
            let Some(mut item) = self.attach_queue.pop_front() else {
                break;
            };
            item.attempts += 1;
            self.send(Message::AttachNeed {
                hash: item.hash.clone(),
            });
            let deadline = now + attach_timeout_for(item.size);
            self.attach_in_flight
                .insert(item.hash.clone(), (item, deadline));
        }
    }

    fn on_attach_need(&mut self, repo: &dyn Repo, hash: String) {
        match repo.read_attachment(&hash) {
            Ok(Some((mime, bytes))) => {
                let total = bytes.len() as u64;
                if bytes.is_empty() {
                    self.send(Message::AttachPiece {
                        hash,
                        mime,
                        offset: 0,
                        total,
                        data: Vec::new(),
                    });
                    return;
                }
                for (i, chunk) in bytes.chunks(PIECE_BYTES).enumerate() {
                    self.send(Message::AttachPiece {
                        hash: hash.clone(),
                        mime: mime.clone(),
                        offset: (i * PIECE_BYTES) as u64,
                        total,
                        data: chunk.to_vec(),
                    });
                }
            }
            Ok(None) => self.send(Message::AttachMissing { hash }),
            Err(e) => {
                warn_log!("[sync] readAttachment({hash}) failed: {e}");
                self.send(Message::AttachMissing { hash });
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn on_attach_piece(
        &mut self,
        repo: &dyn Repo,
        hash: String,
        mime: String,
        offset: u64,
        total: u64,
        data: Vec<u8>,
        now: i64,
    ) {
        if total > MAX_IMAGE_BYTES {
            warn_log!("[sync] refusing attachment {hash}: {total} bytes is over the limit");
            self.incoming.remove(&hash);
            self.attach_in_flight.remove(&hash);
            self.attach_pump(now);
            return;
        }
        if offset == 0 {
            // A transfer starting, or starting over after a retry.
            self.incoming.insert(
                hash.clone(),
                Incoming {
                    mime,
                    total,
                    bytes: Vec::with_capacity(total as usize),
                },
            );
        }
        let Some(incoming) = self.incoming.get_mut(&hash) else {
            // A piece of a transfer this side did not see start. The retry, or
            // the next connection, fetches the image whole.
            return;
        };
        if incoming.total != total || incoming.bytes.len() as u64 != offset {
            warn_log!("[sync] attachment {hash} arrived out of order, waiting for a retry");
            self.incoming.remove(&hash);
            return;
        }
        incoming.bytes.extend_from_slice(&data);
        // Pieces arriving is progress: the deadline follows them.
        if let Some((_, deadline)) = self.attach_in_flight.get_mut(&hash) {
            *deadline = now + ATTACH_TIMEOUT_MS;
        }
        if (incoming.bytes.len() as u64) < total {
            return;
        }

        let done = self.incoming.remove(&hash).expect("present above");
        self.attach_in_flight.remove(&hash);
        if let Err(e) = repo.save_attachment(&hash, &done.mime, &done.bytes) {
            warn_log!("[sync] saveAttachment({hash}) failed: {e}");
        }
        self.attach_pump(now);
    }

    // --- progress and completion -----------------------------------------

    fn report_progress(&mut self) {
        let pending = self.total.saturating_sub(self.settled);
        self.out.push(Out::Progress {
            pending,
            total: self.total,
        });
        if self.total > 0 && pending > 0 {
            self.out.push(Out::Phase(Phase::Transferring));
        }
    }

    fn maybe_finish(&mut self, now: i64) {
        if !self.local_done || !self.peer_done {
            return;
        }
        if !self.queue.is_empty() || !self.in_flight.is_empty() {
            return;
        }
        if !self.complete_sent {
            self.complete_sent = true;
            self.send(Message::SyncComplete);
        }
        if self.peer_complete && !self.synced {
            self.synced = true;
            self.out.push(Out::Phase(Phase::Synced));
            self.out.push(Out::Synced { at: now });
        }
    }

    fn send(&mut self, msg: Message) {
        self.out.push(Out::Send(msg));
    }

    fn take(&mut self) -> Vec<Out> {
        std::mem::take(&mut self.out)
    }
}

fn log_err<T>(result: Result<T, String>, id: &str) {
    if let Err(e) = result {
        warn_log!("[sync] could not apply a change to {id}: {e}");
    }
}

#[cfg(test)]
mod tests;

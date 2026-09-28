//! Connections to paired devices, for the life of the process (ADR 0031,
//! decision 1; ADR 0032).
//!
//! - **One connection per device pair,** dialled by whichever device can
//!   reach the other: at start, when a device is found, after a wake or a
//!   network change, and after a drop on a backoff from one to thirty seconds.
//! - **Two connections at once** (both dialled): the one dialled by the lower
//!   node_id is kept, so both sides keep the same one, unless the existing one
//!   has gone quiet, in which case it is probably dead and the new one wins.
//!   A connection counts once the other side's first frame arrives, since in
//!   TLS 1.3 the dialler finishes its handshake before the listener has
//!   checked its key.
//! - **On each connection:** notes before images, a heartbeat after 20
//!   seconds with nothing else to send, and dropped after 60 seconds without
//!   a byte.
//! - **Pairing** happens inside TLS: an unpaired device may send one pair
//!   request and nothing else, and the answer goes back on the same
//!   connection, which then carries on as the pair's sync connection.
//! - **Disconnect** is stored, and a disconnected device is neither dialled
//!   nor let in until the user reconnects it.

use super::events::{Events, PeerState};
use super::frame::{self, Activity, ActivityReader};
use super::protocol::Message;
use super::repo::SqliteRepo;
use super::session::{Out, Phase, Session};
use super::tls;
use crate::crypto::now_ms;
use crate::network::peers::Peers;
use crate::network::signaling_manager::allow_pair_prompt;
use crate::pairing;
use ed25519_dalek::SigningKey;
use parking_lot::Mutex;
use rusqlite::Connection;
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, Notify};
use tokio_rustls::{TlsAcceptor, TlsConnector};

/// Send a heartbeat after this long with nothing else to send.
pub const HEARTBEAT_AFTER_MS: u64 = 20_000;
/// Drop a connection that has received no bytes for this long.
pub const DEAD_AFTER_MS: i64 = 60_000;
/// An existing connection that heard from its device this recently is alive,
/// and a second connection is the two devices dialling at once.
const DUPLICATE_WINDOW_MS: i64 = 5_000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// How long an unpaired device has to send its pair request.
const PAIR_REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a pair request waits for the user to answer it. The page gives
/// up on its own request after 90 seconds; this side waits a little longer.
const PAIR_ANSWER_TIMEOUT: Duration = Duration::from_secs(100);
const RECONNECT_BASE_MS: u64 = 1_000;
const RECONNECT_MAX_MS: u64 = 30_000;
/// How often a connection wakes when nothing else wakes it.
const TICK: Duration = Duration::from_secs(1);

/// The backoff before reconnect attempt `attempt` (from zero), plus jitter, as
/// the webview's `reconnectDelay` was: without jitter, two devices that
/// dropped together retry in lockstep, and every retry is a fresh collision.
pub fn reconnect_delay_ms(attempt: u32, jitter_ms: u64) -> u64 {
    let exponential = RECONNECT_BASE_MS.saturating_mul(1u64 << attempt.min(16));
    exponential.min(RECONNECT_MAX_MS) + jitter_ms
}

/// Which of two connections to one device to keep, given who dialled each
/// and whether the existing one has heard from its device lately. True keeps
/// the new one.
pub fn keep_new_connection(
    lower_node_id: &str,
    existing_dialled_by: &str,
    new_dialled_by: &str,
    existing_alive: bool,
) -> bool {
    if !existing_alive {
        return true;
    }
    // Both dialled at once. Keep the one the lower node_id dialled, which
    // both sides work out the same way.
    new_dialled_by == lower_node_id && existing_dialled_by != lower_node_id
}

/// This device, as the engine needs it.
pub struct Me {
    pub node_id: String,
    pub user_id: String,
    pub display_name: Mutex<String>,
    pub signing: SigningKey,
}

enum Cmd {
    Send(Message),
    RequestAttachment(String),
    Close,
}

struct Conn {
    id: u64,
    /// The node_id of the device that dialled this connection.
    dialled_by: String,
    commands: mpsc::UnboundedSender<Cmd>,
    activity: Activity,
    synced: bool,
    images_pending: bool,
}

struct PendingPair {
    respond: oneshot::Sender<bool>,
}

#[derive(Default)]
struct State {
    running: bool,
    conns: HashMap<String, Conn>,
    dialling: HashSet<String>,
    attempts: HashMap<String, u32>,
    status: HashMap<String, PeerState>,
    pending_pairs: HashMap<String, PendingPair>,
    prompts: Vec<(String, i64)>,
    found_task: Option<tokio::task::JoinHandle<()>>,
}

struct Inner {
    db: Arc<Mutex<Connection>>,
    data_dir: PathBuf,
    events: Arc<dyn Events>,
    me: Me,
    peers: Arc<Peers>,
    state: Mutex<State>,
    ids: AtomicU64,
    /// Woken whenever a connection's state changes, for `run_once`.
    changed: Notify,
}

/// Who a connection is with, as the pair table has them.
#[derive(Clone)]
struct PeerInfo {
    node_id: String,
    display_name: String,
    room_id: String,
}

#[derive(Clone)]
pub struct SyncManager {
    inner: Arc<Inner>,
}

/// What a bounded run did (ADR 0034, decision 7).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunReport {
    /// Devices a connection was made with.
    pub reached: Vec<String>,
    /// Devices that got to synced both ways before the run ended.
    pub synced: Vec<String>,
    pub timed_out: bool,
}

impl SyncManager {
    pub fn new(
        db: Arc<Mutex<Connection>>,
        data_dir: PathBuf,
        events: Arc<dyn Events>,
        me: Me,
        peers: Arc<Peers>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                db,
                data_dir,
                events,
                me,
                peers,
                state: Mutex::new(State::default()),
                ids: AtomicU64::new(1),
                changed: Notify::new(),
            }),
        }
    }

    pub fn node_id(&self) -> &str {
        &self.inner.me.node_id
    }

    pub fn set_display_name(&self, name: &str) {
        *self.inner.me.display_name.lock() = name.to_string();
    }

    /// Keep connections to every paired device this device can reach, and
    /// dial whichever is found next. For the foreground (ADR 0031, decision 1).
    pub fn start(&self) {
        let mut found = self.inner.peers.subscribe();
        let manager = self.clone();
        let task = tokio::spawn(async move {
            loop {
                match found.recv().await {
                    Ok(node_id) => manager.dial(&node_id),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => manager.sweep(),
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        {
            let mut state = self.inner.state.lock();
            state.running = true;
            if let Some(old) = state.found_task.replace(task) {
                old.abort();
            }
        }
        self.sweep();
    }

    /// Close everything and stop reconnecting.
    pub fn stop(&self) {
        let conns: Vec<mpsc::UnboundedSender<Cmd>> = {
            let mut state = self.inner.state.lock();
            state.running = false;
            if let Some(task) = state.found_task.take() {
                task.abort();
            }
            state.conns.values().map(|c| c.commands.clone()).collect()
        };
        for commands in conns {
            let _ = commands.send(Cmd::Close);
        }
    }

    /// Dial every paired, connected-by-choice device that is not connected.
    pub fn sweep(&self) {
        for pair in self.inner.pairs() {
            if !pair.disconnected {
                self.dial(&pair.peer_node_id);
            }
        }
    }

    /// Dial one device, if it is paired, not disconnected, reachable, and not
    /// connected or being dialled already.
    pub fn dial(&self, node_id: &str) {
        start_dial(&self.inner, node_id);
    }

    /// A connection arrived on the shared listener starting with a TLS
    /// handshake (ADR 0032, decision 3).
    pub fn accept(&self, stream: TcpStream) {
        let inner = self.inner.clone();
        tokio::spawn(async move { accept(inner, stream).await });
    }

    /// Ask `node_id` to pair. Returns once the request is on its way; the
    /// answer comes through `Events::pair_answered`.
    pub async fn request_pair(&self, node_id: &str) -> Result<(), String> {
        request_pair(self.inner.clone(), node_id.to_string()).await
    }

    /// Answer a pending pair request from `node_id`.
    pub fn answer_pair(&self, node_id: &str, accept: bool) -> Result<(), String> {
        let pending = self.inner.state.lock().pending_pairs.remove(node_id);
        let pending =
            pending.ok_or_else(|| "that pair request is no longer waiting".to_string())?;
        let _ = pending.respond.send(accept);
        Ok(())
    }

    /// Close the connection to `node_id`, and refuse it until the user
    /// reconnects it. Stored, so it outlasts a restart (ADR 0032, decision 10).
    pub fn disconnect(&self, node_id: &str) -> Result<(), String> {
        {
            let db = self.inner.db.lock();
            pairing::set_disconnected(&db, &self.inner.me.user_id, node_id, true)?;
        }
        self.close(node_id);
        Ok(())
    }

    /// Lift a disconnect, and dial at once, skipping the backoff. A live
    /// connection is left alone (ADR 0004, decision 1).
    pub fn reconnect(&self, node_id: &str) -> Result<(), String> {
        {
            let db = self.inner.db.lock();
            pairing::set_disconnected(&db, &self.inner.me.user_id, node_id, false)?;
        }
        self.inner.state.lock().attempts.remove(node_id);
        self.dial(node_id);
        Ok(())
    }

    /// Close the connection to a device that is no longer paired.
    pub fn forget(&self, node_id: &str) {
        self.close(node_id);
        self.inner.state.lock().status.remove(node_id);
    }

    fn close(&self, node_id: &str) {
        let commands = self
            .inner
            .state
            .lock()
            .conns
            .get(node_id)
            .map(|c| c.commands.clone());
        if let Some(commands) = commands {
            let _ = commands.send(Cmd::Close);
        }
    }

    /// Tell every connected device about a change made here.
    pub fn broadcast(&self, msg: Message) {
        let conns: Vec<mpsc::UnboundedSender<Cmd>> = self
            .inner
            .state
            .lock()
            .conns
            .values()
            .map(|c| c.commands.clone())
            .collect();
        for commands in conns {
            let _ = commands.send(Cmd::Send(msg.clone()));
        }
    }

    /// Ask every connected device for an image this device is missing.
    pub fn request_attachment(&self, hash: &str) {
        let conns: Vec<mpsc::UnboundedSender<Cmd>> = self
            .inner
            .state
            .lock()
            .conns
            .values()
            .map(|c| c.commands.clone())
            .collect();
        for commands in conns {
            let _ = commands.send(Cmd::RequestAttachment(hash.to_string()));
        }
    }

    /// Every paired device's connection, for a page that has just loaded.
    pub fn status(&self) -> Vec<PeerState> {
        let known = self.inner.state.lock().status.clone();
        self.inner
            .pairs()
            .into_iter()
            .map(|pair| {
                known
                    .get(&pair.peer_node_id)
                    .cloned()
                    .unwrap_or_else(|| idle_state(&pair))
            })
            .collect()
    }

    /// Whether a connection to `node_id` is up.
    pub fn is_connected(&self, node_id: &str) -> bool {
        self.inner.state.lock().conns.contains_key(node_id)
    }

    /// A bounded run, for a phone in the background (ADR 0034, decision 1):
    /// dial every paired device there is a route to, wait until each is
    /// synced both ways and has no images left to fetch, or until `budget`
    /// runs out, then close them all. Never listens.
    pub async fn run_once(&self, budget: Duration) -> RunReport {
        let deadline = tokio::time::Instant::now() + budget;
        let targets: Vec<String> = self
            .inner
            .pairs()
            .into_iter()
            .filter(|p| !p.disconnected && self.inner.peers.best(&p.peer_node_id).is_some())
            .map(|p| p.peer_node_id)
            .collect();
        for node_id in &targets {
            self.dial(node_id);
        }

        let mut report = RunReport::default();
        loop {
            let notified = self.inner.changed.notified();
            let (connected, done, dialling) = {
                let state = self.inner.state.lock();
                let connected: Vec<String> = targets
                    .iter()
                    .filter(|n| state.conns.contains_key(*n))
                    .cloned()
                    .collect();
                let done: Vec<String> = connected
                    .iter()
                    .filter(|n| {
                        state
                            .conns
                            .get(*n)
                            .is_some_and(|c| c.synced && !c.images_pending)
                    })
                    .cloned()
                    .collect();
                let dialling = targets.iter().any(|n| state.dialling.contains(n));
                (connected, done, dialling)
            };
            for node_id in &connected {
                if !report.reached.contains(node_id) {
                    report.reached.push(node_id.clone());
                }
            }
            for node_id in &done {
                if !report.synced.contains(node_id) {
                    report.synced.push(node_id.clone());
                }
            }
            // Finished when nothing is still dialling and every connection
            // that came up is done.
            if !dialling && done.len() == connected.len() {
                break;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                report.timed_out = true;
                break;
            }
        }
        for node_id in &targets {
            self.close(node_id);
        }
        report
    }
}

impl Inner {
    fn pairs(&self) -> Vec<pairing::DevicePair> {
        let db = self.db.lock();
        pairing::load_pairs(&db, &self.me.user_id).unwrap_or_else(|e| {
            warn_log!("[sync] could not read the pair table: {e}");
            Vec::new()
        })
    }

    fn pair(&self, node_id: &str) -> Option<pairing::DevicePair> {
        let db = self.db.lock();
        pairing::get_pair_by_node_id(&db, &self.me.user_id, node_id)
            .ok()
            .flatten()
    }

    fn is_disconnected(&self, node_id: &str) -> bool {
        let db = self.db.lock();
        pairing::is_disconnected(&db, &self.me.user_id, node_id).unwrap_or(false)
    }

    fn set_status(&self, node_id: &str, update: impl FnOnce(&mut PeerState)) {
        // Looked up before the state lock, so no database query runs under it.
        let Some(pair) = self.pair(node_id) else {
            return;
        };
        let state = {
            let mut guard = self.state.lock();
            let entry = guard
                .status
                .entry(node_id.to_string())
                .or_insert_with(|| idle_state(&pair));
            update(entry);
            entry.clone()
        };
        self.events.peer_state(&state);
    }

    fn should_redial(&self, node_id: &str) -> bool {
        self.state.lock().running && self.pair(node_id).is_some() && !self.is_disconnected(node_id)
    }
}

fn idle_state(pair: &pairing::DevicePair) -> PeerState {
    PeerState {
        peer_node_id: pair.peer_node_id.clone(),
        display_name: pair.peer_display_name.clone(),
        room_id: pair.room_id.clone(),
        connected: false,
        reconnecting: false,
        phase: "idle".to_string(),
        pending: 0,
        total: 0,
        last_synced_at: pair.last_synchronized,
    }
}

fn phase_name(phase: Phase) -> &'static str {
    match phase {
        Phase::Reconciling => "reconciling",
        Phase::Transferring => "transferring",
        Phase::Synced => "synced",
        Phase::Error => "error",
    }
}

async fn connect_any(addrs: &[IpAddr], port: u16) -> Result<TcpStream, String> {
    let mut last = "no addresses".to_string();
    for addr in addrs {
        let target = SocketAddr::new(*addr, port);
        match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(target)).await {
            Ok(Ok(stream)) => return Ok(stream),
            Ok(Err(e)) => last = format!("{target}: {e}"),
            Err(_) => last = format!("{target}: timed out"),
        }
    }
    Err(last)
}

async fn connect_tls(
    inner: &Inner,
    node_id: &str,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>, String> {
    let route = inner
        .peers
        .best(node_id)
        .ok_or_else(|| format!("{node_id} is not reachable"))?;
    let stream = connect_any(&route.addrs, route.port).await?;
    let connector = TlsConnector::from(tls::client_config(&inner.me.signing, node_id)?);
    tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        connector.connect(tls::server_name(), stream),
    )
    .await
    .map_err(|_| "the handshake timed out".to_string())?
    .map_err(|e| format!("the handshake failed: {e}"))
}

/// Check a device can be dialled and mark it as being dialled, then dial it.
///
/// The mark is set here, before anything is spawned, and cleared only once
/// the connection is established or has failed: a bounded run that looked in
/// between would otherwise see nothing in flight and stop (ADR 0034).
fn start_dial(inner: &Arc<Inner>, node_id: &str) {
    let Some(pair) = inner.pair(node_id) else {
        return;
    };
    if inner.is_disconnected(node_id) || inner.peers.best(node_id).is_none() {
        return;
    }
    {
        let mut state = inner.state.lock();
        if state.conns.contains_key(node_id) || !state.dialling.insert(node_id.to_string()) {
            return;
        }
    }
    inner.set_status(node_id, |s| {
        s.reconnecting = true;
        s.phase = "connecting".to_string();
    });
    inner.changed.notify_waiters();
    let inner = inner.clone();
    let node_id = node_id.to_string();
    tokio::spawn(async move { dial(inner, node_id, pair).await });
}

fn finish_dial(inner: &Inner, node_id: &str) {
    inner.state.lock().dialling.remove(node_id);
    inner.changed.notify_waiters();
}

async fn dial(inner: Arc<Inner>, node_id: String, pair: pairing::DevicePair) {
    let result = connect_tls(&inner, &node_id).await;
    match result {
        Ok(stream) => {
            let peer = PeerInfo {
                node_id: node_id.clone(),
                display_name: pair.peer_display_name,
                room_id: pair.room_id,
            };
            let dialled_by = inner.me.node_id.clone();
            run(inner.clone(), stream, peer, dialled_by, None).await;
        }
        Err(e) => trace!("[sync] could not reach {node_id}: {e}"),
    }
    finish_dial(&inner, &node_id);
    schedule_redial(inner, node_id);
}

/// Try again after the backoff, if the device should still be connected.
fn schedule_redial(inner: Arc<Inner>, node_id: String) {
    if !inner.should_redial(&node_id) {
        inner.set_status(&node_id, |s| s.reconnecting = false);
        return;
    }
    let attempt = {
        let mut state = inner.state.lock();
        if state.conns.contains_key(&node_id) {
            return;
        }
        let attempts = state.attempts.entry(node_id.clone()).or_insert(0);
        let attempt = *attempts;
        *attempts += 1;
        attempt
    };
    let jitter = rand::random::<u64>() % 1_000;
    let delay = reconnect_delay_ms(attempt, jitter);
    inner.set_status(&node_id, |s| s.reconnecting = true);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(delay)).await;
        if inner.should_redial(&node_id) {
            start_dial(&inner, &node_id);
        }
    });
}

async fn accept(inner: Arc<Inner>, stream: TcpStream) {
    let config = match tls::server_config(&inner.me.signing) {
        Ok(config) => config,
        Err(e) => {
            warn_log!("[sync] cannot accept connections: {e}");
            return;
        }
    };
    let accepted =
        tokio::time::timeout(HANDSHAKE_TIMEOUT, TlsAcceptor::from(config).accept(stream)).await;
    let mut stream = match accepted {
        Ok(Ok(stream)) => stream,
        Ok(Err(e)) => return trace!("[sync] a handshake failed: {e}"),
        Err(_) => return trace!("[sync] a handshake timed out"),
    };
    let Some(node_id) = tls::peer_node_id(stream.get_ref().1) else {
        return;
    };

    // Checked against the pair table after every handshake, not only by the
    // verifier (ADR 0032, decision 2).
    match inner.pair(&node_id) {
        Some(pair) => {
            if inner.is_disconnected(&node_id) {
                trace!("[sync] refusing {node_id}, which the user disconnected");
                let _ = stream.shutdown().await;
                return;
            }
            let peer = PeerInfo {
                node_id: node_id.clone(),
                display_name: pair.peer_display_name,
                room_id: pair.room_id,
            };
            // Read before the session starts: a device that forgot this one
            // and is pairing again opens with a pair request, which is
            // answered rather than handed to the session.
            let first =
                tokio::time::timeout(PAIR_REQUEST_READ_TIMEOUT, frame::read(&mut stream)).await;
            let first = match first {
                Ok(Ok(Some(Message::PairRequest { .. }))) => {
                    let reply = Message::PairAccepted {
                        user_id: inner.me.user_id.clone(),
                        display_name: inner.me.display_name.lock().clone(),
                    };
                    if frame::write(&mut stream, &reply).await.is_err() {
                        return;
                    }
                    None
                }
                Ok(Ok(Some(msg))) => Some(msg),
                _ => return,
            };
            run(inner.clone(), stream, peer, node_id.clone(), first).await;
            schedule_redial(inner, node_id);
        }
        None => answer_pair_request(inner, stream, node_id).await,
    }
}

/// An unpaired device dialled in: it may send one pair request, and nothing
/// else, and the user decides (ADR 0032, decision 5).
async fn answer_pair_request<S>(inner: Arc<Inner>, mut stream: S, node_id: String)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let first = tokio::time::timeout(PAIR_REQUEST_READ_TIMEOUT, frame::read(&mut stream)).await;
    let Ok(Ok(Some(Message::PairRequest {
        user_id,
        display_name,
    }))) = first
    else {
        trace!("[sync] {node_id} is not paired and did not ask to be");
        return;
    };

    let (respond, answer) = oneshot::channel();
    {
        let mut state = inner.state.lock();
        if !allow_pair_prompt(&mut state.prompts, &node_id, now_ms()) {
            trace!("[sync] ignoring a repeat pair request from {node_id}");
            return;
        }
        state
            .pending_pairs
            .insert(node_id.clone(), PendingPair { respond });
    }
    inner
        .events
        .pair_requested(&node_id, &user_id, &display_name);

    let accepted = matches!(
        tokio::time::timeout(PAIR_ANSWER_TIMEOUT, answer).await,
        Ok(Ok(true))
    );
    inner.state.lock().pending_pairs.remove(&node_id);

    if !accepted {
        let _ = frame::write(&mut stream, &Message::PairDeclined).await;
        let _ = stream.shutdown().await;
        return;
    }

    let reply = Message::PairAccepted {
        user_id: inner.me.user_id.clone(),
        display_name: inner.me.display_name.lock().clone(),
    };
    if let Err(e) = frame::write(&mut stream, &reply).await {
        warn_log!("[sync] {node_id} hung up before hearing the pair was accepted: {e}");
        return;
    }
    let room_id = pairing::derive_room_id(&inner.me.user_id, &user_id);
    {
        let db = inner.db.lock();
        if let Err(e) =
            pairing::save_pair(&db, &inner.me.user_id, &node_id, &display_name, &room_id)
        {
            warn_log!("[sync] could not record the pair with {node_id}: {e}");
            return;
        }
    }
    let peer = PeerInfo {
        node_id: node_id.clone(),
        display_name,
        room_id,
    };
    run(inner.clone(), stream, peer, node_id.clone(), None).await;
    schedule_redial(inner, node_id);
}

async fn request_pair(inner: Arc<Inner>, node_id: String) -> Result<(), String> {
    let mut stream = connect_tls(&inner, &node_id).await?;
    let request = Message::PairRequest {
        user_id: inner.me.user_id.clone(),
        display_name: inner.me.display_name.lock().clone(),
    };
    frame::write(&mut stream, &request).await?;

    tokio::spawn(async move {
        let reply = tokio::time::timeout(PAIR_ANSWER_TIMEOUT, frame::read(&mut stream)).await;
        match reply {
            Ok(Ok(Some(Message::PairAccepted {
                user_id,
                display_name,
            }))) => {
                let room_id = pairing::derive_room_id(&inner.me.user_id, &user_id);
                {
                    let db = inner.db.lock();
                    if let Err(e) = pairing::save_pair(
                        &db,
                        &inner.me.user_id,
                        &node_id,
                        &display_name,
                        &room_id,
                    ) {
                        warn_log!("[sync] could not record the pair with {node_id}: {e}");
                        return;
                    }
                }
                inner
                    .events
                    .pair_answered(&node_id, &user_id, &display_name, true);
                let peer = PeerInfo {
                    node_id: node_id.clone(),
                    display_name,
                    room_id,
                };
                let dialled_by = inner.me.node_id.clone();
                run(inner.clone(), stream, peer, dialled_by, None).await;
                schedule_redial(inner, node_id);
            }
            Ok(Ok(Some(Message::PairDeclined))) => {
                inner.events.pair_answered(&node_id, "", "", false);
            }
            _ => {
                trace!("[sync] {node_id} did not answer the pair request");
                inner.events.pair_answered(&node_id, "", "", false);
            }
        }
    });
    Ok(())
}

/// One connection, from its first frame to its end. `first` is a frame the
/// caller already read off the stream, handed to the session in order.
async fn run<S>(
    inner: Arc<Inner>,
    stream: S,
    peer: PeerInfo,
    dialled_by: String,
    first: Option<Message>,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let conn_id = inner.ids.fetch_add(1, Ordering::Relaxed);
    let (read_half, write_half) = tokio::io::split(stream);
    let activity = Activity::new(now_ms());

    // Reading on its own task: a frame read that a select abandoned halfway
    // would lose the bytes already read.
    let (incoming_tx, mut incoming) = mpsc::channel::<Result<Message, String>>(64);
    let mut reader = ActivityReader::new(read_half, activity.clone(), now_ms);
    let reader_task = tokio::spawn(async move {
        loop {
            match frame::read(&mut reader).await {
                Ok(Some(msg)) => {
                    if incoming_tx.send(Ok(msg)).await.is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    let _ = incoming_tx.send(Err(e)).await;
                    break;
                }
            }
        }
    });

    // Writing on its own task, notes ahead of images (ADR 0032, decision 7).
    let (control_tx, control_rx) = mpsc::unbounded_channel::<Message>();
    let (bulk_tx, bulk_rx) = mpsc::unbounded_channel::<Message>();
    let writer_task = tokio::spawn(write_loop(write_half, control_rx, bulk_rx));
    let send = |msg: Message| {
        let _ = if msg.is_bulk() {
            bulk_tx.send(msg)
        } else {
            control_tx.send(msg)
        };
    };

    let (commands_tx, mut commands) = mpsc::unbounded_channel::<Cmd>();
    let repo = SqliteRepo::new(
        inner.db.clone(),
        inner.data_dir.clone(),
        inner.events.clone(),
    );
    let mut session = Session::new();
    let mut established = false;

    for out in session.start(&repo, now_ms()) {
        apply(&inner, &peer, out, &send);
    }
    if let Some(msg) = first {
        if !establish(&inner, &peer, conn_id, &dialled_by, &commands_tx, &activity) {
            reader_task.abort();
            return;
        }
        established = true;
        for out in session.handle(&repo, msg, now_ms()) {
            apply(&inner, &peer, out, &send);
        }
        update_progress_flags(&inner, &peer.node_id, conn_id, &session);
    }

    loop {
        let wake = session
            .next_deadline()
            .map(|at| (at - now_ms()).clamp(0, TICK.as_millis() as i64) as u64)
            .unwrap_or(TICK.as_millis() as u64);
        tokio::select! {
            received = incoming.recv() => {
                let msg = match received {
                    Some(Ok(msg)) => msg,
                    Some(Err(e)) => {
                        trace!("[sync] {}: {e}", peer.node_id);
                        break;
                    }
                    None => break,
                };
                if !established {
                    if !establish(&inner, &peer, conn_id, &dialled_by, &commands_tx, &activity) {
                        trace!("[sync] {}: keeping the other connection", peer.node_id);
                        break;
                    }
                    established = true;
                }
                if matches!(msg, Message::Heartbeat) {
                    continue;
                }
                for out in session.handle(&repo, msg, now_ms()) {
                    apply(&inner, &peer, out, &send);
                }
                update_progress_flags(&inner, &peer.node_id, conn_id, &session);
            }
            command = commands.recv() => match command {
                Some(Cmd::Send(msg)) => send(msg),
                Some(Cmd::RequestAttachment(hash)) => {
                    for out in session.request_attachment(hash, now_ms()) {
                        apply(&inner, &peer, out, &send);
                    }
                    update_progress_flags(&inner, &peer.node_id, conn_id, &session);
                }
                Some(Cmd::Close) | None => break,
            },
            _ = tokio::time::sleep(Duration::from_millis(wake)) => {
                for out in session.tick(now_ms()) {
                    apply(&inner, &peer, out, &send);
                }
                update_progress_flags(&inner, &peer.node_id, conn_id, &session);
                if now_ms() - activity.last() > DEAD_AFTER_MS {
                    trace!("[sync] {}: nothing heard for a minute, dropping", peer.node_id);
                    break;
                }
            }
        }
    }

    reader_task.abort();
    drop(control_tx);
    drop(bulk_tx);
    let _ = writer_task.await;

    let was_current = {
        let mut state = inner.state.lock();
        if state
            .conns
            .get(&peer.node_id)
            .is_some_and(|c| c.id == conn_id)
        {
            state.conns.remove(&peer.node_id);
            true
        } else {
            false
        }
    };
    if was_current {
        inner.set_status(&peer.node_id, |s| {
            s.connected = false;
            s.phase = "idle".to_string();
        });
    }
    inner.changed.notify_waiters();
}

/// Register a connection whose first frame has arrived, applying the
/// duplicate rule. False means this one is the one to close.
fn establish(
    inner: &Arc<Inner>,
    peer: &PeerInfo,
    conn_id: u64,
    dialled_by: &str,
    commands: &mpsc::UnboundedSender<Cmd>,
    activity: &Activity,
) -> bool {
    let now = now_ms();
    let lower = if inner.me.node_id < peer.node_id {
        inner.me.node_id.clone()
    } else {
        peer.node_id.clone()
    };
    let replaced = {
        let mut state = inner.state.lock();
        let replaced = match state.conns.get(&peer.node_id) {
            None => None,
            Some(existing) => {
                let alive = now - existing.activity.last() <= DUPLICATE_WINDOW_MS;
                if !keep_new_connection(&lower, &existing.dialled_by, dialled_by, alive) {
                    return false;
                }
                Some(existing.commands.clone())
            }
        };
        state.conns.insert(
            peer.node_id.clone(),
            Conn {
                id: conn_id,
                dialled_by: dialled_by.to_string(),
                commands: commands.clone(),
                activity: activity.clone(),
                synced: false,
                images_pending: false,
            },
        );
        state.attempts.remove(&peer.node_id);
        state.dialling.remove(&peer.node_id);
        replaced
    };
    if let Some(old) = replaced {
        let _ = old.send(Cmd::Close);
    }
    inner.set_status(&peer.node_id, |s| {
        s.connected = true;
        s.reconnecting = false;
    });
    inner.changed.notify_waiters();
    true
}

fn update_progress_flags(inner: &Inner, node_id: &str, conn_id: u64, session: &Session) {
    let mut changed = false;
    {
        let mut state = inner.state.lock();
        if let Some(conn) = state.conns.get_mut(node_id) {
            if conn.id == conn_id {
                let synced = session.is_synced();
                let images = session.has_images_pending();
                changed = conn.synced != synced || conn.images_pending != images;
                conn.synced = synced;
                conn.images_pending = images;
            }
        }
    }
    if changed {
        inner.changed.notify_waiters();
    }
}

fn apply(inner: &Inner, peer: &PeerInfo, out: Out, send: &impl Fn(Message)) {
    match out {
        Out::Send(msg) => send(msg),
        Out::Phase(phase) => {
            inner.set_status(&peer.node_id, |s| s.phase = phase_name(phase).into())
        }
        Out::Progress { pending, total } => inner.set_status(&peer.node_id, |s| {
            s.pending = pending;
            s.total = total;
        }),
        Out::Synced { at } => {
            {
                let db = inner.db.lock();
                if let Err(e) = pairing::update_last_sync(&db, &peer.room_id) {
                    warn_log!(
                        "[sync] could not record the sync with {}: {e}",
                        peer.node_id
                    );
                }
            }
            inner.set_status(&peer.node_id, |s| s.last_synced_at = Some(at));
        }
    }
}

async fn write_loop<W>(
    mut writer: W,
    mut control: mpsc::UnboundedReceiver<Message>,
    mut bulk: mpsc::UnboundedReceiver<Message>,
) where
    W: AsyncWrite + Unpin,
{
    let mut bulk_open = true;
    loop {
        let msg = tokio::select! {
            biased;
            msg = control.recv() => match msg {
                Some(msg) => msg,
                None => break,
            },
            msg = bulk.recv(), if bulk_open => match msg {
                Some(msg) => msg,
                None => {
                    bulk_open = false;
                    continue;
                }
            },
            _ = tokio::time::sleep(Duration::from_millis(HEARTBEAT_AFTER_MS)) => Message::Heartbeat,
        };
        if let Err(e) = frame::write(&mut writer, &msg).await {
            trace!("[sync] a write failed: {e}");
            break;
        }
    }
    let _ = writer.shutdown().await;
}

#[cfg(test)]
mod tests;

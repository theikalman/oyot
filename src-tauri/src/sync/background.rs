//! A phone's background run (ADR 0034): find the paired devices this one can
//! reach, sync with each until both sides are done or time runs out, and
//! record what happened.
//!
//! Nothing here needs Tauri or a page. Android starts a run from a
//! WorkManager job, which Tauri never sees, and iOS from a background task
//! that may launch the app with no scene at all. So a run takes the data
//! directory, opens the database the way the app does, and tells nobody
//! anything but the database.

use super::events::NoEvents;
use super::manager::{Me, RunReport, SyncManager};
use super::routes;
use super::runs::{self, RunRecord};
use crate::crypto::now_ms;
use crate::db::{configure_connection, DB_FILE};
use crate::endpoints::{self, DeviceEndpoint};
use crate::network::peers::Peers;
use crate::network::remote_peers::probe_peer;
use crate::network::signaling_manager::SignalingManager;
use crate::pairing::{self, DevicePair};
use parking_lot::Mutex;
use rusqlite::Connection;
use std::future::Future;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;

/// The setting that turns background runs off (ADR 0034, decision 4).
pub const ENABLED_KEY: &str = "background_sync";
/// The setting that lets them run on mobile data.
pub const MOBILE_DATA_KEY: &str = "background_sync_mobile_data";

/// How long finding the devices may take, out of a run's budget. A dead
/// address costs its connect timeout, so this caps what a list of them costs.
const FIND_BUDGET: Duration = Duration::from_secs(8);

/// What started a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// Android's periodic WorkManager job.
    WorkManager,
    /// iOS app refresh: about 30 seconds, at times iOS picks.
    AppRefresh,
    /// An iOS processing task: minutes, usually overnight while charging.
    Processing,
    /// The app leaving the screen with a sync in progress.
    Leaving,
}

impl Trigger {
    pub fn name(self) -> &'static str {
        match self {
            Trigger::WorkManager => "workmanager",
            Trigger::AppRefresh => "app-refresh",
            Trigger::Processing => "processing",
            Trigger::Leaving => "leaving",
        }
    }

    #[cfg_attr(desktop, allow(dead_code))]
    pub fn from_name(name: &str) -> Option<Trigger> {
        [
            Trigger::WorkManager,
            Trigger::AppRefresh,
            Trigger::Processing,
            Trigger::Leaving,
        ]
        .into_iter()
        .find(|t| t.name() == name)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Options {
    pub trigger: Trigger,
    /// How long the run may take, from start to recorded.
    pub budget: Duration,
    /// Whether images move: only on an unmetered network (decision 4).
    pub images: bool,
    /// How long to listen for mDNS alongside probing, under a multicast lock
    /// the caller holds: a few seconds on Android, none on iOS (decision 3).
    pub browse: Duration,
}

/// Whether a run is in progress in this process. iOS can start an app
/// refresh and a processing task close together, and two runs would dial
/// the same devices twice.
static RUNNING: AtomicBool = AtomicBool::new(false);
/// Woken to end the run in progress early.
static STOP: std::sync::Mutex<Option<Arc<Notify>>> = std::sync::Mutex::new(None);

struct Running;

impl Drop for Running {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::Release);
    }
}

/// End the run in progress, if there is one: the system is taking its time
/// back, or the app came on screen and syncs for itself. What the run
/// finished stands (decision 2).
#[cfg_attr(desktop, allow(dead_code))]
pub fn stop() {
    if let Some(stop) = STOP.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        stop.notify_one();
    }
}

/// Run once, on a runtime of its own, for a caller outside any: the Android
/// and iOS entry points. Returns the run's record as JSON, for the caller to
/// log, or what kept it from running.
#[cfg_attr(desktop, allow(dead_code))]
pub fn run_blocking(data_dir: &Path, options: Options) -> String {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => return serde_json::json!({ "error": e.to_string() }).to_string(),
    };
    let stop = Arc::new(Notify::new());
    *STOP.lock().unwrap_or_else(|e| e.into_inner()) = Some(stop.clone());
    let result = runtime.block_on(run(data_dir, options, stop.notified()));
    *STOP.lock().unwrap_or_else(|e| e.into_inner()) = None;
    // The run's connections close as the runtime goes; give them a moment
    // to say so to the other side.
    runtime.shutdown_timeout(Duration::from_secs(1));
    match result {
        Ok(Some(record)) => serde_json::to_string(&record).unwrap_or_default(),
        Ok(None) => serde_json::json!({ "skipped": true }).to_string(),
        Err(e) => serde_json::json!({ "error": e }).to_string(),
    }
}

/// One background run. `None` when there was nothing to run: the setting is
/// off, the app has never been set up, no device is paired, or another run
/// is already going.
pub async fn run(
    data_dir: &Path,
    options: Options,
    stop: impl Future<Output = ()>,
) -> Result<Option<RunRecord>, String> {
    if RUNNING.swap(true, Ordering::AcqRel) {
        return Ok(None);
    }
    let _running = Running;
    let started_at = now_ms();
    let deadline = tokio::time::Instant::now() + options.budget;
    let mut stop = std::pin::pin!(stop);

    if !crate::commands::config::read_flag_at(data_dir, ENABLED_KEY, true) {
        return Ok(None);
    }
    let path = data_dir.join(DB_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let db = Connection::open(&path).map_err(|e| format!("could not open the database: {e}"))?;
    configure_connection(&db)?;
    // The app may have been updated since it last ran, and this run may be
    // the first thing to open its database.
    crate::setup_database_tables(&db)?;
    crate::run_migrations(&db)?;

    let Some(identity) = crate::identity::load_identity(&db)? else {
        return Ok(None);
    };
    let user_id = identity.public.user_id.clone();
    let pairs: Vec<DevicePair> = pairing::load_pairs(&db, &user_id)?
        .into_iter()
        .filter(|p| !p.disconnected)
        .collect();
    if pairs.is_empty() {
        return Ok(None);
    }
    let typed = endpoints::load_endpoints(&db, &user_id)?;
    let remembered = routes::load(&db, &user_id)?;
    let db = Arc::new(Mutex::new(db));

    let me = Me {
        node_id: identity.public.node_id.clone(),
        user_id: user_id.clone(),
        display_name: Mutex::new(identity.public.display_name.clone()),
        signing: identity.signing_key.clone(),
    };
    let signaling = Arc::new(SignalingManager::new());
    signaling.set_identity(identity);
    let peers = Arc::new(Peers::new(None));

    let find = find_devices(
        &pairs,
        &typed,
        &remembered,
        &signaling,
        &peers,
        &me.node_id,
        options.browse,
    );
    let find_for = FIND_BUDGET.min(options.budget / 2);
    let cancelled = tokio::select! {
        _ = tokio::time::timeout(find_for, find) => false,
        _ = &mut stop => true,
    };

    let report = if cancelled {
        RunReport {
            cancelled: true,
            ..RunReport::default()
        }
    } else {
        let manager = SyncManager::new(
            db.clone(),
            data_dir.to_path_buf(),
            Arc::new(NoEvents),
            me,
            peers,
        );
        manager.set_images(options.images);
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let report = manager.run_until(remaining, stop).await;
        manager.stop();
        report
    };

    let record = RunRecord {
        trigger: options.trigger.name().to_string(),
        started_at,
        ended_at: now_ms(),
        reached: names(&pairs, &report.reached),
        docs_received: report.moved.docs_received,
        docs_sent: report.moved.docs_sent,
        images_received: report.moved.images_received,
        images_sent: report.moved.images_sent,
        outcome: outcome(&report).to_string(),
        error: None,
    };
    runs::record(&db.lock(), &record)?;
    Ok(Some(record))
}

/// Put every paired device this run can reach into `peers`: the addresses
/// the user typed for it, then where discovery last found it, each proved by
/// a probe before it is dialled, and, on Android, whatever answers mDNS
/// while the run listens (decision 3).
async fn find_devices(
    pairs: &[DevicePair],
    typed: &[DeviceEndpoint],
    remembered: &[routes::LanRoute],
    signaling: &Arc<SignalingManager>,
    peers: &Arc<Peers>,
    our_node_id: &str,
    browse: Duration,
) {
    let boot_id = uuid::Uuid::new_v4().to_string();
    let mut probes = tokio::task::JoinSet::new();
    for pair in pairs {
        let node_id = pair.peer_node_id.clone();
        let mut addresses: Vec<DeviceEndpoint> = typed
            .iter()
            .filter(|e| e.peer_node_id == node_id)
            .cloned()
            .collect();
        if let Some(route) = remembered.iter().find(|r| r.peer_node_id == node_id) {
            addresses.extend(route.addrs.iter().map(|addr| DeviceEndpoint {
                peer_node_id: node_id.clone(),
                host: addr.to_string(),
                port: route.port,
                added_at: 0,
                last_ok: None,
            }));
        }
        if addresses.is_empty() {
            continue;
        }
        let (signaling, peers, boot_id) = (signaling.clone(), peers.clone(), boot_id.clone());
        probes.spawn(async move {
            if let Some((peer, _)) = probe_peer(&signaling, &boot_id, &node_id, &addresses).await {
                peers.observe(peer);
            }
        });
    }
    let listening = crate::network::lan_discovery::browse_for(peers, our_node_id, browse);
    tokio::join!(probes.join_all(), listening);
}

/// The display names of the devices a run reached, for its record.
fn names(pairs: &[DevicePair], reached: &[String]) -> Vec<String> {
    reached
        .iter()
        .map(|node_id| {
            pairs
                .iter()
                .find(|p| &p.peer_node_id == node_id)
                .map(|p| p.peer_display_name.clone())
                .unwrap_or_else(|| node_id.clone())
        })
        .collect()
}

fn outcome(report: &RunReport) -> &'static str {
    if report.cancelled {
        "cancelled"
    } else if report.reached.is_empty() {
        "unreachable"
    } else if report.timed_out {
        "partial"
    } else {
        "synced"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::documents;
    use crate::commands::sync::merge_into_document;
    use crate::network::lan_signaling;
    use yrs::updates::decoder::Decode;
    use yrs::{Doc, GetString, ReadTxn, StateVector, Text, Transact, Update};

    fn state_with(text: &str) -> Vec<u8> {
        let doc = Doc::new();
        let body = doc.get_or_insert_text("content");
        body.insert(&mut doc.transact_mut(), 0, text);
        let state = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        state
    }

    fn text_in(db: &Connection, id: &str) -> String {
        let state: Option<Vec<u8>> = db
            .query_row(
                "SELECT crdt_state FROM documents WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .ok()
            .flatten();
        let Some(state) = state else {
            return String::new();
        };
        let doc = Doc::new();
        let body = doc.get_or_insert_text("content");
        doc.transact_mut()
            .apply_update(Update::decode_v1(&state).unwrap())
            .unwrap();
        let text = body.get_string(&doc.transact());
        text
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("oyot-bg-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A desktop that is awake: its engine running, listening on the shared
    /// port for probes and sync connections, holding one note.
    struct Desktop {
        manager: SyncManager,
        listener: lan_signaling::LanListener,
        node_id: String,
        user_id: String,
        db: Arc<Mutex<Connection>>,
        dir: std::path::PathBuf,
    }

    async fn desktop() -> Desktop {
        let db = Connection::open_in_memory().unwrap();
        crate::setup_database_tables(&db).unwrap();
        crate::run_migrations(&db).unwrap();
        let identity = crate::identity::get_or_create_identity(&db).unwrap();
        documents::insert_document(&db, "groceries", "note", "Groceries", false, 10).unwrap();
        merge_into_document(&db, "groceries", &state_with("milk, eggs"), 10).unwrap();
        let (node_id, user_id) = (
            identity.public.node_id.clone(),
            identity.public.user_id.clone(),
        );
        let me = Me {
            node_id: node_id.clone(),
            user_id: user_id.clone(),
            display_name: Mutex::new("Desktop".to_string()),
            signing: identity.signing_key.clone(),
        };
        let signaling = SignalingManager::new();
        signaling.set_identity(identity);
        let db = Arc::new(Mutex::new(db));
        let dir = temp_dir("desktop");
        let manager = SyncManager::new(
            db.clone(),
            dir.clone(),
            Arc::new(NoEvents),
            me,
            Arc::new(Peers::new(None)),
        );
        let listener = lan_signaling::listen(signaling.inbound(&node_id, "boot"), manager.clone())
            .await
            .unwrap();
        manager.start();
        Desktop {
            manager,
            listener,
            node_id,
            user_id,
            db,
            dir,
        }
    }

    /// A phone's data directory, as the app leaves it: an identity, a pairing
    /// with `desktop`, and the port the desktop was last found at.
    fn phone(desktop: &Desktop, remember_route: bool) -> std::path::PathBuf {
        let dir = temp_dir("phone");
        let db = Connection::open(dir.join(DB_FILE)).unwrap();
        crate::setup_database_tables(&db).unwrap();
        crate::run_migrations(&db).unwrap();
        let identity = crate::identity::get_or_create_identity(&db).unwrap();
        let room = pairing::derive_room_id(&identity.public.user_id, &desktop.user_id);
        pairing::save_pair(
            &db,
            &identity.public.user_id,
            &desktop.node_id,
            "Desktop",
            &room,
        )
        .unwrap();
        pairing::save_pair(
            &desktop.db.lock(),
            &desktop.user_id,
            &identity.public.node_id,
            "Phone",
            &room,
        )
        .unwrap();
        if remember_route {
            routes::remember(
                &db,
                &identity.public.user_id,
                &routes::LanRoute {
                    peer_node_id: desktop.node_id.clone(),
                    addrs: vec!["127.0.0.1".parse().unwrap()],
                    port: desktop.listener.port(),
                    seen_at: 1,
                },
            )
            .unwrap();
        }
        dir
    }

    /// One run at a time in a process, so these take turns.
    static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn options() -> Options {
        Options {
            trigger: Trigger::WorkManager,
            budget: Duration::from_secs(20),
            images: true,
            browse: Duration::ZERO,
        }
    }

    // The whole of ADR 0034's run, against a real listener: the remembered
    // address is probed, dialled over TLS, synced, and the run recorded.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_background_run_syncs_with_a_desktop_where_it_was_last_found() {
        let _serial = SERIAL.lock().await;
        let desktop = desktop().await;
        let phone_dir = phone(&desktop, true);

        let record = run(&phone_dir, options(), std::future::pending())
            .await
            .unwrap()
            .expect("a run");

        assert_eq!(record.outcome, "synced", "{record:?}");
        assert_eq!(record.reached, vec!["Desktop".to_string()]);
        assert_eq!(record.docs_received, 1);
        let phone_db = Connection::open(phone_dir.join(DB_FILE)).unwrap();
        assert_eq!(text_in(&phone_db, "groceries"), "milk, eggs");
        assert_eq!(runs::last(&phone_db).unwrap(), Some(record));

        desktop.manager.stop();
        desktop.listener.stop();
        let _ = std::fs::remove_dir_all(&phone_dir);
        let _ = std::fs::remove_dir_all(&desktop.dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_run_with_nowhere_to_dial_says_so() {
        let _serial = SERIAL.lock().await;
        let desktop = desktop().await;
        let phone_dir = phone(&desktop, false);

        let record = run(&phone_dir, options(), std::future::pending())
            .await
            .unwrap()
            .expect("a run");

        assert_eq!(record.outcome, "unreachable");
        assert!(record.reached.is_empty());

        desktop.manager.stop();
        desktop.listener.stop();
        let _ = std::fs::remove_dir_all(&phone_dir);
        let _ = std::fs::remove_dir_all(&desktop.dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn nothing_runs_while_background_sync_is_off_or_nothing_is_set_up() {
        let _serial = SERIAL.lock().await;
        let empty = temp_dir("empty");
        assert_eq!(
            run(&empty, options(), std::future::pending()).await,
            Ok(None),
            "no database yet"
        );
        assert!(!empty.join(DB_FILE).exists(), "and none made");

        std::fs::write(
            empty.join("config.json"),
            serde_json::json!({ ENABLED_KEY: false }).to_string(),
        )
        .unwrap();
        let db = Connection::open(empty.join(DB_FILE)).unwrap();
        crate::setup_database_tables(&db).unwrap();
        assert_eq!(
            run(&empty, options(), std::future::pending()).await,
            Ok(None),
            "turned off"
        );
        let _ = std::fs::remove_dir_all(&empty);
    }

    #[test]
    fn triggers_read_back_from_their_names() {
        for trigger in [
            Trigger::WorkManager,
            Trigger::AppRefresh,
            Trigger::Processing,
            Trigger::Leaving,
        ] {
            assert_eq!(Trigger::from_name(trigger.name()), Some(trigger));
        }
        assert_eq!(Trigger::from_name("push"), None);
    }
}

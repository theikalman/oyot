//! Two devices, each with its own database and listener, over real TLS on
//! localhost.

use super::*;
use crate::commands::documents;
use crate::commands::sync::merge_into_document;
use crate::network::peers::{Peer, PeerSource, PEER_TTL_MS};
use crate::sync::events::Events;
use tokio::net::TcpListener;
use yrs::updates::decoder::Decode;
use yrs::{Doc, GetString, ReadTxn, StateVector, Text, Transact, Update};

#[test]
fn a_repeat_pair_request_inside_the_cooldown_is_dropped() {
    // Every request puts a prompt in front of the user, so anyone who learned
    // a node_id could make the app unusable by asking repeatedly.
    let mut seen = Vec::new();
    let now = 1_000_000;

    assert!(allow_pair_prompt(&mut seen, "peer-a", now));
    assert!(!allow_pair_prompt(&mut seen, "peer-a", now + 1));
    assert!(!allow_pair_prompt(
        &mut seen,
        "peer-a",
        now + PAIR_REQUEST_COOLDOWN_MS - 1
    ));
    assert!(allow_pair_prompt(
        &mut seen,
        "peer-a",
        now + PAIR_REQUEST_COOLDOWN_MS
    ));
}

#[test]
fn one_device_in_cooldown_does_not_silence_another() {
    let mut seen = Vec::new();
    let now = 1_000_000;

    assert!(allow_pair_prompt(&mut seen, "peer-a", now));
    assert!(!allow_pair_prompt(&mut seen, "peer-a", now));
    assert!(
        allow_pair_prompt(&mut seen, "peer-b", now),
        "a different device asking is a different request"
    );
}

#[test]
fn the_pair_request_history_is_bounded() {
    let mut seen = Vec::new();
    for i in 0..MAX_PAIR_REQUEST_SENDERS * 2 {
        assert!(allow_pair_prompt(
            &mut seen,
            &format!("peer-{i}"),
            1_000_000
        ));
    }
    assert_eq!(seen.len(), MAX_PAIR_REQUEST_SENDERS);
}

#[derive(Default)]
struct Recorder {
    log: Mutex<Vec<String>>,
}

impl Recorder {
    fn has(&self, entry: &str) -> bool {
        self.log.lock().iter().any(|e| e == entry)
    }
}

impl Events for Recorder {
    fn doc_merged(&self, id: &str, _: &[u8]) {
        self.log.lock().push(format!("merged {id}"));
    }
    fn pair_requested(&self, from: &str, _: &str, name: &str) {
        self.log.lock().push(format!("requested {from} {name}"));
    }
    fn pair_answered(&self, from: &str, _: &str, _: &str, accepted: bool) {
        self.log.lock().push(format!("answered {from} {accepted}"));
    }
}

struct Device {
    manager: SyncManager,
    db: Arc<Mutex<Connection>>,
    events: Arc<Recorder>,
    peers: Arc<Peers>,
    node_id: String,
    user_id: String,
    name: String,
    port: u16,
    listener: tokio::task::JoinHandle<()>,
    dir: PathBuf,
}

impl Drop for Device {
    fn drop(&mut self) {
        self.listener.abort();
        self.manager.stop();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn device(name: &str) -> Device {
    let db = Connection::open_in_memory().unwrap();
    crate::setup_database_tables(&db).unwrap();
    crate::run_migrations(&db).unwrap();
    let identity = crate::identity::get_or_create_identity(&db).unwrap();
    let db = Arc::new(Mutex::new(db));
    let dir = std::env::temp_dir().join(format!("oyot-sync-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let events = Arc::new(Recorder::default());
    let peers = Arc::new(Peers::new(None));
    let me = Me {
        node_id: identity.public.node_id.clone(),
        user_id: identity.public.user_id.clone(),
        display_name: Mutex::new(name.to_string()),
        signing: identity.signing_key,
    };
    let manager = SyncManager::new(db.clone(), dir.clone(), events.clone(), me, peers.clone());

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let accepting = manager.clone();
    let listener = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            accepting.accept(stream);
        }
    });

    Device {
        manager,
        db,
        events,
        peers,
        node_id: identity.public.node_id,
        user_id: identity.public.user_id,
        name: name.to_string(),
        port,
        listener,
        dir,
    }
}

/// `from` can reach `to`, the way a stored address answering would say.
fn route(from: &Device, to: &Device) {
    from.peers.observe(Peer {
        node_id: to.node_id.clone(),
        source: PeerSource::Address,
        boot_id: None,
        addrs: vec!["127.0.0.1".parse().unwrap()],
        host: None,
        port: to.port,
        seen_at: now_ms(),
        key: format!("127.0.0.1:{}", to.port),
    });
}

/// `to`, as discovery reports it on this network: at `port` on this machine,
/// first heard at `seen_at`.
fn on_this_network(to: &Device, port: u16, seen_at: i64) -> Peer {
    Peer {
        node_id: to.node_id.clone(),
        source: PeerSource::Mdns,
        boot_id: None,
        addrs: vec!["127.0.0.1".parse().unwrap()],
        host: None,
        port,
        seen_at,
        key: format!("{}._oyot._tcp.local.", to.name),
    }
}

fn pair(a: &Device, b: &Device) {
    let room = pairing::derive_room_id(&a.user_id, &b.user_id);
    pairing::save_pair(&a.db.lock(), &a.user_id, &b.node_id, &b.name, &room).unwrap();
    pairing::save_pair(&b.db.lock(), &b.user_id, &a.node_id, &a.name, &room).unwrap();
}

fn is_paired(from: &Device, with: &Device) -> bool {
    pairing::get_pair_by_node_id(&from.db.lock(), &from.user_id, &with.node_id)
        .unwrap()
        .is_some()
}

fn state_with(text: &str) -> Vec<u8> {
    let doc = Doc::new();
    let body = doc.get_or_insert_text("content");
    body.insert(&mut doc.transact_mut(), 0, text);
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    state
}

fn write_note(device: &Device, id: &str, text: &str) {
    let db = device.db.lock();
    documents::insert_document(&db, id, "note", id, false, 10).unwrap();
    merge_into_document(&db, id, &state_with(text), 10).unwrap();
}

fn text_of(device: &Device, id: &str) -> String {
    let state: Option<Option<Vec<u8>>> = device
        .db
        .lock()
        .query_row(
            "SELECT crdt_state FROM documents WHERE id = ?1 AND is_deleted = 0",
            [id],
            |r| r.get(0),
        )
        .ok();
    let Some(Some(state)) = state else {
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

async fn eventually(what: &str, check: impl Fn() -> bool) {
    for _ in 0..400 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test(flavor = "multi_thread")]
async fn paired_devices_sync_both_ways_over_tls() {
    let (a, b) = (device("laptop").await, device("desktop").await);
    pair(&a, &b);
    route(&a, &b);
    write_note(&a, "groceries", "milk, eggs");
    write_note(&b, "todo", "call mum");

    b.manager.start();
    a.manager.start();

    eventually("both notes on both devices", || {
        text_of(&b, "groceries") == "milk, eggs" && text_of(&a, "todo") == "call mum"
    })
    .await;
    eventually("both reporting synced", || {
        a.manager.status().iter().any(|s| s.phase == "synced")
            && b.manager.status().iter().any(|s| s.phase == "synced")
    })
    .await;
    assert!(a.manager.is_connected(&b.node_id));
}

// ADR 0034, decision 3: a phone's background run tries where discovery last
// found a device. Only a paired device's place is worth keeping, and only
// what discovery found: a typed address is kept already.
#[tokio::test(flavor = "multi_thread")]
async fn where_discovery_finds_a_paired_device_is_remembered() {
    let (a, b, c) = (
        device("phone").await,
        device("desktop").await,
        device("stranger").await,
    );
    pair(&a, &b);
    a.manager.start();

    let found = |node_id: &str, source: PeerSource, last: u8| Peer {
        node_id: node_id.to_string(),
        source,
        boot_id: None,
        addrs: vec![
            format!("192.168.1.{last}").parse().unwrap(),
            "fe80::1".parse().unwrap(),
        ],
        host: None,
        port: 19701,
        seen_at: now_ms(),
        key: format!("{node_id}-{source:?}"),
    };
    a.peers.observe(found(&c.node_id, PeerSource::Mdns, 30));
    a.peers.observe(found(&b.node_id, PeerSource::Mdns, 20));

    eventually("the desktop's route", || {
        !routes::load(&a.db.lock(), &a.user_id).unwrap().is_empty()
    })
    .await;
    let kept = routes::load(&a.db.lock(), &a.user_id).unwrap();
    assert_eq!(kept.len(), 1, "the stranger is not paired");
    assert_eq!(kept[0].peer_node_id, b.node_id);
    assert_eq!(
        kept[0].addrs,
        vec!["192.168.1.20".parse::<IpAddr>().unwrap()],
        "a link-local address means nothing on a later visit"
    );
}

// mdns-sd reports a device once, when it is first resolved, and refreshes its
// records without a word, so discovery's sighting of a device that never left
// is as old as its stay. The sweep used to drop it a minute and a half in,
// every dial after that found no route, and only a stored address ever
// reached a device on the same wifi.
#[tokio::test(flavor = "multi_thread")]
async fn a_device_found_on_this_network_long_ago_is_still_dialled() {
    let (a, b) = (device("laptop").await, device("desktop").await);
    pair(&a, &b);
    write_note(&b, "groceries", "milk, eggs");
    a.peers
        .observe(on_this_network(&b, b.port, now_ms() - 10 * PEER_TTL_MS));
    // What discovery's sweep does every 30 seconds.
    a.peers.sweep(now_ms());

    b.manager.start();
    a.manager.start();

    eventually("the note over this network", || {
        text_of(&a, "groceries") == "milk, eggs"
    })
    .await;
}

// ADR 0032, decision 3: one port, so one firewall prompt and one number in a
// stored address. A probe still gets its pong, and a TLS handshake on the
// same port reaches the engine.
#[tokio::test(flavor = "multi_thread")]
async fn probes_and_sync_connections_share_the_listener() {
    use crate::network::lan_signaling;
    use crate::network::signaling_manager::{ProbePayload, SignalingManager};

    let (a, b) = (device("laptop").await, device("desktop").await);
    pair(&a, &b);
    write_note(&b, "groceries", "milk, eggs");

    let signaling = SignalingManager::new();
    signaling.set_identity(crate::identity::get_or_create_identity(&b.db.lock()).unwrap());
    let listener =
        lan_signaling::listen(signaling.inbound(&b.node_id, "boot-b"), b.manager.clone())
            .await
            .unwrap();
    let port = listener.port();

    let asker = SignalingManager::new();
    asker.set_identity(crate::identity::get_or_create_identity(&a.db.lock()).unwrap());
    let ping = asker
        .seal_for(
            &b.node_id,
            "ping",
            serde_json::to_string(&ProbePayload::new("boot-a")).unwrap(),
        )
        .unwrap();
    let pong = lan_signaling::request(SocketAddr::from(([127, 0, 0, 1], port)), &ping)
        .await
        .unwrap();
    assert_eq!(pong.msg_type, "pong");
    assert!(asker.admit_reply(&pong));

    a.peers.observe(Peer {
        node_id: b.node_id.clone(),
        source: PeerSource::Address,
        boot_id: None,
        addrs: vec!["127.0.0.1".parse().unwrap()],
        host: None,
        port,
        seen_at: now_ms(),
        key: format!("127.0.0.1:{port}"),
    });
    b.manager.start();
    a.manager.start();
    eventually("the note over the shared port", || {
        text_of(&a, "groceries") == "milk, eggs"
    })
    .await;
    listener.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_device_pairs_inside_tls_and_then_syncs() {
    let (a, b) = (device("phone").await, device("desktop").await);
    route(&a, &b);
    write_note(&b, "from the desktop", "hello phone");
    b.manager.start();

    a.manager.request_pair(&b.node_id).await.unwrap();
    let asked = format!("requested {} phone", a.node_id);
    eventually("the desktop being asked", || b.events.has(&asked)).await;
    b.manager.answer_pair(&a.node_id, true).unwrap();

    let answered = format!("answered {} true", b.node_id);
    eventually("the phone hearing yes", || a.events.has(&answered)).await;
    assert!(is_paired(&a, &b));
    eventually("the desktop recording the pair", || is_paired(&b, &a)).await;
    eventually("the note arriving", || {
        text_of(&a, "from the desktop") == "hello phone"
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_declined_request_leaves_no_pair_on_either_side() {
    let (a, b) = (device("phone").await, device("desktop").await);
    route(&a, &b);
    b.manager.start();

    a.manager.request_pair(&b.node_id).await.unwrap();
    let asked = format!("requested {} phone", a.node_id);
    eventually("the desktop being asked", || b.events.has(&asked)).await;
    b.manager.answer_pair(&a.node_id, false).unwrap();

    let answered = format!("answered {} false", b.node_id);
    eventually("the phone hearing no", || a.events.has(&answered)).await;
    assert!(!is_paired(&a, &b));
    assert!(!is_paired(&b, &a));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unpaired_device_that_does_not_ask_gets_nothing() {
    let (a, b) = (device("stranger").await, device("desktop").await);
    write_note(&b, "private", "not for strangers");
    b.manager.start();

    // The stranger completes a handshake, which pairing needs, and then tries
    // to sync as if it were paired.
    let stream = TcpStream::connect(("127.0.0.1", b.port)).await.unwrap();
    let signing = crate::crypto::generate_signing_key();
    let connector = TlsConnector::from(tls::client_config(&signing, &b.node_id).unwrap());
    let mut tls = connector.connect(tls::server_name(), stream).await.unwrap();
    frame::write(&mut tls, &Message::SyncManifest { docs: vec![] })
        .await
        .unwrap();
    let reply = tokio::time::timeout(Duration::from_secs(5), frame::read(&mut tls)).await;
    assert!(
        !matches!(reply, Ok(Ok(Some(_)))),
        "a device that is not paired was answered"
    );
    assert!(b.events.log.lock().is_empty());
    drop(a);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_disconnected_device_is_refused_until_it_is_reconnected() {
    let (a, b) = (device("laptop").await, device("desktop").await);
    pair(&a, &b);
    route(&a, &b);
    b.manager.start();
    b.manager.disconnect(&a.node_id).unwrap();

    write_note(&a, "note", "from the laptop");
    a.manager.start();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        text_of(&b, "note"),
        "",
        "the disconnected device got through"
    );

    b.manager.reconnect(&a.node_id).unwrap();
    a.manager.reconnect(&b.node_id).unwrap();
    eventually("the note arriving once reconnected", || {
        text_of(&b, "note") == "from the laptop"
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bounded_run_ends_once_both_sides_are_synced() {
    let (phone, desktop) = (device("phone").await, device("desktop").await);
    pair(&phone, &desktop);
    route(&phone, &desktop);
    for i in 0..10 {
        write_note(&phone, &format!("note {i}"), "written on the phone");
    }
    write_note(&desktop, "from the desktop", "hello");
    desktop.manager.start();

    let report = phone.manager.run_once(Duration::from_secs(20)).await;

    assert!(!report.timed_out, "{report:?}");
    assert_eq!(report.synced, vec![desktop.node_id.clone()]);
    for i in 0..10 {
        assert_eq!(
            text_of(&desktop, &format!("note {i}")),
            "written on the phone"
        );
    }
    assert_eq!(text_of(&phone, "from the desktop"), "hello");
    assert_eq!(report.moved.docs_sent, 10);
    assert_eq!(report.moved.docs_received, 1);
    eventually("the run's connection closing", || {
        !phone.manager.is_connected(&desktop.node_id)
    })
    .await;
}

// Runs can come back to back: a phone leaving the screen, then a scheduled
// run. The second must not be turned away by what is left of the first
// one's connection, on either side, or take it for up and synced.
#[tokio::test(flavor = "multi_thread")]
async fn a_run_straight_after_another_connects_afresh() {
    let (phone, desktop) = (device("phone").await, device("desktop").await);
    pair(&phone, &desktop);
    route(&phone, &desktop);
    write_note(&desktop, "first", "for the first run");
    desktop.manager.start();

    let first = phone.manager.run_once(Duration::from_secs(20)).await;
    assert_eq!(first.synced, vec![desktop.node_id.clone()], "{first:?}");
    assert_eq!(first.moved.docs_received, 1, "{first:?}");
    assert!(
        !phone.manager.is_connected(&desktop.node_id),
        "a run leaves no connection behind"
    );

    write_note(&desktop, "second", "for the second run");
    let second = phone.manager.run_once(Duration::from_secs(20)).await;
    assert_eq!(second.synced, vec![desktop.node_id.clone()], "{second:?}");
    assert_eq!(second.moved.docs_received, 1, "{second:?}");
    assert_eq!(text_of(&phone, "second"), "for the second run");
}

// ADR 0034, decision 6: a phone leaving the screen stops reaching out, lets a
// sync in progress finish, then closes and stays closed.
#[tokio::test(flavor = "multi_thread")]
async fn leaving_lets_a_sync_in_progress_finish_then_goes_quiet() {
    let (phone, desktop) = (device("phone").await, device("desktop").await);
    pair(&phone, &desktop);
    route(&phone, &desktop);
    for i in 0..60 {
        write_note(&desktop, &format!("note {i}"), "from the desktop");
    }
    desktop.manager.start();
    phone.manager.start();
    eventually("a connection", || {
        phone.manager.is_connected(&desktop.node_id)
    })
    .await;

    let report = phone
        .manager
        .finish(Duration::from_secs(20), std::future::pending())
        .await;

    // Already finished by the time it was asked is fine too; what matters is
    // that nothing was cut off.
    if let Some(report) = report {
        assert_eq!(report.synced, vec![desktop.node_id.clone()], "{report:?}");
    }
    for i in 0..60 {
        assert_eq!(text_of(&phone, &format!("note {i}")), "from the desktop");
    }
    eventually("the connection closing", || {
        !phone.manager.is_connected(&desktop.node_id)
    })
    .await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    assert!(
        !phone.manager.is_connected(&desktop.node_id),
        "nothing redials a phone that left the screen"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn leaving_with_nothing_in_progress_just_closes() {
    let (phone, desktop) = (device("phone").await, device("desktop").await);
    pair(&phone, &desktop);
    route(&phone, &desktop);
    desktop.manager.start();
    phone.manager.start();
    eventually("both synced", || {
        phone.manager.status().iter().any(|s| s.phase == "synced")
    })
    .await;

    let report = phone
        .manager
        .finish(Duration::from_secs(20), std::future::pending())
        .await;

    assert_eq!(report, None);
    eventually("the connection closing", || {
        !phone.manager.is_connected(&desktop.node_id)
    })
    .await;
}

// ADR 0034, decision 6: when the system takes the time back, the run stops
// and says so; what it finished stands.
#[tokio::test(flavor = "multi_thread")]
async fn a_bounded_run_stops_when_the_system_takes_its_time_back() {
    let (phone, desktop) = (device("phone").await, device("desktop").await);
    pair(&phone, &desktop);
    route(&phone, &desktop);
    desktop.manager.start();

    let report = phone
        .manager
        .run_until(Duration::from_secs(20), std::future::ready(()))
        .await;

    assert!(report.cancelled, "{report:?}");
    assert!(!report.timed_out);
}

// ADR 0034, decision 4: on mobile data a run's connections leave images
// alone, both ways.
#[tokio::test(flavor = "multi_thread")]
async fn a_run_without_images_leaves_them_where_they_are() {
    let (phone, desktop) = (device("phone").await, device("desktop").await);
    pair(&phone, &desktop);
    route(&phone, &desktop);
    write_note(&desktop, "from the desktop", "hello");
    // An image the note embeds, which the desktop offers on every connection.
    let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    png.extend_from_slice(&[7; 32]);
    let image = crate::commands::attachments::store_attachment_at(
        &desktop.db,
        &desktop.dir,
        &png,
        "image/png",
    )
    .unwrap();
    desktop
        .db
        .lock()
        .execute(
            "INSERT INTO document_attachments (document_id, hash) VALUES ('from the desktop', ?1)",
            [&image.hash],
        )
        .unwrap();
    desktop.manager.start();
    phone.manager.set_images(false);

    let report = phone.manager.run_once(Duration::from_secs(20)).await;

    assert_eq!(report.synced, vec![desktop.node_id.clone()]);
    assert_eq!(text_of(&phone, "from the desktop"), "hello");
    assert_eq!(report.moved.images_received + report.moved.images_sent, 0);
    let held = crate::commands::attachments::has_attachment(&phone.db.lock(), &image.hash);
    assert_eq!(held, Ok(false), "the phone did not fetch it");

    // The same run with images allowed does fetch it, so the test above is
    // not passing for want of an image to move.
    phone.manager.set_images(true);
    let report = phone.manager.run_once(Duration::from_secs(20)).await;
    assert_eq!(report.moved.images_received, 1, "{report:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bounded_run_with_nobody_reachable_ends_at_once() {
    let (phone, desktop) = (device("phone").await, device("desktop").await);
    pair(&phone, &desktop);
    let report = phone.manager.run_once(Duration::from_secs(20)).await;
    assert_eq!(report, RunReport::default());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_live_update_reaches_a_connected_device() {
    let (a, b) = (device("laptop").await, device("desktop").await);
    pair(&a, &b);
    route(&a, &b);
    write_note(&a, "doc", "base");
    b.manager.start();
    a.manager.start();
    eventually("the first sync", || text_of(&b, "doc") == "base").await;

    // An edit on A, sent live rather than waiting for the next connection.
    let update = {
        let state: Vec<u8> =
            a.db.lock()
                .query_row(
                    "SELECT crdt_state FROM documents WHERE id = 'doc'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
        let doc = Doc::new();
        let body = doc.get_or_insert_text("content");
        doc.transact_mut()
            .apply_update(Update::decode_v1(&state).unwrap())
            .unwrap();
        let before = doc.transact().state_vector();
        body.insert(&mut doc.transact_mut(), 4, "!");
        let delta = doc.transact().encode_state_as_update_v1(&before);
        delta
    };
    merge_into_document(&a.db.lock(), "doc", &update, 20).unwrap();
    a.manager.broadcast(Message::LiveUpdate {
        id: "doc".into(),
        update,
    });

    eventually("the live edit", || text_of(&b, "doc") == "base!").await;
    assert!(b.events.has("merged doc"));
}

#[test]
fn the_backoff_doubles_from_a_second_to_thirty() {
    assert_eq!(reconnect_delay_ms(0, 0), 1_000);
    assert_eq!(reconnect_delay_ms(1, 0), 2_000);
    assert_eq!(reconnect_delay_ms(4, 0), 16_000);
    assert_eq!(reconnect_delay_ms(5, 0), 30_000);
    assert_eq!(reconnect_delay_ms(60, 250), 30_250);
}

#[test]
fn two_live_connections_keep_the_one_the_lower_node_dialled() {
    // Both sides agree: whichever order they see them in.
    assert!(keep_new_connection("a", "b", "a", true));
    assert!(!keep_new_connection("a", "a", "b", true));
}

#[test]
fn a_quiet_connection_gives_way_to_a_new_one() {
    assert!(keep_new_connection("a", "a", "b", false));
}

#[test]
fn a_device_that_dials_again_replaces_its_own_connection() {
    // It dials only a device it has no connection with, so it gave the old
    // one up, however lately that one was heard from. Whichever node it is.
    assert!(keep_new_connection("a", "a", "a", true));
    assert!(keep_new_connection("a", "b", "b", true));
}

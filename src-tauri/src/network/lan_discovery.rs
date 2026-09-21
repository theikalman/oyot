//! Finding this user's other devices on the local network.
//!
//! Advertises one mDNS service and browses for the same, so two devices on one
//! wifi can reach each other with no internet and no broker. What they exchange
//! once they have is unchanged: the same signed envelope, over
//! `lan_signaling`, carrying the same offer, answer and ICE candidates.
//!
//! The TXT record carries the node_id and nothing else identifying. A device
//! name in it would broadcast "Aji's laptop" to every stranger on every network
//! the user joins, to save one round trip on a flow that already requires
//! confirming a node_id by hand.
//!
//! See docs/decisions/0018-local-network-sync-as-a-second-signaling-transport.md.

use parking_lot::Mutex as ParkingMutex;
use serde::Serialize;
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// The service Oyot advertises and browses for.
pub const SERVICE_TYPE: &str = "_oyot._tcp.local.";

/// TXT keys, kept short because a TXT record is small and every device on the
/// network can read it.
const TXT_NODE_ID: &str = "nid";
const TXT_BOOT: &str = "boot";
const TXT_VERSION: &str = "v";

/// What this build advertises, and the only version it understands. A peer
/// announcing anything else is ignored rather than guessed at.
const ADVERT_VERSION: &str = "1";

/// How long a peer stays in the table after its last announcement.
///
/// Comfortably longer than the re-announcement interval, so a device is not
/// dropped and re-found on a slow network, and short enough that a laptop
/// carried out of the house stops being offered as reachable.
const PEER_TTL_MS: i64 = 90_000;

/// A device seen on this network.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LanPeer {
    pub node_id: String,
    /// The peer's id for this run of its process, when it advertised one. The
    /// same idea as the signaling boot id (ADR 0011) and not the same value: a
    /// device that restarted should read as a change here even when it comes
    /// back at the address it left.
    pub boot_id: Option<String>,
    pub addrs: Vec<IpAddr>,
    pub port: u16,
    /// When we last heard this advertisement.
    pub seen_at: i64,
    /// The mDNS instance this came from, so a removal can be matched back to
    /// the peer without re-deriving it.
    #[serde(skip)]
    pub fullname: String,
}

impl LanPeer {
    /// Whether this is the same device, at the same place, as `other`.
    ///
    /// `seen_at` is excluded on purpose: a re-announcement of an unchanged
    /// service should not read as news. mDNS re-announces on a timer, and
    /// treating each one as a change would run a reconnect sweep every time.
    fn same_reachability(&self, other: &LanPeer) -> bool {
        self.node_id == other.node_id
            && self.boot_id == other.boot_id
            && self.port == other.port
            && self.addrs == other.addrs
    }
}

/// The TXT properties to advertise for this device.
pub fn advert_properties(node_id: &str, boot_id: &str) -> Vec<(String, String)> {
    vec![
        (TXT_NODE_ID.to_string(), node_id.to_string()),
        (TXT_BOOT.to_string(), boot_id.to_string()),
        (TXT_VERSION.to_string(), ADVERT_VERSION.to_string()),
    ]
}

/// A DNS-safe, stable instance label for this device.
///
/// Not the node_id itself: that is base64url, whose alphabet includes `_`,
/// which is not valid in a hostname label. A hash of it is unique, stable
/// across restarts, and reveals nothing the TXT record does not already carry.
pub fn instance_name(node_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(node_id.as_bytes());
    hex::encode(&digest[..8])
}

/// Read one advertisement into a peer, or reject it.
///
/// Rejects an advert with no node_id, one announcing a version we do not
/// speak, one with no address to connect to, and our own.
pub fn peer_from_advert(
    txt: &HashMap<String, String>,
    fullname: &str,
    addrs: Vec<IpAddr>,
    port: u16,
    our_node_id: &str,
    now: i64,
) -> Option<LanPeer> {
    let node_id = txt.get(TXT_NODE_ID)?.trim().to_string();
    if node_id.is_empty() || node_id == our_node_id {
        return None;
    }
    if txt.get(TXT_VERSION).map(String::as_str) != Some(ADVERT_VERSION) {
        return None;
    }
    if addrs.is_empty() || port == 0 {
        return None;
    }
    // Sorted, IPv4 first, for two reasons. The library hands these over as a
    // set, so the same advertisement can arrive in a different order each
    // time, and an order-sensitive comparison would read that as a peer that
    // moved and run a reconnect sweep for nothing. And IPv4 first is the order
    // worth trying on a home network, which is what `send_to` wants anyway.
    let mut addrs = addrs;
    addrs.sort_by_key(|a| (!a.is_ipv4(), a.to_string()));
    addrs.dedup();
    Some(LanPeer {
        node_id,
        boot_id: txt.get(TXT_BOOT).map(|s| s.to_string()),
        addrs,
        port,
        seen_at: now,
        fullname: fullname.to_string(),
    })
}

/// Which devices are reachable on this network right now.
#[derive(Debug, Default)]
pub struct PeerTable {
    peers: HashMap<String, LanPeer>,
}

impl PeerTable {
    /// Record an advertisement. Reports whether anything about how to reach
    /// this peer changed, so a re-announcement of a peer we already have does
    /// not trigger a reconnect sweep.
    pub fn upsert(&mut self, peer: LanPeer) -> bool {
        let changed = match self.peers.get(&peer.node_id) {
            Some(existing) => !existing.same_reachability(&peer),
            None => true,
        };
        self.peers.insert(peer.node_id.clone(), peer);
        changed
    }

    /// Drop the peer behind one mDNS instance, returning its node_id.
    pub fn remove_by_fullname(&mut self, fullname: &str) -> Option<String> {
        let node_id = self
            .peers
            .values()
            .find(|p| p.fullname == fullname)
            .map(|p| p.node_id.clone())?;
        self.peers.remove(&node_id);
        Some(node_id)
    }

    /// Drop peers we have not heard from inside the TTL, returning their ids.
    ///
    /// mDNS announces a departure when a device leaves politely. A laptop that
    /// is closed, or carried out of range, leaves nothing behind at all, and
    /// without this it would stay in the table as a route that cannot work.
    pub fn prune(&mut self, now: i64) -> Vec<String> {
        let expired: Vec<String> = self
            .peers
            .values()
            .filter(|p| now - p.seen_at > PEER_TTL_MS)
            .map(|p| p.node_id.clone())
            .collect();
        for node_id in &expired {
            self.peers.remove(node_id);
        }
        expired
    }

    pub fn get(&self, node_id: &str) -> Option<&LanPeer> {
        self.peers.get(node_id)
    }

    pub fn all(&self) -> Vec<LanPeer> {
        self.peers.values().cloned().collect()
    }

    pub fn clear(&mut self) {
        self.peers.clear();
    }
}

// --- the handle the rest of the app holds ---------------------------------

/// How often the table is swept for peers that went quiet.
const PRUNE_INTERVAL: Duration = Duration::from_secs(30);

/// Local-network discovery, as the frontend sees it.
pub const STATUS_OFF: &str = "off";
pub const STATUS_ACTIVE: &str = "active";
pub const STATUS_ERROR: &str = "error";

fn emit(app: &Option<AppHandle>, event: &str, payload: serde_json::Value) {
    if let Some(app) = app {
        let _ = app.emit(event, payload);
    }
}

fn emit_status(app: &Option<AppHandle>, status: &str) {
    emit(app, "lan-status", serde_json::json!(status));
}

fn emit_found(app: &Option<AppHandle>, peer: &LanPeer) {
    emit(app, "lan-peer-found", serde_json::json!(peer));
}

fn emit_lost(app: &Option<AppHandle>, node_id: &str) {
    emit(
        app,
        "lan-peer-lost",
        serde_json::json!({ "node_id": node_id }),
    );
}

/// Advertises this device and keeps a table of the others.
///
/// Owns no signaling of its own: it answers "can this peer be reached without
/// the internet, and at which address", which is what the route decision and
/// `lan_signaling` need from it.
pub struct LanDiscovery {
    app: Option<AppHandle>,
    peers: Arc<ParkingMutex<PeerTable>>,
    running: ParkingMutex<Option<backend::Handle>>,
}

impl LanDiscovery {
    pub fn new(app: Option<AppHandle>) -> Self {
        Self {
            app,
            peers: Arc::new(ParkingMutex::new(PeerTable::default())),
            running: ParkingMutex::new(None),
        }
    }

    /// Begin advertising and browsing. `port` is the port `lan_signaling` is
    /// listening on, which is what peers will connect back to.
    ///
    /// Starting twice is a restart rather than an error: the port changes when
    /// the listener is rebound, and an advertisement naming the old one is
    /// worse than none.
    pub fn start(&self, node_id: &str, boot_id: &str, port: u16) -> Result<(), String> {
        self.stop();
        match backend::spawn(
            self.app.clone(),
            self.peers.clone(),
            node_id.to_string(),
            boot_id.to_string(),
            port,
        ) {
            Ok(handle) => {
                *self.running.lock() = Some(handle);
                trace!("[LAN] discovery active on port {}", port);
                emit_status(&self.app, STATUS_ACTIVE);
                Ok(())
            }
            Err(e) => {
                warn_log!("[LAN] discovery could not start: {}", e);
                emit_status(&self.app, STATUS_ERROR);
                Err(e)
            }
        }
    }

    /// Stop advertising, forget every peer, and say so.
    ///
    /// The table is cleared rather than left to expire: peers in it would go on
    /// being offered as reachable by a route that is no longer running.
    pub fn stop(&self) {
        let was_running = self.running.lock().take();
        if let Some(handle) = was_running {
            handle.stop();
            self.peers.lock().clear();
            trace!("[LAN] discovery stopped");
            emit_status(&self.app, STATUS_OFF);
        }
    }

    pub fn peers(&self) -> Vec<LanPeer> {
        self.peers.lock().all()
    }

    /// Where to reach one peer, if it is on this network.
    pub fn peer(&self, node_id: &str) -> Option<LanPeer> {
        self.peers.lock().get(node_id).cloned()
    }
}

/// Record one advertisement and tell the frontend if it is news.
///
/// Shared by both backends: the difference between them is how an
/// advertisement is heard, not what is done with it.
fn observe(app: &Option<AppHandle>, peers: &ParkingMutex<PeerTable>, peer: LanPeer) {
    let node_id = peer.node_id.clone();
    let changed = peers.lock().upsert(peer.clone());
    if changed {
        trace!("[LAN] peer {} at {:?}:{}", node_id, peer.addrs, peer.port);
        emit_found(app, &peer);
    }
}

/// Forget one peer and tell the frontend.
fn forget(app: &Option<AppHandle>, peers: &ParkingMutex<PeerTable>, fullname: &str) {
    let gone = peers.lock().remove_by_fullname(fullname);
    if let Some(node_id) = gone {
        trace!("[LAN] peer {} left", node_id);
        emit_lost(app, &node_id);
    }
}

/// Drop peers that stopped announcing, and tell the frontend.
fn sweep(app: &Option<AppHandle>, peers: &ParkingMutex<PeerTable>, now: i64) {
    let expired = peers.lock().prune(now);
    for node_id in expired {
        trace!("[LAN] peer {} went quiet", node_id);
        emit_lost(app, &node_id);
    }
}

/// The mDNS backend, for every platform that can bind a multicast socket.
///
/// iOS cannot without an entitlement Apple reviews by hand, so it gets the
/// stub below until the Bonjour browser plugin exists. Both expose the same
/// two items, and everything above this line is shared. See ADR 0018.
#[cfg(not(target_os = "ios"))]
mod backend {
    use super::{
        advert_properties, forget, instance_name, observe, peer_from_advert, sweep, PeerTable,
        PRUNE_INTERVAL, SERVICE_TYPE,
    };
    use crate::crypto;
    use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
    use parking_lot::Mutex as ParkingMutex;
    use std::collections::HashMap;
    use std::sync::Arc;
    use tauri::AppHandle;

    pub(super) struct Handle {
        daemon: ServiceDaemon,
        fullname: String,
        tasks: Vec<tauri::async_runtime::JoinHandle<()>>,
    }

    impl Handle {
        pub(super) fn stop(self) {
            // Unregister first, so peers hear this device leave rather than
            // waiting out its TTL.
            let _ = self.daemon.unregister(&self.fullname);
            let _ = self.daemon.shutdown();
            for task in self.tasks {
                task.abort();
            }
        }
    }

    pub(super) fn spawn(
        app: Option<AppHandle>,
        peers: Arc<ParkingMutex<PeerTable>>,
        node_id: String,
        boot_id: String,
        port: u16,
    ) -> Result<Handle, String> {
        let daemon = ServiceDaemon::new().map_err(|e| format!("could not start mDNS: {e}"))?;

        let instance = instance_name(&node_id);
        let host = format!("{instance}.local.");
        let properties: HashMap<String, String> =
            advert_properties(&node_id, &boot_id).into_iter().collect();

        // Empty addresses plus `enable_addr_auto`: the library tracks the
        // interfaces itself, which is what keeps the advertisement right when
        // the device moves between wifi and ethernet.
        let service = ServiceInfo::new(SERVICE_TYPE, &instance, &host, "", port, properties)
            .map_err(|e| format!("could not describe the service: {e}"))?
            .enable_addr_auto();
        let fullname = service.get_fullname().to_string();

        daemon
            .register(service)
            .map_err(|e| format!("could not advertise on the network: {e}"))?;

        let receiver = daemon
            .browse(SERVICE_TYPE)
            .map_err(|e| format!("could not browse the network: {e}"))?;

        let browse = {
            let app = app.clone();
            let peers = peers.clone();
            let our_node_id = node_id.clone();
            tauri::async_runtime::spawn(async move {
                while let Ok(event) = receiver.recv_async().await {
                    match event {
                        ServiceEvent::ServiceResolved(info) => {
                            let txt: HashMap<String, String> = info
                                .txt_properties
                                .iter()
                                .map(|p| (p.key().to_lowercase(), p.val_str().to_string()))
                                .collect();
                            let addrs = info
                                .addresses
                                .iter()
                                .map(|a| a.to_ip_addr())
                                .collect::<Vec<_>>();
                            if let Some(peer) = peer_from_advert(
                                &txt,
                                &info.fullname,
                                addrs,
                                info.port,
                                &our_node_id,
                                crypto::now_ms(),
                            ) {
                                observe(&app, &peers, peer);
                            }
                        }
                        ServiceEvent::ServiceRemoved(_ty, fullname) => {
                            forget(&app, &peers, &fullname);
                        }
                        _ => {}
                    }
                }
            })
        };

        let prune = {
            let app = app.clone();
            let peers = peers.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(PRUNE_INTERVAL).await;
                    sweep(&app, &peers, crypto::now_ms());
                }
            })
        };

        Ok(Handle {
            daemon,
            fullname,
            tasks: vec![browse, prune],
        })
    }
}

/// The iOS stub.
///
/// Browsing there goes through `NWBrowser`, which needs only an Info.plist
/// entry, rather than the raw multicast socket this crate binds, which needs
/// an entitlement Apple reviews by hand. Until that plugin exists the app
/// falls back to the broker on iOS, which is what it does today.
///
/// Everything above this module is platform independent and already shared,
/// so the work is a `spawn` that returns a `Handle` and feeds the same
/// `PeerTable`. What it involves is written down under "Still to do: the iOS
/// backend" in DEVELOPMENT.md.
#[cfg(target_os = "ios")]
mod backend {
    use super::PeerTable;
    use parking_lot::Mutex as ParkingMutex;
    use std::sync::Arc;
    use tauri::AppHandle;

    pub(super) struct Handle;

    impl Handle {
        pub(super) fn stop(self) {}
    }

    pub(super) fn spawn(
        _app: Option<AppHandle>,
        _peers: Arc<ParkingMutex<PeerTable>>,
        _node_id: String,
        _boot_id: String,
        _port: u16,
    ) -> Result<Handle, String> {
        Err(
            "local-network discovery on iOS needs an NWBrowser backend, which is not built yet; \
             see \"Still to do: the iOS backend\" in DEVELOPMENT.md"
                .to_string(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    const US: &str = "our-node-id";

    fn txt(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn advert(node_id: &str) -> HashMap<String, String> {
        txt(&[("nid", node_id), ("boot", "boot-1"), ("v", "1")])
    }

    fn addr(last: u8) -> Vec<IpAddr> {
        vec![IpAddr::V4(Ipv4Addr::new(192, 168, 1, last))]
    }

    fn peer(node_id: &str, last: u8, now: i64) -> LanPeer {
        peer_from_advert(
            &advert(node_id),
            &format!("{node_id}._oyot._tcp.local."),
            addr(last),
            7000,
            US,
            now,
        )
        .expect("a well-formed advert")
    }

    #[test]
    fn a_well_formed_advert_becomes_a_peer() {
        let got = peer("peer-a", 20, 1_000);
        assert_eq!(got.node_id, "peer-a");
        assert_eq!(got.boot_id.as_deref(), Some("boot-1"));
        assert_eq!(got.port, 7000);
        assert_eq!(got.addrs, addr(20));
    }

    // Every device browses for the service it also advertises, so it sees
    // itself. Connecting to yourself is not a useful use of an evening.
    #[test]
    fn our_own_advertisement_is_not_a_peer() {
        let got = peer_from_advert(&advert(US), "self._oyot._tcp.local.", addr(2), 7000, US, 0);
        assert!(got.is_none());
    }

    #[test]
    fn an_advert_from_a_version_we_do_not_speak_is_ignored() {
        let props = txt(&[("nid", "peer-a"), ("v", "2")]);
        assert!(peer_from_advert(&props, "f", addr(2), 7000, US, 0).is_none());
    }

    #[test]
    fn an_advert_with_no_node_id_is_ignored() {
        let props = txt(&[("v", "1")]);
        assert!(peer_from_advert(&props, "f", addr(2), 7000, US, 0).is_none());
    }

    #[test]
    fn an_advert_with_nowhere_to_connect_is_ignored() {
        assert!(peer_from_advert(&advert("peer-a"), "f", vec![], 7000, US, 0).is_none());
        assert!(peer_from_advert(&advert("peer-a"), "f", addr(2), 0, US, 0).is_none());
    }

    // mDNS re-announces on a timer. Reporting each one as a change would run a
    // reconnect sweep every time a peer said it was still there.
    #[test]
    fn re_announcing_an_unchanged_peer_is_not_a_change() {
        let mut table = PeerTable::default();
        assert!(table.upsert(peer("peer-a", 20, 1_000)), "first sighting");
        assert!(
            !table.upsert(peer("peer-a", 20, 2_000)),
            "same device, same address, later"
        );
    }

    // The library hands addresses over as a set, so the same announcement can
    // arrive in a different order. Reading that as a peer that moved would run
    // a reconnect sweep on every re-announcement, at random.
    #[test]
    fn the_same_addresses_in_a_different_order_are_not_a_change() {
        let mut table = PeerTable::default();
        let v4 = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20));
        let v6 = IpAddr::V6("fe80::1".parse().unwrap());

        let one = peer_from_advert(&advert("peer-a"), "f", vec![v4, v6], 7000, US, 1_000).unwrap();
        let other =
            peer_from_advert(&advert("peer-a"), "f", vec![v6, v4], 7000, US, 2_000).unwrap();

        assert!(table.upsert(one));
        assert!(!table.upsert(other), "same device, same addresses");
    }

    #[test]
    fn an_advert_is_read_with_ipv4_first() {
        let v4 = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20));
        let v6 = IpAddr::V6("fe80::1".parse().unwrap());
        let got = peer_from_advert(&advert("peer-a"), "f", vec![v6, v4], 7000, US, 0).unwrap();
        assert_eq!(got.addrs, vec![v4, v6]);
    }

    #[test]
    fn a_peer_that_moved_to_another_address_is_a_change() {
        let mut table = PeerTable::default();
        table.upsert(peer("peer-a", 20, 1_000));
        assert!(table.upsert(peer("peer-a", 21, 2_000)));
    }

    #[test]
    fn a_peer_that_restarted_is_a_change() {
        let mut table = PeerTable::default();
        table.upsert(peer("peer-a", 20, 1_000));

        let mut restarted = peer("peer-a", 20, 2_000);
        restarted.boot_id = Some("boot-2".to_string());
        assert!(table.upsert(restarted), "a new run of the peer");
    }

    #[test]
    fn a_departing_peer_is_removed_by_its_instance() {
        let mut table = PeerTable::default();
        let p = peer("peer-a", 20, 1_000);
        let fullname = p.fullname.clone();
        table.upsert(p);

        assert_eq!(
            table.remove_by_fullname(&fullname).as_deref(),
            Some("peer-a")
        );
        assert!(table.get("peer-a").is_none());
        assert_eq!(table.remove_by_fullname(&fullname), None);
    }

    // A closed laptop announces nothing on its way out.
    #[test]
    fn a_peer_that_went_quiet_is_pruned() {
        let mut table = PeerTable::default();
        table.upsert(peer("peer-a", 20, 1_000));
        table.upsert(peer("peer-b", 21, 1_000 + PEER_TTL_MS));

        let gone = table.prune(1_000 + PEER_TTL_MS + 1);

        assert_eq!(gone, vec!["peer-a".to_string()]);
        assert!(table.get("peer-b").is_some(), "still inside its TTL");
    }

    #[test]
    fn an_instance_name_is_stable_and_dns_safe() {
        let node_id = "abc-DEF_123";
        assert_eq!(instance_name(node_id), instance_name(node_id));
        assert!(instance_name(node_id)
            .chars()
            .all(|c| c.is_ascii_alphanumeric()));
        assert_ne!(instance_name(node_id), instance_name("another-node"));
    }

    #[test]
    fn what_we_advertise_is_what_a_peer_reads_back() {
        let props: HashMap<String, String> =
            advert_properties("peer-a", "boot-9").into_iter().collect();
        let got = peer_from_advert(&props, "f", addr(2), 7000, US, 5).unwrap();

        assert_eq!(got.node_id, "peer-a");
        assert_eq!(got.boot_id.as_deref(), Some("boot-9"));
    }

    // The record is readable by everyone on the network, so what is not in it
    // matters as much as what is.
    #[test]
    fn the_advertisement_carries_no_device_name() {
        let props = advert_properties("peer-a", "boot-9");
        let keys: Vec<&str> = props.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, vec!["nid", "boot", "v"]);
    }
}

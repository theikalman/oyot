//! Finding this user's other devices on the local network.
//!
//! Advertises one mDNS service and browses for the same, so two devices on one
//! wifi can reach each other with no internet at all. Since ADR 0022 the
//! broker is gone, and since ADR 0023 this is one of two ways a peer is found:
//! the other is an address the user stored for it, which is a different module
//! writing into the same `Peers` table.
//!
//! The TXT record carries the node_id and nothing else identifying. A device
//! name in it would broadcast "Aji's laptop" to every stranger on every network
//! the user joins, to save one round trip on a flow that already requires
//! confirming a node_id by hand. A tailnet address does not go in it either,
//! for the same reason: it is readable by everyone on the network.
//!
//! See docs/decisions/0018-local-network-sync-as-a-second-signaling-transport.md.

use crate::network::peers::{normalize_addrs, Peer, PeerSource, Peers};
use parking_lot::Mutex as ParkingMutex;
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
) -> Option<Peer> {
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
    Some(Peer {
        node_id,
        source: PeerSource::Mdns,
        boot_id: txt.get(TXT_BOOT).map(|s| s.to_string()),
        addrs: normalize_addrs(addrs),
        host: None,
        port,
        seen_at: now,
        key: fullname.to_string(),
    })
}

// --- the handle the rest of the app holds ---------------------------------

/// How often the peer table is swept for peers that went quiet.
const PRUNE_INTERVAL: Duration = Duration::from_secs(30);

/// Local-network discovery, as the frontend sees it.
pub const STATUS_OFF: &str = "off";
pub const STATUS_ACTIVE: &str = "active";
pub const STATUS_ERROR: &str = "error";

fn emit_status(app: &Option<AppHandle>, status: &str) {
    if let Some(app) = app {
        let _ = app.emit("lan-status", serde_json::json!(status));
    }
}

/// Advertises this device and reports the others it hears.
///
/// Owns no signaling and no peer table of its own: it answers "who is on this
/// wifi, and at which address", and writes that into the shared `Peers`.
pub struct LanDiscovery {
    app: Option<AppHandle>,
    peers: Arc<Peers>,
    running: ParkingMutex<Option<backend::Handle>>,
}

impl LanDiscovery {
    pub fn new(app: Option<AppHandle>, peers: Arc<Peers>) -> Self {
        Self {
            app,
            peers,
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

    /// Stop advertising, forget every peer found this way, and say so.
    ///
    /// Those entries are cleared rather than left to expire: they would go on
    /// being offered as reachable by a route that is no longer running. Peers
    /// found at a stored address are untouched, because that route is still up.
    pub fn stop(&self) {
        let was_running = self.running.lock().take();
        if let Some(handle) = was_running {
            handle.stop();
            self.peers.clear_source(PeerSource::Mdns);
            trace!("[LAN] discovery stopped");
            emit_status(&self.app, STATUS_OFF);
        }
    }
}

/// The mDNS backend, for every platform that can bind a multicast socket.
///
/// iOS cannot without an entitlement Apple reviews by hand, so it gets the
/// stub below until the Bonjour browser plugin exists. Both expose the same
/// two items, and everything above this line is shared. See ADR 0018.
#[cfg(not(target_os = "ios"))]
mod backend {
    use super::{advert_properties, instance_name, peer_from_advert, PRUNE_INTERVAL, SERVICE_TYPE};
    use crate::crypto;
    use crate::network::peers::{PeerSource, Peers};
    use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
    use std::collections::HashMap;
    use std::sync::Arc;

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
        peers: Arc<Peers>,
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
                                peers.observe(peer);
                            }
                        }
                        ServiceEvent::ServiceRemoved(_ty, fullname) => {
                            peers.forget_key(PeerSource::Mdns, &fullname);
                        }
                        _ => {}
                    }
                }
            })
        };

        let prune = {
            let peers = peers.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(PRUNE_INTERVAL).await;
                    peers.sweep(crypto::now_ms());
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
/// an entitlement Apple reviews by hand. Until that plugin exists an iOS
/// device finds nobody on the network it is on. Since ADR 0023 that is no
/// longer the whole story: an address the user types is reachable there like
/// anywhere else, so iOS syncs with the devices it has been given an address
/// for.
///
/// Everything above this module is platform independent and already shared,
/// so the work is a `spawn` that returns a `Handle` and feeds the same
/// `Peers`. What it involves is written down under "Still to do: the iOS
/// backend" in DEVELOPMENT.md.
#[cfg(target_os = "ios")]
mod backend {
    use crate::network::peers::Peers;
    use std::sync::Arc;

    pub(super) struct Handle;

    impl Handle {
        pub(super) fn stop(self) {}
    }

    pub(super) fn spawn(
        _peers: Arc<Peers>,
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

    #[test]
    fn a_well_formed_advert_becomes_a_peer() {
        let got =
            peer_from_advert(&advert("peer-a"), "f", addr(20), 7000, US, 1_000).expect("a peer");

        assert_eq!(got.node_id, "peer-a");
        assert_eq!(got.source, PeerSource::Mdns);
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

    #[test]
    fn an_advert_is_read_with_ipv4_first() {
        let v4 = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20));
        let v6 = IpAddr::V6("fe80::1".parse().unwrap());
        let got = peer_from_advert(&advert("peer-a"), "f", vec![v6, v4], 7000, US, 0).unwrap();
        assert_eq!(got.addrs, vec![v4, v6]);
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

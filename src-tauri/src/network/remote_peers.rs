//! Turning a stored address into a peer you can actually reach.
//!
//! [ADR 0023](../../../docs/decisions/0023-reach-a-peer-at-an-address-you-already-know.md).
//! mDNS hands discovery two things at once: where a device is, and the fact
//! that it is there at all. A row in `device_endpoints` is only the first, and
//! every reconnect path, the pairing form and the device list are built on
//! having the second.
//!
//! So this asks. A signed `ping` to each stored address, a signed `pong` back
//! on the same connection, and the peer goes into the same table mDNS writes
//! into. An address that does not answer is not a peer, which is the same
//! answer the local route gives for a device that is switched off.
//!
//! A TCP connect would have been cheaper and would have proved the wrong
//! thing: that something is listening, not that it is the device we mean.

use crate::crypto;
use crate::endpoints::{self, DeviceEndpoint};
use crate::network::lan_signaling;
use crate::network::message::SignalingMessage;
use crate::network::peers::{normalize_addrs, Peer, PeerSource, Peers};
use crate::network::signaling_manager::SignalingManager;
use parking_lot::Mutex as ParkingMutex;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;

/// How often every stored address is tried.
///
/// Two thirds of the peer TTL, so a device that is up stays up in the table on
/// one successful probe out of two. Short enough that closing a laptop and
/// opening another is noticed while the user is still looking at the screen.
const PROBE_INTERVAL: Duration = Duration::from_secs(45);

/// What a probe and its answer carry.
#[derive(Debug, Serialize, Deserialize)]
struct ProbePayload {
    /// The sender's id for this run of its process, so a device that restarted
    /// reads as a change rather than as the same peer still sitting there.
    boot_id: String,
}

/// Probes every stored address on a timer, and on demand.
pub struct RemoteProbe {
    peers: Arc<Peers>,
    db: Arc<ParkingMutex<Connection>>,
    manager: Arc<SignalingManager>,
    boot_id: String,
    running: ParkingMutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    /// Woken when an address is added, so someone who has just typed one finds
    /// out whether it was right instead of waiting out the interval.
    kick: Arc<Notify>,
}

impl RemoteProbe {
    pub fn new(
        peers: Arc<Peers>,
        db: Arc<ParkingMutex<Connection>>,
        manager: Arc<SignalingManager>,
        boot_id: String,
    ) -> Self {
        Self {
            peers,
            db,
            manager,
            boot_id,
            running: ParkingMutex::new(None),
            kick: Arc::new(Notify::new()),
        }
    }

    /// Start probing. Starting twice is a restart rather than an error.
    pub fn start(&self) {
        self.stop();

        let peers = self.peers.clone();
        let db = self.db.clone();
        let manager = self.manager.clone();
        let boot_id = self.boot_id.clone();
        let kick = self.kick.clone();

        let task = tauri::async_runtime::spawn(async move {
            loop {
                probe_all(&peers, &db, &manager, &boot_id).await;
                tokio::select! {
                    _ = tokio::time::sleep(PROBE_INTERVAL) => {}
                    _ = kick.notified() => {}
                }
            }
        });
        *self.running.lock() = Some(task);
        trace!(
            "[remote] probing stored addresses every {:?}",
            PROBE_INTERVAL
        );
    }

    /// Stop probing and forget what probing found.
    ///
    /// Those entries are dropped rather than left to expire, for the same
    /// reason discovery drops its own: they would go on being offered as
    /// reachable by something that is no longer running.
    pub fn stop(&self) {
        if let Some(task) = self.running.lock().take() {
            task.abort();
            self.peers.clear_source(PeerSource::Address);
            trace!("[remote] probing stopped");
        }
    }

    /// Run a pass now, without waiting for the interval.
    pub fn probe_now(&self) {
        self.kick.notify_one();
    }
}

/// One pass over every stored address.
async fn probe_all(
    peers: &Arc<Peers>,
    db: &Arc<ParkingMutex<Connection>>,
    manager: &Arc<SignalingManager>,
    boot_id: &str,
) {
    let Some(me) = manager.public_identity() else {
        return;
    };

    let stored = {
        let db = db.lock();
        match endpoints::load_endpoints(&db, &me.user_id) {
            Ok(rows) => rows,
            Err(e) => {
                warn_log!("[remote] could not read stored addresses: {}", e);
                return;
            }
        }
    };

    for (node_id, addresses) in by_peer(stored) {
        // Already here on this network, so there is nothing an address could
        // add. If wifi goes away, the next pass finds it the other way.
        if peers
            .best(&node_id)
            .is_some_and(|p| p.source == PeerSource::Mdns)
        {
            continue;
        }

        match probe_peer(manager, boot_id, &node_id, &addresses).await {
            Some((peer, answered)) => {
                peers.observe(peer);
                let db = db.lock();
                let _ = endpoints::mark_endpoint_ok(
                    &db,
                    &me.user_id,
                    &node_id,
                    &answered.host,
                    answered.port,
                    crypto::now_ms(),
                );
            }
            None => peers.forget(&node_id, PeerSource::Address),
        }
    }
}

/// Group stored rows by the device they belong to, preserving their order.
fn by_peer(rows: Vec<DeviceEndpoint>) -> Vec<(String, Vec<DeviceEndpoint>)> {
    let mut order: Vec<String> = Vec::new();
    let mut grouped: HashMap<String, Vec<DeviceEndpoint>> = HashMap::new();
    for row in rows {
        if !grouped.contains_key(&row.peer_node_id) {
            order.push(row.peer_node_id.clone());
        }
        grouped
            .entry(row.peer_node_id.clone())
            .or_default()
            .push(row);
    }
    order
        .into_iter()
        .filter_map(|id| grouped.remove(&id).map(|rows| (id, rows)))
        .collect()
}

/// Try each of a device's addresses until one answers.
///
/// Stops at the first answer: a second address for the same device is an
/// alternative, not an addition, and trying the rest would cost a connection
/// each to learn nothing.
async fn probe_peer(
    manager: &Arc<SignalingManager>,
    boot_id: &str,
    node_id: &str,
    addresses: &[DeviceEndpoint],
) -> Option<(Peer, DeviceEndpoint)> {
    for endpoint in addresses {
        match probe_one(manager, boot_id, node_id, endpoint).await {
            Ok(peer) => return Some((peer, endpoint.clone())),
            Err(e) => trace!(
                "[remote] {}:{} did not answer for {}: {}",
                endpoint.host,
                endpoint.port,
                node_id,
                e
            ),
        }
    }
    None
}

async fn probe_one(
    manager: &Arc<SignalingManager>,
    boot_id: &str,
    node_id: &str,
    endpoint: &DeviceEndpoint,
) -> Result<Peer, String> {
    let payload = serde_json::json!({ "boot_id": boot_id }).to_string();
    let ping = manager.seal_for(node_id, "ping", payload)?;

    let resolved: Vec<std::net::SocketAddr> =
        tokio::net::lookup_host((endpoint.host.as_str(), endpoint.port))
            .await
            .map_err(|e| format!("{} does not resolve: {e}", endpoint.host))?
            .collect();

    let mut last = "that address resolves to nothing".to_string();
    for addr in resolved {
        match lan_signaling::request(addr, &ping).await {
            Ok(reply) => {
                let peer_boot = admit_pong(manager, node_id, &reply)?;
                return Ok(Peer {
                    node_id: node_id.to_string(),
                    source: PeerSource::Address,
                    boot_id: peer_boot,
                    addrs: normalize_addrs(vec![addr.ip()]),
                    host: Some(endpoint.host.clone()),
                    port: endpoint.port,
                    seen_at: crypto::now_ms(),
                    key: format!("{}:{}", endpoint.host, endpoint.port),
                });
            }
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// Whether an answer is a `pong` from the device we asked, and what it says.
///
/// An answer is checked exactly as an unsolicited message is - right recipient,
/// valid signature, recent, unseen nonce - and then for being from the node we
/// addressed. Without that last check, anything that can occupy an address
/// could answer for any device the user has an address for.
fn admit_pong(
    manager: &Arc<SignalingManager>,
    node_id: &str,
    reply: &SignalingMessage,
) -> Result<Option<String>, String> {
    if reply.msg_type != "pong" {
        return Err(format!(
            "answered with a {} rather than a pong",
            reply.msg_type
        ));
    }
    if reply.from != node_id {
        return Err(format!(
            "that address answers for {}, not for us",
            reply.from
        ));
    }
    if !manager.admit_reply(reply) {
        return Err("the answer did not verify".to_string());
    }
    Ok(serde_json::from_str::<ProbePayload>(&reply.payload)
        .ok()
        .map(|p| p.boot_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{LocalIdentity, UserIdentity};

    /// Two devices, each holding its own key and knowing the other's node_id.
    fn two_devices() -> (Arc<SignalingManager>, Arc<SignalingManager>, String, String) {
        let mut built = Vec::new();
        for (user, name) in [("u1", "Laptop"), ("u2", "Phone")] {
            let signing_key = crypto::generate_signing_key();
            let node_id = crypto::encode_node_id(&signing_key.verifying_key());
            let mgr = Arc::new(SignalingManager::new(Arc::new(Peers::new(None))));
            mgr.set_identity(LocalIdentity {
                public: UserIdentity {
                    user_id: user.to_string(),
                    node_id: node_id.clone(),
                    display_name: name.to_string(),
                },
                signing_key,
            });
            built.push((mgr, node_id));
        }
        let (them, their_id) = built.pop().unwrap();
        let (us, our_id) = built.pop().unwrap();
        (us, them, our_id, their_id)
    }

    fn endpoint(node_id: &str, host: &str) -> DeviceEndpoint {
        DeviceEndpoint {
            peer_node_id: node_id.to_string(),
            host: host.to_string(),
            port: 19701,
            added_at: 0,
            last_ok: None,
        }
    }

    #[test]
    fn rows_are_grouped_by_device_in_the_order_they_arrived() {
        let grouped = by_peer(vec![
            endpoint("peer-a", "laptop.ts.net"),
            endpoint("peer-b", "tablet.ts.net"),
            endpoint("peer-a", "100.64.0.9"),
        ]);

        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped[0].0, "peer-a");
        assert_eq!(grouped[0].1.len(), 2, "both of peer-a's addresses");
        assert_eq!(grouped[0].1[0].host, "laptop.ts.net", "in stored order");
        assert_eq!(grouped[1].0, "peer-b");
    }

    #[test]
    fn nothing_stored_is_nothing_to_probe() {
        assert!(by_peer(vec![]).is_empty());
    }

    #[test]
    fn a_pong_from_the_device_we_asked_is_admitted() {
        let (us, them, our_id, their_id) = two_devices();
        let payload = serde_json::json!({ "boot_id": "boot-7" }).to_string();
        let pong = them.seal_for(&our_id, "pong", payload).unwrap();

        let got = admit_pong(&us, &their_id, &pong).unwrap();

        assert_eq!(got.as_deref(), Some("boot-7"));
    }

    // Anything can occupy an address. Without this, whatever answers there
    // would be recorded as a route to the device the user meant.
    #[test]
    fn a_pong_from_a_different_device_is_refused() {
        let (us, them, our_id, _) = two_devices();
        let payload = serde_json::json!({ "boot_id": "boot-7" }).to_string();
        let pong = them.seal_for(&our_id, "pong", payload).unwrap();

        let err = admit_pong(&us, "some-other-node", &pong).unwrap_err();

        assert!(err.contains("answers for"), "got: {err}");
    }

    #[test]
    fn an_answer_that_is_not_a_pong_is_refused() {
        let (us, them, our_id, their_id) = two_devices();
        let offer = them.seal_for(&our_id, "offer", "sdp".to_string()).unwrap();

        let err = admit_pong(&us, &their_id, &offer).unwrap_err();

        assert!(err.contains("rather than a pong"), "got: {err}");
    }

    // The signature is what makes the answer worth anything: an address that
    // replies with a well-formed unsigned pong proves only that something
    // there can write JSON.
    #[test]
    fn an_unsigned_pong_is_refused() {
        let (us, _them, our_id, their_id) = two_devices();
        let forged = SignalingMessage {
            from: their_id.clone(),
            to: Some(our_id),
            msg_type: "pong".to_string(),
            payload: serde_json::json!({ "boot_id": "boot-7" }).to_string(),
            ts: crypto::now_ms(),
            nonce: crypto::random_nonce(),
            sig: "not-a-signature".to_string(),
        };

        let err = admit_pong(&us, &their_id, &forged).unwrap_err();

        assert!(err.contains("did not verify"), "got: {err}");
    }

    // A device that answers a probe without saying which run of the process it
    // is, is still reachable. Losing the restart signal is not losing the peer.
    #[test]
    fn a_pong_with_nothing_readable_in_it_is_still_a_pong() {
        let (us, them, our_id, their_id) = two_devices();
        let pong = them.seal_for(&our_id, "pong", "{}".to_string()).unwrap();

        assert_eq!(admit_pong(&us, &their_id, &pong).unwrap(), None);
    }
}

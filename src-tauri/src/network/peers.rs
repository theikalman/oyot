//! Who this device can reach right now, and how it found out.
//!
//! Discovery used to be one thing, so the table of peers lived inside it. Since
//! [ADR 0023](../../../docs/decisions/0023-reach-a-peer-at-an-address-you-already-know.md)
//! there are two ways a device becomes reachable - it announced itself on this
//! network, or the user told us where it is and it answered a probe - and they
//! have nothing in common except the answer they produce. So the answer lives
//! here, and each source writes into it.
//!
//! One node can hold an entry per source at once: a laptop on this wifi that
//! also has a tailnet address is genuinely reachable twice. `best` picks the
//! local one, because routing signaling for the device across the room through
//! a VPN and back is slower for no gain.

use parking_lot::Mutex as ParkingMutex;
use serde::Serialize;
use std::collections::HashMap;
use std::net::IpAddr;
use tauri::{AppHandle, Emitter};

/// How long a peer found at a stored address stays in the table after it last
/// answered.
///
/// Comfortably longer than the probe interval, so a device is not dropped and
/// re-found on a slow network, and short enough that a laptop carried out of
/// the house stops being offered as reachable. A device found on this network
/// is not timed out by it: see `PeerSource::ages_out`.
pub const PEER_TTL_MS: i64 = 90_000;

/// How a peer was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PeerSource {
    /// It announced itself on this network.
    Mdns,
    /// It answered a probe at an address the user stored for it.
    Address,
}

impl PeerSource {
    /// Lower is better. `best` uses this and nothing else, so the preference
    /// between sources is one line rather than a branch in three callers.
    fn rank(self) -> u8 {
        match self {
            PeerSource::Mdns => 0,
            PeerSource::Address => 1,
        }
    }

    /// Whether the table drops this source's entries once `seen_at` is older
    /// than the TTL.
    ///
    /// A stored address's are: its prober writes a fresh `seen_at` every time
    /// the device answers. mDNS entries are not, because mdns-sd reports a
    /// device when it is first resolved and when its records change, and
    /// refreshes them without a word, so `seen_at` is when it was first found.
    /// Timing that out dropped every device on this network a minute and a
    /// half after it was found, nothing ever found it again, and every dial
    /// from then on had no route. mdns-sd times the records out itself,
    /// within two minutes of the device going quiet, and says so with
    /// `ServiceRemoved`.
    fn ages_out(self) -> bool {
        match self {
            PeerSource::Mdns => false,
            PeerSource::Address => true,
        }
    }
}

/// A device this one can reach.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Peer {
    pub node_id: String,
    pub source: PeerSource,
    /// The peer's id for this run of its process, when we know one. The same
    /// idea as the signaling boot id (ADR 0011) and not the same value: a
    /// device that restarted should read as a change here even when it comes
    /// back at the address it left.
    pub boot_id: Option<String>,
    pub addrs: Vec<IpAddr>,
    /// The host as the user wrote it, for an address peer. `None` for mDNS,
    /// which has no name worth showing that the addresses do not already say.
    pub host: Option<String>,
    pub port: u16,
    /// When we last heard from this peer.
    pub seen_at: i64,
    /// What this entry came from, so a removal can be matched back to the peer
    /// without re-deriving it: the mDNS instance, or `host:port`.
    #[serde(skip)]
    pub key: String,
}

impl Peer {
    /// Whether this is the same device, at the same place, as `other`.
    ///
    /// `seen_at` is excluded on purpose: hearing from a peer we already have
    /// should not read as news. Both sources repeat on a timer, and treating
    /// each repeat as a change would run a reconnect sweep every time.
    fn same_reachability(&self, other: &Peer) -> bool {
        self.node_id == other.node_id
            && self.source == other.source
            && self.boot_id == other.boot_id
            && self.port == other.port
            && self.addrs == other.addrs
            && self.host == other.host
    }
}

/// Sort addresses IPv4 first, then by value, and drop duplicates.
///
/// Both sources hand these over unordered - mDNS as a set, a resolver as
/// whatever DNS returned - so the same sighting can arrive in a different order
/// each time, and an order-sensitive comparison would read that as a peer that
/// moved and run a reconnect sweep for nothing. IPv4 first is also the order
/// worth trying, which is what the sender wants anyway.
pub fn normalize_addrs(mut addrs: Vec<IpAddr>) -> Vec<IpAddr> {
    addrs.sort_by_key(|a| (!a.is_ipv4(), a.to_string()));
    addrs.dedup();
    addrs
}

/// Which devices are reachable right now, by which route.
#[derive(Debug, Default)]
pub struct PeerTable {
    peers: HashMap<(String, PeerSource), Peer>,
}

impl PeerTable {
    /// Record a sighting. Reports whether anything about how to reach this
    /// peer changed, so hearing from a peer we already have does not trigger a
    /// reconnect sweep.
    pub fn upsert(&mut self, peer: Peer) -> bool {
        let key = (peer.node_id.clone(), peer.source);
        let changed = match self.peers.get(&key) {
            Some(existing) => !existing.same_reachability(&peer),
            None => true,
        };
        self.peers.insert(key, peer);
        changed
    }

    /// Drop the peer one source's entry points at, returning its node_id.
    pub fn remove_by_key(&mut self, source: PeerSource, key: &str) -> Option<String> {
        let node_id = self
            .peers
            .values()
            .find(|p| p.source == source && p.key == key)
            .map(|p| p.node_id.clone())?;
        self.peers.remove(&(node_id.clone(), source));
        Some(node_id)
    }

    /// Drop one node's entry for one source. Reports whether there was one.
    pub fn remove(&mut self, node_id: &str, source: PeerSource) -> bool {
        self.peers.remove(&(node_id.to_string(), source)).is_some()
    }

    /// Drop peers we have not heard from inside the TTL, from the sources
    /// that say each time they hear from one (`PeerSource::ages_out`).
    ///
    /// An address that stopped answering is forgotten by the probe that
    /// found out, but an entry nothing probes any more would otherwise stay
    /// in the table as a route that may not work. A device on this network
    /// that is closed, or carried out of range, is mdns-sd's to notice: its
    /// records lapse, and discovery forgets it then.
    pub fn prune(&mut self, now: i64) -> Vec<(String, PeerSource)> {
        let expired: Vec<(String, PeerSource)> = self
            .peers
            .values()
            .filter(|p| p.source.ages_out() && now - p.seen_at > PEER_TTL_MS)
            .map(|p| (p.node_id.clone(), p.source))
            .collect();
        for key in &expired {
            self.peers.remove(key);
        }
        expired
    }

    /// The best route to one peer, or `None` if there is none.
    pub fn best(&self, node_id: &str) -> Option<&Peer> {
        self.routes(node_id).into_iter().next()
    }

    /// Every route to one peer, best first: a dial tries the next when one
    /// fails.
    pub fn routes(&self, node_id: &str) -> Vec<&Peer> {
        let mut routes: Vec<&Peer> = self
            .peers
            .values()
            .filter(|p| p.node_id == node_id)
            .collect();
        routes.sort_by_key(|p| p.source.rank());
        routes
    }

    pub fn all(&self) -> Vec<Peer> {
        self.peers.values().cloned().collect()
    }

    /// Forget everything one source found, returning what was dropped. Used
    /// when that source stops: its entries would go on being offered as
    /// reachable by a route that is no longer running.
    pub fn clear_source(&mut self, source: PeerSource) -> Vec<String> {
        let gone: Vec<String> = self
            .peers
            .values()
            .filter(|p| p.source == source)
            .map(|p| p.node_id.clone())
            .collect();
        self.peers.retain(|_, p| p.source != source);
        gone
    }
}

/// The table plus the handle it reports through.
///
/// Held by `AppState` and shared by every source, so "who can we reach" has one
/// home and the frontend hears about all of it the same way.
pub struct Peers {
    app: Option<AppHandle>,
    table: ParkingMutex<PeerTable>,
    /// The node_id of every peer that became reachable, for the sync engine
    /// to dial it (ADR 0032, decision 1).
    found: tokio::sync::broadcast::Sender<String>,
}

impl Peers {
    pub fn new(app: Option<AppHandle>) -> Self {
        Self {
            app,
            table: ParkingMutex::new(PeerTable::default()),
            found: tokio::sync::broadcast::channel(64).0,
        }
    }

    /// Hear about every peer that becomes reachable, by node_id.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<String> {
        self.found.subscribe()
    }

    /// Record one sighting and tell the frontend if it is news.
    pub fn observe(&self, peer: Peer) {
        let changed = self.table.lock().upsert(peer.clone());
        if changed {
            trace!(
                "[peers] {} reachable via {:?} at {:?}:{}",
                peer.node_id,
                peer.source,
                peer.addrs,
                peer.port
            );
            self.emit_found(&peer);
        }
    }

    /// Forget the peer one source's entry points at.
    pub fn forget_key(&self, source: PeerSource, key: &str) {
        let gone = self.table.lock().remove_by_key(source, key);
        if let Some(node_id) = gone {
            trace!("[peers] {} left ({:?})", node_id, source);
            self.emit_lost(&node_id, source);
        }
    }

    /// Forget one node's entry for one source.
    pub fn forget(&self, node_id: &str, source: PeerSource) {
        if self.table.lock().remove(node_id, source) {
            trace!("[peers] {} unreachable via {:?}", node_id, source);
            self.emit_lost(node_id, source);
        }
    }

    /// Drop peers that went quiet, and tell the frontend.
    pub fn sweep(&self, now: i64) {
        let expired = self.table.lock().prune(now);
        for (node_id, source) in expired {
            trace!("[peers] {} went quiet ({:?})", node_id, source);
            self.emit_lost(&node_id, source);
        }
    }

    /// Forget everything one source found, and tell the frontend.
    pub fn clear_source(&self, source: PeerSource) {
        let gone = self.table.lock().clear_source(source);
        for node_id in gone {
            self.emit_lost(&node_id, source);
        }
    }

    /// The best route to one peer, if there is one.
    pub fn best(&self, node_id: &str) -> Option<Peer> {
        self.table.lock().best(node_id).cloned()
    }

    /// Every route to one peer, best first.
    pub fn routes(&self, node_id: &str) -> Vec<Peer> {
        self.table
            .lock()
            .routes(node_id)
            .into_iter()
            .cloned()
            .collect()
    }

    pub fn all(&self) -> Vec<Peer> {
        self.table.lock().all()
    }

    fn emit_found(&self, peer: &Peer) {
        // Nobody listening is fine: the engine is not running.
        let _ = self.found.send(peer.node_id.clone());
        if let Some(app) = &self.app {
            let _ = app.emit("peer-found", serde_json::json!(peer));
        }
    }

    fn emit_lost(&self, node_id: &str, source: PeerSource) {
        if let Some(app) = &self.app {
            let _ = app.emit(
                "peer-lost",
                serde_json::json!({ "node_id": node_id, "source": source }),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn addr(last: u8) -> Vec<IpAddr> {
        vec![IpAddr::V4(Ipv4Addr::new(192, 168, 1, last))]
    }

    fn peer(node_id: &str, source: PeerSource, last: u8, now: i64) -> Peer {
        Peer {
            node_id: node_id.to_string(),
            source,
            boot_id: Some("boot-1".to_string()),
            addrs: addr(last),
            host: None,
            port: 7000,
            seen_at: now,
            key: format!("{node_id}-{source:?}"),
        }
    }

    #[test]
    fn hearing_from_an_unchanged_peer_is_not_a_change() {
        let mut table = PeerTable::default();
        assert!(table.upsert(peer("a", PeerSource::Mdns, 20, 1_000)));
        assert!(!table.upsert(peer("a", PeerSource::Mdns, 20, 2_000)));
    }

    #[test]
    fn a_peer_that_moved_is_a_change() {
        let mut table = PeerTable::default();
        table.upsert(peer("a", PeerSource::Mdns, 20, 1_000));
        assert!(table.upsert(peer("a", PeerSource::Mdns, 21, 2_000)));
    }

    // A laptop on this wifi that also has a stored address is reachable twice,
    // and losing one route must not take the other with it.
    #[test]
    fn one_node_can_be_reachable_by_two_routes_at_once() {
        let mut table = PeerTable::default();
        table.upsert(peer("a", PeerSource::Mdns, 20, 1_000));
        table.upsert(peer("a", PeerSource::Address, 99, 1_000));

        assert_eq!(table.all().len(), 2);
        table.remove("a", PeerSource::Mdns);
        assert_eq!(
            table.best("a").map(|p| p.source),
            Some(PeerSource::Address),
            "the address route survives the local one going away"
        );
    }

    // Routing signaling for the device across the room out through a VPN and
    // back is slower for no gain.
    #[test]
    fn the_local_route_wins_when_there_are_two() {
        let mut table = PeerTable::default();
        table.upsert(peer("a", PeerSource::Address, 99, 1_000));
        table.upsert(peer("a", PeerSource::Mdns, 20, 1_000));

        assert_eq!(table.best("a").map(|p| p.source), Some(PeerSource::Mdns));
    }

    #[test]
    fn an_unknown_peer_has_no_route() {
        let table = PeerTable::default();
        assert!(table.best("nobody").is_none());
    }

    #[test]
    fn a_peer_is_removed_by_the_key_its_source_knows_it_by() {
        let mut table = PeerTable::default();
        let p = peer("a", PeerSource::Mdns, 20, 1_000);
        let key = p.key.clone();
        table.upsert(p);

        assert_eq!(
            table.remove_by_key(PeerSource::Mdns, &key).as_deref(),
            Some("a")
        );
        assert!(table.best("a").is_none());
        assert_eq!(table.remove_by_key(PeerSource::Mdns, &key), None);
    }

    // A removal must not reach across sources: the same device found twice is
    // two entries, and one key only ever names one of them.
    #[test]
    fn removing_by_key_does_not_touch_another_source() {
        let mut table = PeerTable::default();
        let local = peer("a", PeerSource::Mdns, 20, 1_000);
        let key = local.key.clone();
        table.upsert(local);
        table.upsert(peer("a", PeerSource::Address, 99, 1_000));

        table.remove_by_key(PeerSource::Mdns, &key);
        assert_eq!(table.best("a").map(|p| p.source), Some(PeerSource::Address));
    }

    #[test]
    fn an_address_that_went_quiet_is_pruned() {
        let mut table = PeerTable::default();
        table.upsert(peer("a", PeerSource::Address, 20, 1_000));
        table.upsert(peer("b", PeerSource::Address, 21, 1_000 + PEER_TTL_MS));

        let gone = table.prune(1_000 + PEER_TTL_MS + 1);

        assert_eq!(gone, vec![("a".to_string(), PeerSource::Address)]);
        assert!(table.best("b").is_some(), "still inside its TTL");
    }

    // mdns-sd reports a device once, and again only when its records change,
    // so hearing nothing more is the device staying put. Timing it out left
    // a device on the same wifi with no route a minute and a half after it
    // was found, and only a stored address ever reached it after that.
    #[test]
    fn a_device_on_this_network_is_not_timed_out() {
        let mut table = PeerTable::default();
        table.upsert(peer("a", PeerSource::Mdns, 20, 1_000));

        let gone = table.prune(1_000 + 100 * PEER_TTL_MS);

        assert!(gone.is_empty());
        assert_eq!(table.best("a").map(|p| p.source), Some(PeerSource::Mdns));
    }

    // A dial goes down this list until one route works, so a stored address
    // is still tried when the local route is there and fails.
    #[test]
    fn every_route_to_a_device_comes_this_network_first() {
        let mut table = PeerTable::default();
        table.upsert(peer("a", PeerSource::Address, 99, 1_000));
        table.upsert(peer("a", PeerSource::Mdns, 20, 1_000));
        table.upsert(peer("b", PeerSource::Mdns, 21, 1_000));

        let sources: Vec<PeerSource> = table.routes("a").iter().map(|p| p.source).collect();
        assert_eq!(sources, vec![PeerSource::Mdns, PeerSource::Address]);
        assert!(table.routes("nobody").is_empty());
    }

    #[test]
    fn clearing_one_source_leaves_the_other_alone() {
        let mut table = PeerTable::default();
        table.upsert(peer("a", PeerSource::Mdns, 20, 1_000));
        table.upsert(peer("b", PeerSource::Address, 21, 1_000));

        assert_eq!(table.clear_source(PeerSource::Mdns), vec!["a".to_string()]);
        assert!(table.best("a").is_none());
        assert!(table.best("b").is_some());
    }

    #[test]
    fn addresses_are_normalized_ipv4_first_without_duplicates() {
        let v4 = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20));
        let v6: IpAddr = "fe80::1".parse().unwrap();

        assert_eq!(normalize_addrs(vec![v6, v4, v4]), vec![v4, v6]);
    }
}

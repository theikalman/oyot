//! Where each paired device was last found on this network (ADR 0034,
//! decision 3).
//!
//! A phone's background run cannot count on hearing mDNS: iOS has no browser
//! yet, and Android hears it only for the few seconds a run holds a multicast
//! lock. So whenever discovery finds a paired device, the address it was
//! found at is kept here, and a background run tries it after the addresses
//! the user typed. A row is a guess, like a typed address: the device may
//! have moved, and the probe that tries it says whether it is still there.

use rusqlite::{params, Connection};
use std::net::IpAddr;

/// One device's address on the network it was last found on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LanRoute {
    pub peer_node_id: String,
    /// IPv4 first, as discovery orders them.
    pub addrs: Vec<IpAddr>,
    pub port: u16,
    pub seen_at: i64,
}

/// Addresses another device could dial on a later visit to this network.
/// Loopback reaches only this machine, and a link-local IPv6 address means
/// nothing without the interface it was heard on, which is not kept.
pub fn worth_remembering(addr: &IpAddr) -> bool {
    match addr {
        IpAddr::V4(v4) => !v4.is_loopback() && !v4.is_link_local() && !v4.is_unspecified(),
        IpAddr::V6(v6) => {
            !v6.is_loopback() && !v6.is_unspecified() && (v6.segments()[0] & 0xffc0) != 0xfe80
        }
    }
}

/// Keep where a device was found, replacing where it was found before.
pub fn remember(db: &Connection, user_id: &str, route: &LanRoute) -> Result<(), String> {
    let addrs: Vec<String> = route.addrs.iter().map(IpAddr::to_string).collect();
    db.execute(
        "INSERT INTO lan_routes (user_id, peer_node_id, addrs, port, seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(user_id, peer_node_id) DO UPDATE SET
             addrs = excluded.addrs, port = excluded.port, seen_at = excluded.seen_at",
        params![
            user_id,
            route.peer_node_id,
            addrs.join(","),
            route.port as i64,
            route.seen_at
        ],
    )
    .map_err(|e| format!("could not remember where {} was: {e}", route.peer_node_id))?;
    Ok(())
}

/// Every remembered route, for the devices paired with this one.
pub fn load(db: &Connection, user_id: &str) -> Result<Vec<LanRoute>, String> {
    let mut stmt = db
        .prepare(
            "SELECT r.peer_node_id, r.addrs, r.port, r.seen_at FROM lan_routes r
               JOIN device_pairs p
                 ON p.user_id = r.user_id AND p.peer_node_id = r.peer_node_id
              WHERE r.user_id = ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![user_id], |row| {
            let addrs: String = row.get(1)?;
            Ok(LanRoute {
                peer_node_id: row.get(0)?,
                addrs: addrs.split(',').filter_map(|a| a.parse().ok()).collect(),
                port: row.get::<_, i64>(2)? as u16,
                seen_at: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|route| !route.addrs.is_empty() && route.port != 0)
        .collect();
    Ok(rows)
}

/// Forget where a device was, as removing its pairing does.
pub fn forget(db: &Connection, user_id: &str, peer_node_id: &str) -> Result<(), String> {
    db.execute(
        "DELETE FROM lan_routes WHERE user_id = ?1 AND peer_node_id = ?2",
        params![user_id, peer_node_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        crate::setup_database_tables(&db).unwrap();
        crate::run_migrations(&db).unwrap();
        crate::pairing::save_pair(&db, "me", "desktop", "Desktop", "room").unwrap();
        db
    }

    fn route(addrs: &[&str], port: u16, at: i64) -> LanRoute {
        LanRoute {
            peer_node_id: "desktop".to_string(),
            addrs: addrs.iter().map(|a| a.parse().unwrap()).collect(),
            port,
            seen_at: at,
        }
    }

    #[test]
    fn the_last_place_a_device_was_found_is_the_one_kept() {
        let db = library();
        remember(&db, "me", &route(&["192.168.1.20"], 19701, 1)).unwrap();
        remember(&db, "me", &route(&["10.0.0.5", "fd00::5"], 19702, 2)).unwrap();

        assert_eq!(
            load(&db, "me").unwrap(),
            vec![route(&["10.0.0.5", "fd00::5"], 19702, 2)]
        );
    }

    // A route only means anything while the two devices are paired, and a
    // removed pairing's route would have a background run dial a device that
    // no longer lets this one in.
    #[test]
    fn only_paired_devices_have_routes() {
        let db = library();
        remember(&db, "me", &route(&["192.168.1.20"], 19701, 1)).unwrap();
        let mut stranger = route(&["192.168.1.30"], 19701, 1);
        stranger.peer_node_id = "stranger".to_string();
        remember(&db, "me", &stranger).unwrap();

        let loaded = load(&db, "me").unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].peer_node_id, "desktop");

        forget(&db, "me", "desktop").unwrap();
        assert!(load(&db, "me").unwrap().is_empty());
    }

    #[test]
    fn only_addresses_another_visit_could_dial_are_worth_remembering() {
        for kept in [
            "192.168.1.20",
            "10.1.2.3",
            "100.64.0.9",
            "fd00::5",
            "2001:db8::1",
        ] {
            assert!(worth_remembering(&kept.parse().unwrap()), "{kept}");
        }
        for dropped in [
            "127.0.0.1",
            "169.254.1.1",
            "0.0.0.0",
            "::1",
            "fe80::1",
            "::",
        ] {
            assert!(!worth_remembering(&dropped.parse().unwrap()), "{dropped}");
        }
    }
}

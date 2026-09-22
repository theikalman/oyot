//! Addresses the user has told us a device can be reached at.
//!
//! [ADR 0023](../../docs/decisions/0023-reach-a-peer-at-an-address-you-already-know.md).
//! mDNS answers "where is this device" for devices on this network and cannot
//! answer it for anything else. This is the other answer, and it is the user's:
//! a host and a port, typed once.
//!
//! A row here is a guess, not a fact. The device may be off, the name may be
//! misspelled, the VPN may be down. `network::remote_peers` is what turns a row
//! into a peer, by getting a signed answer back from it.
//!
//! Rows are not tied to a pairing. An address has to be enterable before the
//! pairing exists, because reaching the device is how the pairing gets made.

use crate::network::lan_signaling::SIGNALING_PORT;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceEndpoint {
    pub peer_node_id: String,
    /// As the user wrote it, lower-cased. A MagicDNS name, a literal address,
    /// anything `lookup_host` will take.
    pub host: String,
    pub port: u16,
    pub added_at: i64,
    /// When this address last answered a probe, or `None` if it never has.
    /// The difference between "not connected right now" and "this address has
    /// never worked", which is the one thing a typed address gets wrong often
    /// enough to be worth showing.
    pub last_ok: Option<i64>,
}

/// Read a typed address into a host and a port.
///
/// Accepts `host`, `host:port`, an IPv6 literal, and `[literal]:port`. The port
/// is optional because the listener has a default one (ADR 0023) and asking
/// someone to type it would be asking them to know it.
pub fn parse_endpoint(input: &str) -> Result<(String, u16), String> {
    let text = input.trim();
    if text.is_empty() {
        return Err("Type the address of the other device.".to_string());
    }
    if text.contains(char::is_whitespace) {
        return Err("An address cannot contain spaces.".to_string());
    }
    // A URL is a reasonable thing to paste and a wrong thing to store: the
    // scheme and path would go into a DNS lookup verbatim.
    if text.contains("://") || text.contains('/') {
        return Err("Use just a host name or address, with no scheme or path.".to_string());
    }

    let (host, port) = if let Some(rest) = text.strip_prefix('[') {
        // `[v6]` or `[v6]:port`
        let (inside, after) = rest.split_once(']').ok_or_else(|| {
            "That looks like an IPv6 address with no closing bracket.".to_string()
        })?;
        match after {
            "" => (inside, None),
            _ => {
                let port = after.strip_prefix(':').ok_or_else(|| {
                    "Put the port after the closing bracket, as [address]:port.".to_string()
                })?;
                (inside, Some(port))
            }
        }
    } else {
        match text.rsplit_once(':') {
            // More than one colon and no brackets: a bare IPv6 literal, where
            // the last colon is part of the address rather than a port.
            Some(_) if text.matches(':').count() > 1 => (text, None),
            Some((host, port)) => (host, Some(port)),
            None => (text, None),
        }
    };

    if host.is_empty() {
        return Err("That address has no host in it.".to_string());
    }

    let port = match port {
        None => SIGNALING_PORT,
        Some(p) => p
            .parse::<u16>()
            .map_err(|_| format!("\"{p}\" is not a port number."))
            .and_then(|p| {
                if p == 0 {
                    Err("0 is not a port you can connect to.".to_string())
                } else {
                    Ok(p)
                }
            })?,
    };

    Ok((host.to_lowercase(), port))
}

pub fn load_endpoints(
    db: &rusqlite::Connection,
    user_id: &str,
) -> Result<Vec<DeviceEndpoint>, String> {
    let mut stmt = db
        .prepare(
            "SELECT peer_node_id, host, port, added_at, last_ok
             FROM device_endpoints WHERE user_id = ? ORDER BY peer_node_id, host, port",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![user_id], |row| {
            Ok(DeviceEndpoint {
                peer_node_id: row.get(0)?,
                host: row.get(1)?,
                port: row.get::<_, i64>(2)? as u16,
                added_at: row.get(3)?,
                last_ok: row.get(4).ok(),
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// Store one address for one device. Re-adding the same one is not an error,
/// and deliberately keeps whatever `last_ok` it already had.
pub fn save_endpoint(
    db: &rusqlite::Connection,
    user_id: &str,
    peer_node_id: &str,
    host: &str,
    port: u16,
    now: i64,
) -> Result<(), String> {
    db.execute(
        "INSERT INTO device_endpoints (user_id, peer_node_id, host, port, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(user_id, peer_node_id, host, port) DO NOTHING",
        params![user_id, peer_node_id, host, port as i64, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn remove_endpoint(
    db: &rusqlite::Connection,
    user_id: &str,
    peer_node_id: &str,
    host: &str,
    port: u16,
) -> Result<(), String> {
    db.execute(
        "DELETE FROM device_endpoints
         WHERE user_id = ? AND peer_node_id = ? AND host = ? AND port = ?",
        params![user_id, peer_node_id, host, port as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Forget every address for one device. Called when its pairing is removed:
/// an address is only ever useful for reaching a device we are paired with,
/// and leaving it behind would mean a removed device came back as reachable.
pub fn remove_endpoints_for_peer(
    db: &rusqlite::Connection,
    user_id: &str,
    peer_node_id: &str,
) -> Result<(), String> {
    db.execute(
        "DELETE FROM device_endpoints WHERE user_id = ? AND peer_node_id = ?",
        params![user_id, peer_node_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Record that this address answered.
pub fn mark_endpoint_ok(
    db: &rusqlite::Connection,
    user_id: &str,
    peer_node_id: &str,
    host: &str,
    port: u16,
    now: i64,
) -> Result<(), String> {
    db.execute(
        "UPDATE device_endpoints SET last_ok = ?
         WHERE user_id = ? AND peer_node_id = ? AND host = ? AND port = ?",
        params![now, user_id, peer_node_id, host, port as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> rusqlite::Connection {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        crate::setup_database_tables(&db).unwrap();
        db
    }

    #[test]
    fn a_bare_host_takes_the_default_port() {
        assert_eq!(
            parse_endpoint("laptop.tail1234.ts.net"),
            Ok(("laptop.tail1234.ts.net".to_string(), SIGNALING_PORT))
        );
    }

    #[test]
    fn a_port_can_be_written_out() {
        assert_eq!(
            parse_endpoint("100.101.102.103:9000"),
            Ok(("100.101.102.103".to_string(), 9000))
        );
    }

    // Typing one is unlikely and pasting one is not, and the last colon in it
    // is part of the address rather than a port.
    #[test]
    fn a_bare_ipv6_literal_is_not_read_as_a_port() {
        assert_eq!(
            parse_endpoint("fd7a:115c:a1e0::1"),
            Ok(("fd7a:115c:a1e0::1".to_string(), SIGNALING_PORT))
        );
    }

    #[test]
    fn a_bracketed_ipv6_literal_can_carry_a_port() {
        assert_eq!(
            parse_endpoint("[fd7a:115c:a1e0::1]:9000"),
            Ok(("fd7a:115c:a1e0::1".to_string(), 9000))
        );
        assert_eq!(
            parse_endpoint("[fd7a:115c:a1e0::1]"),
            Ok(("fd7a:115c:a1e0::1".to_string(), SIGNALING_PORT))
        );
    }

    // A host name is case-insensitive, and two spellings of one address would
    // otherwise be two rows and two probes.
    #[test]
    fn a_host_is_stored_lower_cased_and_trimmed() {
        assert_eq!(
            parse_endpoint("  Laptop.Tail1234.TS.net  "),
            Ok(("laptop.tail1234.ts.net".to_string(), SIGNALING_PORT))
        );
    }

    #[test]
    fn what_cannot_be_an_address_is_refused_with_a_reason() {
        for bad in [
            "",
            "   ",
            "my laptop",
            "https://laptop.ts.net",
            "laptop.ts.net/sync",
            "laptop.ts.net:0",
            "laptop.ts.net:port",
            "laptop.ts.net:99999",
            ":9000",
            "[fd7a::1",
        ] {
            assert!(parse_endpoint(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn an_endpoint_survives_the_round_trip() {
        let db = db();
        save_endpoint(&db, "u1", "peer-a", "laptop.ts.net", 19701, 1_000).unwrap();

        let got = load_endpoints(&db, "u1").unwrap();

        assert_eq!(got.len(), 1);
        assert_eq!(got[0].host, "laptop.ts.net");
        assert_eq!(got[0].port, 19701);
        assert_eq!(got[0].last_ok, None);
    }

    // The settings screen shows a device's addresses, and pairing needs one
    // before there is a pairing, so neither can be keyed off the pair table.
    #[test]
    fn a_device_can_hold_several_addresses() {
        let db = db();
        save_endpoint(&db, "u1", "peer-a", "laptop.ts.net", 19701, 1_000).unwrap();
        save_endpoint(&db, "u1", "peer-a", "100.64.0.9", 19701, 1_000).unwrap();

        assert_eq!(load_endpoints(&db, "u1").unwrap().len(), 2);
    }

    // Re-adding an address someone already added is a no-op, not a reset: the
    // one thing on the row worth keeping is whether it has ever worked.
    #[test]
    fn re_adding_an_address_keeps_what_it_knows() {
        let db = db();
        save_endpoint(&db, "u1", "peer-a", "laptop.ts.net", 19701, 1_000).unwrap();
        mark_endpoint_ok(&db, "u1", "peer-a", "laptop.ts.net", 19701, 5_000).unwrap();

        save_endpoint(&db, "u1", "peer-a", "laptop.ts.net", 19701, 9_000).unwrap();

        let got = load_endpoints(&db, "u1").unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].last_ok, Some(5_000));
        assert_eq!(got[0].added_at, 1_000);
    }

    #[test]
    fn one_address_can_be_removed_without_the_others() {
        let db = db();
        save_endpoint(&db, "u1", "peer-a", "laptop.ts.net", 19701, 1_000).unwrap();
        save_endpoint(&db, "u1", "peer-a", "100.64.0.9", 19701, 1_000).unwrap();

        remove_endpoint(&db, "u1", "peer-a", "100.64.0.9", 19701).unwrap();

        let got = load_endpoints(&db, "u1").unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].host, "laptop.ts.net");
    }

    // A device the user has just unpaired must not stay reachable.
    #[test]
    fn unpairing_a_device_forgets_its_addresses() {
        let db = db();
        save_endpoint(&db, "u1", "peer-a", "laptop.ts.net", 19701, 1_000).unwrap();
        save_endpoint(&db, "u1", "peer-b", "tablet.ts.net", 19701, 1_000).unwrap();

        remove_endpoints_for_peer(&db, "u1", "peer-a").unwrap();

        let got = load_endpoints(&db, "u1").unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].peer_node_id, "peer-b");
    }

    #[test]
    fn one_users_addresses_are_not_anothers() {
        let db = db();
        save_endpoint(&db, "u1", "peer-a", "laptop.ts.net", 19701, 1_000).unwrap();

        assert!(load_endpoints(&db, "u2").unwrap().is_empty());
    }
}

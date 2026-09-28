//! Noticing a wake from sleep or a change of network (ADR 0030, decision 9).
//!
//! Tauri reports neither on a desktop, and both leave sync stale: a WebRTC
//! connection that went quiet for 30 seconds is gone by the time the machine
//! wakes, and a new network can mean new routes to every peer. So a task
//! looks every `TICK`:
//!
//! - **Sleep** shows as the wall clock having moved much further than one
//!   tick since the last look. The task's own timer does not count time
//!   asleep, the wall clock does.
//! - **A network change** shows as this machine's interface addresses
//!   changing, which `if-addrs` (already in the tree through mdns-sd) lists
//!   without anything to subscribe to on each OS.
//!
//! Either one probes the stored addresses at once and tells the page, which
//! runs its reconnect sweep. A clock moved by hand looks like a wake, which
//! costs one needless reconnect sweep.

use crate::db::AppState;
use std::net::IpAddr;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// The event the page is sent, with "wake" or "network" as its payload.
pub const NETWORK_CHANGED_EVENT: &str = "network-changed";

const TICK: Duration = Duration::from_secs(10);

/// How much later than due a tick has to come before it counts as a wake.
/// Generous, so a machine that is merely busy does not count.
const WAKE_SLACK_MS: i64 = 30_000;

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last_wall = crate::crypto::now_ms();
        let mut last_addresses = local_addresses();
        loop {
            tokio::time::sleep(TICK).await;
            let now = crate::crypto::now_ms();
            let addresses = local_addresses();
            let reason = change(
                woke_up(last_wall, now, TICK.as_millis() as i64),
                addresses != last_addresses,
            );
            last_wall = now;
            last_addresses = addresses;

            if let Some(reason) = reason {
                trace!("[desktop] {reason}: probing stored addresses and reconnecting");
                app.state::<AppState>().remote.probe_now();
                let _ = app.emit(NETWORK_CHANGED_EVENT, reason);
            }
        }
    });
}

/// Whether a tick that was due `tick_ms` after `previous` came late enough to
/// mean the machine was asleep in between.
pub fn woke_up(previous: i64, now: i64, tick_ms: i64) -> bool {
    now - previous > tick_ms + WAKE_SLACK_MS
}

/// What to call a change, if there was one. A wake is named first: the
/// addresses usually change across one as well, and the wake is the cause.
pub fn change(woke: bool, addresses_changed: bool) -> Option<&'static str> {
    if woke {
        Some("wake")
    } else if addresses_changed {
        Some("network")
    } else {
        None
    }
}

/// This machine's addresses, loopback left out, in a stable order so two
/// readings compare equal when nothing changed.
fn local_addresses() -> Vec<IpAddr> {
    let mut addresses: Vec<IpAddr> = match if_addrs::get_if_addrs() {
        Ok(interfaces) => interfaces
            .into_iter()
            .filter(|interface| !interface.is_loopback())
            .map(|interface| interface.ip())
            .collect(),
        Err(e) => {
            warn_log!("[desktop] could not list network interfaces: {e}");
            Vec::new()
        }
    };
    addresses.sort();
    addresses.dedup();
    addresses
}

#[cfg(test)]
mod tests {
    use super::*;

    const TICK_MS: i64 = 10_000;

    #[test]
    fn a_tick_on_time_is_not_a_wake() {
        assert!(!woke_up(0, TICK_MS, TICK_MS));
        assert!(!woke_up(0, TICK_MS + 5_000, TICK_MS));
    }

    #[test]
    fn a_tick_much_later_than_due_is_a_wake() {
        assert!(woke_up(0, TICK_MS + WAKE_SLACK_MS + 1, TICK_MS));
        assert!(woke_up(0, 8 * 60 * 60 * 1000, TICK_MS));
    }

    #[test]
    fn a_clock_moved_back_is_not_a_wake() {
        assert!(!woke_up(1_000_000, 0, TICK_MS));
    }

    #[test]
    fn a_wake_is_named_before_a_network_change() {
        assert_eq!(change(true, true), Some("wake"));
        assert_eq!(change(true, false), Some("wake"));
        assert_eq!(change(false, true), Some("network"));
        assert_eq!(change(false, false), None);
    }

    #[test]
    fn reading_the_addresses_twice_gives_the_same_list() {
        assert_eq!(local_addresses(), local_addresses());
    }
}

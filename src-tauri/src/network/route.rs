//! Which transport carries a signaling message.
//!
//! The decision itself is a pure function so it can be tested without a broker,
//! a network, or an `RTCPeerConnection`, the same reason the negotiation rules
//! live in `sync/signaling/negotiation.ts` on the frontend side.
//!
//! See docs/decisions/0018-local-network-sync-as-a-second-signaling-transport.md.

/// The transport a signaling message travelled over, or is about to.
///
/// Carried on every inbound event so the frontend can say which path a peer is
/// connected by, and so a failed attempt can be attributed to the right route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// Discovered on this network and reached directly. Needs no internet.
    Lan,
    /// Relayed through the configured MQTT broker (ADR 0001).
    Broker,
}

impl Route {
    pub fn label(self) -> &'static str {
        match self {
            Route::Lan => "lan",
            Route::Broker => "broker",
        }
    }
}

/// What the choice depends on, gathered by the caller.
#[derive(Debug, Clone, Copy)]
pub struct RouteInputs {
    /// The user asked for local-network sync only, so the broker is not an
    /// option even when it is reachable.
    pub local_only: bool,
    /// This peer has been seen on this network and has an address to try.
    pub lan_discovered: bool,
    /// This peer's local route failed recently.
    pub lan_cooling: bool,
    /// The broker is connected, not merely configured. A client that has
    /// never reached its broker publishes into a void, and preferring that
    /// void over a working local network is worse than having no fallback.
    pub broker_connected: bool,
}

/// The route to try for one peer, or `None` when there is no way to reach it.
///
/// Local first, and never both: two offers for one peer is the collision
/// perfect negotiation exists to survive (ADR 0002), and racing the routes
/// would manufacture one on every connection to save a few seconds.
///
/// A cooldown is a preference, not a prohibition. It says "something else
/// first if there is anything else", because on a device with no broker, or
/// one whose broker is unreachable, writing off the local route means writing
/// off the only route there is: every message then fails with "no signaling
/// route", the peer cannot even answer an offer it received, and both devices
/// sit at "Connecting..." until one of them is restarted.
pub fn choose_route(inputs: RouteInputs) -> Option<Route> {
    if inputs.lan_discovered && !inputs.lan_cooling {
        return Some(Route::Lan);
    }
    if !inputs.local_only && inputs.broker_connected {
        return Some(Route::Broker);
    }
    // Nothing else can carry it, so a route that failed recently beats no
    // route at all.
    if inputs.lan_discovered {
        return Some(Route::Lan);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs() -> RouteInputs {
        RouteInputs {
            local_only: false,
            lan_discovered: false,
            lan_cooling: false,
            broker_connected: true,
        }
    }

    #[test]
    fn the_local_network_wins_when_the_peer_is_on_it() {
        let got = choose_route(RouteInputs {
            lan_discovered: true,
            ..inputs()
        });
        assert_eq!(got, Some(Route::Lan));
    }

    #[test]
    fn the_broker_carries_a_peer_that_is_not_on_this_network() {
        assert_eq!(choose_route(inputs()), Some(Route::Broker));
    }

    #[test]
    fn a_local_route_that_failed_recently_gives_way_to_the_broker() {
        let got = choose_route(RouteInputs {
            lan_discovered: true,
            lan_cooling: true,
            ..inputs()
        });
        assert_eq!(got, Some(Route::Broker));
    }

    // The bug this rule was rewritten for. Two devices on one network, no
    // broker between them: the local route fails once, and writing it off
    // leaves nothing at all. Every message then fails with "no signaling
    // route", so the peer cannot even answer an offer it just received, and
    // both sides sit at "Connecting..." for ever.
    #[test]
    fn a_cooling_local_route_is_still_better_than_no_route() {
        let got = choose_route(RouteInputs {
            lan_discovered: true,
            lan_cooling: true,
            broker_connected: false,
            local_only: false,
        });
        assert_eq!(got, Some(Route::Lan));
    }

    // The setting has to be true at the packet level or it is a promise the
    // user cannot check.
    #[test]
    fn local_only_never_falls_back_to_the_broker() {
        let got = choose_route(RouteInputs {
            local_only: true,
            ..inputs()
        });
        assert_eq!(got, None, "a reachable broker is still not an option");
    }

    #[test]
    fn local_only_keeps_using_a_local_route_that_failed() {
        let got = choose_route(RouteInputs {
            local_only: true,
            lan_discovered: true,
            lan_cooling: true,
            broker_connected: true,
        });
        assert_eq!(got, Some(Route::Lan), "there is nothing else to wait for");
    }

    #[test]
    fn local_only_still_uses_the_local_network() {
        let got = choose_route(RouteInputs {
            local_only: true,
            lan_discovered: true,
            lan_cooling: false,
            broker_connected: false,
        });
        assert_eq!(got, Some(Route::Lan));
    }

    #[test]
    fn there_is_no_route_when_nothing_is_reachable() {
        let got = choose_route(RouteInputs {
            broker_connected: false,
            ..inputs()
        });
        assert_eq!(got, None);
    }
}

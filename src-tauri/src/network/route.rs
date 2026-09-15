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
    /// This peer has been seen on this network and is not in a failure
    /// cooldown.
    pub lan_available: bool,
    /// A broker client exists for this session.
    pub broker_connected: bool,
}

/// The route to try for one peer, or `None` when there is no way to reach it.
///
/// Local first, and never both: two offers for one peer is the collision
/// perfect negotiation exists to survive (ADR 0002), and racing the routes
/// would manufacture one on every connection to save a few seconds.
pub fn choose_route(inputs: RouteInputs) -> Option<Route> {
    if inputs.lan_available {
        return Some(Route::Lan);
    }
    if inputs.local_only {
        return None;
    }
    if inputs.broker_connected {
        return Some(Route::Broker);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs() -> RouteInputs {
        RouteInputs {
            local_only: false,
            lan_available: false,
            broker_connected: true,
        }
    }

    #[test]
    fn the_local_network_wins_when_the_peer_is_on_it() {
        let got = choose_route(RouteInputs {
            lan_available: true,
            ..inputs()
        });
        assert_eq!(got, Some(Route::Lan));
    }

    #[test]
    fn the_broker_carries_a_peer_that_is_not_on_this_network() {
        assert_eq!(choose_route(inputs()), Some(Route::Broker));
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
    fn local_only_still_uses_the_local_network() {
        let got = choose_route(RouteInputs {
            local_only: true,
            lan_available: true,
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

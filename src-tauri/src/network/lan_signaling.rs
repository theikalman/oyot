//! The listener every other device reaches this one on, and the probe sent
//! to a stored address.
//!
//! One port carries two things (ADR 0032, decision 3). A connection that
//! opens with a TLS handshake is a sync connection, and goes to the sync
//! engine. Anything else is a signed `SignalingMessage` in a frame of its
//! own, which since ADR 0032 means a probe: a `ping`, answered with a `pong`
//! on the same connection. The envelope does not trust the transport: ADR
//! 0009 treated the broker that used to carry it as untrusted
//! infrastructure, and an untrusted LAN is the same threat model.
//!
//! The port is fixed where it can be. mDNS tells a peer on this network which
//! port to use, but a peer reached at a stored address (ADR 0023) has only the
//! address the user typed, so there has to be a port it can assume. It is a
//! preference rather than a requirement: if something else holds it, the
//! listener falls back to an ephemeral port and the local route carries on
//! working, while the stored-address route cannot be reached inbound. That is
//! a real state with a real cause, so the listener reports which it got.
//!
//! A probe is one connection per exchange, rather than one held open per
//! peer: the handshake costs about a millisecond on a LAN and buys
//! statelessness. The connection that stays open is the sync engine's.
//!
//! See docs/decisions/0018-local-network-sync-as-a-second-signaling-transport.md
//! and docs/decisions/0022-drop-the-broker-and-sync-only-on-the-local-network.md.

use crate::crypto;
use crate::network::message::SignalingMessage;
use crate::network::signaling_manager::Inbound;
use crate::sync::manager::SyncManager;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// The port this device prefers to listen on.
///
/// Below every platform's ephemeral range (Linux starts at 32768, macOS and
/// Windows at 49152), so an unrelated outbound socket on this machine cannot
/// have been handed it, and not registered with IANA. Peers reached at a
/// stored address assume it when the user does not write one.
pub const SIGNALING_PORT: u16 = 19701;

/// The largest frame we will read.
///
/// A probe is a few hundred bytes. This is generous, and small enough that a
/// hostile length prefix cannot make us allocate anything interesting. It
/// also keeps a frame's first byte at zero, which is how a probe is told from
/// a TLS handshake.
const MAX_FRAME_BYTES: usize = 64 * 1024;

/// The first byte of a TLS record carrying a handshake.
const TLS_HANDSHAKE: u8 = 0x16;

/// How long one inbound connection may take to deliver its frame.
const READ_TIMEOUT: Duration = Duration::from_secs(10);

/// How long to spend reaching a peer before trying its next address.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

/// How long a whole send may take once connected.
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

/// How long to wait for an answer to a probe. A peer answers from memory, so
/// this is a round trip plus nothing, and waiting longer would only make a
/// device that is not there take longer to report as not there.
const REPLY_TIMEOUT: Duration = Duration::from_secs(5);

/// Frames allowed from one address per window, and how long that window is.
///
/// Anyone on the network can connect to this listener. Verification already
/// drops what they send, but doing that work on demand is itself the cost, so
/// the limit is on arrivals rather than on acceptances, TLS handshakes
/// included. Generous next to a real exchange, which is single digits.
const RATE_WINDOW_MS: i64 = 10_000;
const MAX_FRAMES_PER_WINDOW: u32 = 30;

/// Distinct addresses whose rate we track, bounded the way the pairing-prompt
/// history is: the oldest entry goes, which at worst forgives that address one
/// window early.
const MAX_TRACKED_SOURCES: usize = 32;

/// Arrivals per source address, in a sliding window.
#[derive(Debug, Default)]
pub struct RateLimiter {
    /// (address, when this window started, arrivals in it)
    seen: Vec<(IpAddr, i64, u32)>,
}

impl RateLimiter {
    pub fn allow(&mut self, addr: IpAddr, now: i64) -> bool {
        if let Some(entry) = self.seen.iter_mut().find(|(ip, _, _)| *ip == addr) {
            if now - entry.1 >= RATE_WINDOW_MS {
                entry.1 = now;
                entry.2 = 1;
                return true;
            }
            if entry.2 >= MAX_FRAMES_PER_WINDOW {
                return false;
            }
            entry.2 += 1;
            return true;
        }
        if self.seen.len() >= MAX_TRACKED_SOURCES {
            self.seen.remove(0);
        }
        self.seen.push((addr, now, 1));
        true
    }
}

/// Write one length-prefixed frame.
pub async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, body: &[u8]) -> Result<(), String> {
    if body.len() > MAX_FRAME_BYTES {
        return Err(format!(
            "message of {} bytes is over the {MAX_FRAME_BYTES} byte frame limit",
            body.len()
        ));
    }
    let len = (body.len() as u32).to_be_bytes();
    w.write_all(&len).await.map_err(|e| e.to_string())?;
    w.write_all(body).await.map_err(|e| e.to_string())?;
    w.flush().await.map_err(|e| e.to_string())
}

/// Read one length-prefixed frame.
///
/// The length is checked before anything is allocated, so a peer cannot ask
/// for a gigabyte by saying so.
pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> Result<Vec<u8>, String> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len).await.map_err(|e| e.to_string())?;
    let len = u32::from_be_bytes(len) as usize;
    if len == 0 {
        return Err("empty frame".to_string());
    }
    if len > MAX_FRAME_BYTES {
        return Err(format!("frame of {len} bytes is over the limit"));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).await.map_err(|e| e.to_string())?;
    Ok(body)
}

/// A running listener. Dropping the handle does not stop it; `stop` does.
pub struct LanListener {
    port: u16,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl LanListener {
    /// The port peers should be told to connect back to.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Whether this is the port a peer with only an address can assume.
    ///
    /// False means the local route is fine and the stored-address route cannot
    /// reach this device inbound, which is worth saying out loud rather than
    /// leaving to be discovered as a peer that never connects.
    pub fn on_default_port(&self) -> bool {
        self.port == SIGNALING_PORT
    }

    pub fn stop(self) {
        self.task.abort();
    }
}

/// Bind the preferred port, or any free one.
///
/// Not `SO_REUSEPORT`: two copies of the app on one machine sharing the port
/// would each get some of the other's connections, which is worse than the
/// second one falling back.
async fn bind() -> Result<TcpListener, String> {
    match TcpListener::bind(("0.0.0.0", SIGNALING_PORT)).await {
        Ok(listener) => Ok(listener),
        Err(e) => {
            warn_log!(
                "[LAN] port {} is not available ({}), falling back to an ephemeral one; \
                 peers that only have a stored address cannot reach this device",
                SIGNALING_PORT,
                e
            );
            TcpListener::bind("0.0.0.0:0")
                .await
                .map_err(|e| format!("could not bind a local signaling port: {e}"))
        }
    }
}

/// Start accepting connections: probes, answered through `inbound`, and sync
/// connections, handed to `sync`.
///
/// Binds on every IPv4 interface, which includes a VPN's: a tailnet address is
/// an address on this machine like any other, so nothing here knows or cares
/// that a connection arrived over one. IPv4 only for now, which is what a home
/// network hands out and what every tailnet node has.
pub async fn listen(inbound: Inbound, sync: SyncManager) -> Result<LanListener, String> {
    let listener = bind().await?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let task = tauri::async_runtime::spawn(async move {
        let mut limiter = RateLimiter::default();
        loop {
            let (stream, from) = match listener.accept().await {
                Ok(pair) => pair,
                Err(e) => {
                    warn_log!("[LAN] accept failed: {}", e);
                    continue;
                }
            };
            if !limiter.allow(from.ip(), crypto::now_ms()) {
                trace!("[LAN] rate limiting {}", from.ip());
                continue;
            }
            let inbound = inbound.clone();
            let sync = sync.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = serve(stream, from, inbound, sync).await {
                    trace!("[LAN] dropped a connection from {}: {}", from, e);
                }
            });
        }
    });

    trace!("[LAN] signaling listening on port {}", port);
    Ok(LanListener { port, task })
}

/// Hand a sync connection to the engine, or answer a probe.
///
/// The first byte decides, read without taking it off the stream: a TLS
/// handshake starts with 0x16, and a probe's frame with the high byte of a
/// length under 64 KiB, which is zero.
async fn serve(
    mut stream: TcpStream,
    from: SocketAddr,
    inbound: Inbound,
    sync: SyncManager,
) -> Result<(), String> {
    let mut first = [0u8; 1];
    let peeked = tokio::time::timeout(READ_TIMEOUT, stream.peek(&mut first))
        .await
        .map_err(|_| "timed out waiting for the first byte".to_string())?
        .map_err(|e| e.to_string())?;
    if peeked == 0 {
        return Err("closed before sending anything".to_string());
    }
    if first[0] == TLS_HANDSHAKE {
        sync.accept(stream);
        return Ok(());
    }

    let body = tokio::time::timeout(READ_TIMEOUT, read_frame(&mut stream))
        .await
        .map_err(|_| "timed out waiting for a frame".to_string())??;

    let msg: SignalingMessage =
        serde_json::from_slice(&body).map_err(|e| format!("unreadable envelope: {e}"))?;

    trace!("[LAN] {} from {}", msg.msg_type, from);
    let reply = inbound.receive(msg);

    if let Some(reply) = reply {
        let body = serde_json::to_vec(&reply).map_err(|e| e.to_string())?;
        tokio::time::timeout(WRITE_TIMEOUT, write_frame(&mut stream, &body))
            .await
            .map_err(|_| "reply timed out".to_string())??;
    }
    Ok(())
}

/// Send one message to one address and wait for the answer: a probe.
pub async fn request(addr: SocketAddr, msg: &SignalingMessage) -> Result<SignalingMessage, String> {
    let body = serde_json::to_vec(msg).map_err(|e| e.to_string())?;

    let mut stream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr))
        .await
        .map_err(|_| "connection timed out".to_string())?
        .map_err(|e| e.to_string())?;

    tokio::time::timeout(WRITE_TIMEOUT, write_frame(&mut stream, &body))
        .await
        .map_err(|_| "send timed out".to_string())??;

    let reply = tokio::time::timeout(REPLY_TIMEOUT, read_frame(&mut stream))
        .await
        .map_err(|_| "no answer".to_string())??;

    serde_json::from_slice(&reply).map_err(|e| format!("unreadable answer: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn ip(last: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(192, 168, 1, last))
    }

    #[tokio::test]
    async fn a_frame_survives_the_round_trip() {
        let (mut a, mut b) = tokio::io::duplex(1024);
        let body = br#"{"from":"peer","type":"offer"}"#;

        write_frame(&mut a, body).await.unwrap();
        let got = read_frame(&mut b).await.unwrap();

        assert_eq!(got, body);
    }

    #[tokio::test]
    async fn two_frames_do_not_run_into_each_other() {
        let (mut a, mut b) = tokio::io::duplex(1024);

        write_frame(&mut a, b"first").await.unwrap();
        write_frame(&mut a, b"second").await.unwrap();

        assert_eq!(read_frame(&mut b).await.unwrap(), b"first");
        assert_eq!(read_frame(&mut b).await.unwrap(), b"second");
    }

    // The length prefix is the one thing a stranger controls before we have
    // read anything, so it is checked before anything is allocated.
    #[tokio::test]
    async fn a_frame_that_claims_to_be_enormous_is_refused() {
        let (mut a, mut b) = tokio::io::duplex(1024);

        a.write_all(&u32::MAX.to_be_bytes()).await.unwrap();

        let err = read_frame(&mut b).await.unwrap_err();
        assert!(err.contains("over the limit"), "got: {err}");
    }

    #[tokio::test]
    async fn an_oversize_message_is_refused_before_it_is_sent() {
        let (mut a, _b) = tokio::io::duplex(1024);
        let body = vec![0u8; MAX_FRAME_BYTES + 1];

        let err = write_frame(&mut a, &body).await.unwrap_err();
        assert!(err.contains("frame limit"), "got: {err}");
    }

    #[tokio::test]
    async fn a_truncated_frame_is_an_error_rather_than_a_short_message() {
        let (mut a, mut b) = tokio::io::duplex(1024);

        a.write_all(&10u32.to_be_bytes()).await.unwrap();
        a.write_all(b"only-4").await.unwrap();
        drop(a);

        assert!(read_frame(&mut b).await.is_err());
    }

    #[test]
    fn a_source_that_floods_is_cut_off_for_the_rest_of_the_window() {
        let mut limiter = RateLimiter::default();
        let now = 1_000_000;

        for i in 0..MAX_FRAMES_PER_WINDOW {
            assert!(
                limiter.allow(ip(20), now),
                "arrival {i} is inside the limit"
            );
        }
        assert!(!limiter.allow(ip(20), now));
        assert!(!limiter.allow(ip(20), now + RATE_WINDOW_MS - 1));
        assert!(limiter.allow(ip(20), now + RATE_WINDOW_MS), "a new window");
    }

    #[test]
    fn one_source_flooding_does_not_silence_another() {
        let mut limiter = RateLimiter::default();
        let now = 1_000_000;

        for _ in 0..MAX_FRAMES_PER_WINDOW + 5 {
            limiter.allow(ip(20), now);
        }

        assert!(
            limiter.allow(ip(21), now),
            "a different device is a different peer"
        );
    }

    #[test]
    fn the_rate_limit_history_is_bounded() {
        let mut limiter = RateLimiter::default();
        for i in 0..MAX_TRACKED_SOURCES * 2 {
            limiter.allow(ip(i as u8), 1_000_000);
        }
        assert_eq!(limiter.seen.len(), MAX_TRACKED_SOURCES);
    }
}

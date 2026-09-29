//! Frames on a sync connection (ADR 0032, decision 6).
//!
//! A frame is a four-byte big-endian length of what follows, then a
//! four-byte length of the JSON header, the header, and the message's bytes
//! raw: a Yjs update, a state vector, or a piece of an image. Nothing is
//! base64 on the wire, and no serialisation dependency beyond serde_json is
//! needed.
//!
//! Frames are capped at 64 MiB, the largest message the data channel's
//! framing accepted. The connection is authenticated before any frame is
//! read, so the cap is about memory, not about strangers.

use super::protocol::Message;
use std::pin::Pin;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};

pub const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

/// A whole frame, length included, ready to write.
pub fn encode(msg: &Message) -> Result<Vec<u8>, String> {
    let header =
        serde_json::to_vec(msg).map_err(|e| format!("cannot encode {}: {e}", msg.name()))?;
    let payload = msg.payload().unwrap_or(&[]);
    let body_len = 4 + header.len() + payload.len();
    if body_len > MAX_FRAME_BYTES {
        return Err(format!(
            "{} of {body_len} bytes is over the {MAX_FRAME_BYTES} byte frame limit",
            msg.name()
        ));
    }
    let mut out = Vec::with_capacity(4 + body_len);
    out.extend_from_slice(&(body_len as u32).to_be_bytes());
    out.extend_from_slice(&(header.len() as u32).to_be_bytes());
    out.extend_from_slice(&header);
    out.extend_from_slice(payload);
    Ok(out)
}

/// A message from a frame's body (everything after the leading length).
pub fn decode(body: &[u8]) -> Result<Message, String> {
    let Some(header_len) = body.get(..4) else {
        return Err("a frame too short to hold its header's length".to_string());
    };
    let header_len = u32::from_be_bytes(header_len.try_into().unwrap()) as usize;
    let Some(header) = body.get(4..4 + header_len) else {
        return Err("a frame shorter than its header says".to_string());
    };
    let mut msg: Message =
        serde_json::from_slice(header).map_err(|e| format!("an unreadable message: {e}"))?;
    msg.set_payload(body[4 + header_len..].to_vec())?;
    Ok(msg)
}

pub async fn write<W: AsyncWrite + Unpin>(w: &mut W, msg: &Message) -> Result<(), String> {
    let frame = encode(msg)?;
    w.write_all(&frame).await.map_err(|e| e.to_string())?;
    w.flush().await.map_err(|e| e.to_string())
}

/// The next message, or `None` when the other side closed the connection
/// cleanly between frames.
pub async fn read<R: AsyncRead + Unpin>(r: &mut R) -> Result<Option<Message>, String> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.to_string()),
    }
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_FRAME_BYTES {
        return Err(format!(
            "a frame of {len} bytes is over the {MAX_FRAME_BYTES} byte limit"
        ));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body)
        .await
        .map_err(|e| format!("the connection ended inside a frame: {e}"))?;
    decode(&body).map(Some)
}

/// When a connection last received anything, in milliseconds since the epoch.
///
/// Counted per byte rather than per frame (ADR 0032, decision 8): a large
/// document on a slow link can take longer than the liveness limit to arrive
/// whole, and a connection moving bytes is not dead.
#[derive(Debug, Clone, Default)]
pub struct Activity(Arc<AtomicI64>);

impl Activity {
    pub fn new(now: i64) -> Self {
        Self(Arc::new(AtomicI64::new(now)))
    }

    pub fn last(&self) -> i64 {
        self.0.load(Ordering::Relaxed)
    }

    pub fn touch(&self, now: i64) {
        self.0.store(now, Ordering::Relaxed);
    }
}

/// A reader that records activity whenever bytes arrive.
pub struct ActivityReader<R> {
    inner: R,
    activity: Activity,
    clock: fn() -> i64,
}

impl<R> ActivityReader<R> {
    pub fn new(inner: R, activity: Activity, clock: fn() -> i64) -> Self {
        Self {
            inner,
            activity,
            clock,
        }
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for ActivityReader<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let polled = Pin::new(&mut self.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = &polled {
            if buf.filled().len() > before {
                let now = (self.clock)();
                self.activity.touch(now);
            }
        }
        polled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn delta() -> Message {
        Message::SyncDelta {
            id: "doc".into(),
            update: vec![1, 2, 3, 250],
        }
    }

    #[test]
    fn a_message_survives_the_round_trip_bytes_and_all() {
        let frame = encode(&delta()).unwrap();
        assert_eq!(decode(&frame[4..]).unwrap(), delta());
    }

    #[test]
    fn the_bytes_come_after_the_header_unencoded() {
        let frame = encode(&delta()).unwrap();
        assert_eq!(&frame[frame.len() - 4..], &[1, 2, 3, 250]);
    }

    #[tokio::test]
    async fn frames_read_back_in_order_and_a_clean_close_is_none() {
        let mut wire = Vec::new();
        write(&mut wire, &delta()).await.unwrap();
        write(&mut wire, &Message::SyncDone).await.unwrap();
        let mut r = &wire[..];
        assert_eq!(read(&mut r).await.unwrap(), Some(delta()));
        assert_eq!(read(&mut r).await.unwrap(), Some(Message::SyncDone));
        assert_eq!(read(&mut r).await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_frame_that_claims_to_be_enormous_is_refused_before_it_is_read() {
        let wire = ((MAX_FRAME_BYTES + 1) as u32).to_be_bytes();
        assert!(read(&mut &wire[..]).await.is_err());
    }

    #[tokio::test]
    async fn a_connection_that_ends_inside_a_frame_is_an_error() {
        let frame = encode(&delta()).unwrap();
        assert!(read(&mut &frame[..frame.len() - 1]).await.is_err());
    }

    #[test]
    fn a_header_that_says_it_is_longer_than_the_frame_is_refused() {
        let mut body = 100u32.to_be_bytes().to_vec();
        body.extend_from_slice(br#"{"t":"sync-done"}"#);
        assert!(decode(&body).is_err());
    }

    #[test]
    fn bytes_on_a_message_that_carries_none_are_refused() {
        let mut frame = encode(&Message::SyncDone).unwrap();
        frame.push(7);
        assert!(decode(&frame[4..]).is_err());
    }

    #[test]
    fn an_oversize_message_is_refused_before_it_is_sent() {
        let big = Message::SyncDelta {
            id: "d".into(),
            update: vec![0; MAX_FRAME_BYTES],
        };
        assert!(encode(&big).is_err());
    }

    #[tokio::test]
    async fn reading_records_when_bytes_arrived() {
        fn clock() -> i64 {
            42
        }
        let frame = encode(&delta()).unwrap();
        let activity = Activity::new(0);
        let mut reader = ActivityReader::new(&frame[..], activity.clone(), clock);
        read(&mut reader).await.unwrap();
        assert_eq!(activity.last(), 42);
    }
}

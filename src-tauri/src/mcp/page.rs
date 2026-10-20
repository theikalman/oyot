//! Asking the page for what only it can do (ADR 0037, decision 6).
//!
//! Only the page can turn a note into Markdown, because only it has the
//! editor's schema, and only it can decode and redraw an image. Rust asks it
//! with an `mcp-request` event and the page answers with `mcp_respond`. Each
//! request is handled in the page as one step of that document's write queue,
//! so a read sees every write before it and none after.

use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, watch};

/// How long the page has to answer. A hidden page on Linux answered in a few
/// milliseconds in the spike (ADR 0037, open question 2); this is for one
/// rendering a very large note.
const TIMEOUT: Duration = Duration::from_secs(10);

/// How long to wait for the page to start listening. A client that starts
/// Oyot (ADR 0037, decision 2) calls as soon as Rust listens, which is well
/// before the page has loaded; an event sent before the page listens is lost.
const LOAD_TIMEOUT: Duration = Duration::from_secs(30);

/// What the tools ask of the page. A trait, so the tests can stand in for it.
#[async_trait]
pub trait Page: Send + Sync {
    async fn ask(&self, method: &str, params: Value) -> Result<Value, String>;
}

type Answer = Result<Value, String>;

pub struct PageRelay {
    app: AppHandle,
    next: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Answer>>>,
    /// Whether the page has said it is listening.
    ready: watch::Sender<bool>,
}

impl PageRelay {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            next: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            ready: watch::channel(false).0,
        }
    }

    /// The page is listening for requests.
    pub fn page_ready(&self) {
        self.ready.send_replace(true);
    }

    /// The page's answer to request `id`. One nobody waits for any more, which
    /// timed out, is dropped.
    pub fn respond(&self, id: u64, answer: Answer) {
        if let Some(waiting) = self.pending.lock().remove(&id) {
            let _ = waiting.send(answer);
        }
    }
}

#[async_trait]
impl Page for PageRelay {
    async fn ask(&self, method: &str, params: Value) -> Answer {
        let mut ready = self.ready.subscribe();
        if tokio::time::timeout(LOAD_TIMEOUT, ready.wait_for(|ready| *ready))
            .await
            .is_err()
        {
            return Err(
                "Oyot's window has not finished loading. Try again in a moment.".to_string(),
            );
        }

        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (answer, answered) = oneshot::channel();
        self.pending.lock().insert(id, answer);

        let request = json!({ "id": id, "method": method, "params": params });
        if let Err(e) = self
            .app
            .emit_to(crate::desktop::MAIN_WINDOW, "mcp-request", request)
        {
            self.pending.lock().remove(&id);
            return Err(format!("Oyot's window could not be asked: {e}"));
        }
        match tokio::time::timeout(TIMEOUT, answered).await {
            Ok(Ok(answer)) => answer,
            _ => {
                self.pending.lock().remove(&id);
                Err("Oyot's window did not answer in time.".to_string())
            }
        }
    }
}

//! The server end to end: the protocol as a client speaks it, over a stream,
//! against a real database.

use super::access::{Access, Current};
use super::endpoint::Endpoint;
use super::listener::Listener;
use super::page::Page;
use super::server::OyotServer;
use super::tools::Context;
use parking_lot::Mutex;
use rmcp::ServiceExt;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

fn database() -> Arc<Mutex<Connection>> {
    let db = Connection::open_in_memory().unwrap();
    crate::setup_database_tables(&db).unwrap();
    let note = |id: &str, kind: &str, title: &str, body: &str, at: i64| {
        db.execute(
            "INSERT INTO documents (id, type, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id, kind, title, at],
        )
        .unwrap();
        db.execute(
            "INSERT INTO document_search (document_id, title, body) VALUES (?1, ?2, ?3)",
            params![id, title, body],
        )
        .unwrap();
    };
    note(
        "n1",
        "note",
        "Kyoto trip",
        "two nights near the river",
        1_000,
    );
    note("n2", "note", "Packing", "see the trip note", 2_000);
    // A journal's title is its day; its id is the day written out.
    note(
        "20 Oct 2026",
        "journal",
        "2026-10-20",
        "wrote the plan",
        3_000,
    );
    db.execute_batch(
        "INSERT INTO document_todos (document_id, ordinal, text, checked, depth) VALUES
             ('n2', 0, 'passport', 1, 0), ('n2', 1, 'charger', 0, 0), ('n2', 2, 'adapter', 0, 1);
         INSERT INTO document_tags (document_id, name) VALUES ('n1', 'travel'), ('n2', 'travel');
         INSERT INTO document_links (source_id, target_id) VALUES ('n2', 'n1');",
    )
    .unwrap();
    Arc::new(Mutex::new(db))
}

/// A page that answers from a table, and remembers what it was asked.
#[derive(Default)]
struct FakePage {
    answers: Mutex<std::collections::HashMap<String, Value>>,
    asked: Mutex<Vec<(String, Value)>>,
}

#[async_trait::async_trait]
impl Page for FakePage {
    async fn ask(&self, method: &str, params: Value) -> Result<Value, String> {
        self.asked.lock().push((method.to_string(), params));
        self.answers
            .lock()
            .get(method)
            .cloned()
            .ok_or_else(|| format!("the page was not expecting {method}"))
    }
}

impl FakePage {
    fn answer(&self, method: &str, value: Value) {
        self.answers.lock().insert(method.to_string(), value);
    }

    fn methods(&self) -> Vec<String> {
        self.asked.lock().iter().map(|(m, _)| m.clone()).collect()
    }
}

struct Setup {
    ctx: Arc<Context>,
    page: Arc<FakePage>,
    fetched: Arc<Mutex<Vec<String>>>,
    data_dir: std::path::PathBuf,
}

fn setup(access: Access) -> Setup {
    let page = Arc::new(FakePage::default());
    let fetched = Arc::new(Mutex::new(Vec::new()));
    let data_dir = std::env::temp_dir().join(format!("oyot-mcp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(data_dir.join("attachments")).unwrap();
    let ctx = Arc::new(Context {
        db: database(),
        access: Arc::new(Current::new(access)),
        data_dir: data_dir.clone(),
        page: page.clone(),
        fetch_attachment: {
            let fetched = fetched.clone();
            Arc::new(move |hash| fetched.lock().push(hash.to_string()))
        },
    });
    Setup {
        ctx,
        page,
        fetched,
        data_dir,
    }
}

impl Drop for Setup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.data_dir);
    }
}

/// A context whose stand-ins nothing looks at. Its data directory is gone
/// as soon as it is made, and none of the tools it serves read one.
fn context(access: Access) -> Arc<Context> {
    setup(access).ctx.clone()
}

/// A client: writes requests as lines, reads responses as lines.
struct Client<S: AsyncRead + AsyncWrite + Unpin> {
    stream: BufReader<S>,
    next_id: u64,
}

impl<S: AsyncRead + AsyncWrite + Unpin> Client<S> {
    async fn start(stream: S) -> (Self, Value) {
        let mut client = Client {
            stream: BufReader::new(stream),
            next_id: 0,
        };
        let info = client
            .request(
                "initialize",
                json!({
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": { "name": "test", "version": "1" }
                }),
            )
            .await;
        client
            .send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .await;
        (client, info)
    }

    async fn send(&mut self, message: Value) {
        let mut line = message.to_string();
        line.push('\n');
        self.stream
            .get_mut()
            .write_all(line.as_bytes())
            .await
            .unwrap();
    }

    async fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await;
        loop {
            let mut line = String::new();
            assert!(
                self.stream.read_line(&mut line).await.unwrap() > 0,
                "the server hung up"
            );
            let message: Value = serde_json::from_str(&line).unwrap();
            if message["id"] == id {
                return message;
            }
        }
    }

    async fn call(&mut self, tool: &str, arguments: Value) -> Value {
        let response = self
            .request(
                "tools/call",
                json!({ "name": tool, "arguments": arguments }),
            )
            .await;
        response["result"].clone()
    }

    async fn tools(&mut self) -> Vec<String> {
        let response = self.request("tools/list", json!({})).await;
        response["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect()
    }
}

async fn connected(access: Access) -> (Client<tokio::io::DuplexStream>, Value) {
    connected_to(context(access)).await
}

async fn connected_to(ctx: Arc<Context>) -> (Client<tokio::io::DuplexStream>, Value) {
    let (ours, theirs) = tokio::io::duplex(1 << 20);
    tokio::spawn(async move {
        if let Ok(running) = OyotServer::new(ctx).serve(theirs).await {
            let _ = running.waiting().await;
        }
    });
    Client::start(ours).await
}

fn text(result: &Value) -> String {
    result["content"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

#[tokio::test]
async fn a_client_is_told_who_it_is_talking_to() {
    let (_client, info) = connected(Access::ReadOnly).await;
    assert_eq!(info["result"]["serverInfo"]["name"], "oyot");
    assert!(info["result"]["capabilities"]["tools"].is_object());
    assert!(info["result"]["instructions"]
        .as_str()
        .unwrap()
        .contains("Oyot"));
}

#[tokio::test]
async fn read_only_lists_the_tools_that_read() {
    let (mut client, _) = connected(Access::ReadOnly).await;
    assert_eq!(
        client.tools().await,
        [
            "search_notes",
            "list_notes",
            "read_note",
            "get_journal",
            "list_todos",
            "list_tags",
            "notes_with_tag",
            "get_backlinks",
            "read_attachment"
        ]
    );
}

#[tokio::test]
async fn off_lists_nothing_and_refuses_every_call() {
    let (mut client, _) = connected(Access::Off).await;
    assert!(client.tools().await.is_empty());
    let result = client.call("list_tags", json!({})).await;
    assert_eq!(result["isError"], true);
    assert!(text(&result).contains("off in Oyot's settings"));
}

#[tokio::test]
async fn search_finds_words_in_the_text_and_marks_them() {
    let (mut client, _) = connected(Access::ReadOnly).await;
    let result = client
        .call("search_notes", json!({ "query": "river" }))
        .await;
    assert_eq!(result["isError"], false);
    assert!(text(&result).contains("Kyoto trip (note, id n1)"));
    assert!(text(&result).contains("**river**"));
    assert_eq!(result["structuredContent"]["results"][0]["id"], "n1");

    let journals = client
        .call(
            "search_notes",
            json!({ "query": "plan", "type": "journal" }),
        )
        .await;
    assert_eq!(
        journals["structuredContent"]["results"][0]["id"],
        "20 Oct 2026"
    );
}

#[tokio::test]
async fn notes_are_listed_newest_first_a_page_at_a_time() {
    let (mut client, _) = connected(Access::ReadOnly).await;
    let first = client
        .call("list_notes", json!({ "type": "note", "limit": 1 }))
        .await;
    assert_eq!(first["structuredContent"]["notes"][0]["id"], "n2");
    assert_eq!(first["structuredContent"]["total"], 2);
    assert_eq!(first["structuredContent"]["next_offset"], 1);
    assert!(text(&first).contains("Pass offset 1 for more."));

    let second = client
        .call(
            "list_notes",
            json!({ "type": "note", "limit": 1, "offset": 1 }),
        )
        .await;
    assert_eq!(second["structuredContent"]["notes"][0]["id"], "n1");
    assert_eq!(second["structuredContent"]["next_offset"], Value::Null);
}

#[tokio::test]
async fn todos_carry_what_toggle_todo_will_need() {
    let (mut client, _) = connected(Access::ReadOnly).await;
    let open = client.call("list_todos", json!({ "checked": false })).await;
    assert_eq!(
        open["structuredContent"]["todos"],
        json!([
            { "note_id": "n2", "note_title": "Packing", "note_type": "note", "ordinal": 1, "text": "charger", "checked": false, "depth": 0 },
            { "note_id": "n2", "note_title": "Packing", "note_type": "note", "ordinal": 2, "text": "adapter", "checked": false, "depth": 1 }
        ])
    );
    assert!(text(&open)
        .contains("## Packing (id n2)\n- [ ] charger (ordinal 1)\n  - [ ] adapter (ordinal 2)\n"));
}

#[tokio::test]
async fn tags_and_links_are_answered_from_the_index() {
    let (mut client, _) = connected(Access::ReadOnly).await;
    let tags = client.call("list_tags", json!({})).await;
    assert_eq!(text(&tags), "- #travel (2 notes)\n");

    let tagged = client
        .call("notes_with_tag", json!({ "tag": "#Travel" }))
        .await;
    assert_eq!(
        tagged["structuredContent"]["notes"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    let links = client.call("get_backlinks", json!({ "id": "n1" })).await;
    assert_eq!(links["structuredContent"]["notes"][0]["id"], "n2");

    let missing = client.call("get_backlinks", json!({ "id": "nope" })).await;
    assert_eq!(missing["isError"], true);
    assert!(text(&missing).contains("no note with id"));
}

#[tokio::test]
async fn a_bad_call_is_an_error_the_assistant_can_read() {
    let (mut client, _) = connected(Access::ReadOnly).await;
    let unknown = client.call("delete_everything", json!({})).await;
    assert_eq!(unknown["isError"], true);
    let bad = client.call("search_notes", json!({ "query": 3 })).await;
    assert_eq!(text(&bad), "query must be a string.");
}

#[cfg(unix)]
#[tokio::test]
async fn the_socket_serves_clients_and_changing_the_setting_ends_their_sessions() {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let dir = std::path::Path::new("/tmp").join(format!("oyot-mcp-{}", &id[..12]));
    std::fs::create_dir_all(&dir).unwrap();
    let endpoint = Endpoint::in_dir(&dir);
    let Endpoint::Socket(path) = &endpoint;
    let path = path.clone();

    let listener = Listener::start(endpoint, context(Access::ReadOnly)).unwrap();
    let stream = tokio::net::UnixStream::connect(&path).await.unwrap();
    let (mut client, info) = Client::start(stream).await;
    assert_eq!(info["result"]["serverInfo"]["name"], "oyot");
    assert_eq!(client.tools().await.len(), 9);

    listener.drop_sessions();
    let mut line = String::new();
    let read = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        client.stream.read_line(&mut line),
    )
    .await
    .expect("the session ends");
    assert_eq!(read.unwrap(), 0, "the server hung up");

    // A new client is still welcome.
    let stream = tokio::net::UnixStream::connect(&path).await.unwrap();
    let (_client, info) = Client::start(stream).await;
    assert_eq!(info["result"]["serverInfo"]["name"], "oyot");

    listener.stop();
    assert!(!path.exists(), "stopping removes the socket");
    let _ = std::fs::remove_dir_all(dir);
}

// --- the tools that need the page -------------------------------------------

const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MISSING: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ORPHAN: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

/// The start of a PNG of `w` by `h`: all the header reader looks at.
fn png(w: u32, h: u32) -> Vec<u8> {
    let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
    b.extend(w.to_be_bytes());
    b.extend(h.to_be_bytes());
    b.extend([8, 6, 0, 0, 0]);
    b
}

/// An image stored for note n1, as `bytes`, and one n1 embeds that this
/// device does not have, and one held that no note embeds.
fn with_images(setup: &Setup, bytes: &[u8]) {
    std::fs::write(setup.data_dir.join("attachments/a.png"), bytes).unwrap();
    std::fs::write(setup.data_dir.join("attachments/c.png"), bytes).unwrap();
    let db = setup.ctx.db.lock();
    db.execute(
        "INSERT INTO attachments (hash, mime_type, local_path, is_fully_downloaded, created_at)
         VALUES (?1, 'image/png', 'attachments/a.png', 1, 0),
                (?2, 'image/png', NULL, 0, 0),
                (?3, 'image/png', 'attachments/c.png', 1, 0)",
        params![HASH, MISSING, ORPHAN],
    )
    .unwrap();
    db.execute(
        "INSERT INTO document_attachments (document_id, hash) VALUES ('n1', ?1), ('n1', ?2)",
        params![HASH, MISSING],
    )
    .unwrap();
}

fn rendered(markdown: &str) -> Value {
    json!({
        "markdown": markdown,
        "revision": "rev-1",
        "images": [
            { "ref": HASH, "kind": "attachment", "alt": "A cat" },
            { "ref": MISSING, "kind": "attachment", "alt": null },
            { "ref": "1", "kind": "inline", "alt": null }
        ]
    })
}

#[tokio::test]
async fn a_note_is_read_as_markdown_with_its_revision_and_images() {
    let s = setup(Access::ReadOnly);
    with_images(&s, &png(10, 10));
    s.page
        .answer("readNote", rendered("# Trip\n\ntwo nights\n"));
    let (mut client, _) = connected_to(s.ctx.clone()).await;

    let result = client.call("read_note", json!({ "id": "n1" })).await;
    assert_eq!(result["isError"], false, "{result}");
    let shown = text(&result);
    assert!(
        shown.starts_with("Title: Kyoto trip\nId: n1 (note)\n"),
        "{shown}"
    );
    assert!(shown.contains("Revision: rev-1\n"));
    assert!(shown.contains(&format!(
        "- oyot-attachment://{HASH} \"A cat\" (image/png)\n"
    )));
    assert!(shown.contains(&format!(
        "- oyot-attachment://{MISSING} (image/png, not on this device yet)\n"
    )));
    assert!(
        shown.contains("- oyot-inline-image://1 (inline; give read_attachment this note's id)\n")
    );
    assert!(shown.ends_with("---\n\n# Trip\n\ntwo nights\n"));
    assert_eq!(result["structuredContent"]["revision"], "rev-1");
    assert_eq!(result["structuredContent"]["images"][1]["available"], false);
    assert_eq!(s.page.asked.lock()[0].1, json!({ "docId": "n1" }));
}

#[tokio::test]
async fn a_note_that_does_not_exist_is_not_asked_of_the_page() {
    let s = setup(Access::ReadOnly);
    let (mut client, _) = connected_to(s.ctx.clone()).await;
    let result = client.call("read_note", json!({ "id": "nope" })).await;
    assert_eq!(result["isError"], true);
    assert!(s.page.methods().is_empty());
}

#[tokio::test]
async fn a_very_long_note_is_cut_short_and_says_so() {
    let s = setup(Access::ReadOnly);
    s.page.answer(
        "readNote",
        json!({ "markdown": "é".repeat(150_000), "revision": "r", "images": [] }),
    );
    let (mut client, _) = connected_to(s.ctx.clone()).await;
    let result = client.call("read_note", json!({ "id": "n1" })).await;
    assert_eq!(result["structuredContent"]["truncated"], true);
    assert!(text(&result).contains("[Cut short: the note is 300 KB"));
}

#[tokio::test]
async fn a_journal_is_found_by_its_day() {
    let s = setup(Access::ReadOnly);
    s.page.answer(
        "readNote",
        json!({ "markdown": "wrote the plan\n", "revision": "r", "images": [] }),
    );
    let (mut client, _) = connected_to(s.ctx.clone()).await;

    let found = client
        .call("get_journal", json!({ "date": "2026-10-20" }))
        .await;
    assert!(
        text(&found).contains("Id: 20 Oct 2026 (journal)"),
        "{found}"
    );

    let none = client
        .call("get_journal", json!({ "date": "2026-10-21" }))
        .await;
    assert_eq!(none["isError"], false);
    assert_eq!(none["structuredContent"]["found"], false);

    let bad = client
        .call("get_journal", json!({ "date": "yesterday" }))
        .await;
    assert_eq!(text(&bad), "date must be a day, as YYYY-MM-DD.");
}

#[tokio::test]
async fn a_small_image_goes_straight_from_rust() {
    let s = setup(Access::ReadOnly);
    with_images(&s, &png(800, 600));
    let (mut client, _) = connected_to(s.ctx.clone()).await;

    let result = client
        .call(
            "read_attachment",
            json!({ "ref": format!("oyot-attachment://{HASH}") }),
        )
        .await;
    assert_eq!(result["isError"], false, "{result}");
    assert_eq!(result["content"][2]["type"], "image");
    assert_eq!(result["content"][2]["mimeType"], "image/png");
    assert_eq!(result["structuredContent"]["width"], 800);
    assert!(s.page.methods().is_empty(), "the page was not needed");
}

#[tokio::test]
async fn a_large_image_is_redrawn_by_the_page() {
    let s = setup(Access::ReadOnly);
    with_images(&s, &png(4032, 3024));
    s.page.answer(
        "prepareImage",
        json!({ "ok": true, "mime": "image/jpeg", "base64": "AAAA", "width": 1568, "height": 1176, "scaled": true, "firstFrameOnly": false }),
    );
    let (mut client, _) = connected_to(s.ctx.clone()).await;

    let result = client.call("read_attachment", json!({ "ref": HASH })).await;
    assert_eq!(result["isError"], false, "{result}");
    assert_eq!(result["content"][2]["mimeType"], "image/jpeg");
    assert!(text(&result).contains("1568x1176, scaled down to fit"));
    let asked = s.page.asked.lock();
    assert_eq!(asked[0].0, "prepareImage");
    assert_eq!(asked[0].1["mime"], "image/png");
    assert_eq!(asked[0].1["maxBytes"], 700_000);
}

#[tokio::test]
async fn an_image_not_here_yet_is_asked_for_from_other_devices() {
    let s = setup(Access::ReadOnly);
    with_images(&s, &png(10, 10));
    let (mut client, _) = connected_to(s.ctx.clone()).await;

    let result = client
        .call("read_attachment", json!({ "ref": MISSING }))
        .await;
    assert_eq!(result["isError"], true);
    assert!(text(&result).contains("not on this device yet"));
    assert_eq!(*s.fetched.lock(), vec![MISSING.to_string()]);
}

#[tokio::test]
async fn an_image_no_note_holds_is_not_served() {
    let s = setup(Access::ReadOnly);
    with_images(&s, &png(10, 10));
    let (mut client, _) = connected_to(s.ctx.clone()).await;

    let result = client
        .call("read_attachment", json!({ "ref": ORPHAN }))
        .await;
    assert_eq!(result["isError"], true);
    assert!(text(&result).contains("No note holds"));
    assert!(s.fetched.lock().is_empty());
}

#[tokio::test]
async fn an_inline_image_is_read_out_of_its_note_by_the_page() {
    let s = setup(Access::ReadOnly);
    use base64::Engine;
    let small = base64::engine::general_purpose::STANDARD.encode(png(16, 16));
    s.page.answer(
        "inlineImage",
        json!({ "mime": "image/png", "base64": small }),
    );
    let (mut client, _) = connected_to(s.ctx.clone()).await;

    let without = client
        .call("read_attachment", json!({ "ref": "oyot-inline-image://1" }))
        .await;
    assert_eq!(
        text(&without),
        "An inline image needs note_id, the note it is in."
    );

    let result = client
        .call(
            "read_attachment",
            json!({ "ref": "oyot-inline-image://1", "note_id": "n1" }),
        )
        .await;
    assert_eq!(result["isError"], false, "{result}");
    assert_eq!(
        s.page.asked.lock()[0].1,
        json!({ "docId": "n1", "id": "1" })
    );
}

#[tokio::test]
async fn a_note_can_bring_its_images_with_it() {
    let s = setup(Access::ReadOnly);
    with_images(&s, &png(10, 10));
    use base64::Engine;
    let small = base64::engine::general_purpose::STANDARD.encode(png(16, 16));
    s.page.answer("readNote", rendered("![A cat](x)\n"));
    s.page.answer(
        "inlineImage",
        json!({ "mime": "image/png", "base64": small }),
    );
    let (mut client, _) = connected_to(s.ctx.clone()).await;

    let result = client
        .call("read_note", json!({ "id": "n1", "include_images": true }))
        .await;
    let content = result["content"].as_array().unwrap();
    let images: Vec<&Value> = content.iter().filter(|c| c["type"] == "image").collect();
    assert_eq!(images.len(), 2, "the held one and the inline one");
    assert!(text(&result).contains("[Images not included: image 2: "));
    assert!(content[1]["text"]
        .as_str()
        .unwrap()
        .starts_with("Image 1: oyot-attachment://"));
}

// --- the tools that write ---------------------------------------------------

#[tokio::test]
async fn read_only_offers_no_tool_that_writes_and_refuses_one() {
    let s = setup(Access::ReadOnly);
    let (mut client, _) = connected_to(s.ctx.clone()).await;
    assert!(!client.tools().await.contains(&"edit_note".to_string()));
    let refused = client
        .call("append_to_note", json!({ "id": "n1", "markdown": "x" }))
        .await;
    assert_eq!(refused["isError"], true);
    assert!(s.page.methods().is_empty());
}

#[tokio::test]
async fn read_write_offers_the_tools_that_write_and_none_that_delete() {
    let (mut client, _) = connected(Access::ReadWrite).await;
    let tools = client.tools().await;
    assert_eq!(tools.len(), 15);
    for name in [
        "create_note",
        "edit_note",
        "append_to_note",
        "append_to_journal",
        "rename_note",
        "toggle_todo",
    ] {
        assert!(tools.contains(&name.to_string()), "{name}");
    }
    assert!(!tools.iter().any(|t| t.contains("delete")));
}

#[tokio::test]
async fn an_edit_is_passed_on_and_its_new_revision_returned() {
    let s = setup(Access::ReadWrite);
    s.page.answer(
        "editNote",
        json!({ "status": "changed", "revision": "rev-2", "blocks": 1 }),
    );
    let (mut client, _) = connected_to(s.ctx.clone()).await;
    let result = client
        .call(
            "edit_note",
            json!({ "id": "n1", "markdown": "new\n", "revision": "rev-1" }),
        )
        .await;
    assert_eq!(text(&result), "Saved, 1 block changed. Revision: rev-2\n");
    assert_eq!(
        s.page.asked.lock()[0].1,
        json!({ "docId": "n1", "markdown": "new\n", "revision": "rev-1", "acceptFormattingLoss": false })
    );
}

#[tokio::test]
async fn an_edit_from_a_stale_revision_comes_back_with_the_note_as_it_is() {
    let s = setup(Access::ReadWrite);
    s.page.answer(
        "editNote",
        json!({ "status": "conflict", "revision": "rev-3", "markdown": "typed meanwhile\n" }),
    );
    let (mut client, _) = connected_to(s.ctx.clone()).await;
    let result = client
        .call(
            "edit_note",
            json!({ "id": "n1", "markdown": "new\n", "revision": "rev-1" }),
        )
        .await;
    assert_eq!(result["isError"], true);
    assert!(text(&result).contains("at revision rev-3"));
    assert!(text(&result).ends_with("typed meanwhile\n"));
}

#[tokio::test]
async fn an_edit_that_would_lose_formatting_says_what_and_where() {
    let s = setup(Access::ReadWrite);
    s.page.answer(
        "editNote",
        json!({ "status": "lossy", "lossy": [{ "index": 2, "markdown": "| a |\n| --- |", "losses": ["a table's column widths"] }] }),
    );
    let (mut client, _) = connected_to(s.ctx.clone()).await;
    let result = client
        .call(
            "edit_note",
            json!({ "id": "n1", "markdown": "x\n", "revision": "r" }),
        )
        .await;
    assert_eq!(result["isError"], true);
    let shown = text(&result);
    assert!(shown
        .contains("- block 3, which would lose a table's column widths:\n    | a |\n    | --- |"));
    assert!(shown.contains("accept_formatting_loss: true"));
}

#[tokio::test]
async fn a_journal_is_made_for_a_day_that_has_none_before_it_is_added_to() {
    let s = setup(Access::ReadWrite);
    s.page
        .answer("createJournal", json!({ "id": "21 Oct 2026" }));
    s.page.answer(
        "appendNote",
        json!({ "status": "changed", "revision": "r" }),
    );
    let (mut client, _) = connected_to(s.ctx.clone()).await;

    let existing = client
        .call(
            "append_to_journal",
            json!({ "date": "2026-10-20", "markdown": "- a" }),
        )
        .await;
    assert_eq!(existing["isError"], false, "{existing}");
    let missing = client
        .call(
            "append_to_journal",
            json!({ "date": "2026-10-21", "markdown": "- b" }),
        )
        .await;
    assert_eq!(missing["isError"], false, "{missing}");

    let asked = s.page.asked.lock();
    assert_eq!(
        asked[0].1,
        json!({ "docId": "20 Oct 2026", "markdown": "- a" })
    );
    assert_eq!(asked[1].0, "createJournal");
    assert_eq!(asked[1].1, json!({ "date": "2026-10-21" }));
    assert_eq!(
        asked[2].1,
        json!({ "docId": "21 Oct 2026", "markdown": "- b" })
    );
}

#[tokio::test]
async fn a_journal_cannot_be_renamed_and_a_note_needs_a_title() {
    let s = setup(Access::ReadWrite);
    s.page
        .answer("renameNote", json!({ "title": "Kyoto, again" }));
    let (mut client, _) = connected_to(s.ctx.clone()).await;

    let journal = client
        .call(
            "rename_note",
            json!({ "id": "20 Oct 2026", "title": "Mine" }),
        )
        .await;
    assert_eq!(journal["isError"], true);
    let blank = client
        .call("rename_note", json!({ "id": "n1", "title": "   " }))
        .await;
    assert_eq!(text(&blank), "A title cannot be empty.");
    let renamed = client
        .call(
            "rename_note",
            json!({ "id": "n1", "title": "Kyoto, again" }),
        )
        .await;
    assert_eq!(text(&renamed), "Renamed Kyoto trip to Kyoto, again.\n");
    assert_eq!(s.page.methods(), ["renameNote"]);
}

#[tokio::test]
async fn a_task_that_moved_is_not_ticked_and_the_tasks_are_shown() {
    let s = setup(Access::ReadWrite);
    s.page.answer(
        "toggleTodo",
        json!({ "status": "moved", "todos": [{ "ordinal": 0, "text": "charger", "checked": false, "depth": 0 }] }),
    );
    let (mut client, _) = connected_to(s.ctx.clone()).await;
    let result = client
        .call(
            "toggle_todo",
            json!({ "note_id": "n2", "ordinal": 1, "text": "charger", "checked": true }),
        )
        .await;
    assert_eq!(result["isError"], true);
    assert!(text(&result).ends_with("- [ ] charger (ordinal 0)\n"));

    let missing = client
        .call(
            "toggle_todo",
            json!({ "note_id": "n2", "text": "x", "checked": true }),
        )
        .await;
    assert_eq!(text(&missing), "ordinal is required.");
}

#[tokio::test]
async fn a_new_note_is_made_by_the_page() {
    let s = setup(Access::ReadWrite);
    s.page
        .answer("createNote", json!({ "id": "new-1", "revision": "r1" }));
    let (mut client, _) = connected_to(s.ctx.clone()).await;
    let result = client
        .call(
            "create_note",
            json!({ "title": " Ideas ", "markdown": "one\n" }),
        )
        .await;
    assert_eq!(text(&result), "Created Ideas (id new-1). Revision: r1\n");
    assert_eq!(
        s.page.asked.lock()[0].1,
        json!({ "title": "Ideas", "markdown": "one\n" })
    );
}

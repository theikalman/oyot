//! The server end to end: the protocol as a client speaks it, over a stream,
//! against a real database.

use super::access::{Access, Current};
use super::endpoint::Endpoint;
use super::listener::Listener;
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
    note(
        "20 Oct 2026",
        "journal",
        "20 Oct 2026",
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

fn context(access: Access) -> Arc<Context> {
    Arc::new(Context {
        db: database(),
        access: Arc::new(Current::new(access)),
    })
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
    let (ours, theirs) = tokio::io::duplex(1 << 16);
    let ctx = context(access);
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
            "list_todos",
            "list_tags",
            "notes_with_tag",
            "get_backlinks"
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
    assert_eq!(client.tools().await.len(), 6);

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

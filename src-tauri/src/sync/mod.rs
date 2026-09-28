//! The sync engine, in Rust (ADR 0031, ADR 0032).
//!
//! Sync used to run in the webview, over WebRTC, and stopped whenever the
//! page did. Here it runs for the life of the process, with or without a
//! window, over one TLS connection per pair of devices:
//!
//! - `protocol`: the messages two devices exchange
//! - `frame`: how a message is put on the wire
//! - `reconcile`: what to do about one document, given another copy's word
//! - `session`: one connection's share of the exchange, sans-IO

pub mod frame;
pub mod protocol;
pub mod reconcile;
pub mod session;

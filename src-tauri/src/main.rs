// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // What an MCP client launches (ADR 0037). Handled before Tauri starts, so
    // the single-instance plugin never sees it as a second copy of Oyot.
    #[cfg(desktop)]
    if std::env::args().nth(1).as_deref() == Some("--mcp") {
        std::process::exit(oyot_lib::mcp::bridge::run());
    }
    oyot_lib::run()
}

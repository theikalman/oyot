//! Tracing that does not ship.
//!
//! The signaling and sync paths trace heavily, which is what makes a pairing
//! problem diagnosable. None of it belongs in a release build: it is noise on
//! stderr, it formats strings on the save path, and the signaling traces name a
//! device id on every message.
//!
//! A macro rather than the `log` crate plus a Tauri plugin: the only thing
//! needed here is "compile this out of release", and that is one `cfg`. Adding
//! a logging backend, its plugin registration and its capability permission
//! would be more moving parts than the problem has.

/// Verbose tracing. Compiled out entirely in release builds.
#[macro_export]
macro_rules! trace {
    // Double-braced so the expansion is a block expression: `#[cfg]` is legal
    // on a statement but not on an expression, and trace! is used in both
    // positions (including match arms).
    ($($arg:tt)*) => {{
        #[cfg(debug_assertions)]
        std::eprintln!($($arg)*);
        // Keeps the arguments "used" in release, so a variable that only feeds
        // a trace does not trip unused_variables. format_args! borrows without
        // allocating and the result is dropped immediately, so it costs
        // nothing at runtime.
        #[cfg(not(debug_assertions))]
        {
            let _ = std::format_args!($($arg)*);
        }
    }};
}

/// Something unexpected that we recovered from. Kept in release builds: a user
/// reporting a problem should have something to read.
#[macro_export]
macro_rules! warn_log {
    ($($arg:tt)*) => {{
        std::eprintln!($($arg)*);
    }};
}

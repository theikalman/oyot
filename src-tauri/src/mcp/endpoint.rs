//! Where the app listens and the bridge connects (ADR 0037, decision 3).
//!
//! On macOS and Linux a Unix socket in the app's data directory, which only
//! this user can reach. On Windows a named pipe, which has no directory: its
//! name carries the user's, and the listener refuses clients on other
//! machines.

use std::path::{Path, PathBuf};

/// The app's identifier, as `tauri.conf.json` has it. Tauri names the data
/// directory after it, and the bridge has no Tauri to ask; a test keeps the
/// two in step.
pub const IDENTIFIER: &str = "com.ajiyakin.oyot";

#[cfg(unix)]
const SOCKET_FILE: &str = "mcp.sock";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Endpoint {
    #[cfg(unix)]
    Socket(PathBuf),
    #[cfg(windows)]
    Pipe(String),
}

impl Endpoint {
    /// The endpoint for a data directory.
    #[allow(unused_variables)]
    pub fn in_dir(data_dir: &Path) -> Endpoint {
        #[cfg(unix)]
        {
            Endpoint::Socket(data_dir.join(SOCKET_FILE))
        }
        #[cfg(windows)]
        {
            Endpoint::Pipe(pipe_name())
        }
    }

    /// The endpoint the running app has, worked out the way Tauri works out
    /// its data directory: `dirs::data_dir()` joined with the identifier.
    pub fn for_this_user() -> Option<Endpoint> {
        Some(Endpoint::in_dir(&dirs::data_dir()?.join(IDENTIFIER)))
    }
}

/// `\\.\pipe\com.ajiyakin.oyot.mcp.<user>`. The user's name keeps two people
/// signed in to one machine from finding each other's pipe.
#[cfg(windows)]
fn pipe_name() -> String {
    let user: String = std::env::var("USERNAME")
        .unwrap_or_default()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    format!(r"\\.\pipe\{IDENTIFIER}.mcp.{user}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_identifier_is_the_one_tauri_names_the_data_directory_after() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json"))
            .expect("tauri.conf.json is JSON");
        assert_eq!(conf["identifier"], IDENTIFIER);
    }

    #[cfg(unix)]
    #[test]
    fn the_socket_is_in_the_data_directory() {
        assert_eq!(
            Endpoint::in_dir(Path::new("/data/oyot")),
            Endpoint::Socket(PathBuf::from("/data/oyot/mcp.sock"))
        );
    }
}

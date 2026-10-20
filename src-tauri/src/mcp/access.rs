//! What MCP clients may do, as the user set it (ADR 0037, decision 4).

use crate::commands::config::{read_string, write_string};
use std::sync::atomic::{AtomicU8, Ordering};

/// The key in `config.json`.
const KEY: &str = "mcp_access";

/// Off until the user turns it on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    /// No tools are listed and every call is refused.
    Off,
    /// The tools that read, and none that write.
    ReadOnly,
}

impl Access {
    pub fn as_str(self) -> &'static str {
        match self {
            Access::Off => "off",
            Access::ReadOnly => "read_only",
        }
    }

    /// The setting a stored or requested value names. Anything else is
    /// `None`, and a stored value that is `None` reads as off: a hand-edited
    /// file should never turn access on by accident.
    pub fn parse(value: &str) -> Option<Access> {
        match value {
            "off" => Some(Access::Off),
            "read_only" => Some(Access::ReadOnly),
            _ => None,
        }
    }

    fn to_u8(self) -> u8 {
        match self {
            Access::Off => 0,
            Access::ReadOnly => 1,
        }
    }

    fn from_u8(value: u8) -> Access {
        match value {
            1 => Access::ReadOnly,
            _ => Access::Off,
        }
    }
}

pub fn read(app: &tauri::AppHandle) -> Access {
    read_string(app, KEY)
        .as_deref()
        .and_then(Access::parse)
        .unwrap_or(Access::Off)
}

pub fn write(app: &tauri::AppHandle, access: Access) -> Result<(), String> {
    write_string(app, KEY, access.as_str())
}

/// The setting as every session sees it, changed in one place.
pub struct Current(AtomicU8);

impl Current {
    pub fn new(access: Access) -> Self {
        Self(AtomicU8::new(access.to_u8()))
    }

    pub fn get(&self) -> Access {
        Access::from_u8(self.0.load(Ordering::SeqCst))
    }

    pub fn set(&self, access: Access) {
        self.0.store(access.to_u8(), Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_setting_reads_back_as_itself() {
        for access in [Access::Off, Access::ReadOnly] {
            assert_eq!(Access::parse(access.as_str()), Some(access));
            assert_eq!(Access::from_u8(access.to_u8()), access);
        }
    }

    #[test]
    fn anything_else_is_not_a_setting() {
        for value in ["", "on", "READ_ONLY", "read_write", "true"] {
            assert_eq!(Access::parse(value), None, "{value:?}");
        }
    }
}

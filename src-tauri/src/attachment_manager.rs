#![allow(dead_code)]

use std::sync::Arc;

pub struct AttachmentManager {
    _workspace_path: String,
    _db: Arc<parking_lot::Mutex<rusqlite::Connection>>,
}

#[derive(Debug, Clone)]
pub struct AttachmentInfo {
    pub hash: String,
    pub mime_type: String,
    pub local_path: Option<String>,
    pub is_fully_downloaded: bool,
}

impl AttachmentManager {
    pub fn new(workspace_path: String, db: Arc<parking_lot::Mutex<rusqlite::Connection>>) -> Self {
        Self {
            _workspace_path: workspace_path,
            _db: db,
        }
    }
}

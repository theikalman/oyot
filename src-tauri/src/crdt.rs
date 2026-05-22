use loro::{ContainerID, ExportMode, LoroDoc, VersionVector};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentMetadata {
    pub title: String,
    pub todo_count: i32,
    pub completed_todo_count: i32,
}

pub struct CrdtDocument {
    doc: LoroDoc,
}

impl CrdtDocument {
    pub fn new() -> Self {
        Self {
            doc: LoroDoc::new(),
        }
    }

    pub fn load_from_state(&mut self, blob: &[u8]) -> Result<(), String> {
        if blob.is_empty() {
            return Ok(());
        }
        let new_doc = LoroDoc::from_snapshot(blob).map_err(|e| e.to_string())?;
        *self = Self { doc: new_doc };
        Ok(())
    }

    pub fn apply_update(&mut self, update: &[u8]) -> Result<(), String> {
        if update.is_empty() {
            return Ok(());
        }
        self.doc.import(update).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn export_state(&self) -> Vec<u8> {
        self.doc.export(ExportMode::Snapshot).unwrap_or_default()
    }

    pub fn export_update_since(&self, clock: &VersionVector) -> Result<Vec<u8>, String> {
        self.doc
            .export(ExportMode::updates(clock))
            .map_err(|e| e.to_string())
    }

    fn get_text_by_name(&self, name: &str) -> String {
        let cid = ContainerID::new_root(name.into(), loro::ContainerType::Text);
        let text = self.doc.get_text(&cid);
        let mut result = String::new();
        text.iter(|s| {
            result.push_str(s);
            true
        });
        result
    }

    pub fn get_metadata(&self) -> DocumentMetadata {
        let title = self.get_text_by_name("title");
        let todo_count = self.count_todos();
        let completed_todo_count = self.count_completed_todos();

        DocumentMetadata {
            title: if title.is_empty() {
                "Untitled".to_string()
            } else {
                title
            },
            todo_count,
            completed_todo_count,
        }
    }

    fn count_todos(&self) -> i32 {
        let cid = ContainerID::new_root("todos".into(), loro::ContainerType::List);
        let list = self.doc.get_list(&cid);
        list.len() as i32
    }

    fn count_completed_todos(&self) -> i32 {
        let cid = ContainerID::new_root("todos".into(), loro::ContainerType::List);
        let list = self.doc.get_list(&cid);
        let mut count = 0i32;
        for i in 0..list.len() {
            if let Some(loro::ValueOrContainer::Value(loro::LoroValue::Map(map))) = list.get(i) {
                if let Some(loro::LoroValue::Bool(done)) = map.get("done") {
                    if *done {
                        count += 1;
                    }
                }
            }
        }
        count
    }
}

impl Default for CrdtDocument {
    fn default() -> Self {
        Self::new()
    }
}

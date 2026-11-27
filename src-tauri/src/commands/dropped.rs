//! Files dropped on the window from the system.
//!
//! On a computer Tauri takes a file dropped from the system for itself, so
//! the page's `drop` event never carries it, and the window event that
//! reports it carries its path instead. The path came from the system, so it
//! may be read; one the page handed over may not (see
//! `pick_and_import_image`). So the paths stay here, the page is told only
//! where the drop landed and a token for it, and it names the drop by that
//! token, once, when the drop landed on a note open for writing.
//!
//! One drop path for every kind of file a note takes, so a drop is heard by
//! one listener and accepted by one call, whatever it holds.

use std::io::Read;
use std::path::{Path, PathBuf};

use crate::commands::attachments::{import_image_bytes, StoredImage, MAX_IMAGE_BYTES};
use crate::db::AppState;

/// The kinds of file a note takes from a drop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropKind {
    Image,
}

/// The kind a dropped file is taken as, by its name. Only a first sort, to
/// leave out what no note takes: the bytes decide when it is stored.
pub fn kind_of(path: &Path) -> Option<DropKind> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" => Some(DropKind::Image),
        _ => None,
    }
}

/// The files of a drop a note could take: files, not folders, of a kind it
/// takes, in the order they were dropped.
fn droppable(paths: &[PathBuf]) -> Vec<PathBuf> {
    paths
        .iter()
        .filter(|p| kind_of(p).is_some() && p.is_file())
        .cloned()
        .collect()
}

/// The files last dropped on the window, until the page says where they go.
#[derive(Default)]
pub struct DroppedFiles(parking_lot::Mutex<Option<(String, Vec<PathBuf>)>>);

impl DroppedFiles {
    /// Hold a drop's files in place of any before, and the token for them.
    fn hold(&self, paths: Vec<PathBuf>) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        *self.0.lock() = Some((token.clone(), paths));
        token
    }

    /// The files of the drop `token` names, once. A token for any other drop
    /// leaves the one waiting where it is.
    fn take(&self, token: &str) -> Result<Vec<PathBuf>, String> {
        let mut pending = self.0.lock();
        match pending.take() {
            Some((held, paths)) if held == token => Ok(paths),
            other => {
                *pending = other;
                Err("those files are no longer waiting to be added".to_string())
            }
        }
    }
}

/// What the page is told of a drop with files a note takes.
#[derive(Clone, serde::Serialize)]
pub struct FilesDropped {
    pub token: String,
    pub count: usize,
    /// Where they were dropped, in the page's own pixels.
    pub x: f64,
    pub y: f64,
}

/// Told to the page when files a note takes are dropped on the window.
pub const FILES_DROPPED_EVENT: &str = "files-dropped";

/// Hear files dropped on the window, keep the ones a note takes, and ask the
/// page whether they were dropped somewhere that takes them.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    use tauri::{DragDropEvent, Emitter, Manager, WindowEvent};
    let WindowEvent::DragDrop(DragDropEvent::Drop { paths, position }) = event else {
        return;
    };
    let files = droppable(paths);
    if files.is_empty() {
        return;
    }
    let count = files.len();
    let token = window.state::<DroppedFiles>().hold(files);
    let at = position.to_logical::<f64>(window.scale_factor().unwrap_or(1.0));
    let told = window.emit(
        FILES_DROPPED_EVENT,
        FilesDropped {
            token,
            count,
            x: at.x,
            y: at.y,
        },
    );
    if let Err(e) = told {
        warn_log!("[drop] could not tell the page about a drop: {e}");
    }
}

/// What came of storing dropped files.
#[derive(Default, serde::Serialize)]
pub struct DroppedResult {
    pub images: Vec<StoredImage>,
    /// Why each one that was not stored was not, by its file name.
    pub failed: Vec<String>,
}

/// Store the files of the drop `token` names. The page calls this when they
/// were dropped on a note, and not otherwise, so nothing dropped elsewhere is
/// stored or offered to paired devices.
#[tauri::command]
pub async fn accept_dropped_files(
    state: tauri::State<'_, AppState>,
    dropped: tauri::State<'_, DroppedFiles>,
    token: String,
) -> Result<DroppedResult, String> {
    let paths = dropped.take(&token)?;
    let mut result = DroppedResult::default();
    for path in paths {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "a file".to_string());
        // Sorted again, not trusted from when it was held: nothing but this
        // module holds paths, but the kind decides how the file is read.
        match kind_of(&path) {
            Some(DropKind::Image) => {
                let stored = std::fs::File::open(&path)
                    .map_err(|e| format!("could not open it: {e}"))
                    .and_then(|file| read_capped(file, MAX_IMAGE_BYTES))
                    .and_then(|bytes| import_image_bytes(&state, &bytes));
                match stored {
                    Ok(image) => result.images.push(image),
                    Err(e) => result.failed.push(format!("{name}: {e}")),
                }
            }
            None => result
                .failed
                .push(format!("{name}: not a file a note takes")),
        }
    }
    Ok(result)
}

/// Read a file, refusing it once it is longer than `cap` rather than reading
/// all of it first.
fn read_capped(source: impl Read, cap: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    source
        .take(cap as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("could not read it: {e}"))?;
    if bytes.len() > cap {
        return Err(format!("it is over the {} MB limit", cap / (1024 * 1024)));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The page names a drop by a token it was told, and the paths stay here,
    // so nothing the page says can make Rust read a file of its choosing.
    #[test]
    fn a_drop_is_taken_by_its_own_token_and_only_once() {
        let dropped = DroppedFiles::default();
        let token = dropped.hold(vec!["/tmp/a.png".into()]);

        assert!(dropped.take("made-up").is_err());
        assert_eq!(
            dropped.take(&token).unwrap(),
            vec![PathBuf::from("/tmp/a.png")],
            "a wrong token leaves the drop waiting"
        );
        assert!(dropped.take(&token).is_err(), "and it is taken once");
    }

    #[test]
    fn a_new_drop_replaces_one_still_waiting() {
        let dropped = DroppedFiles::default();
        let first = dropped.hold(vec!["/tmp/a.png".into()]);
        let second = dropped.hold(vec!["/tmp/b.png".into()]);

        assert!(dropped.take(&first).is_err());
        assert_eq!(dropped.take(&second).unwrap().len(), 1);
    }

    #[test]
    fn nothing_is_waiting_before_a_drop() {
        assert!(DroppedFiles::default().take("").is_err());
    }

    #[test]
    fn images_are_known_by_their_name_whatever_its_case() {
        for name in ["a.png", "a.PNG", "a.jpg", "a.Jpeg", "a.gif", "a.webp"] {
            assert_eq!(kind_of(Path::new(name)), Some(DropKind::Image), "{name}");
        }
        for name in ["a.svg", "a.txt", "a", "png", "a.png.exe", ".png"] {
            assert_eq!(kind_of(Path::new(name)), None, "{name}");
        }
    }

    #[test]
    fn only_files_a_note_takes_are_kept_from_a_drop() {
        let dir = std::env::temp_dir().join(format!("oyot-drop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("folder.png")).unwrap();
        for name in ["one.png", "notes.txt", "two.JPG"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        let dropped = [
            "one.png",
            "notes.txt",
            "folder.png",
            "missing.png",
            "two.JPG",
        ]
        .map(|n| dir.join(n));

        let kept = droppable(&dropped);
        std::fs::remove_dir_all(&dir).unwrap();

        assert_eq!(kept, vec![dir.join("one.png"), dir.join("two.JPG")]);
    }

    #[test]
    fn a_file_over_the_cap_is_refused() {
        assert_eq!(read_capped(&[1u8, 2, 3][..], 3).unwrap(), vec![1, 2, 3]);
        assert!(read_capped(&[1u8, 2, 3, 4][..], 3).is_err());
    }
}

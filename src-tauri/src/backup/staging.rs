//! Where a backup is built before it is delivered, and where a backup being
//! imported is checked before anything reads it (ADR 0024, decision 3).
//!
//! A directory under the app's cache, so the operating system is free to
//! clear it, and cleared at every start in case a crash left something
//! behind.

use std::path::{Path, PathBuf};

/// A file in the staging directory that is removed when this is dropped,
/// whether the work it was for succeeded or not.
#[derive(Debug)]
pub struct StagedFile {
    path: PathBuf,
}

impl StagedFile {
    /// A fresh name in `dir`. Nothing is created until something writes to
    /// it.
    pub fn new(dir: &Path, purpose: &str) -> Result<Self, String> {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("could not prepare {}: {e}", dir.display()))?;
        Ok(StagedFile {
            path: dir.join(format!("{purpose}-{}.zip", uuid::Uuid::new_v4())),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        // Absent if nothing was ever written, which is not worth a word.
        if let Err(e) = std::fs::remove_file(&self.path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                warn_log!("[backup] could not remove {}: {e}", self.path.display());
            }
        }
    }
}

/// Remove whatever an earlier run left in `dir`. Best effort: a file that
/// will not go is only a file.
pub fn clear(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Err(e) = std::fs::remove_file(&path) {
                warn_log!("[backup] could not remove {}: {e}", path.display());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::scratch;
    use super::*;

    #[test]
    fn a_staged_file_goes_when_it_is_done_with() {
        let dir = scratch();
        let staged = StagedFile::new(&dir.join("backup"), "backup").unwrap();
        std::fs::write(staged.path(), b"archive").unwrap();
        let path = staged.path().to_path_buf();
        assert!(path.exists());
        drop(staged);
        assert!(!path.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_staged_file_that_was_never_written_is_no_trouble() {
        let dir = scratch();
        drop(StagedFile::new(&dir, "import").unwrap());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn clearing_removes_what_a_crash_left_behind() {
        let dir = scratch();
        std::fs::write(dir.join("backup-left.zip"), b"partial").unwrap();
        std::fs::write(dir.join("import-left.zip"), b"partial").unwrap();
        clear(&dir);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        // A directory that does not exist yet is simply empty.
        clear(&dir.join("never-made"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

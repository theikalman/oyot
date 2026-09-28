//! What a native file dialog hands back, read the same way by everything that
//! opens one.
//!
//! On a computer the dialog returns a path. On a phone it returns a URL: a
//! content URI on Android, a security-scoped file URL on iOS. Neither is a
//! path, so opening one goes through `tauri-plugin-fs`, which is registered
//! for its Rust API only (see `Cargo.toml`), and naming one means reading the
//! name out of the URI.

use std::fs::File;
use tauri::AppHandle;
use tauri_plugin_dialog::FilePath;

/// The name the file had where the user picked it, when one can be read out
/// of what the dialog returned.
///
/// A content URI names a document by id, and for the common providers the id
/// ends in the path the user saw, percent-encoded. When it does not, what
/// comes back here is only the id, so a caller that needs a real name checks
/// it looks like one, as a backup checks for `.zip`.
pub(crate) fn file_name(path: &FilePath) -> Option<String> {
    let name = match path {
        FilePath::Path(path) => path.file_name()?.to_string_lossy().into_owned(),
        FilePath::Url(url) => {
            let last = url.path_segments()?.next_back()?;
            let decoded = percent_encoding::percent_decode_str(last)
                .decode_utf8_lossy()
                .into_owned();
            decoded.rsplit(['/', ':']).next()?.to_string()
        }
    };
    let name = name.trim().to_string();
    (!name.is_empty()).then_some(name)
}

/// Open a picked file for reading, whichever kind of location it is.
pub(crate) fn open(app: &AppHandle, path: &FilePath) -> std::io::Result<File> {
    match path {
        FilePath::Path(path) => File::open(path),
        FilePath::Url(_) => {
            use tauri_plugin_fs::{FsExt, OpenOptions};
            let mut options = OpenOptions::new();
            options.read(true);
            app.fs().open(path.clone(), options)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn url(s: &str) -> FilePath {
        FilePath::Url(s.parse().unwrap())
    }

    #[test]
    fn names_a_file_from_its_path() {
        let path = FilePath::Path(PathBuf::from("/home/me/Notes/Trip to Kyoto.md"));
        assert_eq!(file_name(&path).as_deref(), Some("Trip to Kyoto.md"));
    }

    #[test]
    fn names_a_file_from_an_android_content_uri() {
        let uri = url("content://com.android.externalstorage.documents/document/\
             primary%3ADocuments%2FNotes%2FTrip%20to%20Kyoto.md");
        assert_eq!(file_name(&uri).as_deref(), Some("Trip to Kyoto.md"));
    }

    // What a provider that names documents by id alone hands back. It is not
    // a name, and the callers are the ones who can tell.
    #[test]
    fn a_uri_that_names_nothing_yields_only_its_id() {
        let opaque =
            url("content://com.google.android.apps.docs.storage/document/acc%3D1%3Bdoc%3D42");
        assert_eq!(file_name(&opaque).as_deref(), Some("acc=1;doc=42"));
    }

    #[test]
    fn a_path_with_no_file_name_has_no_name() {
        assert_eq!(file_name(&FilePath::Path(PathBuf::from("/"))), None);
    }
}

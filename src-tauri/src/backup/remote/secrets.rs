//! Where a provider keeps its link: what lets it act for the user without
//! asking them to sign in again.
//!
//! A refresh token goes in the OS keychain, and nowhere else: a system
//! without one cannot stay linked, and says so, rather than keeping a refresh
//! token in a file in clear (ADR 0025, decision 3). Android is the exception
//! that proves it: Google Play services keeps the grant there, and the link
//! holds no secret, only which account it is, so it is a plain file. The
//! calls block, and on macOS can wait on a prompt, so callers run them off
//! the async runtime.

pub trait SecretStore: Send + Sync {
    fn load(&self) -> Result<Option<String>, String>;
    fn save(&self, secret: &str) -> Result<(), String>;
    /// Removing what is not there is not an error.
    fn clear(&self) -> Result<(), String>;
}

/// One entry in the OS keychain.
#[cfg(desktop)]
pub struct Keychain {
    service: String,
    account: String,
}

#[cfg(desktop)]
impl Keychain {
    pub fn new(service: &str, account: &str) -> Self {
        Keychain {
            service: service.to_string(),
            account: account.to_string(),
        }
    }

    fn entry(&self) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, &self.account).map_err(describe)
    }
}

#[cfg(desktop)]
impl SecretStore for Keychain {
    fn load(&self) -> Result<Option<String>, String> {
        match self.entry()?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(describe(e)),
        }
    }

    fn save(&self, secret: &str) -> Result<(), String> {
        self.entry()?.set_password(secret).map_err(describe)
    }

    fn clear(&self) -> Result<(), String> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(describe(e)),
        }
    }
}

#[cfg(desktop)]
fn describe(e: keyring::Error) -> String {
    match e {
        keyring::Error::NoDefaultStore => {
            "this system has no keychain Oyot can use, so it cannot stay linked".to_string()
        }
        keyring::Error::NoStorageAccess(_) => {
            "the keychain is locked or refused access".to_string()
        }
        other => format!("the keychain failed: {other}"),
    }
}

/// One entry in the iOS keychain.
///
/// In the data protection keychain, readable after the phone's first unlock
/// since it started and never copied to another device: a refresh token
/// restored onto a new phone from a backup would be one more copy of a
/// credential, for a link that phone never made.
#[cfg(target_os = "ios")]
pub struct Keychain {
    service: String,
    account: String,
}

#[cfg(target_os = "ios")]
impl Keychain {
    pub fn new(service: &str, account: &str) -> Self {
        Keychain {
            service: service.to_string(),
            account: account.to_string(),
        }
    }

    fn entry(&self) -> Result<keyring_core::Entry, String> {
        use apple_native_keyring_store::protected::{AccessPolicy, Cred};
        Cred::build(
            &self.service,
            &self.account,
            AccessPolicy::AfterFirstUnlockThisDeviceOnly,
            None,
            false,
        )
        .map_err(|e| format!("the keychain failed: {e}"))
    }
}

#[cfg(target_os = "ios")]
impl SecretStore for Keychain {
    fn load(&self) -> Result<Option<String>, String> {
        match self.entry()?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("the keychain failed: {e}")),
        }
    }

    fn save(&self, secret: &str) -> Result<(), String> {
        self.entry()?
            .set_password(secret)
            .map_err(|e| format!("the keychain failed: {e}"))
    }

    fn clear(&self) -> Result<(), String> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("the keychain failed: {e}")),
        }
    }
}

/// A link that holds no secret, in a file of the app's own: Android, where
/// Google Play services keeps the grant and the link is only which account
/// it is for.
pub struct LinkFile {
    path: std::path::PathBuf,
}

impl LinkFile {
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub fn new(path: std::path::PathBuf) -> Self {
        LinkFile { path }
    }
}

impl SecretStore for LinkFile {
    fn load(&self) -> Result<Option<String>, String> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => Ok(Some(text)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("could not read the link: {e}")),
        }
    }

    fn save(&self, secret: &str) -> Result<(), String> {
        // Written beside it and renamed over it, so a crash never leaves
        // half a link.
        let partial = self.path.with_extension("partial");
        std::fs::write(&partial, secret)
            .and_then(|()| std::fs::rename(&partial, &self.path))
            .map_err(|e| format!("could not save the link: {e}"))
    }

    fn clear(&self) -> Result<(), String> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("could not forget the link: {e}")),
        }
    }
}

/// An in-memory stand-in, for tests.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore(parking_lot::Mutex<Option<String>>);

#[cfg(test)]
impl SecretStore for MemoryStore {
    fn load(&self) -> Result<Option<String>, String> {
        Ok(self.0.lock().clone())
    }

    fn save(&self, secret: &str) -> Result<(), String> {
        *self.0.lock() = Some(secret.to_string());
        Ok(())
    }

    fn clear(&self) -> Result<(), String> {
        *self.0.lock() = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_link_file_reads_back_what_was_saved_and_forgets_it() {
        let dir = crate::backup::test_support::scratch();
        let store = LinkFile::new(dir.join("link.json"));
        assert_eq!(store.load(), Ok(None));
        store.save("{\"email\":\"me@example.com\"}").unwrap();
        assert_eq!(
            store.load().unwrap().as_deref(),
            Some("{\"email\":\"me@example.com\"}")
        );
        store.clear().unwrap();
        assert_eq!(store.load(), Ok(None));
        // Forgetting what is not there is not an error.
        store.clear().unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

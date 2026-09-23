//! Where a provider keeps what lets it act for the user without asking them
//! to sign in again.
//!
//! The OS keychain, and nowhere else: a system without one cannot stay
//! linked, and says so, rather than keeping a refresh token in a file in
//! clear (ADR 0025, decision 3). The calls block, and on macOS can wait on a
//! prompt, so callers run them off the async runtime.

pub trait SecretStore: Send + Sync {
    fn load(&self) -> Result<Option<String>, String>;
    fn save(&self, secret: &str) -> Result<(), String>;
    /// Removing what is not there is not an error.
    fn clear(&self) -> Result<(), String>;
}

/// One entry in the OS keychain.
pub struct Keychain {
    service: String,
    account: String,
}

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

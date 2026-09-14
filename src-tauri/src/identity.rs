use crate::crypto;
use ed25519_dalek::SigningKey;
use rusqlite::params;
use serde::{Deserialize, Serialize};

/// What the frontend sees. The secret key never leaves Rust.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserIdentity {
    /// Stable per-install id. Two paired devices hash their pair of user_ids
    /// into a room_id; it is a pair label, not a trust anchor.
    pub user_id: String,
    /// This device's Ed25519 public key, base64url-unpadded. Signatures are
    /// verified against it, so it IS the device's identity rather than a name
    /// for it. See docs/decisions/0009-authenticated-signaling.md.
    pub node_id: String,
    pub display_name: String,
}

/// The identity plus the key material needed to sign, for use inside Rust.
pub struct LocalIdentity {
    pub public: UserIdentity,
    pub signing_key: SigningKey,
}

// Hand-written rather than derived: this struct holds secret key material, and
// a derived Debug would put it in any log line or panic message that formats an
// identity.
impl std::fmt::Debug for LocalIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalIdentity")
            .field("public", &self.public)
            .field("signing_key", &"<redacted>")
            .finish()
    }
}

pub fn get_or_create_identity(db: &rusqlite::Connection) -> Result<LocalIdentity, String> {
    if let Some(identity) = load_identity(db)? {
        return Ok(identity);
    }

    let signing_key = crypto::generate_signing_key();
    let node_id = crypto::encode_node_id(&signing_key.verifying_key());
    let user_id = uuid::Uuid::new_v4().to_string();
    let display_name = default_display_name(&node_id);

    db.execute(
        "INSERT INTO identity (user_id, node_id, display_name, secret_key) VALUES (?, ?, ?, ?)",
        params![
            &user_id,
            &node_id,
            &display_name,
            signing_key.to_bytes().as_slice()
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(LocalIdentity {
        public: UserIdentity {
            user_id,
            node_id,
            display_name,
        },
        signing_key,
    })
}

fn default_display_name(node_id: &str) -> String {
    let hostname = hostname::get()
        .ok()
        .map(|h| h.to_string_lossy().to_string())
        .filter(|h| !h.is_empty() && h != "localhost" && h != "localhost.localdomain");

    // Android's gethostname() (what the `hostname` crate calls under the hood)
    // reliably returns "localhost" rather than a real device name, since the
    // real name lives in Settings.Global.DEVICE_NAME, not the POSIX hostname.
    hostname.unwrap_or_else(|| format!("Device-{}", &node_id[..8]))
}

fn load_identity(db: &rusqlite::Connection) -> Result<Option<LocalIdentity>, String> {
    let row = db
        .query_row(
            // `rowid` rather than bare LIMIT 1: without an ordering SQLite
            // may return any row, and nothing stops the table holding more
            // than one. Picking a different identity between launches would
            // invalidate every pairing.
            "SELECT user_id, node_id, display_name, secret_key FROM identity \
              ORDER BY rowid LIMIT 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<Vec<u8>>>(3)?,
                ))
            },
        )
        .ok();

    let Some((user_id, node_id, display_name, secret)) = row else {
        return Ok(None);
    };

    // A row with no usable key predates signed signaling, or was corrupted.
    // Either way there is nothing to recover: the node_id is derived from the
    // key, so without it this device has no identity. Migration v3 clears such
    // rows, so reaching here means something else went wrong.
    let Some(secret) = secret.as_deref().and_then(crypto::signing_key_from_bytes) else {
        return Err(
            "identity row has no usable signing key; delete the identity table to re-provision"
                .to_string(),
        );
    };

    if crypto::encode_node_id(&secret.verifying_key()) != node_id {
        return Err("identity node_id does not match its stored key".to_string());
    }

    Ok(Some(LocalIdentity {
        public: UserIdentity {
            user_id,
            node_id,
            display_name,
        },
        signing_key: secret,
    }))
}

pub fn update_display_name(db: &rusqlite::Connection, display_name: &str) -> Result<(), String> {
    db.execute(
        "UPDATE identity SET display_name = ?
          WHERE user_id = (SELECT user_id FROM identity ORDER BY rowid LIMIT 1)",
        params![display_name],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        crate::setup_database_tables(&db).unwrap();
        db
    }

    // Nothing stops the table holding more than one row, and a bare LIMIT 1
    // lets SQLite return any of them. Picking a different identity between
    // launches would invalidate every pairing on the device.
    #[test]
    fn the_same_identity_is_loaded_every_time() {
        let db = db();
        let first = get_or_create_identity(&db).unwrap();

        // A second row, as a stray migration or a bug might leave behind.
        db.execute(
            "INSERT INTO identity (user_id, node_id, display_name, secret_key)
                 VALUES ('other', 'other-node', 'Other', x'00')",
            [],
        )
        .unwrap();

        for _ in 0..5 {
            let again = get_or_create_identity(&db).unwrap();
            assert_eq!(again.public.node_id, first.public.node_id);
        }
    }

    #[test]
    fn renaming_keeps_the_identity_and_changes_only_the_name() {
        let db = db();
        let before = get_or_create_identity(&db).unwrap();

        update_display_name(&db, "Kitchen laptop").unwrap();

        let after = get_or_create_identity(&db).unwrap();
        assert_eq!(after.public.display_name, "Kitchen laptop");
        assert_eq!(after.public.node_id, before.public.node_id);
        assert_eq!(after.public.user_id, before.public.user_id);
    }

    #[test]
    fn a_new_identity_gets_a_key_and_a_matching_node_id() {
        let db = db();
        let me = get_or_create_identity(&db).unwrap();

        assert_eq!(me.public.node_id.len(), 43);
        assert_eq!(
            crypto::encode_node_id(&me.signing_key.verifying_key()),
            me.public.node_id,
            "node_id must be the public key it will be verified against"
        );
    }

    #[test]
    fn the_identity_is_stable_across_loads() {
        let db = db();
        let first = get_or_create_identity(&db).unwrap();
        let second = get_or_create_identity(&db).unwrap();

        assert_eq!(first.public.node_id, second.public.node_id);
        assert_eq!(first.public.user_id, second.public.user_id);
        assert_eq!(first.signing_key.to_bytes(), second.signing_key.to_bytes());
    }

    #[test]
    fn a_row_whose_key_does_not_match_its_node_id_is_refused() {
        let db = db();
        get_or_create_identity(&db).unwrap();
        db.execute("UPDATE identity SET node_id = 'not-the-real-key'", [])
            .unwrap();

        let err = get_or_create_identity(&db).unwrap_err();
        assert!(err.contains("does not match"), "unexpected error: {err}");
    }

    #[test]
    fn a_row_with_no_key_is_refused_rather_than_used_unsigned() {
        let db = db();
        get_or_create_identity(&db).unwrap();
        db.execute("UPDATE identity SET secret_key = NULL", [])
            .unwrap();

        assert!(get_or_create_identity(&db).is_err());
    }

    #[test]
    fn two_devices_do_not_share_an_identity() {
        let a = get_or_create_identity(&db()).unwrap();
        let b = get_or_create_identity(&db()).unwrap();
        assert_ne!(a.public.node_id, b.public.node_id);
        assert_ne!(a.public.user_id, b.public.user_id);
    }
}

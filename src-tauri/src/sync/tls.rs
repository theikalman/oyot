//! TLS 1.3 with raw public keys, where the key is the node key (ADR 0032,
//! decision 2).
//!
//! A device's node_id already is its Ed25519 public key (ADR 0009), so the
//! same key authenticates a sync connection: each side presents it as a raw
//! public key (RFC 7250), and there are no certificates, no authorities and
//! nothing to renew. TLS 1.3 signs its handshake under its own context
//! string, so a handshake signature and a signed signaling envelope cannot be
//! passed off as one another.
//!
//! - **The dialler** accepts the listener only if its key is the device it
//!   meant to reach.
//! - **The listener** accepts any well-formed device key at the TLS layer,
//!   because pairing starts with a stranger dialling in (decision 5). Who the
//!   dialler is, and what it may do, is decided after the handshake from
//!   `peer_node_id`, against the pair table, on every connection.
//! - **No resumption**, on either side. A resumed TLS session skips the
//!   verifier, which would let a device the user had removed back in.

use crate::crypto::{decode_node_id, encode_node_id};
use ed25519_dalek::{SigningKey, VerifyingKey};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::{AlwaysResolvesClientRawPublicKeys, Resumption};
use rustls::crypto::{verify_tls13_signature_with_raw_key, WebPkiSupportedAlgorithms};
use rustls::pki_types::{
    CertificateDer, PrivatePkcs8KeyDer, ServerName, SubjectPublicKeyInfoDer, UnixTime,
};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::server::{AlwaysResolvesServerRawPublicKeys, NoServerSessionStorage};
use rustls::sign::CertifiedKey;
use rustls::{
    ClientConfig, CommonState, DigitallySignedStruct, DistinguishedName, Error, ServerConfig,
    SignatureScheme,
};
use std::sync::Arc;

/// The DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410), which the
/// 32 bytes of the key follow.
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/// The DER prefix of an Ed25519 private key in PKCS#8 (RFC 8410), which the
/// 32 bytes of its seed follow.
const ED25519_PKCS8_PREFIX: [u8; 16] = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

/// The name the dialler gives the listener. Nothing checks it: the listener
/// is identified by its key, not by a name.
const SERVER_NAME: &str = "oyot.invalid";

/// A device key as the SubjectPublicKeyInfo a raw public key travels as.
pub fn spki_for(key: &VerifyingKey) -> Vec<u8> {
    let mut spki = ED25519_SPKI_PREFIX.to_vec();
    spki.extend_from_slice(key.as_bytes());
    spki
}

/// The node_id a raw public key belongs to, if it is a well-formed Ed25519
/// key and nothing else.
pub fn node_id_from_spki(spki: &[u8]) -> Option<String> {
    let key = spki.strip_prefix(&ED25519_SPKI_PREFIX[..])?;
    let bytes: [u8; 32] = key.try_into().ok()?;
    let key = VerifyingKey::from_bytes(&bytes).ok()?;
    Some(encode_node_id(&key))
}

/// The node_id of whoever is on the other end of a finished handshake.
pub fn peer_node_id(conn: &CommonState) -> Option<String> {
    let certs = conn.peer_certificates()?;
    node_id_from_spki(certs.first()?.as_ref())
}

fn algorithms() -> WebPkiSupportedAlgorithms {
    rustls::crypto::ring::default_provider().signature_verification_algorithms
}

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn certified_key(signing: &SigningKey) -> Result<Arc<CertifiedKey>, String> {
    let mut pkcs8 = ED25519_PKCS8_PREFIX.to_vec();
    pkcs8.extend_from_slice(signing.as_bytes());
    let key = rustls::crypto::ring::sign::any_eddsa_type(&PrivatePkcs8KeyDer::from(pkcs8))
        .map_err(|e| format!("the device key cannot sign a handshake: {e}"))?;
    let spki = spki_for(&signing.verifying_key());
    Ok(Arc::new(CertifiedKey::new(
        vec![CertificateDer::from(spki)],
        key,
    )))
}

fn verify_signature(
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
    algorithms: &WebPkiSupportedAlgorithms,
) -> Result<HandshakeSignatureValid, Error> {
    verify_tls13_signature_with_raw_key(
        message,
        &SubjectPublicKeyInfoDer::from(cert.as_ref()),
        dss,
        algorithms,
    )
}

/// The dialler's check: the listener's key is the device it meant to reach.
#[derive(Debug)]
struct ExpectedDevice {
    node_id: String,
    algorithms: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for ExpectedDevice {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        match node_id_from_spki(end_entity.as_ref()) {
            Some(id) if id == self.node_id => Ok(ServerCertVerified::assertion()),
            Some(_) => Err(Error::General(
                "the device that answered is not the one dialled".into(),
            )),
            None => Err(Error::General(
                "the device answered with no device key".into(),
            )),
        }
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(Error::General("sync connections are TLS 1.3 only".into()))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }

    fn requires_raw_public_keys(&self) -> bool {
        true
    }
}

/// The listener's check at the TLS layer: some device's key, well formed.
/// Which device, and whether it is paired, comes after (see the module doc).
#[derive(Debug)]
struct AnyDevice {
    algorithms: WebPkiSupportedAlgorithms,
}

impl ClientCertVerifier for AnyDevice {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }

    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, Error> {
        node_id_from_spki(end_entity.as_ref())
            .map(|_| ClientCertVerified::assertion())
            .ok_or_else(|| Error::General("the dialler presented no device key".into()))
    }

    fn client_auth_mandatory(&self) -> bool {
        true
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(Error::General("sync connections are TLS 1.3 only".into()))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }

    fn requires_raw_public_keys(&self) -> bool {
        true
    }
}

/// For dialling `expected_node_id`, presenting this device's key.
pub fn client_config(
    signing: &SigningKey,
    expected_node_id: &str,
) -> Result<Arc<ClientConfig>, String> {
    decode_node_id(expected_node_id)
        .ok_or_else(|| format!("{expected_node_id:?} is no node id"))?;
    let mut config = ClientConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(ExpectedDevice {
            node_id: expected_node_id.to_string(),
            algorithms: algorithms(),
        }))
        .with_client_cert_resolver(Arc::new(AlwaysResolvesClientRawPublicKeys::new(
            certified_key(signing)?,
        )));
    config.resumption = Resumption::disabled();
    Ok(Arc::new(config))
}

/// For accepting connections, presenting this device's key.
pub fn server_config(signing: &SigningKey) -> Result<Arc<ServerConfig>, String> {
    let mut config = ServerConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| e.to_string())?
        .with_client_cert_verifier(Arc::new(AnyDevice {
            algorithms: algorithms(),
        }))
        .with_cert_resolver(Arc::new(AlwaysResolvesServerRawPublicKeys::new(
            certified_key(signing)?,
        )));
    config.session_storage = Arc::new(NoServerSessionStorage {});
    config.send_tls13_tickets = 0;
    Ok(Arc::new(config))
}

/// The name to hand the dialler's handshake.
pub fn server_name() -> ServerName<'static> {
    ServerName::try_from(SERVER_NAME).expect("a valid DNS name")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::generate_signing_key;
    use rustls::HandshakeKind;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_rustls::{TlsAcceptor, TlsConnector};

    fn node_id(key: &SigningKey) -> String {
        encode_node_id(&key.verifying_key())
    }

    /// One handshake over an in-memory pipe. Returns what each side saw of
    /// the other, or the first error.
    async fn handshake(
        dialler: &SigningKey,
        listener: &SigningKey,
        expected: &str,
    ) -> Result<(String, String, HandshakeKind), String> {
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let connector = TlsConnector::from(client_config(dialler, expected)?);
        let acceptor = TlsAcceptor::from(server_config(listener)?);

        let server = tokio::spawn(async move {
            let mut tls = acceptor
                .accept(server_io)
                .await
                .map_err(|e| e.to_string())?;
            let seen = peer_node_id(tls.get_ref().1).ok_or("no peer key")?;
            let mut byte = [0u8; 1];
            tls.read_exact(&mut byte).await.map_err(|e| e.to_string())?;
            Ok::<_, String>(seen)
        });

        let mut tls = connector
            .connect(server_name(), client_io)
            .await
            .map_err(|e| e.to_string())?;
        let saw_listener = peer_node_id(tls.get_ref().1).ok_or("no peer key")?;
        let kind = tls.get_ref().1.handshake_kind().ok_or("no handshake")?;
        // TLS 1.3 finishes the dialler first; a byte through proves the
        // listener accepted it too.
        tls.write_all(&[1]).await.map_err(|e| e.to_string())?;
        tls.flush().await.map_err(|e| e.to_string())?;
        let saw_dialler = server.await.map_err(|e| e.to_string())??;
        Ok((saw_listener, saw_dialler, kind))
    }

    #[tokio::test]
    async fn two_devices_know_each_other_by_their_node_keys() {
        let (a, b) = (generate_signing_key(), generate_signing_key());
        let (listener, dialler, kind) = handshake(&a, &b, &node_id(&b)).await.unwrap();
        assert_eq!(listener, node_id(&b));
        assert_eq!(dialler, node_id(&a));
        assert_eq!(kind, HandshakeKind::Full);
    }

    #[tokio::test]
    async fn a_dialler_refuses_a_device_it_did_not_dial() {
        let (a, b, c) = (
            generate_signing_key(),
            generate_signing_key(),
            generate_signing_key(),
        );
        assert!(handshake(&a, &b, &node_id(&c)).await.is_err());
    }

    #[tokio::test]
    async fn every_connection_is_a_full_handshake() {
        let (a, b) = (generate_signing_key(), generate_signing_key());
        for _ in 0..2 {
            let (_, _, kind) = handshake(&a, &b, &node_id(&b)).await.unwrap();
            assert_eq!(kind, HandshakeKind::Full);
        }
    }

    #[test]
    fn a_key_reads_back_as_its_node_id() {
        let key = generate_signing_key();
        let spki = spki_for(&key.verifying_key());
        assert_eq!(node_id_from_spki(&spki), Some(node_id(&key)));
    }

    #[test]
    fn anything_but_an_ed25519_key_is_no_node_id() {
        assert_eq!(node_id_from_spki(&[]), None);
        assert_eq!(node_id_from_spki(&ED25519_SPKI_PREFIX), None);
        let mut long = spki_for(&generate_signing_key().verifying_key());
        long.push(0);
        assert_eq!(node_id_from_spki(&long), None);
    }

    #[test]
    fn a_config_for_no_node_id_is_refused() {
        assert!(client_config(&generate_signing_key(), "not a node id").is_err());
    }
}

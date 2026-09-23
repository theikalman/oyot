//! Signing in the way an installed app should (RFC 8252): in the system
//! browser, with the answer coming back to a one-shot listener on the loopback
//! address, and the code bound to this attempt by PKCE (RFC 7636).
//!
//! Nothing here is specific to Google, so the next provider that signs in with
//! OAuth reuses all of it.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub const CANCELLED: &str = "linking was cancelled";

/// How long one connection to the listener gets to send its request.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Longest request head read. A redirect is one short line; anything much
/// longer is not the browser coming back.
const MAX_REQUEST_HEAD: usize = 16 * 1024;

/// A PKCE pair: the verifier stays on this device, the challenge goes out in
/// the sign-in address. Whoever exchanges the code must hold the verifier, so
/// a code intercepted on its way back is worth nothing.
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl Pkce {
    pub fn generate() -> Self {
        Self::from_verifier(random_token())
    }

    pub fn from_verifier(verifier: String) -> Self {
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        Pkce {
            verifier,
            challenge,
        }
    }
}

/// 32 random bytes, base64url without padding: 43 characters, within what PKCE
/// allows for a verifier, and ample for the `state` that ties the answer to
/// the request.
pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// The sign-in address: `endpoint` with `params` as its query.
pub fn authorization_url(endpoint: &str, params: &[(&str, &str)]) -> Result<String, String> {
    let mut url = url::Url::parse(endpoint).map_err(|e| format!("bad sign-in address: {e}"))?;
    url.query_pairs_mut().extend_pairs(params);
    Ok(url.into())
}

/// A form body, as a token endpoint takes it.
pub fn form(pairs: &[(&str, &str)]) -> Vec<u8> {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish()
        .into_bytes()
}

/// What a token endpoint answers with.
#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub expires_in: Option<u64>,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Space-separated. What the user actually granted, which with granular
    /// consent can be less than what was asked for.
    #[serde(default)]
    pub scope: Option<String>,
}

/// What a token endpoint answers with when it refuses.
#[derive(Debug, Deserialize)]
pub struct TokenError {
    pub error: String,
}

/// Whether a granted `scope` includes `wanted`.
pub fn grants(scope: Option<&str>, wanted: &str) -> bool {
    scope.is_some_and(|s| s.split_whitespace().any(|granted| granted == wanted))
}

/// How the browser came back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Redirect {
    Code(String),
    /// The user declined, or the service refused; the value is its reason.
    Denied(String),
}

/// Read what one request to the listener was, given the `state` that went
/// out. `None` for anything that is not our redirect: a browser asking for a
/// favicon, a stale tab from an earlier attempt, or something else on this
/// machine poking at the port. Those are answered and waited past; only the
/// right `state` ends the wait.
pub fn parse_redirect(request_line: &str, state: &str) -> Option<Redirect> {
    let mut parts = request_line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let target = parts.next()?;
    if !target.starts_with('/') {
        return None;
    }
    let url = url::Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    let mut code = None;
    let mut error = None;
    let mut returned_state = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            "state" => returned_state = Some(value.into_owned()),
            _ => {}
        }
    }
    if returned_state.as_deref() != Some(state) {
        return None;
    }
    match (code, error) {
        (_, Some(error)) => Some(Redirect::Denied(error)),
        (Some(code), None) if !code.is_empty() => Some(Redirect::Code(code)),
        _ => None,
    }
}

/// A one-shot listener on the loopback address, at a port the system picks.
pub struct Loopback {
    listener: TcpListener,
    redirect_uri: String,
}

impl Loopback {
    pub async fn bind() -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| format!("could not prepare to sign in: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("could not prepare to sign in: {e}"))?
            .port();
        Ok(Loopback {
            listener,
            redirect_uri: format!("http://127.0.0.1:{port}"),
        })
    }

    pub fn redirect_uri(&self) -> &str {
        &self.redirect_uri
    }

    /// Wait for the browser to come back with an answer for `state`.
    pub async fn wait(
        &self,
        state: &str,
        timeout: Duration,
        mut cancel: super::Cancel,
    ) -> Result<Redirect, String> {
        let deadline = tokio::time::sleep(timeout);
        tokio::pin!(deadline);
        loop {
            let stream = tokio::select! {
                accepted = self.listener.accept() => match accepted {
                    Ok((stream, _)) => stream,
                    Err(e) => {
                        warn_log!("[oauth] accept failed: {e}");
                        continue;
                    }
                },
                _ = &mut deadline => {
                    return Err("linking timed out: nothing came back from the browser".to_string());
                }
                _ = &mut cancel => return Err(CANCELLED.to_string()),
            };
            if let Some(redirect) = answer(stream, state).await {
                return Ok(redirect);
            }
        }
    }
}

/// Read one request, answer it with a page for the browser, and say what it
/// was.
async fn answer(mut stream: TcpStream, state: &str) -> Option<Redirect> {
    let head = tokio::time::timeout(REQUEST_TIMEOUT, read_head(&mut stream))
        .await
        .ok()?;
    let redirect = head
        .as_deref()
        .and_then(|head| head.lines().next())
        .and_then(|line| parse_redirect(line, state));

    let (status, title, message) = match &redirect {
        Some(Redirect::Code(_)) => (
            "200 OK",
            "Linked",
            "You can close this tab and go back to Oyot.",
        ),
        Some(Redirect::Denied(_)) => (
            "200 OK",
            "Not linked",
            "Linking was cancelled. You can close this tab.",
        ),
        None => (
            "404 Not Found",
            "Not found",
            "This is not the sign-in Oyot is waiting for.",
        ),
    };
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title></head>\
         <body style=\"font-family:system-ui,sans-serif;max-width:32em;margin:4em auto;\
         padding:0 1em;color:#333\"><h1 style=\"font-size:1.4em\">{title}</h1>\
         <p>{message}</p></body></html>"
    );
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
    redirect
}

/// The request head, up to the blank line that ends it.
async fn read_head(stream: &mut TcpStream) -> Option<String> {
    let mut head = Vec::new();
    let mut buffer = [0u8; 1024];
    while head.len() < MAX_REQUEST_HEAD {
        let n = stream.read(&mut buffer).await.ok()?;
        if n == 0 {
            break;
        }
        head.extend_from_slice(&buffer[..n]);
        if head.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    String::from_utf8(head).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    // The worked example in RFC 7636, appendix B.
    #[test]
    fn derives_the_challenge_the_standard_says() {
        let pkce = Pkce::from_verifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".to_string());
        assert_eq!(
            pkce.challenge,
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn a_generated_verifier_is_within_what_pkce_allows() {
        let pkce = Pkce::generate();
        assert!((43..=128).contains(&pkce.verifier.len()));
        assert!(pkce
            .verifier
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        assert_ne!(random_token(), random_token());
    }

    #[test]
    fn builds_the_sign_in_address_with_every_parameter_encoded() {
        let url = authorization_url(
            "https://accounts.example/auth",
            &[("scope", "a b"), ("redirect_uri", "http://127.0.0.1:5000")],
        )
        .unwrap();
        assert_eq!(
            url,
            "https://accounts.example/auth?scope=a+b&redirect_uri=http%3A%2F%2F127.0.0.1%3A5000"
        );
    }

    #[test]
    fn reads_the_code_from_the_redirect() {
        assert_eq!(
            parse_redirect("GET /?state=s1&code=4%2Fabc&scope=x HTTP/1.1", "s1"),
            Some(Redirect::Code("4/abc".to_string()))
        );
    }

    #[test]
    fn reads_a_refusal_from_the_redirect() {
        assert_eq!(
            parse_redirect("GET /?error=access_denied&state=s1 HTTP/1.1", "s1"),
            Some(Redirect::Denied("access_denied".to_string()))
        );
    }

    #[test]
    fn waits_past_anything_that_is_not_the_answer_to_this_request() {
        for line in [
            "GET /favicon.ico HTTP/1.1",
            "GET /?code=abc&state=someone-elses HTTP/1.1",
            "GET /?code=abc HTTP/1.1",
            "POST /?code=abc&state=s1 HTTP/1.1",
            "GET /?code=&state=s1 HTTP/1.1",
            "",
            "GET",
        ] {
            assert_eq!(parse_redirect(line, "s1"), None, "{line:?}");
        }
    }

    #[test]
    fn a_granted_scope_is_matched_whole() {
        let wanted = "https://www.googleapis.com/auth/drive.file";
        assert!(grants(Some(&format!("openid {wanted}")), wanted));
        assert!(!grants(
            Some("https://www.googleapis.com/auth/drive.file.x"),
            wanted
        ));
        assert!(!grants(None, wanted));
    }

    async fn request(port: u16, target: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }

    fn port_of(loopback: &Loopback) -> u16 {
        loopback
            .redirect_uri()
            .rsplit(':')
            .next()
            .unwrap()
            .parse()
            .unwrap()
    }

    // The listener end to end, with this test standing in for the browser: a
    // stray request is answered and waited past, and the real redirect ends
    // the wait with its code.
    #[tokio::test]
    async fn the_listener_waits_for_the_browser_to_come_back() {
        let loopback = Loopback::bind().await.unwrap();
        let port = port_of(&loopback);
        let (_keep, cancel) = tokio::sync::oneshot::channel();

        let browser = tokio::spawn(async move {
            let stray = request(port, "/favicon.ico").await;
            let done = request(port, "/?state=s1&code=the-code").await;
            (stray, done)
        });
        let redirect = loopback
            .wait("s1", Duration::from_secs(5), cancel)
            .await
            .unwrap();
        assert_eq!(redirect, Redirect::Code("the-code".to_string()));

        let (stray, done) = browser.await.unwrap();
        assert!(stray.starts_with("HTTP/1.1 404"));
        assert!(done.starts_with("HTTP/1.1 200"));
        assert!(done.contains("go back to Oyot"));
    }

    #[tokio::test]
    async fn the_listener_stops_when_linking_is_cancelled() {
        let loopback = Loopback::bind().await.unwrap();
        let (cancel_tx, cancel) = tokio::sync::oneshot::channel();
        cancel_tx.send(()).unwrap();
        let error = loopback
            .wait("s1", Duration::from_secs(5), cancel)
            .await
            .unwrap_err();
        assert_eq!(error, CANCELLED);
    }

    #[tokio::test]
    async fn the_listener_gives_up_in_the_end() {
        let loopback = Loopback::bind().await.unwrap();
        let (_keep, cancel) = tokio::sync::oneshot::channel();
        let error = loopback
            .wait("s1", Duration::from_millis(50), cancel)
            .await
            .unwrap_err();
        assert!(error.contains("timed out"), "{error}");
    }
}

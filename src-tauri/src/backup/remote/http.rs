//! The HTTP a provider needs, behind a trait, so a provider is tested against
//! a stand-in for the service rather than the service itself.

use super::Progress;
use async_trait::async_trait;
use serde::de::DeserializeOwned;
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

#[derive(Debug, Clone)]
pub struct HttpRequest {
    pub method: Method,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpRequest {
    pub fn new(method: Method, url: impl Into<String>) -> Self {
        HttpRequest {
            method,
            url: url.into(),
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }

    pub fn body(mut self, body: Vec<u8>) -> Self {
        self.body = body;
        self
    }

    pub fn json(self, value: &serde_json::Value) -> Self {
        self.header("Content-Type", "application/json; charset=UTF-8")
            .body(value.to_string().into_bytes())
    }

    pub fn form(self, pairs: &[(&str, &str)]) -> Self {
        self.header("Content-Type", "application/x-www-form-urlencoded")
            .body(super::oauth::form(pairs))
    }

    pub fn bearer(self, token: &str) -> Self {
        self.header("Authorization", &format!("Bearer {token}"))
    }

    /// A header's value, by case-insensitive name.
    #[cfg(test)]
    pub fn header_value(&self, name: &str) -> Option<&str> {
        find(&self.headers, name)
    }
}

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// A header's value, by case-insensitive name.
    pub fn header(&self, name: &str) -> Option<&str> {
        find(&self.headers, name)
    }

    pub fn json<T: DeserializeOwned>(&self) -> Result<T, String> {
        serde_json::from_slice(&self.body)
            .map_err(|e| format!("could not read the answer ({}): {e}", self.status))
    }
}

fn find<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

#[derive(Debug)]
pub enum HttpError {
    /// No whole answer: the connection failed, dropped, or timed out. Worth
    /// asking again.
    Network(String),
    /// Refused for a reason asking again will not change.
    Fatal(String),
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HttpError::Network(e) => write!(f, "could not reach the server: {e}"),
            HttpError::Fatal(e) => f.write_str(e),
        }
    }
}

#[async_trait]
pub trait HttpClient: Send + Sync {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, HttpError>;

    /// Like `send`, except that a successful body goes to `to` as it arrives,
    /// never whole in memory, and is refused past `limit` bytes. The response
    /// comes back without it. A failure's body is kept, for its error.
    async fn download(
        &self,
        request: HttpRequest,
        to: &Path,
        limit: u64,
        progress: Progress<'_>,
    ) -> Result<HttpResponse, HttpError>;
}

/// The real thing.
pub struct Reqwest {
    client: reqwest::Client,
}

/// How long one request may take, start to finish, other than a download.
/// Enough for an upload piece on a slow line.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// Progress is reported at most this often during a download, rather than
/// once per network read.
const PROGRESS_STEP: u64 = 1024 * 1024;

impl Reqwest {
    pub fn new() -> Result<Self, String> {
        // reqwest is built without a crypto provider of its own (ADR 0025,
        // decision 8). Installing ring's is idempotent: a second call finds
        // one installed and changes nothing.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .user_agent(concat!("oyot/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(30))
            // Per read, not per request, so a large download on a slow line
            // is not cut off, while a stalled one still is.
            .read_timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| format!("could not prepare to connect: {e}"))?;
        Ok(Reqwest { client })
    }

    fn build(&self, request: HttpRequest) -> reqwest::RequestBuilder {
        let method = match request.method {
            Method::Get => reqwest::Method::GET,
            Method::Post => reqwest::Method::POST,
            Method::Put => reqwest::Method::PUT,
            Method::Patch => reqwest::Method::PATCH,
            Method::Delete => reqwest::Method::DELETE,
        };
        let mut builder = self.client.request(method, &request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name.as_str(), value.as_str());
        }
        if !matches!(request.method, Method::Get | Method::Delete) {
            builder = builder.body(request.body);
        }
        builder
    }
}

fn classify(e: reqwest::Error) -> HttpError {
    if e.is_builder() {
        HttpError::Fatal(e.to_string())
    } else {
        HttpError::Network(e.to_string())
    }
}

fn headers_of(response: &reqwest::Response) -> Vec<(String, String)> {
    response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                value.to_str().unwrap_or_default().to_string(),
            )
        })
        .collect()
}

#[async_trait]
impl HttpClient for Reqwest {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
        let response = self
            .build(request)
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(classify)?;
        let status = response.status().as_u16();
        let headers = headers_of(&response);
        let body = response.bytes().await.map_err(classify)?.to_vec();
        Ok(HttpResponse {
            status,
            headers,
            body,
        })
    }

    async fn download(
        &self,
        request: HttpRequest,
        to: &Path,
        limit: u64,
        progress: Progress<'_>,
    ) -> Result<HttpResponse, HttpError> {
        use tokio::io::AsyncWriteExt;

        let mut response = self.build(request).send().await.map_err(classify)?;
        let status = response.status().as_u16();
        let headers = headers_of(&response);
        if !response.status().is_success() {
            let body = response.bytes().await.map_err(classify)?.to_vec();
            return Ok(HttpResponse {
                status,
                headers,
                body,
            });
        }

        let total = response.content_length().unwrap_or(0);
        if total > limit {
            return Err(HttpError::Fatal(
                "this file is larger than a backup can be".to_string(),
            ));
        }
        let mut file = tokio::fs::File::create(to)
            .await
            .map_err(|e| HttpError::Fatal(format!("could not save the download: {e}")))?;
        let mut received: u64 = 0;
        let mut reported: u64 = 0;
        progress(0, total);
        while let Some(chunk) = response.chunk().await.map_err(classify)? {
            received += chunk.len() as u64;
            if received > limit {
                return Err(HttpError::Fatal(
                    "this file is larger than a backup can be".to_string(),
                ));
            }
            file.write_all(&chunk)
                .await
                .map_err(|e| HttpError::Fatal(format!("could not save the download: {e}")))?;
            if received - reported >= PROGRESS_STEP {
                reported = received;
                progress(received, total);
            }
        }
        file.flush()
            .await
            .map_err(|e| HttpError::Fatal(format!("could not save the download: {e}")))?;
        progress(received, total.max(received));
        Ok(HttpResponse {
            status,
            headers,
            body: Vec::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // reqwest is built without a crypto provider, and panics at the first
    // client if none was installed. This is the check that one is.
    #[test]
    fn builds_a_client_with_the_crypto_provider_it_brings() {
        assert!(Reqwest::new().is_ok());
        // And a second time, once one is already installed.
        assert!(Reqwest::new().is_ok());
    }

    // The whole TLS path against a real server: the ring provider, and the
    // system's own certificate check. Needs the network, so it is not part of
    // the normal run: `cargo test -- --ignored reaches_google`.
    #[tokio::test]
    #[ignore]
    async fn reaches_google_over_tls() {
        let http = Reqwest::new().unwrap();
        let request = HttpRequest::new(
            Method::Get,
            "https://www.googleapis.com/discovery/v1/apis?name=drive&preferred=true",
        );
        let response = http.send(request).await.unwrap();
        assert_eq!(response.status, 200);
        assert!(String::from_utf8_lossy(&response.body).contains("drive:v3"));
    }
}

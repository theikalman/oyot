//! Google Drive, the first remote destination (ADR 0025).
//!
//! It asks for one scope, `drive.file`: the files this app creates, and nothing
//! else in the user's Drive. New backups go into a folder the user can see,
//! "Oyot Backups", and every backup is tagged with `appProperties`, which is
//! how they are found again: a backup the user moves elsewhere in their Drive
//! is still listed, and the list says where each came from without a download.

use super::http::{HttpClient, HttpError, HttpRequest, HttpResponse, Method, Reqwest};
use super::oauth::{self, Loopback, Pkce, Redirect, TokenError, TokenResponse};
use super::secrets::{Keychain, SecretStore};
use super::{Account, BackupProvider, Cancel, OpenUrl, Progress, RemoteBackup, UploadMeta};
use crate::backup::format::FORMAT_VERSION;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const ID: &str = "google-drive";

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT: &str = "https://oauth2.googleapis.com/revoke";
const DRIVE: &str = "https://www.googleapis.com/drive/v3";
const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3";

/// The only scope asked for (ADR 0025, decision 4).
const SCOPE: &str = "https://www.googleapis.com/auth/drive.file";

/// The keychain entry the link lives in: the app's identifier, and this
/// provider's id.
const KEYCHAIN_SERVICE: &str = "com.ajiyakin.oyot";

const FOLDER_NAME: &str = "Oyot Backups";
/// The `appProperties` key the app marks what it put in Drive with. Only this
/// app can see its `appProperties`, whatever the user renames or moves.
const MARK: &str = "oyot";
const MARK_BACKUP: &str = "backup";
const MARK_FOLDER: &str = "backups-folder";

const FILE_FIELDS: &str = "id,name,size,createdTime,appProperties";

/// How long the browser gets to come back.
const LINK_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// An upload goes in pieces of this size: a multiple of the 256 KiB Drive
/// requires, large enough that a big backup is not thousands of requests, and
/// small enough that a failure part way costs little.
const CHUNK: u64 = 8 * 1024 * 1024;
/// Failures in a row, with no progress between them, before an upload gives
/// up.
const MAX_FAILURES: u32 = 5;
/// An access token is renewed this long before Google says it lapses, so one
/// never lapses in the middle of a request.
const EXPIRY_MARGIN: Duration = Duration::from_secs(60);
/// Longest device name recorded with a backup. `appProperties` allows 124
/// bytes for a key and its value together.
const MAX_DEVICE_BYTES: usize = 100;
/// Most backups listed: far past any retention setting, and a bound on paging.
const MAX_LISTED: usize = 1000;

const NOT_LINKED: &str = "no Google account is linked";
const RELINK: &str =
    "Google Drive access has ended. Link your Google account again to back up there.";

/// The link, as it is kept in the keychain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Link {
    refresh_token: String,
    email: String,
    #[serde(default)]
    name: Option<String>,
}

struct Access {
    token: String,
    expires_at: Instant,
}

#[derive(Default)]
struct Session {
    /// `None` until the keychain has been read; then what it held.
    link: Option<Option<Link>>,
    access: Option<Access>,
}

pub struct GoogleDrive {
    client_id: String,
    client_secret: String,
    http: Arc<dyn HttpClient>,
    secrets: Arc<dyn SecretStore>,
    session: tokio::sync::Mutex<Session>,
    /// Fields rather than constants so the tests need neither 8 MiB files nor
    /// real waits.
    chunk: u64,
    retry_delay: Duration,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileResource {
    id: String,
    #[serde(default)]
    name: String,
    /// Drive spells it as a string.
    #[serde(default)]
    size: Option<String>,
    #[serde(default)]
    created_time: Option<String>,
    #[serde(default)]
    app_properties: HashMap<String, String>,
}

impl FileResource {
    fn into_backup(self) -> RemoteBackup {
        let property = |key: &str| self.app_properties.get(key).cloned();
        let number = |key: &str| property(key).and_then(|v| v.parse::<u64>().ok());
        // What the app recorded when it took the backup; failing that, when
        // Drive received the file.
        let created_at = property("createdAt")
            .and_then(|v| v.parse::<i64>().ok())
            .or_else(|| {
                self.created_time
                    .as_deref()
                    .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                    .map(|t| t.timestamp_millis())
            })
            .unwrap_or(0);
        RemoteBackup {
            id: self.id.clone(),
            name: self.name.clone(),
            size: self.size.as_deref().and_then(|s| s.parse().ok()),
            created_at,
            device: property("device"),
            document_count: number("documentCount"),
            attachment_count: number("attachmentCount"),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileList {
    #[serde(default)]
    files: Vec<FileResource>,
    #[serde(default)]
    next_page_token: Option<String>,
}

enum UploadError {
    /// Drive forgot the upload session; starting a new one is the only way on.
    SessionGone,
    Failed(String),
}

/// What asking an upload session how far it got says.
enum Progressed {
    Done(FileResource),
    Received(u64),
}

impl GoogleDrive {
    /// The provider, when this build was given a client id and secret to sign
    /// in with (ADR 0025, decision 6).
    pub fn from_build() -> Option<Self> {
        let client_id = option_env!("OYOT_GOOGLE_CLIENT_ID")?.trim();
        let client_secret = option_env!("OYOT_GOOGLE_CLIENT_SECRET")?.trim();
        if client_id.is_empty() || client_secret.is_empty() {
            return None;
        }
        let http = match Reqwest::new() {
            Ok(http) => http,
            Err(e) => {
                warn_log!("[backup] Google Drive unavailable: {e}");
                return None;
            }
        };
        Some(Self::new(
            client_id,
            client_secret,
            Arc::new(http),
            Arc::new(Keychain::new(KEYCHAIN_SERVICE, ID)),
        ))
    }

    fn new(
        client_id: &str,
        client_secret: &str,
        http: Arc<dyn HttpClient>,
        secrets: Arc<dyn SecretStore>,
    ) -> Self {
        GoogleDrive {
            client_id: client_id.to_string(),
            client_secret: client_secret.to_string(),
            http,
            secrets,
            session: tokio::sync::Mutex::new(Session::default()),
            chunk: CHUNK,
            retry_delay: Duration::from_secs(1),
        }
    }

    // --- the link ----------------------------------------------------------

    async fn stored_link(&self) -> Result<Option<Link>, String> {
        let mut session = self.session.lock().await;
        if let Some(link) = &session.link {
            return Ok(link.clone());
        }
        let secrets = self.secrets.clone();
        let raw = tokio::task::spawn_blocking(move || secrets.load())
            .await
            .map_err(|e| format!("could not read the keychain: {e}"))??;
        let link = raw.and_then(|raw| match serde_json::from_str::<Link>(&raw) {
            Ok(link) => Some(link),
            Err(e) => {
                // Not something this build wrote. Treated as not linked,
                // which linking again repairs.
                warn_log!("[backup] ignoring an unreadable Google Drive link: {e}");
                None
            }
        });
        session.link = Some(link.clone());
        Ok(link)
    }

    async fn save_link(&self, link: Link, access: Access) -> Result<(), String> {
        let secrets = self.secrets.clone();
        let raw = serde_json::to_string(&link).map_err(|e| e.to_string())?;
        tokio::task::spawn_blocking(move || secrets.save(&raw))
            .await
            .map_err(|e| format!("could not write to the keychain: {e}"))??;
        let mut session = self.session.lock().await;
        session.link = Some(Some(link));
        session.access = Some(access);
        Ok(())
    }

    async fn forget_link(&self) -> Result<(), String> {
        let secrets = self.secrets.clone();
        tokio::task::spawn_blocking(move || secrets.clear())
            .await
            .map_err(|e| format!("could not write to the keychain: {e}"))??;
        *self.session.lock().await = Session {
            link: Some(None),
            access: None,
        };
        Ok(())
    }

    /// A current access token, renewed from the refresh token when it has
    /// lapsed or is about to.
    async fn access_token(&self) -> Result<String, String> {
        let link = self.stored_link().await?.ok_or(NOT_LINKED)?;
        let mut session = self.session.lock().await;
        if let Some(access) = &session.access {
            if access.expires_at > Instant::now() + EXPIRY_MARGIN {
                return Ok(access.token.clone());
            }
        }

        let request = HttpRequest::new(Method::Post, TOKEN_ENDPOINT).form(&[
            ("client_id", self.client_id.as_str()),
            ("client_secret", self.client_secret.as_str()),
            ("refresh_token", link.refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ]);
        let response = self
            .http
            .send(request)
            .await
            .map_err(|e| format!("could not reach Google: {e}"))?;
        if !response.is_success() {
            // The refresh token itself is dead: revoked from the account,
            // expired, or the password changed. Nothing but linking again
            // brings it back, so the link is forgotten and the page says so.
            if response
                .json::<TokenError>()
                .is_ok_and(|e| e.error == "invalid_grant")
            {
                drop(session);
                self.forget_link().await?;
                return Err(RELINK.to_string());
            }
            return Err(format!(
                "Google would not renew access ({})",
                response.status
            ));
        }
        let token: TokenResponse = response.json()?;
        session.access = Some(Access {
            token: token.access_token.clone(),
            expires_at: Instant::now() + Duration::from_secs(token.expires_in.unwrap_or(3600)),
        });
        Ok(token.access_token)
    }

    /// Send with the access token, renewing it once if Google says it has
    /// lapsed. A second refusal stands.
    async fn authorized(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
        let token = self.access_token().await.map_err(HttpError::Fatal)?;
        let response = self.http.send(request.clone().bearer(&token)).await?;
        if response.status != 401 {
            return Ok(response);
        }
        self.session.lock().await.access = None;
        let token = self.access_token().await.map_err(HttpError::Fatal)?;
        self.http.send(request.bearer(&token)).await
    }

    async fn call(&self, request: HttpRequest) -> Result<HttpResponse, String> {
        let response = self.authorized(request).await.map_err(|e| e.to_string())?;
        if response.is_success() {
            Ok(response)
        } else {
            Err(drive_error(&response))
        }
    }

    // --- the folder ----------------------------------------------------------

    /// The folder new backups go in, made if it is not there. Looked up on
    /// every backup rather than remembered, so one the user has since deleted
    /// is replaced rather than filled from the bin.
    async fn folder_id(&self) -> Result<String, String> {
        let url = with_query(
            &format!("{DRIVE}/files"),
            &[
                ("q", marked(MARK_FOLDER).as_str()),
                ("fields", "files(id)"),
                ("spaces", "drive"),
                ("pageSize", "1"),
            ],
        );
        let found: FileList = self
            .call(HttpRequest::new(Method::Get, url))
            .await?
            .json()?;
        if let Some(folder) = found.files.into_iter().next() {
            return Ok(folder.id);
        }

        let mut properties = serde_json::Map::new();
        properties.insert(MARK.to_string(), MARK_FOLDER.into());
        let body = serde_json::json!({
            "name": FOLDER_NAME,
            "mimeType": "application/vnd.google-apps.folder",
            "appProperties": properties,
        });
        let url = with_query(&format!("{DRIVE}/files"), &[("fields", "id")]);
        let created: FileResource = self
            .call(HttpRequest::new(Method::Post, url).json(&body))
            .await?
            .json()?;
        Ok(created.id)
    }

    // --- uploading -----------------------------------------------------------

    /// Open a resumable upload session, and return where to send the pieces.
    async fn start_upload(
        &self,
        folder: &str,
        meta: &UploadMeta,
        size: u64,
    ) -> Result<String, String> {
        let body = serde_json::json!({
            "name": meta.file_name,
            "mimeType": "application/zip",
            "parents": [folder],
            "appProperties": backup_properties(meta),
        });
        let url = with_query(
            &format!("{UPLOAD}/files"),
            &[("uploadType", "resumable"), ("fields", FILE_FIELDS)],
        );
        let request = HttpRequest::new(Method::Post, url)
            .json(&body)
            .header("X-Upload-Content-Type", "application/zip")
            .header("X-Upload-Content-Length", &size.to_string());
        let response = self.call(request).await?;
        response
            .header("location")
            .map(str::to_string)
            .ok_or_else(|| "Google Drive did not start the upload".to_string())
    }

    /// Send the file in pieces. After a failure, ask the session how much
    /// arrived and carry on from there, because a piece can land with only
    /// its answer lost.
    async fn send_pieces(
        &self,
        session: &str,
        file: &Path,
        size: u64,
        progress: Progress<'_>,
    ) -> Result<FileResource, UploadError> {
        use tokio::io::{AsyncReadExt, AsyncSeekExt};

        let mut source = tokio::fs::File::open(file)
            .await
            .map_err(|e| UploadError::Failed(format!("could not read the backup: {e}")))?;
        let mut offset: u64 = 0;
        let mut failures: u32 = 0;
        progress(0, size);
        loop {
            let end = (offset + self.chunk).min(size);
            let mut piece = vec![0u8; (end - offset) as usize];
            let unreadable =
                |e: std::io::Error| UploadError::Failed(format!("could not read the backup: {e}"));
            source
                .seek(std::io::SeekFrom::Start(offset))
                .await
                .map_err(unreadable)?;
            source.read_exact(&mut piece).await.map_err(unreadable)?;
            let request = HttpRequest::new(Method::Put, session)
                .header(
                    "Content-Range",
                    &format!("bytes {offset}-{}/{size}", end - 1),
                )
                .body(piece);

            match self.authorized(request).await {
                Ok(response) if response.status == 200 || response.status == 201 => {
                    progress(size, size);
                    return response.json().map_err(UploadError::Failed);
                }
                Ok(response) if response.status == 308 => {
                    let received = received(&response);
                    if received > offset {
                        offset = received;
                        failures = 0;
                        progress(offset, size);
                        continue;
                    }
                    // Accepted nothing: counted as a failure, so a session
                    // that never moves cannot loop forever.
                }
                Ok(response) if response.status == 404 || response.status == 410 => {
                    return Err(UploadError::SessionGone);
                }
                Ok(response) if retryable(&response) => {}
                Ok(response) => return Err(UploadError::Failed(drive_error(&response))),
                Err(HttpError::Network(_)) => {}
                Err(HttpError::Fatal(e)) => return Err(UploadError::Failed(e)),
            }

            failures += 1;
            if failures > MAX_FAILURES {
                return Err(UploadError::Failed(
                    "the upload kept failing. Check the connection and try again.".to_string(),
                ));
            }
            tokio::time::sleep(self.retry_delay * 2u32.pow(failures - 1)).await;
            match self.upload_status(session, size, offset).await? {
                Progressed::Done(resource) => {
                    progress(size, size);
                    return Ok(resource);
                }
                Progressed::Received(received) => {
                    offset = received;
                    progress(offset, size);
                }
            }
        }
    }

    /// Ask an upload session how much it holds. When the question itself
    /// fails, assume `offset`, and let the next piece find out.
    async fn upload_status(
        &self,
        session: &str,
        size: u64,
        offset: u64,
    ) -> Result<Progressed, UploadError> {
        let request = HttpRequest::new(Method::Put, session)
            .header("Content-Range", &format!("bytes */{size}"))
            .body(Vec::new());
        match self.authorized(request).await {
            Ok(response) if response.status == 200 || response.status == 201 => response
                .json()
                .map(Progressed::Done)
                .map_err(UploadError::Failed),
            Ok(response) if response.status == 308 => Ok(Progressed::Received(received(&response))),
            Ok(response) if response.status == 404 || response.status == 410 => {
                Err(UploadError::SessionGone)
            }
            Err(HttpError::Fatal(e)) => Err(UploadError::Failed(e)),
            _ => Ok(Progressed::Received(offset)),
        }
    }
}

#[async_trait]
impl BackupProvider for GoogleDrive {
    fn id(&self) -> &'static str {
        ID
    }

    fn name(&self) -> &'static str {
        "Google Drive"
    }

    async fn account(&self) -> Result<Option<Account>, String> {
        Ok(self.stored_link().await?.map(|link| Account {
            email: link.email,
            name: link.name,
        }))
    }

    async fn link(&self, open_url: OpenUrl<'_>, cancel: Cancel) -> Result<Account, String> {
        let loopback = Loopback::bind().await?;
        let pkce = Pkce::generate();
        let state = oauth::random_token();
        let url = oauth::authorization_url(
            AUTH_ENDPOINT,
            &[
                ("client_id", self.client_id.as_str()),
                ("redirect_uri", loopback.redirect_uri()),
                ("response_type", "code"),
                ("scope", SCOPE),
                ("code_challenge", pkce.challenge.as_str()),
                ("code_challenge_method", "S256"),
                ("state", state.as_str()),
                // A refresh token, every time: without `consent`, Google
                // leaves it out when the account granted access before.
                ("access_type", "offline"),
                ("prompt", "consent"),
            ],
        )?;
        open_url(&url)?;

        let code = match loopback.wait(&state, LINK_TIMEOUT, cancel).await? {
            Redirect::Code(code) => code,
            Redirect::Denied(_) => return Err("linking was cancelled in the browser".to_string()),
        };

        let request = HttpRequest::new(Method::Post, TOKEN_ENDPOINT).form(&[
            ("code", code.as_str()),
            ("client_id", self.client_id.as_str()),
            ("client_secret", self.client_secret.as_str()),
            ("redirect_uri", loopback.redirect_uri()),
            ("grant_type", "authorization_code"),
            ("code_verifier", pkce.verifier.as_str()),
        ]);
        let response = self
            .http
            .send(request)
            .await
            .map_err(|e| format!("could not reach Google: {e}"))?;
        if !response.is_success() {
            return Err(format!("Google refused the sign-in ({})", response.status));
        }
        let tokens: TokenResponse = response.json()?;

        // Google lets the user untick a permission on the consent screen, and
        // a link without it cannot back anything up. Handing back what was
        // granted leaves nothing half-linked on their account.
        if !oauth::grants(tokens.scope.as_deref(), SCOPE) {
            let granted = tokens
                .refresh_token
                .as_deref()
                .unwrap_or(&tokens.access_token);
            let _ = self
                .http
                .send(HttpRequest::new(Method::Post, REVOKE_ENDPOINT).form(&[("token", granted)]))
                .await;
            return Err(
                "Oyot needs permission to add files to your Google Drive. Link again, and leave \
                 that permission ticked."
                    .to_string(),
            );
        }
        let refresh_token = tokens
            .refresh_token
            .clone()
            .ok_or_else(|| "Google did not grant lasting access. Link again.".to_string())?;

        #[derive(Deserialize)]
        struct About {
            user: AboutUser,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct AboutUser {
            #[serde(default)]
            email_address: Option<String>,
            #[serde(default)]
            display_name: Option<String>,
        }
        let url = with_query(
            &format!("{DRIVE}/about"),
            &[("fields", "user(emailAddress,displayName)")],
        );
        let about = self
            .http
            .send(HttpRequest::new(Method::Get, url).bearer(&tokens.access_token))
            .await
            .map_err(|e| format!("could not reach Google: {e}"))?;
        if !about.is_success() {
            return Err(drive_error(&about));
        }
        let user = about.json::<About>()?.user;

        let link = Link {
            refresh_token,
            email: user
                .email_address
                .unwrap_or_else(|| "your Google account".to_string()),
            name: user.display_name,
        };
        let account = Account {
            email: link.email.clone(),
            name: link.name.clone(),
        };
        let access = Access {
            token: tokens.access_token,
            expires_at: Instant::now() + Duration::from_secs(tokens.expires_in.unwrap_or(3600)),
        };
        self.save_link(link, access).await?;
        Ok(account)
    }

    async fn unlink(&self) -> Result<(), String> {
        if let Some(link) = self.stored_link().await? {
            // A courtesy to the user's account. Failing it must not leave
            // this device linked, so its outcome is not waited on for more
            // than it says.
            let request = HttpRequest::new(Method::Post, REVOKE_ENDPOINT)
                .form(&[("token", link.refresh_token.as_str())]);
            if let Err(e) = self.http.send(request).await {
                warn_log!("[backup] could not revoke Google access: {e}");
            }
        }
        self.forget_link().await
    }

    async fn upload(
        &self,
        file: &Path,
        meta: &UploadMeta,
        progress: Progress<'_>,
    ) -> Result<RemoteBackup, String> {
        let size = tokio::fs::metadata(file)
            .await
            .map_err(|e| format!("could not read the backup: {e}"))?
            .len();
        if size == 0 {
            return Err("the backup is empty".to_string());
        }
        let folder = self.folder_id().await?;
        // A session Drive forgets part way (they expire) is started again
        // once from the beginning; a second loss is reported.
        for attempt in 0..2 {
            let session = self.start_upload(&folder, meta, size).await?;
            match self.send_pieces(&session, file, size, progress).await {
                Ok(resource) => return Ok(resource.into_backup()),
                Err(UploadError::SessionGone) if attempt == 0 => continue,
                Err(UploadError::SessionGone) => break,
                Err(UploadError::Failed(e)) => return Err(e),
            }
        }
        Err("Google Drive kept losing the upload. Try again.".to_string())
    }

    async fn list(&self) -> Result<Vec<RemoteBackup>, String> {
        let query = marked(MARK_BACKUP);
        let fields = format!("nextPageToken,files({FILE_FIELDS})");
        let mut backups = Vec::new();
        let mut page_token: Option<String> = None;
        loop {
            let mut params: Vec<(&str, &str)> = vec![
                ("q", query.as_str()),
                ("fields", fields.as_str()),
                ("orderBy", "createdTime desc"),
                ("pageSize", "100"),
                ("spaces", "drive"),
            ];
            if let Some(token) = &page_token {
                params.push(("pageToken", token.as_str()));
            }
            let url = with_query(&format!("{DRIVE}/files"), &params);
            let page: FileList = self
                .call(HttpRequest::new(Method::Get, url))
                .await?
                .json()?;
            backups.extend(page.files.into_iter().map(FileResource::into_backup));
            match page.next_page_token {
                Some(token) if backups.len() < MAX_LISTED => page_token = Some(token),
                _ => break,
            }
        }
        backups.sort_by_key(|b| std::cmp::Reverse(b.created_at));
        Ok(backups)
    }

    async fn download(
        &self,
        id: &str,
        to: &Path,
        limit: u64,
        progress: Progress<'_>,
    ) -> Result<(), String> {
        check_id(id)?;
        let url = format!("{DRIVE}/files/{id}?alt=media");
        for attempt in 0..2 {
            if attempt == 1 {
                self.session.lock().await.access = None;
            }
            let token = self.access_token().await?;
            let request = HttpRequest::new(Method::Get, url.as_str()).bearer(&token);
            let response = self
                .http
                .download(request, to, limit, progress)
                .await
                .map_err(|e| e.to_string())?;
            if response.status == 401 {
                continue;
            }
            return if response.is_success() {
                Ok(())
            } else {
                Err(drive_error(&response))
            };
        }
        Err(RELINK.to_string())
    }

    async fn delete(&self, id: &str) -> Result<(), String> {
        check_id(id)?;
        // To the bin, not gone: the user can take it back out for 30 days.
        let url = with_query(&format!("{DRIVE}/files/{id}"), &[("fields", "id")]);
        let request =
            HttpRequest::new(Method::Patch, url).json(&serde_json::json!({ "trashed": true }));
        self.call(request).await.map(|_| ())
    }
}

/// What the app records with each backup.
fn backup_properties(meta: &UploadMeta) -> serde_json::Map<String, serde_json::Value> {
    let mut properties = serde_json::Map::new();
    let mut put = |key: &str, value: String| {
        properties.insert(key.to_string(), serde_json::Value::String(value));
    };
    put(MARK, MARK_BACKUP.to_string());
    put("formatVersion", FORMAT_VERSION.to_string());
    put("createdAt", meta.created_at.to_string());
    put(
        "device",
        truncate(&meta.device, MAX_DEVICE_BYTES).to_string(),
    );
    put("documentCount", meta.document_count.to_string());
    put("attachmentCount", meta.attachment_count.to_string());
    properties
}

/// At most `max` bytes of `s`, cut at a character boundary.
fn truncate(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// A Drive search for what the app marked with `value`.
fn marked(value: &str) -> String {
    format!("appProperties has {{ key='{MARK}' and value='{value}' }} and trashed = false")
}

fn with_query(base: &str, params: &[(&str, &str)]) -> String {
    let mut url = url::Url::parse(base).expect("a constant base URL parses");
    url.query_pairs_mut().extend_pairs(params);
    url.into()
}

/// A file id goes into a URL path, and arrives from the webview, so it is
/// held to the characters Drive ids are made of.
fn check_id(id: &str) -> Result<(), String> {
    let plain = !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if plain {
        Ok(())
    } else {
        Err(format!("{id:?} is not a Google Drive file id"))
    }
}

/// How many bytes an upload session says it holds. `Range: bytes=0-42` means
/// 43; no header means none.
fn received(response: &HttpResponse) -> u64 {
    response
        .header("range")
        .and_then(|range| range.strip_prefix("bytes="))
        .and_then(|range| range.split('-').nth(1))
        .and_then(|last| last.trim().parse::<u64>().ok())
        .map(|last| last + 1)
        .unwrap_or(0)
}

struct ErrorDetail {
    message: Option<String>,
    reasons: Vec<String>,
}

fn error_detail(response: &HttpResponse) -> ErrorDetail {
    #[derive(Deserialize)]
    struct Body {
        error: Detail,
    }
    #[derive(Deserialize)]
    struct Detail {
        #[serde(default)]
        message: Option<String>,
        #[serde(default)]
        errors: Vec<Reason>,
    }
    #[derive(Deserialize)]
    struct Reason {
        #[serde(default)]
        reason: String,
    }
    match serde_json::from_slice::<Body>(&response.body) {
        Ok(body) => ErrorDetail {
            message: body.error.message,
            reasons: body.error.errors.into_iter().map(|r| r.reason).collect(),
        },
        Err(_) => ErrorDetail {
            message: None,
            reasons: Vec::new(),
        },
    }
}

fn rate_limited(response: &HttpResponse) -> bool {
    response.status == 429
        || (response.status == 403
            && error_detail(response)
                .reasons
                .iter()
                .any(|r| r == "rateLimitExceeded" || r == "userRateLimitExceeded"))
}

fn retryable(response: &HttpResponse) -> bool {
    response.status == 408 || rate_limited(response) || (500..600).contains(&response.status)
}

/// A refusal from Drive, in words.
fn drive_error(response: &HttpResponse) -> String {
    let detail = error_detail(response);
    if detail.reasons.iter().any(|r| r == "storageQuotaExceeded") {
        return "your Google Drive is full".to_string();
    }
    if rate_limited(response) {
        return "Google Drive is busy. Try again in a minute.".to_string();
    }
    match response.status {
        401 => RELINK.to_string(),
        404 => "that backup is no longer in your Google Drive".to_string(),
        status => match detail.message {
            Some(message) if !message.is_empty() => {
                format!("Google Drive refused ({status}): {message}")
            }
            _ => format!("Google Drive refused ({status})"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::super::secrets::MemoryStore;
    use super::*;
    use parking_lot::Mutex;
    use std::collections::HashSet;

    // --- a Google stand-in ---------------------------------------------------

    struct FakeFile {
        name: String,
        app_properties: HashMap<String, String>,
        content: Vec<u8>,
        trashed: bool,
        created: i64,
    }

    struct FakeUpload {
        metadata: serde_json::Value,
        total: u64,
        received: Vec<u8>,
        /// The file it became, once complete. Drive keeps answering for a
        /// finished session, which is what makes asking after a lost answer
        /// safe.
        done: Option<String>,
    }

    #[derive(Default)]
    struct State {
        log: Vec<String>,
        valid_access: HashSet<String>,
        issued: u32,
        refresh_revoked: bool,
        revoked: Vec<String>,
        granted_scope: Option<String>,
        challenge: Option<String>,
        files: Vec<(String, FakeFile)>,
        uploads: HashMap<String, FakeUpload>,
        /// Fail this many piece uploads with a lost connection.
        fail_pieces: u32,
        /// Keep a failed piece's bytes, as if only the answer was lost.
        keep_failed_piece: bool,
        /// Forget every upload session after this many pieces.
        forget_sessions_after: Option<u32>,
        pieces: u32,
        page_size: usize,
    }

    /// Enough of Google's token endpoint and the Drive API to run the
    /// provider against: it keeps the files, checks tokens, holds upload
    /// sessions byte for byte, and fails on request.
    struct FakeGoogle(Mutex<State>);

    fn ok(status: u16, body: serde_json::Value) -> HttpResponse {
        HttpResponse {
            status,
            headers: vec![("Content-Type".to_string(), "application/json".to_string())],
            body: body.to_string().into_bytes(),
        }
    }

    fn form_of(request: &HttpRequest) -> HashMap<String, String> {
        url::form_urlencoded::parse(&request.body)
            .into_owned()
            .collect()
    }

    fn query_of(url: &str) -> HashMap<String, String> {
        url::Url::parse(url)
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect()
    }

    impl FakeGoogle {
        fn new() -> Arc<Self> {
            Arc::new(FakeGoogle(Mutex::new(State {
                granted_scope: Some(format!("openid {SCOPE}")),
                page_size: 100,
                ..State::default()
            })))
        }

        fn issue(state: &mut State) -> String {
            state.issued += 1;
            let token = format!("access-{}", state.issued);
            state.valid_access.insert(token.clone());
            token
        }

        fn file_json(id: &str, file: &FakeFile) -> serde_json::Value {
            serde_json::json!({
                "id": id,
                "name": file.name,
                "size": file.content.len().to_string(),
                "createdTime": chrono::DateTime::from_timestamp_millis(file.created)
                    .unwrap()
                    .to_rfc3339(),
                "appProperties": file.app_properties,
            })
        }

        fn handle(&self, request: &HttpRequest) -> Result<HttpResponse, HttpError> {
            let mut state = self.0.lock();
            let path = request.url.split('?').next().unwrap().to_string();
            state.log.push(format!("{:?} {path}", request.method));

            if request.url == TOKEN_ENDPOINT {
                let form = form_of(request);
                return Ok(match form["grant_type"].as_str() {
                    "authorization_code" => {
                        // The code is only worth anything with the verifier
                        // behind the challenge that went out.
                        let verifier = &form["code_verifier"];
                        let expected = state.challenge.clone().unwrap();
                        if Pkce::from_verifier(verifier.clone()).challenge != expected
                            || form["code"] != "the-code"
                        {
                            return Ok(ok(400, serde_json::json!({ "error": "invalid_grant" })));
                        }
                        let access = Self::issue(&mut state);
                        ok(
                            200,
                            serde_json::json!({
                                "access_token": access,
                                "expires_in": 3599,
                                "refresh_token": "refresh-1",
                                "scope": state.granted_scope,
                            }),
                        )
                    }
                    "refresh_token" if state.refresh_revoked => {
                        ok(400, serde_json::json!({ "error": "invalid_grant" }))
                    }
                    "refresh_token" => {
                        let access = Self::issue(&mut state);
                        ok(
                            200,
                            serde_json::json!({ "access_token": access, "expires_in": 3599 }),
                        )
                    }
                    _ => ok(
                        400,
                        serde_json::json!({ "error": "unsupported_grant_type" }),
                    ),
                });
            }
            if request.url == REVOKE_ENDPOINT {
                let token = form_of(request)["token"].clone();
                state.revoked.push(token);
                return Ok(ok(200, serde_json::json!({})));
            }

            let bearer = request
                .header_value("authorization")
                .and_then(|v| v.strip_prefix("Bearer "))
                .unwrap_or_default()
                .to_string();
            if !state.valid_access.contains(&bearer) {
                return Ok(ok(
                    401,
                    serde_json::json!({ "error": { "message": "expired" } }),
                ));
            }

            if path == format!("{DRIVE}/about") {
                return Ok(ok(
                    200,
                    serde_json::json!({ "user": { "emailAddress": "me@example.com", "displayName": "Me" } }),
                ));
            }

            if path == format!("{DRIVE}/files") && request.method == Method::Get {
                let query = query_of(&request.url);
                let q = &query["q"];
                let wanted = if q.contains(MARK_FOLDER) {
                    MARK_FOLDER
                } else {
                    MARK_BACKUP
                };
                let mut matching: Vec<serde_json::Value> = state
                    .files
                    .iter()
                    .filter(|(_, f)| {
                        !f.trashed && f.app_properties.get(MARK).map(String::as_str) == Some(wanted)
                    })
                    .map(|(id, f)| Self::file_json(id, f))
                    .collect();
                let start: usize = query
                    .get("pageToken")
                    .map(|t| t.parse().unwrap())
                    .unwrap_or(0);
                let page_size = state.page_size;
                let rest = matching.split_off(start.min(matching.len()));
                let next = (rest.len() > page_size).then(|| (start + page_size).to_string());
                let page: Vec<_> = rest.into_iter().take(page_size).collect();
                return Ok(ok(
                    200,
                    serde_json::json!({ "files": page, "nextPageToken": next }),
                ));
            }

            if path == format!("{DRIVE}/files") && request.method == Method::Post {
                let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
                let id = format!("folder{}", state.files.len());
                let app_properties: HashMap<String, String> =
                    serde_json::from_value(body["appProperties"].clone()).unwrap();
                state.files.push((
                    id.clone(),
                    FakeFile {
                        name: body["name"].as_str().unwrap().to_string(),
                        app_properties,
                        content: Vec::new(),
                        trashed: false,
                        created: 0,
                    },
                ));
                return Ok(ok(200, serde_json::json!({ "id": id })));
            }

            if path == format!("{UPLOAD}/files") {
                let metadata: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
                let total: u64 = request
                    .header_value("x-upload-content-length")
                    .unwrap()
                    .parse()
                    .unwrap();
                let session = format!("https://upload.fake/session/{}", state.uploads.len());
                state.uploads.insert(
                    session.clone(),
                    FakeUpload {
                        metadata,
                        total,
                        received: Vec::new(),
                        done: None,
                    },
                );
                return Ok(HttpResponse {
                    status: 200,
                    headers: vec![("Location".to_string(), session)],
                    body: Vec::new(),
                });
            }

            if path.starts_with("https://upload.fake/session/") {
                return Ok(self.piece(&mut state, request));
            }

            if let Some(id) = path.strip_prefix(&format!("{DRIVE}/files/")) {
                let id = id.to_string();
                let Some((_, file)) = state.files.iter_mut().find(|(fid, _)| *fid == id) else {
                    return Ok(ok(
                        404,
                        serde_json::json!({ "error": { "message": "File not found" } }),
                    ));
                };
                if request.method == Method::Patch {
                    file.trashed = true;
                    return Ok(ok(200, serde_json::json!({ "id": id })));
                }
                return Ok(HttpResponse {
                    status: 200,
                    headers: Vec::new(),
                    body: file.content.clone(),
                });
            }

            Ok(ok(
                404,
                serde_json::json!({ "error": { "message": "no such endpoint" } }),
            ))
        }

        fn piece(&self, state: &mut State, request: &HttpRequest) -> HttpResponse {
            let session = request.url.clone();
            if !state.uploads.contains_key(&session) {
                return ok(
                    404,
                    serde_json::json!({ "error": { "message": "session gone" } }),
                );
            }
            if let Some(id) = state.uploads[&session].done.clone() {
                let file = &state.files.iter().find(|(fid, _)| *fid == id).unwrap().1;
                return ok(200, Self::file_json(&id, file));
            }
            let range = request.header_value("content-range").unwrap().to_string();
            let is_query = range.starts_with("bytes */");
            if !is_query {
                state.pieces += 1;
                if state.forget_sessions_after == Some(state.pieces) {
                    state.uploads.clear();
                    return ok(
                        404,
                        serde_json::json!({ "error": { "message": "session gone" } }),
                    );
                }
                let upload = state.uploads.get_mut(&session).unwrap();
                let start: usize = range
                    .strip_prefix("bytes ")
                    .and_then(|r| r.split('-').next())
                    .unwrap()
                    .parse()
                    .unwrap();
                // Bytes past what it already holds are taken; anything it
                // holds is not taken twice.
                if start == upload.received.len() {
                    upload.received.extend_from_slice(&request.body);
                } else if start < upload.received.len() {
                    let overlap = upload.received.len() - start;
                    if overlap < request.body.len() {
                        upload.received.extend_from_slice(&request.body[overlap..]);
                    }
                }
            }

            let upload = state.uploads.get(&session).unwrap();
            if upload.received.len() as u64 == upload.total {
                let metadata = upload.metadata.clone();
                let content = upload.received.clone();
                let id = format!("file{}", state.files.len());
                let file = FakeFile {
                    name: metadata["name"].as_str().unwrap().to_string(),
                    app_properties: serde_json::from_value(metadata["appProperties"].clone())
                        .unwrap(),
                    content,
                    trashed: false,
                    created: 1_790_000_000_000,
                };
                let json = Self::file_json(&id, &file);
                state.files.push((id.clone(), file));
                state.uploads.get_mut(&session).unwrap().done = Some(id);
                return ok(200, json);
            }
            let held = upload.received.len();
            let headers = if held == 0 {
                Vec::new()
            } else {
                vec![("Range".to_string(), format!("bytes=0-{}", held - 1))]
            };
            HttpResponse {
                status: 308,
                headers,
                body: Vec::new(),
            }
        }
    }

    #[async_trait]
    impl HttpClient for FakeGoogle {
        async fn send(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
            let is_piece = request.url.starts_with("https://upload.fake/")
                && !request
                    .header_value("content-range")
                    .is_some_and(|r| r.starts_with("bytes */"));
            if is_piece {
                let failing = {
                    let mut state = self.0.lock();
                    (state.fail_pieces > 0).then(|| {
                        state.fail_pieces -= 1;
                        state.keep_failed_piece
                    })
                };
                if let Some(keep) = failing {
                    if keep {
                        let _ = self.handle(&request);
                    }
                    return Err(HttpError::Network("connection reset".to_string()));
                }
            }
            self.handle(&request)
        }

        async fn download(
            &self,
            request: HttpRequest,
            to: &Path,
            limit: u64,
            progress: Progress<'_>,
        ) -> Result<HttpResponse, HttpError> {
            let mut response = self.handle(&request)?;
            if response.is_success() {
                if response.body.len() as u64 > limit {
                    return Err(HttpError::Fatal(
                        "this file is larger than a backup can be".to_string(),
                    ));
                }
                std::fs::write(to, &response.body).unwrap();
                progress(response.body.len() as u64, response.body.len() as u64);
                response.body.clear();
            }
            Ok(response)
        }
    }

    fn drive(google: &Arc<FakeGoogle>) -> (GoogleDrive, Arc<MemoryStore>) {
        let secrets = Arc::new(MemoryStore::default());
        let mut drive = GoogleDrive::new("client", "secret", google.clone(), secrets.clone());
        drive.chunk = 1000;
        drive.retry_delay = Duration::ZERO;
        (drive, secrets)
    }

    /// Link, with this test standing in for the browser: it reads the sign-in
    /// address, and comes back to the listener with a code.
    async fn link(drive: &GoogleDrive, google: &Arc<FakeGoogle>) -> Result<Account, String> {
        let google = google.clone();
        let open = move |url: &str| -> Result<(), String> {
            let query = query_of(url);
            google.0.lock().challenge = Some(query["code_challenge"].clone());
            assert_eq!(query["scope"], SCOPE);
            assert_eq!(query["code_challenge_method"], "S256");
            assert_eq!(query["access_type"], "offline");
            let redirect = query["redirect_uri"].clone();
            let state = query["state"].clone();
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let port: u16 = redirect.rsplit(':').next().unwrap().parse().unwrap();
                let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
                    .await
                    .unwrap();
                let line = format!("GET /?state={state}&code=the-code HTTP/1.1\r\n\r\n");
                stream.write_all(line.as_bytes()).await.unwrap();
                let mut sink = Vec::new();
                let _ = stream.read_to_end(&mut sink).await;
            });
            Ok(())
        };
        let (_keep, cancel) = tokio::sync::oneshot::channel();
        drive.link(&open, cancel).await
    }

    async fn linked() -> (GoogleDrive, Arc<MemoryStore>, Arc<FakeGoogle>) {
        let google = FakeGoogle::new();
        let (drive, secrets) = drive(&google);
        link(&drive, &google).await.unwrap();
        (drive, secrets, google)
    }

    fn meta() -> UploadMeta {
        UploadMeta {
            file_name: "oyot-backup-2026-09-23-1530.zip".to_string(),
            created_at: 1_790_000_000_000,
            device: "Desk".to_string(),
            document_count: 12,
            attachment_count: 3,
        }
    }

    fn backup_file(len: usize) -> (std::path::PathBuf, Vec<u8>) {
        let dir = crate::backup::test_support::scratch();
        let path = dir.join("backup.zip");
        let content: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &content).unwrap();
        (path, content)
    }

    fn stored_content(google: &FakeGoogle, id: &str) -> Vec<u8> {
        let state = google.0.lock();
        state
            .files
            .iter()
            .find(|(fid, _)| fid == id)
            .unwrap()
            .1
            .content
            .clone()
    }

    // --- linking -------------------------------------------------------------

    #[tokio::test]
    async fn links_an_account_and_keeps_only_the_refresh_token_and_who_it_is() {
        let google = FakeGoogle::new();
        let (drive, secrets) = drive(&google);
        assert_eq!(drive.account().await.unwrap(), None);

        let account = link(&drive, &google).await.unwrap();
        assert_eq!(account.email, "me@example.com");
        assert_eq!(drive.account().await.unwrap(), Some(account));

        let stored: serde_json::Value =
            serde_json::from_str(&secrets.load().unwrap().unwrap()).unwrap();
        assert_eq!(stored["refreshToken"], "refresh-1");
        assert_eq!(stored["email"], "me@example.com");
        assert!(stored.get("accessToken").is_none());
    }

    #[tokio::test]
    async fn refuses_a_link_without_permission_to_add_files_and_hands_it_back() {
        let google = FakeGoogle::new();
        google.0.lock().granted_scope = Some("openid".to_string());
        let (drive, secrets) = drive(&google);

        let error = link(&drive, &google).await.unwrap_err();
        assert!(error.contains("permission"), "{error}");
        assert_eq!(google.0.lock().revoked, vec!["refresh-1".to_string()]);
        assert_eq!(secrets.load().unwrap(), None);
        assert_eq!(drive.account().await.unwrap(), None);
    }

    #[tokio::test]
    async fn unlinking_revokes_access_and_forgets_the_account() {
        let (drive, secrets, google) = linked().await;
        drive.unlink().await.unwrap();
        assert_eq!(google.0.lock().revoked, vec!["refresh-1".to_string()]);
        assert_eq!(secrets.load().unwrap(), None);
        assert_eq!(drive.account().await.unwrap(), None);
        assert_eq!(drive.list().await.unwrap_err(), NOT_LINKED);
    }

    #[tokio::test]
    async fn renews_a_lapsed_access_token_without_asking_the_user() {
        let (drive, _, google) = linked().await;
        // Google forgets every access token it issued, as when one expires.
        google.0.lock().valid_access.clear();
        assert!(drive.list().await.unwrap().is_empty());
        assert_eq!(google.0.lock().issued, 2);
    }

    #[tokio::test]
    async fn a_revoked_link_is_forgotten_and_the_user_asked_to_link_again() {
        let (drive, secrets, google) = linked().await;
        {
            let mut state = google.0.lock();
            state.valid_access.clear();
            state.refresh_revoked = true;
        }
        assert_eq!(drive.list().await.unwrap_err(), RELINK);
        assert_eq!(secrets.load().unwrap(), None);
        assert_eq!(drive.account().await.unwrap(), None);
    }

    // --- uploading -----------------------------------------------------------

    #[tokio::test]
    async fn uploads_in_pieces_into_a_folder_it_makes_once() {
        let (drive, _, google) = linked().await;
        let (path, content) = backup_file(4_500);
        let seen = Mutex::new(Vec::new());
        let progress = |done: u64, total: u64| seen.lock().push((done, total));

        let first = drive.upload(&path, &meta(), &progress).await.unwrap();
        assert_eq!(stored_content(&google, &first.id), content);
        assert_eq!(first.size, Some(4_500));
        assert_eq!(first.device.as_deref(), Some("Desk"));
        assert_eq!(first.document_count, Some(12));
        assert_eq!(first.created_at, 1_790_000_000_000);

        let reported = seen.lock().clone();
        assert_eq!(reported.first(), Some(&(0, 4_500)));
        assert_eq!(reported.last(), Some(&(4_500, 4_500)));
        assert!(reported.windows(2).all(|w| w[0].0 <= w[1].0));

        // The second backup goes into the same folder.
        drive.upload(&path, &meta(), &|_, _| {}).await.unwrap();
        let state = google.0.lock();
        let folders = state
            .files
            .iter()
            .filter(|(_, f)| f.app_properties.get(MARK).map(String::as_str) == Some(MARK_FOLDER))
            .count();
        assert_eq!(folders, 1);
        assert_eq!(
            state
                .files
                .iter()
                .find(|(id, _)| id.starts_with("folder"))
                .unwrap()
                .1
                .name,
            FOLDER_NAME
        );
    }

    // The case the status query exists for: the piece arrived and only the
    // answer was lost. Sending it again from the old offset would be wrong;
    // asking first means nothing is sent twice or skipped.
    #[tokio::test]
    async fn carries_on_after_a_piece_that_landed_but_whose_answer_was_lost() {
        let (drive, _, google) = linked().await;
        {
            let mut state = google.0.lock();
            state.fail_pieces = 1;
            state.keep_failed_piece = true;
        }
        let (path, content) = backup_file(3_500);
        let backup = drive.upload(&path, &meta(), &|_, _| {}).await.unwrap();
        assert_eq!(stored_content(&google, &backup.id), content);
    }

    #[tokio::test]
    async fn sends_a_piece_again_when_it_never_arrived() {
        let (drive, _, google) = linked().await;
        google.0.lock().fail_pieces = 2;
        let (path, content) = backup_file(3_500);
        let backup = drive.upload(&path, &meta(), &|_, _| {}).await.unwrap();
        assert_eq!(stored_content(&google, &backup.id), content);
    }

    #[tokio::test]
    async fn gives_up_on_a_connection_that_keeps_failing() {
        let (drive, _, google) = linked().await;
        google.0.lock().fail_pieces = u32::MAX;
        let (path, _) = backup_file(3_500);
        let error = drive.upload(&path, &meta(), &|_, _| {}).await.unwrap_err();
        assert!(error.contains("kept failing"), "{error}");
    }

    #[tokio::test]
    async fn starts_again_when_drive_forgets_the_upload() {
        let (drive, _, google) = linked().await;
        google.0.lock().forget_sessions_after = Some(2);
        let (path, content) = backup_file(3_500);
        let backup = drive.upload(&path, &meta(), &|_, _| {}).await.unwrap();
        assert_eq!(stored_content(&google, &backup.id), content);
    }

    // --- listing, downloading, deleting ---------------------------------------

    #[tokio::test]
    async fn lists_what_it_uploaded_newest_first_across_pages() {
        let (drive, _, google) = linked().await;
        google.0.lock().page_size = 2;
        let (path, _) = backup_file(10);
        for created_at in [3, 1, 2] {
            let meta = UploadMeta {
                created_at,
                ..meta()
            };
            drive.upload(&path, &meta, &|_, _| {}).await.unwrap();
        }
        let listed: Vec<i64> = drive
            .list()
            .await
            .unwrap()
            .iter()
            .map(|b| b.created_at)
            .collect();
        assert_eq!(listed, vec![3, 2, 1]);
    }

    #[tokio::test]
    async fn downloads_a_backup_and_refuses_one_past_the_limit() {
        let (drive, _, _) = linked().await;
        let (path, content) = backup_file(2_000);
        let backup = drive.upload(&path, &meta(), &|_, _| {}).await.unwrap();

        let to = path.with_file_name("downloaded.zip");
        drive
            .download(&backup.id, &to, 10_000, &|_, _| {})
            .await
            .unwrap();
        assert_eq!(std::fs::read(&to).unwrap(), content);

        assert!(drive
            .download(&backup.id, &to, 100, &|_, _| {})
            .await
            .is_err());
    }

    #[tokio::test]
    async fn deleting_puts_a_backup_in_the_bin_and_out_of_the_list() {
        let (drive, _, google) = linked().await;
        let (path, _) = backup_file(10);
        let backup = drive.upload(&path, &meta(), &|_, _| {}).await.unwrap();
        drive.delete(&backup.id).await.unwrap();
        assert!(drive.list().await.unwrap().is_empty());
        let state = google.0.lock();
        assert!(state
            .files
            .iter()
            .any(|(id, f)| *id == backup.id && f.trashed));
    }

    #[tokio::test]
    async fn only_a_plain_file_id_goes_into_a_url() {
        let (drive, _, _) = linked().await;
        for id in ["", "../about", "a/b", "id?alt=media", "x y"] {
            assert!(drive.delete(id).await.is_err(), "{id:?}");
        }
    }

    // --- words ---------------------------------------------------------------

    #[test]
    fn says_plainly_when_the_drive_is_full() {
        let response = ok(
            403,
            serde_json::json!({ "error": { "message": "quota", "errors": [{ "reason": "storageQuotaExceeded" }] } }),
        );
        assert_eq!(drive_error(&response), "your Google Drive is full");
        assert!(!retryable(&response));
    }

    #[test]
    fn a_rate_limit_is_worth_retrying() {
        let response = ok(
            403,
            serde_json::json!({ "error": { "errors": [{ "reason": "userRateLimitExceeded" }] } }),
        );
        assert!(retryable(&response));
        assert!(retryable(&ok(503, serde_json::json!({}))));
        assert!(!retryable(&ok(400, serde_json::json!({}))));
    }

    #[test]
    fn reads_how_much_an_upload_session_holds() {
        let with = |range: &str| HttpResponse {
            status: 308,
            headers: vec![("Range".to_string(), range.to_string())],
            body: Vec::new(),
        };
        assert_eq!(received(&with("bytes=0-999")), 1000);
        assert_eq!(received(&with("nonsense")), 0);
        assert_eq!(received(&ok(308, serde_json::json!({}))), 0);
    }

    #[test]
    fn records_a_long_device_name_cut_on_a_character() {
        let name = "é".repeat(80);
        let cut = truncate(&name, MAX_DEVICE_BYTES);
        assert!(cut.len() <= MAX_DEVICE_BYTES);
        assert!(name.starts_with(cut));
    }
}

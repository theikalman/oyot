//! Google Drive, the first remote destination (ADR 0025).
//!
//! It asks for one scope, `drive.file`: the files this app creates, and nothing
//! else in the user's Drive. New backups go into a folder the user can see,
//! "Oyot Backups", and every backup is tagged with `appProperties`, which is
//! how they are found again: a backup the user moves elsewhere in their Drive
//! is still listed, and the list says where each came from without a download.

use super::http::{HttpClient, HttpError, HttpRequest, HttpResponse, Method, Reqwest};
use super::oauth::{self, Loopback, Pkce, Redirect, TokenError, TokenResponse};
use super::secrets::SecretStore;
use super::{
    Account, AuthSession, BackupProvider, Cancel, NativeError, OpenUrl, PlayServices, Progress,
    RemoteBackup, UploadMeta,
};
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
const DRIVE: &str = "https://www.googleapis.com/drive/v3";
const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3";

/// The only scope asked for (ADR 0025, decision 4).
const SCOPE: &str = "https://www.googleapis.com/auth/drive.file";

/// The keychain entry the link lives in: the app's identifier, and this
/// provider's id.
#[cfg(any(desktop, target_os = "ios"))]
const KEYCHAIN_SERVICE: &str = "com.ajiyakin.oyot";

/// Where an iOS sign-in comes back to, under the client's own scheme.
#[cfg(any(target_os = "ios", test))]
const IOS_REDIRECT_PATH: &str = "/oauth2redirect";

const FOLDER_NAME: &str = "Oyot Backups";
/// The `appProperties` key the app marks what it put in Drive with. Only this
/// app can see its `appProperties`, whatever the user renames or moves.
const MARK: &str = "oyot";
const MARK_BACKUP: &str = "backup";
const MARK_FOLDER: &str = "backups-folder";

const FILE_FIELDS: &str = "id,name,size,createdTime,appProperties";

/// How long the browser gets to come back.
const LINK_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// How long Google Play services gets to hand out a token without asking the
/// user anything.
const SILENT_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a token from Google Play services is used before another is
/// asked for. Play services does not say when one lapses; they last an hour,
/// and it may hand back one it has held for a while.
const PLAY_TOKEN_LIFETIME: Duration = Duration::from_secs(30 * 60);
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
const NEEDS_PERMISSION: &str = "Oyot needs permission to add files to your Google Drive. Link \
     again, and leave that permission ticked.";
const TOO_LONG: &str = "linking took too long. Try again.";

/// The link, as it is kept.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Link {
    /// What renews access, where the sign-in gives one: none on Android,
    /// where Google Play services keeps the grant itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    refresh_token: Option<String>,
    email: String,
    #[serde(default)]
    name: Option<String>,
}

/// How this platform gets Google's permission, and access tokens under it
/// (ADR 0025, decisions 3 and 7).
enum SignIn {
    /// A refresh token, from a sign-in page, renewed at Google's token
    /// endpoint: desktop and iOS.
    #[cfg_attr(target_os = "android", allow(dead_code))]
    Refresh {
        client_id: String,
        /// A desktop client has one. Google gives an iOS client none, and
        /// PKCE is what ties the code to this app either way.
        client_secret: Option<String>,
        page: Consent,
    },
    /// Access tokens straight from Google Play services, which keeps the
    /// grant and never hands the app a refresh token: Android.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    Play(Arc<dyn PlayServices>),
}

/// Where the sign-in page shows, and how its answer comes back.
enum Consent {
    /// The system browser, answering to a one-shot listener on 127.0.0.1
    /// (RFC 8252): desktop.
    #[cfg_attr(mobile, allow(dead_code))]
    Loopback,
    /// A system sheet that answers to the client's own scheme, and to this
    /// app alone: iOS.
    #[cfg_attr(not(target_os = "ios"), allow(dead_code))]
    Session {
        scheme: String,
        redirect_uri: String,
        session: Arc<dyn AuthSession>,
    },
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
    sign_in: SignIn,
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

/// A value compiled in from the build environment, when it was set and is
/// not blank.
fn configured(value: Option<&'static str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

impl GoogleDrive {
    /// The provider, when this build was set up to sign in to Google on this
    /// platform (ADR 0025, decision 6). A build without it offers backups to
    /// disk only.
    pub fn from_build(app: &tauri::AppHandle) -> Option<Self> {
        let (sign_in, secrets) = Self::sign_in_for_build(app)?;
        let http = match Reqwest::new() {
            Ok(http) => http,
            Err(e) => {
                warn_log!("[backup] Google Drive unavailable: {e}");
                return None;
            }
        };
        Some(Self::new(sign_in, Arc::new(http), secrets))
    }

    /// Desktop: a Desktop OAuth client, with its id and secret.
    #[cfg(desktop)]
    fn sign_in_for_build(_app: &tauri::AppHandle) -> Option<(SignIn, Arc<dyn SecretStore>)> {
        let client_id = configured(option_env!("OYOT_GOOGLE_CLIENT_ID"))?;
        let client_secret = configured(option_env!("OYOT_GOOGLE_CLIENT_SECRET"))?;
        let sign_in = SignIn::Refresh {
            client_id,
            client_secret: Some(client_secret),
            page: Consent::Loopback,
        };
        let secrets = super::secrets::Keychain::new(KEYCHAIN_SERVICE, ID);
        Some((sign_in, Arc::new(secrets)))
    }

    /// iOS: an iOS OAuth client, which has an id and no secret, and signs in
    /// through Apple's authentication session.
    #[cfg(target_os = "ios")]
    fn sign_in_for_build(app: &tauri::AppHandle) -> Option<(SignIn, Arc<dyn SecretStore>)> {
        let client_id = configured(option_env!("OYOT_GOOGLE_IOS_CLIENT_ID"))?;
        let scheme = oauth::reversed_client_id(&client_id)?;
        let sign_in = SignIn::Refresh {
            client_id,
            client_secret: None,
            page: Consent::Session {
                redirect_uri: format!("{scheme}:{IOS_REDIRECT_PATH}"),
                scheme,
                session: Arc::new(super::native::Native::new(app)),
            },
        };
        let secrets = super::secrets::Keychain::new(KEYCHAIN_SERVICE, ID);
        Some((sign_in, Arc::new(secrets)))
    }

    /// Android: Google Play services, which knows the app by its package and
    /// signing certificate, so nothing is compiled in but the switch that
    /// says the Cloud project has an Android client for this build.
    #[cfg(target_os = "android")]
    fn sign_in_for_build(app: &tauri::AppHandle) -> Option<(SignIn, Arc<dyn SecretStore>)> {
        use tauri::Manager;
        configured(option_env!("OYOT_GOOGLE_ANDROID"))?;
        let dir = app.path().app_data_dir().ok()?;
        let sign_in = SignIn::Play(Arc::new(super::native::Native::new(app)));
        let link = super::secrets::LinkFile::new(dir.join("google-drive-link.json"));
        Some((sign_in, Arc::new(link)))
    }

    fn new(sign_in: SignIn, http: Arc<dyn HttpClient>, secrets: Arc<dyn SecretStore>) -> Self {
        GoogleDrive {
            sign_in,
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

    /// A current access token, renewed when it has lapsed or is about to:
    /// from the refresh token, or from Google Play services.
    async fn access_token(&self) -> Result<String, String> {
        let link = self.stored_link().await?.ok_or(NOT_LINKED)?;
        let mut session = self.session.lock().await;
        if let Some(access) = &session.access {
            if access.expires_at > Instant::now() + EXPIRY_MARGIN {
                return Ok(access.token.clone());
            }
        }

        let access = match &self.sign_in {
            SignIn::Refresh {
                client_id,
                client_secret,
                ..
            } => {
                let Some(refresh_token) = link.refresh_token.as_deref() else {
                    // Written by a sign-in of another kind: nothing here can
                    // renew it.
                    drop(session);
                    self.forget_link().await?;
                    return Err(RELINK.to_string());
                };
                let mut form = vec![
                    ("client_id", client_id.as_str()),
                    ("refresh_token", refresh_token),
                    ("grant_type", "refresh_token"),
                ];
                if let Some(secret) = client_secret {
                    form.push(("client_secret", secret.as_str()));
                }
                let request = HttpRequest::new(Method::Post, TOKEN_ENDPOINT).form(&form);
                let response = self
                    .http
                    .send(request)
                    .await
                    .map_err(|e| format!("could not reach Google: {e}"))?;
                if !response.is_success() {
                    // The refresh token itself is dead: revoked from the
                    // account, expired, or the password changed. Nothing but
                    // linking again brings it back, so the link is forgotten
                    // and the page says so.
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
                Access {
                    token: token.access_token,
                    expires_at: Instant::now()
                        + Duration::from_secs(token.expires_in.unwrap_or(3600)),
                }
            }
            SignIn::Play(play) => {
                // Never shows anything: this runs in the middle of a backup,
                // perhaps a scheduled one, with nobody looking.
                let asked = play.authorize(SCOPE, Some(&link.email), false);
                match tokio::time::timeout(SILENT_TIMEOUT, asked).await {
                    Ok(Ok((token, _))) => Access {
                        token,
                        expires_at: Instant::now() + PLAY_TOKEN_LIFETIME,
                    },
                    // The grant needs the user again: they removed it from
                    // their account, or the account left the phone.
                    Ok(Err(NativeError::NeedsUser)) => {
                        drop(session);
                        self.forget_link().await?;
                        return Err(RELINK.to_string());
                    }
                    Ok(Err(e)) => return Err(format!("Google Play services refused: {e}")),
                    Err(_) => return Err("Google Play services did not answer".to_string()),
                }
            }
        };
        let token = access.token.clone();
        session.access = Some(access);
        Ok(token)
    }

    /// Drop the access token Drive just refused, so the next one is fresh.
    /// Google Play services is told as well, or it would hand the same one
    /// back.
    async fn invalidate(&self) {
        let refused = self.session.lock().await.access.take();
        if let (SignIn::Play(play), Some(access)) = (&self.sign_in, refused) {
            play.clear_token(&access.token).await;
        }
    }

    /// Send with the access token, renewing it once if Google says it has
    /// lapsed. A second refusal stands.
    async fn authorized(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
        let token = self.access_token().await.map_err(HttpError::Fatal)?;
        let response = self.http.send(request.clone().bearer(&token)).await?;
        if response.status != 401 {
            return Ok(response);
        }
        self.invalidate().await;
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

    // --- signing in ------------------------------------------------------------

    /// Show Google's consent page and trade the code it gives for tokens:
    /// in the browser on desktop, in Apple's sheet on iOS.
    async fn consent(
        &self,
        client_id: &str,
        client_secret: Option<&str>,
        page: &Consent,
        open_url: OpenUrl<'_>,
        cancel: Cancel,
    ) -> Result<TokenResponse, String> {
        let pkce = Pkce::generate();
        let state = oauth::random_token();
        let address = |redirect_uri: &str| {
            oauth::authorization_url(
                AUTH_ENDPOINT,
                &[
                    ("client_id", client_id),
                    ("redirect_uri", redirect_uri),
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
            )
        };

        let (code, redirect_uri) = match page {
            Consent::Loopback => {
                let loopback = Loopback::bind().await?;
                open_url(&address(loopback.redirect_uri())?)?;
                let code = match loopback.wait(&state, LINK_TIMEOUT, cancel).await? {
                    Redirect::Code(code) => code,
                    Redirect::Denied(_) => {
                        return Err("linking was cancelled in the browser".to_string())
                    }
                };
                (code, loopback.redirect_uri().to_string())
            }
            Consent::Session {
                scheme,
                redirect_uri,
                session,
            } => {
                let url = address(redirect_uri)?;
                let shown = tokio::time::timeout(LINK_TIMEOUT, session.open(&url, scheme));
                let answer = tokio::select! {
                    answer = shown => match answer {
                        Ok(answer) => answer,
                        Err(_) => {
                            session.cancel().await;
                            return Err(TOO_LONG.to_string());
                        }
                    },
                    _ = cancel => {
                        session.cancel().await;
                        return Err(oauth::CANCELLED.to_string());
                    }
                };
                let came_back = answer.map_err(native_link_error)?;
                let code = match oauth::parse_callback(&came_back, scheme, &state) {
                    Some(Redirect::Code(code)) => code,
                    // Declined on Google's page, which is the user saying no.
                    Some(Redirect::Denied(_)) => return Err(oauth::CANCELLED.to_string()),
                    None => {
                        return Err(
                            "the sign-in came back with something Oyot did not ask for. Try \
                             again."
                                .to_string(),
                        )
                    }
                };
                (code, redirect_uri.clone())
            }
        };

        let mut form = vec![
            ("code", code.as_str()),
            ("client_id", client_id),
            ("redirect_uri", redirect_uri.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", pkce.verifier.as_str()),
        ];
        if let Some(secret) = client_secret {
            form.push(("client_secret", secret));
        }
        let response = self
            .http
            .send(HttpRequest::new(Method::Post, TOKEN_ENDPOINT).form(&form))
            .await
            .map_err(|e| format!("could not reach Google: {e}"))?;
        if !response.is_success() {
            return Err(format!("Google refused the sign-in ({})", response.status));
        }
        response.json()
    }

    /// Who the account is, from Drive itself, which the one scope asked for
    /// allows.
    async fn about(&self, token: &str) -> Result<AboutUser, String> {
        #[derive(Deserialize)]
        struct About {
            user: AboutUser,
        }
        let url = with_query(
            &format!("{DRIVE}/about"),
            &[("fields", "user(emailAddress,displayName)")],
        );
        let about = self
            .http
            .send(HttpRequest::new(Method::Get, url).bearer(token))
            .await
            .map_err(|e| format!("could not reach Google: {e}"))?;
        if !about.is_success() {
            return Err(drive_error(&about));
        }
        Ok(about.json::<About>()?.user)
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
        let (token, refresh_token, lifetime) = match &self.sign_in {
            SignIn::Refresh {
                client_id,
                client_secret,
                page,
            } => {
                let tokens = self
                    .consent(client_id, client_secret.as_deref(), page, open_url, cancel)
                    .await?;
                // Google lets the user untick a permission on the consent
                // screen, and a link without it cannot back anything up.
                // Nothing is handed back to Google here: revoking covers every
                // device linked to the account, not just this sign-in.
                if !oauth::grants(tokens.scope.as_deref(), SCOPE) {
                    return Err(NEEDS_PERMISSION.to_string());
                }
                let refresh_token = tokens.refresh_token.ok_or_else(|| {
                    "Google did not grant lasting access. Link again.".to_string()
                })?;
                let lifetime = Duration::from_secs(tokens.expires_in.unwrap_or(3600));
                (tokens.access_token, Some(refresh_token), lifetime)
            }
            SignIn::Play(play) => {
                let asked = tokio::time::timeout(LINK_TIMEOUT, play.authorize(SCOPE, None, true));
                let answer = tokio::select! {
                    answer = asked => answer.map_err(|_| TOO_LONG.to_string())?,
                    _ = cancel => return Err(oauth::CANCELLED.to_string()),
                };
                let (token, scopes) = answer.map_err(native_link_error)?;
                if !scopes.is_empty() && !scopes.iter().any(|s| s == SCOPE) {
                    return Err(NEEDS_PERMISSION.to_string());
                }
                (token, None, PLAY_TOKEN_LIFETIME)
            }
        };

        let user = self.about(&token).await?;
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
            token,
            expires_at: Instant::now() + lifetime,
        };
        self.save_link(link, access).await?;
        Ok(account)
    }

    async fn unlink(&self) -> Result<(), String> {
        // Forgotten on this device only (ADR 0025, decision 2). Google's
        // revocation would cut off every device linked to the account, so
        // that is left to the user, in their Google Account.
        if let SignIn::Play(play) = &self.sign_in {
            if let Some(access) = self.session.lock().await.access.take() {
                play.clear_token(&access.token).await;
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
                self.invalidate().await;
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
        let response = self.authorized(request).await.map_err(|e| e.to_string())?;
        match response.status {
            // Deleted for good already, or never visible to this app: either
            // way, not there, which is what was asked for.
            404 | 410 => Ok(()),
            _ if response.is_success() => Ok(()),
            _ => Err(drive_error(&response)),
        }
    }

    async fn purge(&self, id: &str) -> Result<(), String> {
        check_id(id)?;
        // `drive.file` allows deleting a file this app created, and one it
        // did not create is invisible to it, so answers 404 like one that is
        // gone.
        let request = HttpRequest::new(Method::Delete, format!("{DRIVE}/files/{id}"));
        let response = self.authorized(request).await.map_err(|e| e.to_string())?;
        match response.status {
            404 | 410 => Ok(()),
            _ if response.is_success() => Ok(()),
            _ => Err(drive_error(&response)),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AboutUser {
    #[serde(default)]
    email_address: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
}

/// What a phone's own sign-in ending without access means for linking.
fn native_link_error(e: NativeError) -> String {
    match e {
        // The page treats this one as nothing to report.
        NativeError::Cancelled => oauth::CANCELLED.to_string(),
        other => other.to_string(),
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

    /// Google's revocation endpoint. The provider never calls it: revoking
    /// would cut off every device linked to the account. The fake records
    /// anything sent there so the tests can say so.
    const REVOKE_ENDPOINT: &str = "https://oauth2.googleapis.com/revoke";

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
        /// Every form sent to the token endpoint.
        token_forms: Vec<HashMap<String, String>>,
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
                state.token_forms.push(form.clone());
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
                let Some(index) = state.files.iter().position(|(fid, _)| *fid == id) else {
                    return Ok(ok(
                        404,
                        serde_json::json!({ "error": { "message": "File not found" } }),
                    ));
                };
                if request.method == Method::Delete {
                    state.files.remove(index);
                    return Ok(HttpResponse {
                        status: 204,
                        headers: Vec::new(),
                        body: Vec::new(),
                    });
                }
                let file = &mut state.files[index].1;
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

    fn drive_with(google: &Arc<FakeGoogle>, sign_in: SignIn) -> (GoogleDrive, Arc<MemoryStore>) {
        let secrets = Arc::new(MemoryStore::default());
        let mut drive = GoogleDrive::new(sign_in, google.clone(), secrets.clone());
        drive.chunk = 1000;
        drive.retry_delay = Duration::ZERO;
        (drive, secrets)
    }

    /// The desktop sign-in: a client with a secret, and the browser.
    fn drive(google: &Arc<FakeGoogle>) -> (GoogleDrive, Arc<MemoryStore>) {
        drive_with(
            google,
            SignIn::Refresh {
                client_id: "client".to_string(),
                client_secret: Some("secret".to_string()),
                page: Consent::Loopback,
            },
        )
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
    async fn refuses_a_link_without_permission_to_add_files() {
        let google = FakeGoogle::new();
        google.0.lock().granted_scope = Some("openid".to_string());
        let (drive, secrets) = drive(&google);

        let error = link(&drive, &google).await.unwrap_err();
        assert!(error.contains("permission"), "{error}");
        // Not revoked: that would cut off every other device linked to the
        // same account.
        assert!(google.0.lock().revoked.is_empty());
        assert_eq!(secrets.load().unwrap(), None);
        assert_eq!(drive.account().await.unwrap(), None);
    }

    #[tokio::test]
    async fn unlinking_forgets_the_account_on_this_device_only() {
        let (drive, secrets, google) = linked().await;
        drive.unlink().await.unwrap();
        assert!(google.0.lock().revoked.is_empty());
        assert_eq!(secrets.load().unwrap(), None);
        assert_eq!(drive.account().await.unwrap(), None);
        assert_eq!(drive.list().await.unwrap_err(), NOT_LINKED);
    }

    #[tokio::test]
    async fn a_desktop_client_sends_its_secret() {
        let (drive, _, google) = linked().await;
        google.0.lock().valid_access.clear();
        drive.list().await.unwrap();
        let forms = google.0.lock().token_forms.clone();
        assert_eq!(forms.len(), 2);
        assert!(forms
            .iter()
            .all(|f| f.get("client_secret").map(String::as_str) == Some("secret")));
    }

    // --- iOS: Apple's authentication session ----------------------------------

    const IOS_SCHEME: &str = "com.googleusercontent.apps.1234-abc";

    /// Apple's sheet, with this test as the user: it reads the sign-in
    /// address, and comes back under the client's scheme.
    struct FakeSession {
        google: Arc<FakeGoogle>,
        /// What to answer with instead of the right redirect.
        answer: Mutex<Option<Result<String, NativeError>>>,
        cancelled: Mutex<bool>,
        /// Never answer, as a sheet the user leaves open.
        hang: bool,
        /// Come back as Google does when the user declines.
        decline: bool,
    }

    impl FakeSession {
        fn new(google: &Arc<FakeGoogle>) -> Arc<Self> {
            Arc::new(FakeSession {
                google: google.clone(),
                answer: Mutex::new(None),
                cancelled: Mutex::new(false),
                hang: false,
                decline: false,
            })
        }
    }

    #[async_trait]
    impl AuthSession for FakeSession {
        async fn open(&self, url: &str, scheme: &str) -> Result<String, NativeError> {
            if self.hang {
                std::future::pending::<()>().await;
            }
            if let Some(answer) = self.answer.lock().take() {
                return answer;
            }
            let query = query_of(url);
            assert_eq!(scheme, IOS_SCHEME);
            assert_eq!(
                query["redirect_uri"],
                format!("{IOS_SCHEME}:{IOS_REDIRECT_PATH}")
            );
            assert_eq!(query["code_challenge_method"], "S256");
            self.google.0.lock().challenge = Some(query["code_challenge"].clone());
            let outcome = if self.decline {
                "error=access_denied"
            } else {
                "code=the-code"
            };
            Ok(format!(
                "{IOS_SCHEME}:{IOS_REDIRECT_PATH}?state={}&{outcome}",
                query["state"]
            ))
        }

        async fn cancel(&self) {
            *self.cancelled.lock() = true;
        }
    }

    fn ios_drive(
        google: &Arc<FakeGoogle>,
        session: Arc<FakeSession>,
    ) -> (GoogleDrive, Arc<MemoryStore>) {
        drive_with(
            google,
            SignIn::Refresh {
                client_id: "1234-abc.apps.googleusercontent.com".to_string(),
                client_secret: None,
                page: Consent::Session {
                    scheme: IOS_SCHEME.to_string(),
                    redirect_uri: format!("{IOS_SCHEME}:{IOS_REDIRECT_PATH}"),
                    session,
                },
            },
        )
    }

    fn never_open(_: &str) -> Result<(), String> {
        panic!("an authentication session opens no browser")
    }

    #[tokio::test]
    async fn links_on_ios_through_the_session_without_a_client_secret() {
        let google = FakeGoogle::new();
        let (drive, secrets) = ios_drive(&google, FakeSession::new(&google));
        let (_keep, cancel) = tokio::sync::oneshot::channel();
        let account = drive.link(&never_open, cancel).await.unwrap();
        assert_eq!(account.email, "me@example.com");
        let stored: serde_json::Value =
            serde_json::from_str(&secrets.load().unwrap().unwrap()).unwrap();
        assert_eq!(stored["refreshToken"], "refresh-1");

        // Renewing sends no secret either: Google gives iOS clients none.
        google.0.lock().valid_access.clear();
        drive.list().await.unwrap();
        let forms = google.0.lock().token_forms.clone();
        assert_eq!(forms.len(), 2);
        assert!(forms.iter().all(|f| !f.contains_key("client_secret")));
        assert_eq!(
            forms[0]["redirect_uri"],
            format!("{IOS_SCHEME}:{IOS_REDIRECT_PATH}")
        );
    }

    #[tokio::test]
    async fn refuses_an_ios_callback_that_is_not_the_one_asked_for() {
        let google = FakeGoogle::new();
        let session = FakeSession::new(&google);
        *session.answer.lock() = Some(Ok(format!(
            "{IOS_SCHEME}:{IOS_REDIRECT_PATH}?state=someone-elses&code=the-code"
        )));
        let (drive, secrets) = ios_drive(&google, session);
        let (_keep, cancel) = tokio::sync::oneshot::channel();
        assert!(drive.link(&never_open, cancel).await.is_err());
        assert_eq!(secrets.load().unwrap(), None);
        assert!(google.0.lock().token_forms.is_empty());
    }

    #[tokio::test]
    async fn closing_the_ios_sheet_is_a_quiet_cancel() {
        let google = FakeGoogle::new();
        let session = FakeSession::new(&google);
        *session.answer.lock() = Some(Err(NativeError::Cancelled));
        let (drive, _) = ios_drive(&google, session);
        let (_keep, cancel) = tokio::sync::oneshot::channel();
        assert_eq!(
            drive.link(&never_open, cancel).await.unwrap_err(),
            oauth::CANCELLED
        );
    }

    #[tokio::test]
    async fn declining_on_googles_page_is_a_quiet_cancel_too() {
        let google = FakeGoogle::new();
        let session = Arc::new(FakeSession {
            decline: true,
            ..Arc::try_unwrap(FakeSession::new(&google)).ok().unwrap()
        });
        let (drive, secrets) = ios_drive(&google, session);
        let (_keep, cancel) = tokio::sync::oneshot::channel();
        assert_eq!(
            drive.link(&never_open, cancel).await.unwrap_err(),
            oauth::CANCELLED
        );
        assert_eq!(secrets.load().unwrap(), None);
        assert!(google.0.lock().token_forms.is_empty());
    }

    #[tokio::test]
    async fn cancelling_a_link_closes_the_ios_sheet() {
        let google = FakeGoogle::new();
        let session = Arc::new(FakeSession {
            hang: true,
            ..Arc::try_unwrap(FakeSession::new(&google)).ok().unwrap()
        });
        let (drive, _) = ios_drive(&google, session.clone());
        let (stop, cancel) = tokio::sync::oneshot::channel();
        stop.send(()).unwrap();
        assert_eq!(
            drive.link(&never_open, cancel).await.unwrap_err(),
            oauth::CANCELLED
        );
        assert!(*session.cancelled.lock());
    }

    // --- Android: Google Play services -----------------------------------------

    /// Google Play services, keeping a grant and handing out tokens the fake
    /// Google accepts.
    struct FakePlay {
        google: Arc<FakeGoogle>,
        granted: Mutex<bool>,
        /// Scopes it says it granted.
        scopes: Vec<String>,
        /// The user took the grant away since.
        grant_gone: Mutex<bool>,
        asked: Mutex<Vec<(Option<String>, bool)>>,
        cleared: Mutex<Vec<String>>,
    }

    impl FakePlay {
        fn new(google: &Arc<FakeGoogle>) -> Arc<Self> {
            Arc::new(FakePlay {
                google: google.clone(),
                granted: Mutex::new(false),
                scopes: vec![SCOPE.to_string()],
                grant_gone: Mutex::new(false),
                asked: Mutex::new(Vec::new()),
                cleared: Mutex::new(Vec::new()),
            })
        }
    }

    #[async_trait]
    impl PlayServices for FakePlay {
        async fn authorize(
            &self,
            scope: &str,
            account: Option<&str>,
            interactive: bool,
        ) -> Result<(String, Vec<String>), NativeError> {
            assert_eq!(scope, SCOPE);
            self.asked
                .lock()
                .push((account.map(str::to_string), interactive));
            if *self.grant_gone.lock() || !*self.granted.lock() {
                if !interactive {
                    return Err(NativeError::NeedsUser);
                }
                *self.grant_gone.lock() = false;
                *self.granted.lock() = true;
            }
            let token = FakeGoogle::issue(&mut self.google.0.lock());
            Ok((token, self.scopes.clone()))
        }

        async fn clear_token(&self, token: &str) {
            self.cleared.lock().push(token.to_string());
        }
    }

    async fn android_linked() -> (
        GoogleDrive,
        Arc<MemoryStore>,
        Arc<FakeGoogle>,
        Arc<FakePlay>,
    ) {
        let google = FakeGoogle::new();
        let play = FakePlay::new(&google);
        let (drive, secrets) = drive_with(&google, SignIn::Play(play.clone()));
        let (_keep, cancel) = tokio::sync::oneshot::channel();
        drive.link(&never_open, cancel).await.unwrap();
        (drive, secrets, google, play)
    }

    #[tokio::test]
    async fn links_on_android_and_keeps_no_token_at_all() {
        let (drive, secrets, google, play) = android_linked().await;
        assert_eq!(
            drive.account().await.unwrap().unwrap().email,
            "me@example.com"
        );
        let stored: serde_json::Value =
            serde_json::from_str(&secrets.load().unwrap().unwrap()).unwrap();
        assert!(stored.get("refreshToken").is_none());
        assert_eq!(stored["email"], "me@example.com");
        // The user chose the account; nothing was asked of Google's token
        // endpoint.
        assert_eq!(*play.asked.lock(), vec![(None, true)]);
        assert!(google.0.lock().token_forms.is_empty());
    }

    #[tokio::test]
    async fn renews_on_android_quietly_for_the_linked_account() {
        let (drive, _, google, play) = android_linked().await;
        // Drive stops taking the token Play services handed out.
        google.0.lock().valid_access.clear();
        assert!(drive.list().await.unwrap().is_empty());
        // The refused one was handed back, and a new one asked for, for the
        // same account, without showing anything.
        assert_eq!(*play.cleared.lock(), vec!["access-1".to_string()]);
        assert_eq!(
            play.asked.lock().last().cloned(),
            Some((Some("me@example.com".to_string()), false))
        );
    }

    #[tokio::test]
    async fn an_android_grant_taken_away_asks_to_link_again() {
        let (drive, secrets, google, play) = android_linked().await;
        google.0.lock().valid_access.clear();
        *play.grant_gone.lock() = true;
        assert_eq!(drive.list().await.unwrap_err(), RELINK);
        assert_eq!(secrets.load().unwrap(), None);
        assert_eq!(drive.account().await.unwrap(), None);
    }

    #[tokio::test]
    async fn refuses_an_android_link_without_permission_to_add_files() {
        let google = FakeGoogle::new();
        let play = Arc::new(FakePlay {
            scopes: vec!["openid".to_string()],
            ..Arc::try_unwrap(FakePlay::new(&google)).ok().unwrap()
        });
        let (drive, secrets) = drive_with(&google, SignIn::Play(play));
        let (_keep, cancel) = tokio::sync::oneshot::channel();
        let error = drive.link(&never_open, cancel).await.unwrap_err();
        assert!(error.contains("permission"), "{error}");
        assert_eq!(secrets.load().unwrap(), None);
    }

    #[tokio::test]
    async fn unlinking_on_android_hands_back_the_token_it_held() {
        let (drive, secrets, google, play) = android_linked().await;
        drive.unlink().await.unwrap();
        assert_eq!(*play.cleared.lock(), vec!["access-1".to_string()]);
        assert!(google.0.lock().revoked.is_empty());
        assert_eq!(secrets.load().unwrap(), None);
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
    async fn deleting_a_backup_that_is_already_gone_is_not_an_error() {
        let (drive, _, _) = linked().await;
        drive.delete("no-such-file").await.unwrap();
        drive.purge("no-such-file").await.unwrap();
    }

    #[tokio::test]
    async fn purging_removes_a_backup_for_good() {
        let (drive, _, google) = linked().await;
        let (path, _) = backup_file(10);
        let kept = drive.upload(&path, &meta(), &|_, _| {}).await.unwrap();
        let pruned = drive.upload(&path, &meta(), &|_, _| {}).await.unwrap();
        drive.purge(&pruned.id).await.unwrap();

        let listed: Vec<String> = drive
            .list()
            .await
            .unwrap()
            .into_iter()
            .map(|b| b.id)
            .collect();
        assert_eq!(listed, vec![kept.id]);
        // Not in the bin either, where it would go on using the storage.
        assert!(!google.0.lock().files.iter().any(|(id, _)| *id == pruned.id));
        assert!(google
            .0
            .lock()
            .log
            .iter()
            .any(|line| line.starts_with("Delete ")));
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

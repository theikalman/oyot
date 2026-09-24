//! Signing in to a backup provider through the phone's own facilities
//! (ADR 0025, decision 7).
//!
//! On iOS, a web authentication session: Apple's sign-in sheet, which shows
//! the provider's page and hands the address it ends on back to this app
//! alone. On Android, Google Play services' authorization, which asks the
//! user and then hands out access tokens itself.
//!
//! Only Rust calls this. The plugin has no commands for the webview, and no
//! capability grants any, so what comes back (an access token, an address
//! carrying an authorization code) never reaches the page.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Why a sign-in did not give what was asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The user closed the sign-in.
    Cancelled,
    /// Access needs the user to confirm something, and the call asked for no
    /// interaction (Android).
    NeedsUser,
    /// This phone cannot do it at all: Android without Google Play services.
    Unavailable(String),
    Failed(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Cancelled => f.write_str("the sign-in was cancelled"),
            Error::NeedsUser => f.write_str("the sign-in needs you to confirm it again"),
            Error::Unavailable(message) | Error::Failed(message) => f.write_str(message),
        }
    }
}

/// Access Google Play services granted (Android).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Authorized {
    pub access_token: String,
    #[serde(default)]
    pub granted_scopes: Vec<String>,
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("sign-in")
        .setup(|_app, _api| {
            #[cfg(mobile)]
            {
                use tauri::Manager;
                _app.manage(mobile::SignIn(mobile::register(_api)?));
            }
            Ok(())
        })
        .build()
}

#[cfg(mobile)]
pub use mobile::SignIn;

#[cfg(mobile)]
mod mobile {
    use super::{Authorized, Error};
    use serde::de::DeserializeOwned;
    use serde_json::json;
    use tauri::plugin::mobile::PluginInvokeError;
    use tauri::plugin::{PluginApi, PluginHandle};
    use tauri::Runtime;

    #[cfg(target_os = "ios")]
    tauri::ios_plugin_binding!(init_plugin_sign_in);

    pub(super) fn register<R: Runtime>(
        api: PluginApi<R, ()>,
    ) -> Result<PluginHandle<R>, Box<dyn std::error::Error>> {
        #[cfg(target_os = "android")]
        let handle = api.register_android_plugin("com.ajiyakin.oyot.signin", "SignInPlugin")?;
        #[cfg(target_os = "ios")]
        let handle = api.register_ios_plugin(init_plugin_sign_in)?;
        Ok(handle)
    }

    /// The native side, managed as app state.
    pub struct SignIn<R: Runtime>(pub(super) PluginHandle<R>);

    impl<R: Runtime> SignIn<R> {
        /// Show `url` in a web authentication session, and resolve to the
        /// address it is redirected to under `callback_scheme` (iOS).
        pub async fn web_auth(&self, url: &str, callback_scheme: &str) -> Result<String, Error> {
            #[derive(serde::Deserialize)]
            struct Opened {
                url: String,
            }
            let opened: Opened = self
                .call(
                    "webAuth",
                    json!({ "url": url, "callbackScheme": callback_scheme }),
                )
                .await?;
            Ok(opened.url)
        }

        /// Close a session `web_auth` is waiting on, which then resolves as
        /// cancelled (iOS).
        pub async fn cancel_web_auth(&self) {
            let _ = self
                .call::<serde_json::Value>("cancelWebAuth", json!({}))
                .await;
        }

        /// Access to `scope` from Google Play services (Android). `account`
        /// is the one linked before, if any. With `interactive` false, a
        /// grant that needs the user fails with `NeedsUser` instead of
        /// showing anything.
        pub async fn authorize(
            &self,
            scope: &str,
            account: Option<&str>,
            interactive: bool,
        ) -> Result<Authorized, Error> {
            self.call(
                "authorize",
                json!({ "scope": scope, "account": account, "interactive": interactive }),
            )
            .await
        }

        /// Tell Google Play services that a token it handed out was refused,
        /// so it hands out a new one next time (Android).
        pub async fn clear_token(&self, token: &str) -> Result<(), Error> {
            self.call::<serde_json::Value>("clearToken", json!({ "token": token }))
                .await
                .map(|_| ())
        }

        /// Call the native side and wait for its answer.
        ///
        /// The call runs in a task of its own, to its end. Tauri's
        /// response callback panics if the future waiting for it has been
        /// dropped, and a caller that gives up waiting, on a cancel or a
        /// timeout, drops this one. So what is dropped is only the channel
        /// from that task.
        async fn call<T: DeserializeOwned + Send + 'static>(
            &self,
            method: &'static str,
            payload: serde_json::Value,
        ) -> Result<T, Error> {
            let handle = self.0.clone();
            let (tx, rx) = tokio::sync::oneshot::channel();
            tauri::async_runtime::spawn(async move {
                let result = handle.run_mobile_plugin_async::<T>(method, payload).await;
                let _ = tx.send(result);
            });
            match rx.await {
                Ok(Ok(value)) => Ok(value),
                Ok(Err(e)) => Err(describe(e)),
                Err(_) => Err(Error::Failed(
                    "the sign-in stopped unexpectedly".to_string(),
                )),
            }
        }
    }

    fn describe(e: PluginInvokeError) -> Error {
        match e {
            PluginInvokeError::InvokeRejected(response) => {
                let message = response
                    .message
                    .unwrap_or_else(|| "the sign-in failed".to_string());
                match response.code.as_deref() {
                    Some("cancelled") => Error::Cancelled,
                    Some("needs-user") => Error::NeedsUser,
                    Some("unavailable") => Error::Unavailable(message),
                    _ => Error::Failed(message),
                }
            }
            other => Error::Failed(other.to_string()),
        }
    }
}

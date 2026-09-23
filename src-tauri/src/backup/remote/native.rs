//! The phone's own sign-in (the `sign-in` plugin), as the Drive provider
//! uses it: Apple's authentication session on iOS, Google Play services on
//! Android (ADR 0025, decision 7).

use super::{AuthSession, NativeError, PlayServices};
use async_trait::async_trait;
use tauri::{AppHandle, Manager};
use tauri_plugin_sign_in::{Error, SignIn};

pub struct Native {
    app: AppHandle,
}

impl Native {
    pub fn new(app: &AppHandle) -> Self {
        Native { app: app.clone() }
    }

    fn plugin(&self) -> tauri::State<'_, SignIn<tauri::Wry>> {
        self.app.state::<SignIn<tauri::Wry>>()
    }
}

fn native(e: Error) -> NativeError {
    match e {
        Error::Cancelled => NativeError::Cancelled,
        Error::NeedsUser => NativeError::NeedsUser,
        Error::Unavailable(message) => NativeError::Unavailable(message),
        Error::Failed(message) => NativeError::Failed(message),
    }
}

#[async_trait]
impl AuthSession for Native {
    async fn open(&self, url: &str, scheme: &str) -> Result<String, NativeError> {
        self.plugin().web_auth(url, scheme).await.map_err(native)
    }

    async fn cancel(&self) {
        self.plugin().cancel_web_auth().await;
    }
}

#[async_trait]
impl PlayServices for Native {
    async fn authorize(
        &self,
        scope: &str,
        account: Option<&str>,
        interactive: bool,
    ) -> Result<(String, Vec<String>), NativeError> {
        let granted = self
            .plugin()
            .authorize(scope, account, interactive)
            .await
            .map_err(native)?;
        Ok((granted.access_token, granted.granted_scopes))
    }

    async fn clear_token(&self, token: &str) {
        if let Err(e) = self.plugin().clear_token(token).await {
            warn_log!("[backup] Google Play services could not drop a refused token: {e}");
        }
    }
}

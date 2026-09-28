//! Background sync on phones (ADR 0034): the platform's scheduler, and the
//! app coming on screen and leaving it.
//!
//! - **Android:** a periodic WorkManager job, and `ProcessLifecycleOwner` for
//!   the screen.
//! - **iOS:** an app refresh task and a processing task, registered when
//!   this plugin is created, and the app entering and leaving the
//!   background, with background time asked for to finish a sync on the way
//!   out.
//!
//! What runs is the app's own. The native side calls the app's library
//! directly, JNI on Android and C on iOS, because a background run starts
//! with no Tauri app to call through (`src-tauri/src/mobile.rs`). What this
//! plugin carries from Rust is the schedule. Nothing here is for the webview.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("background-sync")
        .setup(|_app, _api| {
            #[cfg(mobile)]
            {
                use tauri::Manager;
                _app.manage(mobile::BackgroundSync(mobile::register(_api)?));
            }
            Ok(())
        })
        .build()
}

#[cfg(mobile)]
pub use mobile::BackgroundSync;

#[cfg(mobile)]
mod mobile {
    use serde_json::json;
    use tauri::plugin::{PluginApi, PluginHandle};
    use tauri::Runtime;

    #[cfg(target_os = "ios")]
    tauri::ios_plugin_binding!(init_plugin_background_sync);

    pub(super) fn register<R: Runtime>(
        api: PluginApi<R, ()>,
    ) -> Result<PluginHandle<R>, Box<dyn std::error::Error>> {
        #[cfg(target_os = "android")]
        let handle = api
            .register_android_plugin("com.ajiyakin.oyot.backgroundsync", "BackgroundSyncPlugin")?;
        #[cfg(target_os = "ios")]
        let handle = api.register_ios_plugin(init_plugin_background_sync)?;
        Ok(handle)
    }

    /// The native side, managed as app state.
    pub struct BackgroundSync<R: Runtime>(pub(super) PluginHandle<R>);

    impl<R: Runtime> BackgroundSync<R> {
        /// Ask the platform to run background syncs, about every 30 minutes
        /// when it sees fit, or to stop asking. `mobile_data` lets a run
        /// happen off Wi-Fi.
        pub fn schedule(&self, enabled: bool, mobile_data: bool) {
            let handle = self.0.clone();
            // In a task of its own, to its end: Tauri's response callback
            // panics if the future waiting for it has been dropped.
            tauri::async_runtime::spawn(async move {
                let scheduled = handle
                    .run_mobile_plugin_async::<serde_json::Value>(
                        "schedule",
                        json!({ "enabled": enabled, "mobileData": mobile_data }),
                    )
                    .await;
                if let Err(e) = scheduled {
                    eprintln!("[background-sync] could not schedule background runs: {e}");
                }
            });
        }
    }
}

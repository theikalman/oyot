//! A phone's engine follows the screen (ADR 0034, decisions 1, 5 and 6).
//!
//! On screen, the engine is in its foreground mode: listening, discoverable,
//! and connected to every paired device it can reach. Off screen nothing can
//! reach a phone anyway, so it stops listening at once, lets a sync in
//! progress finish, and goes idle, and the platform's scheduler starts a
//! bounded run later. The platform says which it is, not Tauri: Tauri's
//! `Suspended` and `Resumed` also fire when a permission dialog or Control
//! Center covers the app for a moment.
//!
//! The platform calls in through plain functions, JNI on Android and C on
//! iOS, at the bottom of this file: a background run starts with no Tauri
//! app to call through, and the screen changes arrive from code that has
//! none either.

use crate::commands::config::read_flag;
use crate::crypto::now_ms;
use crate::db::AppState;
use crate::sync::background::{self, Trigger, ENABLED_KEY, MOBILE_DATA_KEY};
use crate::sync::manager::SyncManager;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// The app, once `setup` has built it.
static APP: OnceLock<AppHandle> = OnceLock::new();
/// Whether the app is on screen, as the platform last said.
static ON_SCREEN: AtomicBool = AtomicBool::new(false);
/// One change of mode at a time: coming back on screen waits for leaving it
/// to have finished.
static MODE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Hold on to the app, and start the engine if the platform has already
/// said the app is on screen: on Android the screen can be reported before
/// `setup` has run.
pub fn keep(app: &AppHandle) {
    let _ = APP.set(app.clone());
    if ON_SCREEN.load(Ordering::Acquire) {
        start(app.clone());
    }
    reschedule(app);
}

// The platform reports the screen on its main thread, in order, and these
// record it there and return at once: done on other threads, a quick leave
// and return could be recorded the other way round, leaving the engine idle
// with the app on screen.

/// The app came on screen. A background run in this process gives way, and
/// what it finished stands.
pub fn on_foreground() {
    ON_SCREEN.store(true, Ordering::Release);
    background::stop();
    if let Some(app) = APP.get() {
        start(app.clone());
    }
}

/// The app left the screen: stop being reachable, give a sync in progress
/// until `budget` to finish, record it if there was one, and go idle, in a
/// task of its own (Android, which has no more time to ask for).
#[cfg(target_os = "android")]
pub fn on_background(budget: Duration) {
    left_screen();
    if let Some(app) = APP.get() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { leave(&app, budget).await });
    }
}

/// Only record that the app left the screen (iOS, whose `finish_leaving`
/// then runs on another thread, inside the background time it asked for).
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn left_screen() {
    ON_SCREEN.store(false, Ordering::Release);
}

/// What `on_background` does after recording it, returning once the engine
/// is idle, for iOS to end its background time then. Nothing, if the app
/// came back on screen first.
#[cfg(target_os = "ios")]
pub fn finish_leaving(budget: Duration) {
    if let Some(app) = APP.get() {
        tauri::async_runtime::block_on(leave(app, budget));
    }
}

fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let _mode = MODE.lock().await;
        if !ON_SCREEN.load(Ordering::Acquire) {
            return;
        }
        if let Err(e) = crate::commands::signaling::start_network(&app).await {
            warn_log!("[sync] could not start: {e}");
        }
    });
}

async fn leave(app: &AppHandle, budget: Duration) {
    let _mode = MODE.lock().await;
    if ON_SCREEN.load(Ordering::Acquire) {
        // Back on screen before this got its turn.
        return;
    }
    let Some(sync) = app.try_state::<SyncManager>() else {
        return;
    };
    let started_at = now_ms();
    crate::commands::signaling::stop_listening(app);
    let stop = background::stoppable();
    let report = sync.finish(budget, stop.notified()).await;
    background::release(&stop);

    let Some(report) = report else {
        return;
    };
    let state = app.state::<AppState>();
    let db = state.db.lock();
    let pairs = state
        .signaling_manager
        .public_identity()
        .and_then(|me| crate::pairing::load_pairs(&db, &me.user_id).ok())
        .unwrap_or_default();
    if let Err(e) = background::record(&db, Trigger::Leaving, started_at, &report, &pairs) {
        warn_log!("[sync] {e}");
    }
}

/// Ask the platform to run background syncs, or to stop: only while the
/// setting is on and some device is paired (ADR 0034, decision 4).
pub fn reschedule(app: &AppHandle) {
    let paired = {
        let state = app.state::<AppState>();
        let db = state.db.lock();
        state
            .signaling_manager
            .public_identity()
            .and_then(|me| crate::pairing::load_pairs(&db, &me.user_id).ok())
            .is_some_and(|pairs| pairs.iter().any(|p| !p.disconnected))
    };
    let enabled = paired && read_flag(app, ENABLED_KEY, true);
    let mobile_data = read_flag(app, MOBILE_DATA_KEY, false);
    if let Some(plugin) =
        app.try_state::<tauri_plugin_background_sync::BackgroundSync<tauri::Wry>>()
    {
        plugin.schedule(enabled, mobile_data);
    }
}

fn millis(ms: i64) -> Duration {
    Duration::from_millis(ms.max(0) as u64)
}

/// A panic must not unwind into the platform's code, which is undefined
/// behaviour across the boundary.
fn guarded<T>(fallback: T, work: impl FnOnce() -> T + std::panic::UnwindSafe) -> T {
    std::panic::catch_unwind(work).unwrap_or_else(|_| {
        warn_log!("[sync] a background entry point panicked");
        fallback
    })
}

/// What Android's side calls: `com.ajiyakin.oyot.backgroundsync.Native`.
#[cfg(target_os = "android")]
mod android {
    use super::{guarded, millis};
    use crate::sync::background::{self, Options, Trigger};
    use jni::objects::{JClass, JString};
    use jni::sys::{jboolean, jlong, jstring, JNI_TRUE};
    use jni::JNIEnv;
    use std::path::Path;

    /// One WorkManager run. Returns its record as JSON, for the job's log.
    #[no_mangle]
    pub extern "system" fn Java_com_ajiyakin_oyot_backgroundsync_Native_runSync(
        mut env: JNIEnv,
        _class: JClass,
        data_dir: JString,
        budget_ms: jlong,
        images: jboolean,
        browse_ms: jlong,
    ) -> jstring {
        let data_dir: String = match env.get_string(&data_dir) {
            Ok(dir) => dir.into(),
            Err(_) => return std::ptr::null_mut(),
        };
        let result = guarded(String::new(), move || {
            background::run_blocking(
                Path::new(&data_dir),
                Options {
                    trigger: Trigger::WorkManager,
                    budget: millis(budget_ms),
                    images: images == JNI_TRUE,
                    browse: millis(browse_ms),
                },
            )
        });
        env.new_string(result)
            .map(|s| s.into_raw())
            .unwrap_or(std::ptr::null_mut())
    }

    #[no_mangle]
    pub extern "system" fn Java_com_ajiyakin_oyot_backgroundsync_Native_stopSync(
        _env: JNIEnv,
        _class: JClass,
    ) {
        guarded((), background::stop);
    }

    #[no_mangle]
    pub extern "system" fn Java_com_ajiyakin_oyot_backgroundsync_Native_onForeground(
        _env: JNIEnv,
        _class: JClass,
    ) {
        guarded((), super::on_foreground);
    }

    #[no_mangle]
    pub extern "system" fn Java_com_ajiyakin_oyot_backgroundsync_Native_onBackground(
        _env: JNIEnv,
        _class: JClass,
        budget_ms: jlong,
    ) {
        guarded((), move || super::on_background(millis(budget_ms)));
    }
}

/// What iOS's side calls, from `BackgroundSyncPlugin.swift`.
#[cfg(target_os = "ios")]
mod ios {
    use super::{guarded, millis};
    use crate::sync::background::{self, Options, Trigger};
    use std::ffi::{c_char, CStr, CString};
    use std::path::Path;
    use std::time::Duration;

    /// One background task's run. Returns its record as JSON, which the
    /// caller hands back to `oyot_string_free`.
    ///
    /// # Safety
    ///
    /// `data_dir` and `trigger` are NUL-terminated strings, valid for the
    /// length of the call.
    #[no_mangle]
    pub unsafe extern "C" fn oyot_background_run(
        data_dir: *const c_char,
        trigger: *const c_char,
        budget_ms: u64,
        images: bool,
    ) -> *mut c_char {
        if data_dir.is_null() || trigger.is_null() {
            return std::ptr::null_mut();
        }
        let data_dir = CStr::from_ptr(data_dir).to_string_lossy().into_owned();
        let trigger = CStr::from_ptr(trigger).to_string_lossy().into_owned();
        let Some(trigger) = Trigger::from_name(&trigger) else {
            return std::ptr::null_mut();
        };
        let result = guarded(String::new(), move || {
            background::run_blocking(
                Path::new(&data_dir),
                Options {
                    trigger,
                    budget: millis(budget_ms.min(i64::MAX as u64) as i64),
                    images,
                    // No mDNS on iOS until the NWBrowser backend exists.
                    browse: Duration::ZERO,
                },
            )
        });
        CString::new(result)
            .map(CString::into_raw)
            .unwrap_or(std::ptr::null_mut())
    }

    /// # Safety
    ///
    /// `s` came from `oyot_background_run`, and is freed once.
    #[no_mangle]
    pub unsafe extern "C" fn oyot_string_free(s: *mut c_char) {
        if !s.is_null() {
            drop(CString::from_raw(s));
        }
    }

    #[no_mangle]
    pub extern "C" fn oyot_background_stop() {
        guarded((), background::stop);
    }

    #[no_mangle]
    pub extern "C" fn oyot_app_foreground() {
        guarded((), super::on_foreground);
    }

    /// On the main thread, as the app leaves the screen.
    #[no_mangle]
    pub extern "C" fn oyot_app_leaving() {
        guarded((), super::left_screen);
    }

    /// Off the main thread, inside the background time asked for: returns
    /// once a sync in progress has finished and the engine is idle.
    #[no_mangle]
    pub extern "C" fn oyot_app_finish_leaving(budget_ms: u64) {
        guarded((), move || {
            super::finish_leaving(millis(budget_ms.min(i64::MAX as u64) as i64))
        });
    }
}

//! Keeping a hidden Oyot out of App Nap (ADR 0030, decision 8).
//!
//! macOS naps an app that has no visible window, which slows its timers and
//! network, the Rust side's included. An `NSProcessInfo` activity tells the
//! system the app is still doing something the user asked for. It is held
//! while the window is hidden and given back when it is shown again. The
//! machine can still go to sleep: this only stops the app being napped while
//! the machine is awake.
//!
//! Elsewhere there is no App Nap, and both calls do nothing.

#[cfg(target_os = "macos")]
mod imp {
    use objc2::rc::Retained;
    use objc2::runtime::{NSObjectProtocol, ProtocolObject};
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
    use parking_lot::Mutex;

    /// The token `beginActivityWithOptions:reason:` hands back, which has to be
    /// handed back to `endActivity:` to end it.
    struct Activity(Retained<ProtocolObject<dyn NSObjectProtocol>>);

    // SAFETY: the token is an opaque object that NSProcessInfo hands out and
    // takes back from any thread; nothing here reads or changes it, it is only
    // kept until it is returned.
    unsafe impl Send for Activity {}

    static ACTIVITY: Mutex<Option<Activity>> = Mutex::new(None);

    pub fn begin() {
        let mut held = ACTIVITY.lock();
        if held.is_some() {
            return;
        }
        let reason = NSString::from_str("Oyot keeps syncing while its window is closed");
        let token = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
            NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
            &reason,
        );
        *held = Some(Activity(token));
    }

    pub fn end() {
        if let Some(Activity(token)) = ACTIVITY.lock().take() {
            // SAFETY: `token` is the object `beginActivityWithOptions:reason:`
            // returned, which is the type `endActivity:` expects.
            unsafe { NSProcessInfo::processInfo().endActivity(&token) };
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn begin() {}
    pub fn end() {}
}

pub use imp::{begin, end};

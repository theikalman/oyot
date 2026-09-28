package com.ajiyakin.oyot.backgroundsync

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class ScheduleArgs {
    var enabled: Boolean = false
    var mobileData: Boolean = false
}

/**
 * Background sync on Android (ADR 0034): the WorkManager job's schedule,
 * which Rust sets, and the app coming on screen and leaving it, which Rust
 * is told.
 */
@TauriPlugin
class BackgroundSyncPlugin(private val activity: Activity) : Plugin(activity) {

    override fun load(webView: WebView) {
        AppOnScreen.watch()
    }

    @Command
    fun schedule(invoke: Invoke) {
        val args = invoke.parseArgs(ScheduleArgs::class.java)
        SyncWorker.schedule(activity.applicationContext, args.enabled, args.mobileData)
        invoke.resolve()
    }
}

/**
 * Whether the app is on screen, for the whole process, as
 * `ProcessLifecycleOwner` has it: started while any activity is, stopped a
 * moment after the last one stops. Not an activity's own pause and resume,
 * which a permission dialog or the notification shade also cause.
 */
object AppOnScreen : DefaultLifecycleObserver {
    /**
     * How long a sync in progress gets to finish once the app leaves the
     * screen. Android freezes an app about ten seconds after that, with
     * nothing to ask for more.
     */
    private const val LEAVING_BUDGET_MS = 5_000L

    private var watching = false

    /** Start following the screen. Once per process; on the main thread. */
    fun watch() {
        Handler(Looper.getMainLooper()).post {
            if (watching) return@post
            watching = true
            // Told of the state as it stands now, then of every change.
            ProcessLifecycleOwner.get().lifecycle.addObserver(this)
        }
    }

    fun isOnScreen(): Boolean =
        ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(
            androidx.lifecycle.Lifecycle.State.STARTED
        )

    // On the main thread, in order: Rust records which it is at once and
    // does the rest on its own threads, so a quick leave and return cannot
    // be recorded the other way round.
    override fun onStart(owner: LifecycleOwner) {
        Native.onForeground()
    }

    override fun onStop(owner: LifecycleOwner) {
        Native.onBackground(LEAVING_BUDGET_MS)
    }
}

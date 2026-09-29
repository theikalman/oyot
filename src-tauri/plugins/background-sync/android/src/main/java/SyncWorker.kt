package com.ajiyakin.oyot.backgroundsync

import android.content.Context
import android.net.ConnectivityManager
import android.net.wifi.WifiManager
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * The periodic background run (ADR 0034, decision 5): dial out to a device
 * that is awake, sync, and stop.
 *
 * A plain `Worker` rather than a `CoroutineWorker`: the run is one blocking
 * call into Rust, and stopping it early needs `onStopped`, which a
 * `CoroutineWorker` does not let a subclass override.
 */
class SyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        // On screen, the app syncs for itself, and a second engine would
        // only dial the same devices again. The process can outlive the
        // screen by hours, so this asks about the screen, not the process.
        if (AppOnScreen.isOnScreen()) return Result.success()

        val context = applicationContext
        val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        // Images only ever move over an unmetered network (decision 4).
        val images = !connectivity.isActiveNetworkMetered

        // mDNS can be heard only while something holds this, and a
        // background run holds it for its few seconds of listening only.
        val lock = try {
            val wifi = context.getSystemService(Context.WIFI_SERVICE) as WifiManager
            wifi.createMulticastLock(MULTICAST_LOCK_TAG).apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (e: Exception) {
            Log.w(TAG, "no multicast lock, the run will not hear mDNS", e)
            null
        }
        try {
            val record = Native.runSync(
                context.dataDir.absolutePath, BUDGET_MS, images, BROWSE_MS
            )
            Log.i(TAG, "background sync: $record")
        } finally {
            try {
                if (lock?.isHeld == true) lock.release()
            } catch (e: Exception) {
                Log.w(TAG, "could not release the multicast lock", e)
            }
        }
        return Result.success()
    }

    // The system took its time back. What the run finished stands.
    override fun onStopped() {
        Native.stopSync()
    }

    companion object {
        private const val TAG = "OyotSync"
        private const val WORK_NAME = "oyot-background-sync"
        private const val MULTICAST_LOCK_TAG = "oyot-mdns-background"

        /** Half of the ten minutes WorkManager allows a job. */
        private const val BUDGET_MS = 5 * 60_000L

        /** How long a run listens for mDNS. */
        private const val BROWSE_MS = 4_000L

        /**
         * Run every 30 minutes or so, as WorkManager sees fit, or stop.
         *
         * Enqueued so as to update a job that exists rather than replace
         * it: opening the app does not reset its clock, and a changed
         * setting changes its constraints in place.
         */
        fun schedule(context: Context, enabled: Boolean, mobileData: Boolean) {
            val work = WorkManager.getInstance(context)
            if (!enabled) {
                work.cancelUniqueWork(WORK_NAME)
                return
            }
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(
                    if (mobileData) NetworkType.CONNECTED else NetworkType.UNMETERED
                )
                .setRequiresBatteryNotLow(true)
                .build()
            val request = PeriodicWorkRequestBuilder<SyncWorker>(30, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build()
            work.enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.UPDATE, request)
        }
    }
}

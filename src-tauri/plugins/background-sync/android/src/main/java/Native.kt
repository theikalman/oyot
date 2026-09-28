package com.ajiyakin.oyot.backgroundsync

/**
 * The app's Rust library, called directly (`src-tauri/src/mobile.rs`). A
 * background run starts in a process that may never have shown an
 * activity, so there is no Tauri app to call through.
 */
object Native {
    init {
        // The app's own library; a no-op when the activity loaded it already.
        System.loadLibrary("oyot_lib")
    }

    /**
     * One background run. Blocks until it ends, and returns its record as
     * JSON, for the log.
     */
    @JvmStatic
    external fun runSync(dataDir: String, budgetMs: Long, images: Boolean, browseMs: Long): String?

    /** End the run in progress early. */
    @JvmStatic
    external fun stopSync()

    /** The app came on screen. Returns at once. */
    @JvmStatic
    external fun onForeground()

    /** The app left the screen. Returns at once. */
    @JvmStatic
    external fun onBackground(budgetMs: Long)
}

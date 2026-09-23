package com.ajiyakin.oyot

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Bundle
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  // Held while the app is on screen so mDNS discovery can hear anything.
  //
  // Android's wifi chip filters multicast packets out before they reach the
  // app, to save power, unless something holds this lock. Sending is
  // unaffected, so without it this device still announces itself and is heard
  // by anything already browsing, and can still be connected to. What it
  // cannot do is hear anyone else, including the queries a device asks when it
  // starts browsing later, so from the inside the network looks empty and from
  // the outside this device appears only if it happened to be announcing while
  // someone was listening.
  private var multicastLock: WifiManager.MulticastLock? = null

  // The system bars and cutout, in CSS pixels, as JSON for the page. Written
  // on the main thread and read from the WebView's JavaScript bridge thread.
  @Volatile private var safeAreaJson = "{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0}"

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  // Edge to edge, the WebView is drawn under the status bar and the gesture
  // bar, and the page has to leave room for them itself. iOS tells the page how
  // much through env(safe-area-inset-*), but Android's WebView reports zero
  // there on all but its newest versions, which put a note's title under the
  // clock. So the insets are measured here and handed to the page, which
  // prefers them over env() (see app.html and app.css).
  override fun onWebViewCreate(webView: WebView) {
    // Pulled by the page as it starts, so the first paint is already clear of
    // the bars: anything pushed before the page exists is lost.
    webView.addJavascriptInterface(SafeAreaBridge(), "OyotInsets")

    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val density = view.resources.displayMetrics.density
      val json = "{\"top\":${bars.top / density},\"right\":${bars.right / density}," +
        "\"bottom\":${bars.bottom / density},\"left\":${bars.left / density}}"
      if (json != safeAreaJson) {
        safeAreaJson = json
        // Pushed for changes after load, rotation and the like. Harmless if
        // the page is not there yet: it pulls the current value when it is.
        webView.evaluateJavascript("window.__oyotApplyInsets && window.__oyotApplyInsets($json)", null)
      }
      // Not consumed, so a WebView that does support env() still sees them.
      insets
    }
    ViewCompat.requestApplyInsets(webView)
  }

  private inner class SafeAreaBridge {
    @JavascriptInterface
    fun get(): String = safeAreaJson
  }

  // onStart/onStop rather than onCreate/onDestroy: the lock costs battery for
  // as long as it is held, onDestroy may not arrive for a long time after the
  // user has moved on, and a note app syncs when someone opens it. Coming back
  // to the foreground re-takes it, and discovery finds the network again on
  // its own timer.
  override fun onStart() {
    super.onStart()
    acquireMulticastLock()
  }

  override fun onStop() {
    releaseMulticastLock()
    super.onStop()
  }

  private fun acquireMulticastLock() {
    if (multicastLock != null) return
    try {
      // The application context, not this activity: WifiManager outlives an
      // activity and holding one here is a documented way to leak it.
      val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
      val lock = wifi.createMulticastLock(MULTICAST_LOCK_TAG)
      // Not reference counted: with a counter, every acquire needs its own
      // release, and one unbalanced pair leaves the lock held for the life of
      // the process. Off, a single release always releases.
      lock.setReferenceCounted(false)
      lock.acquire()
      multicastLock = lock
      Log.d(TAG, "multicast lock acquired, local network discovery can receive")
    } catch (e: Exception) {
      // Not fatal, and deliberately not surfaced. This device goes on
      // advertising and still accepts connections, so a peer that finds it can
      // still reach it; what it loses is hearing the peers that advertise
      // first. A device that cannot take this lock cannot be told anything
      // useful about it either.
      Log.w(TAG, "could not take the multicast lock, local discovery will not hear peers", e)
    }
  }

  private fun releaseMulticastLock() {
    val lock = multicastLock ?: return
    multicastLock = null
    try {
      if (lock.isHeld) lock.release()
    } catch (e: Exception) {
      Log.w(TAG, "could not release the multicast lock", e)
    }
  }

  companion object {
    private const val TAG = "Oyot"
    private const val MULTICAST_LOCK_TAG = "oyot-mdns"
  }
}

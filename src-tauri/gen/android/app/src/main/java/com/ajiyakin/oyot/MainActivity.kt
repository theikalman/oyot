package com.ajiyakin.oyot

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Bundle
import android.util.Log
import androidx.activity.enableEdgeToEdge

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

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
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

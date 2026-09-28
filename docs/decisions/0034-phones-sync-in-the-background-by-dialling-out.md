# 0034: Phones sync in the background by dialling out on a schedule

- **Status:** Proposed
- **Date:** 2026-09-28
- **Extends:** [0023](0023-reach-a-peer-at-an-address-you-already-know.md),
  [0026](0026-scheduled-backups-run-while-the-app-is-open.md) (the WorkManager
  and BGTaskScheduler alternative it deferred),
  [0031](0031-move-the-sync-engine-into-rust.md),
  [0032](0032-sync-over-one-tls-connection-per-device-pair.md)

## Context

A phone that is not on screen cannot be reached:

- **Android.** An app is frozen about ten seconds after it drops to the
  background with nothing running (Android 14 and later), and its sockets are
  closed. Recent versions ignore its multicast lock meanwhile, and Android 16
  also cuts off its network within seconds.
- **iOS.** An app is suspended within seconds of leaving the screen, and a
  suspended app's listening socket is not served.

Neither lets another device wake the app without a push service. That needs a
server, and ADR 0022 removed the last one.

What both allow is running for a while, at times the system chooses:

- **Android** runs WorkManager jobs, no more often than every 15 minutes, for
  up to 10 minutes each, with network and battery constraints. How often a job
  really runs depends on how much the app is used. One opened every day gets
  plenty; one untouched for a week gets about ten minutes a day.
- **iOS** offers app refresh, about 30 seconds at times it picks from how the
  app is used, and on some days never. It also offers processing tasks, which
  run for minutes, usually overnight while charging. And an app that is
  leaving the screen gets about 30 seconds to finish what it was doing. After
  a force quit, iOS runs nothing until the app is opened again.

So a phone can only sync in the background by dialling out, briefly, to a
device that is awake. ADR 0031 gives it an engine that runs without a page,
and ADR 0032 a connection that only the dialling side needs a route for. In
practice, the awake device is a desktop kept running by ADR 0030.

## Decision

**1. A background run dials out, syncs, and stops.** It is the Rust core's
dial-out mode (ADR 0031, decision 1), with a time budget. It dials each paired
device it has a route to (decision 3), and runs the manifest and delta
exchange with each until both sides have finished pulling (see ADR 0031,
decision 2), or until time runs out. Then it reports what it did.

A run never listens and never advertises. On a phone the core is in its
foreground mode only while the app is on screen, since nothing could reach a
phone in the background anyway. The core reads whether the app is on screen
from the platform when it starts, because on iOS a background launch runs the
app's `setup()` too. After that it follows the platform's own life cycle:

- **Android:** the process moving to and from the foreground, as
  `ProcessLifecycleOwner` reports it.
- **iOS:** the app entering and leaving the background.

Tauri's `Suspended` and `Resumed` events are not used for this. They fire on
`onPause` and on resigning active, which also happen when a permission dialog
or Control Center covers the app for a moment.

**2. Notes come first, then images, and a run can stop at any point.**
Document messages go ahead of image pieces (ADR 0032, decision 7). A run that
stops early has merged some documents completely and not started others;
every merge is one write, so nothing is left half-applied. The next run, or
the next time the app opens, finishes the rest, as reconciliation on every
connection always has.

**3. Background routes are addresses, not discovery.** A run tries, in order:

- the addresses the user typed for a device (ADR 0023)
- the address each device was last found at on this network

That second address is new: whenever mDNS finds a paired device, its address
is remembered in a row of its own, a schema change. On Android, a run also
browses mDNS for a few seconds, under a multicast lock it holds for that run
only. iOS cannot, until the `NWBrowser` backend exists (ADR 0018, decision 8).

**4. On by default once a device is paired, every 30 minutes, on Wi-Fi only.**
Nothing is scheduled while no device is paired. Settings has two switches:

- "Sync in the background", on
- "Also on mobile data", off

Images only move over Wi-Fi, even when mobile data is allowed: notes are
small, photos are not. On mobile data a run neither fetches images nor offers
its own, so the desktop does not pull the phone's photos over it either.

The 30 minutes is a request, and each system decides when a run actually
happens. The settings page says so, in plain words, for each platform.

**5. Android: a periodic WorkManager job.**

- **The job.** A unique periodic `CoroutineWorker`, requested every 30
  minutes. It needs an unmetered network (any network, when mobile data is
  allowed) and a battery that is not low. It is enqueued so as to keep an
  existing job, so opening the app does not reset its clock, and a change to
  either setting updates the job's constraints in place.
- **What it runs.** It loads `oyot_lib` and calls a JNI function (`jni` is
  already in the tree) with the app's data directory and a budget of five
  minutes, half of what WorkManager allows. Tauri is not started, since it
  only starts from the Activity.
- **When the app is on screen.** The core is already syncing in its
  foreground mode, and the job returns at once. The job checks whether the app
  is on screen, not whether the core exists: after an earlier visit, the
  process and its core can outlive the screen by hours.
- **No foreground service.** It would need a permanent notification, a Play
  Console declaration and review, and data-sync services are cut off after six
  hours a day on Android 15 and later.

**6. iOS: app refresh, a processing task, and finishing on the way out.**

- **The plugin.** An in-repo plugin, `plugins/background-sync`, shaped like
  `plugins/sign-in`. Its Swift side registers two tasks when the plugin is
  created, before the app finishes launching. It does not wait for `load`:
  under the scene life cycle, which Apple makes mandatory after iOS 26, `load`
  runs only when the first scene connects, which is too late.
- **The tasks.** `com.ajiyakin.oyot.sync.refresh` is a `BGAppRefreshTask`
  with a budget of 25 seconds. `com.ajiyakin.oyot.sync.catch-up` is a
  `BGProcessingTask` that requires a network, for images and anything the
  short runs did not finish. Both are rescheduled after every run, and
  whenever the app leaves the screen.
- **Finishing on the way out.** When the app leaves the screen with a sync in
  progress, it asks for background time (`beginBackgroundTask`) and lets that
  sync run for up to 25 seconds.
- **Info.plist.** It gains `UIBackgroundModes` (`fetch`, `processing`),
  `BGTaskSchedulerPermittedIdentifiers`, `NSLocalNetworkUsageDescription` and
  `NSBonjourServices`.
- **Local network permission.** It is asked for in the foreground, when the
  user pairs. In the background, a permission nobody has answered yet is
  refused without asking.
- **Expiry.** When a task's time runs out, the handler cancels the run, and
  what it finished stands (decision 2).

**7. Every run is recorded.** A `sync_runs` table records:

- what started the run: the app, WorkManager, app refresh, a processing task,
  or finishing on the way out
- when it started and ended
- which devices it reached
- how many documents and images moved each way
- how it ended

The sync settings show the last background sync, and which device it was
with. Without this record, "background sync is broken" and "the system has
not run us today" look identical. The table keeps its newest 200 rows.

**8. Not in this change.** Each of these fits on top of it later:

- an Android foreground service for always-on sync (decision 5)
- push to wake, which needs a server
- a "Sync now" the user starts that outlives the app: Android's user-initiated
  data transfer jobs, and iOS 26's continued processing tasks
- running scheduled backups (ADR 0026) from background runs

## Alternatives considered

**An always-on foreground service on Android.** It is the only way a phone
stays reachable, at the price of a permanent notification, Play review, and a
six-hour daily cap for data sync. iOS has nothing like it, so it would be an
Android-only behaviour to explain.

**Push to wake, through FCM and APNs.** It needs a server holding both
services' credentials, and ADR 0022 removed the last server. iOS limits
background pushes to a few an hour anyway.

**Listening while in the background.** Neither system allows it: Android
freezes the process and iOS suspends it.

**Browsing mDNS on iOS through a raw multicast socket.** It needs Apple's
multicast entitlement (ADR 0018). `NWBrowser` is the right route, and a piece
of work of its own.

## Consequences

- Background sync on a phone is minutes to hours late, and on iOS it may not
  happen at all on a given day. Opening the app still syncs straight away.
- It only works against a device that is awake. Two phones, both in pockets,
  do not sync with each other; each syncs with the desktop. A headless
  always-on device (ADR 0031) would serve just as well.
- An app the user force-quit (iOS) or force-stopped (Android) does nothing in
  the background until it is opened again.
- A run that finds nothing changed costs a connection and a manifest per
  device. The Wi-Fi default keeps even that off mobile data.
- Testing needs real devices. iOS background tasks can only be started on a
  device, through a debugger command. Android's scheduler, idle mode and
  standby buckets can be forced with `adb`. Nothing on the development Mac can
  run a phone build today.
- targetSdk 37 will require the `ACCESS_LOCAL_NETWORK` permission for any
  local network connection, background or not. It is asked for when pairing,
  like the Local Network prompt on iOS.
- App Store review will ask why the app needs background modes. The answer is
  this ADR's first paragraph.
- Before building, a spike confirms three things:
  - a WorkManager job can call into the Rust core with no Activity running
  - an iOS background task can do the same, with and without the scene life
    cycle
  - registering the tasks when the plugin is created is early enough for
    iOS to accept them

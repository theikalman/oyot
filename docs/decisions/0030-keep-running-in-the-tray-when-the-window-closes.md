# 0030: Keep Oyot running in the tray when its window is closed

- **Status:** Accepted
- **Date:** 2026-09-28
- **Extends:** [0026](0026-scheduled-backups-run-while-the-app-is-open.md)

## Context

A desktop is the device most likely to be switched on, and it is the device a
phone will need to reach once phones sync in the background
([ADR 0034](0034-phones-sync-in-the-background-by-dialling-out.md)). Today a
desktop stops syncing the moment its window closes, because closing the last
window quits the app, and nothing starts it again at login.

Keeping the process alive is not enough on its own, because of where sync
runs. Until [ADR 0031](0031-move-the-sync-engine-into-rust.md) moves it, the
engine is in the webview, and each desktop engine treats a hidden page
differently:

- **Windows.** WebView2 keeps a hidden page running at full speed, but only
  because Tauri never tells it the window is hidden (tauri-apps/tauri#10592).
  That is a quirk of the current Tauri, not a behaviour anyone promised.
- **Linux.** WebKitGTK slows a hidden page's timers to once a second and
  suspends nothing. Separately, WebKitGTK ships with WebRTC turned off, and
  nothing in wry, Tauri or this repo turns it on, so Linux may not sync at all
  today. That has not been checked on a Linux machine yet.
- **macOS.** WebKit suspends the web process of a page nobody can see (one
  report has a hidden Tauri window stopping after about 13 minutes), and App
  Nap slows the Rust side as well. Tauri's `backgroundThrottling` setting
  avoids the suspension only on macOS 14 and later, and this app supports
  10.13.

There is also a trap in how closing works now. `Editor.svelte` listens for the
window's close request so it can flush a pending save. When a page listens for
that event, Tauri cancels the native close and leaves the decision to the
page, and the JavaScript API destroys the window once the listener returns,
unless the listener calls `preventDefault()`. So while a note is open, a Rust
handler that only hid the window would still see it destroyed, and the sync
engine with it.

## Decision

**1. Closing the main window hides it, and Oyot keeps running.** On by
default, as "Keep Oyot running when the window is closed" in settings. With it
off, closing quits, as it does today.

**2. The first close explains itself.** The first time the window is closed
with the setting on, the page says that Oyot keeps syncing in the background
and how to quit it, with "Keep running" (the default button) and "Quit
instead". "Quit instead" quits and turns the setting off. Either way the
question is not asked again, and the setting is where it can be changed.

**3. A tray icon, with a menu.** The menu has Open Oyot, a line saying when
the last sync finished, and Quit Oyot. The menu is required rather than a
nicety: on Linux a tray icon receives no clicks, and some hosts show no icon at
all without one. On macOS the icon sits in the menu bar and the Dock icon
stays; clicking the Dock icon brings the window back (`RunEvent::Reopen`).

**4. Quitting is explicit, and always works.** Quit Oyot in the tray, Quit in
the app menu, Cmd-Q, and logging out or shutting down all exit. Nothing
prevents an explicit exit.

**5. Closing goes through the page, then Rust.** One close listener, in the
layout, which is mounted for the app's lifetime, takes every close request. It
flushes the editor's pending save, shows the notice when it is due, calls
`preventDefault()`, and tells Rust to go on; Rust hides the window or quits,
according to the setting. The `preventDefault()` is not optional, for the
reason in the context above. The editor's own close listener goes, since the
layout's covers it.

The page acknowledges a close request as soon as it arrives. If no
acknowledgement comes within a few seconds, Rust goes ahead without the page,
so a hung page cannot make the window impossible to close. The wait covers
only that acknowledgement, not the time someone spends reading the notice.

**6. One copy of Oyot runs at a time.** `tauri-plugin-single-instance`,
registered before every other plugin. A second launch shows and focuses the
running copy instead. Two copies would each run their own sync against one
database, and the second would lose port 19701 to the first and fall back to a
port that no stored address points at. Launching Oyot again is also the
way back to a hidden window on a Linux desktop that shows no tray icons.

**7. Starting at login is opt-in.** "Start Oyot when you log in", off by
default, through `tauri-plugin-autostart`: a LaunchAgent on macOS, the
per-user Run key on Windows, an autostart entry on Linux. A login start passes
`--hidden` and stays in the tray. The main window is created hidden and
`setup()` shows it unless that flag is present, so a login start never
flashes a window.

**8. On macOS, a hidden Oyot opts out of App Nap.** While the window is hidden
and the setting is on, Oyot holds an `NSProcessInfo` activity
(`NSActivityUserInitiatedAllowingIdleSystemSleep`) through `objc2-foundation`,
which is already in the tree. The machine can still sleep. The main window
also sets `backgroundThrottling` to `disabled`, which keeps the webview's sync
going on macOS 14 and later until ADR 0031 makes that unnecessary.

**9. Waking up and changing networks start a reconnect.** Tauri reports
neither on desktop, and a WebRTC connection that went quiet for 30 seconds is
gone by the time the machine wakes. A Rust task looks every ten seconds and
notices both: sleep, as the wall clock jumping further between two of its
ticks than the tick itself, and network changes, as this machine's interface
addresses changing. `if-addrs` lists those, and is already in the tree through
mdns-sd, where `if-watch` would have been a new dependency with a different
backend on each OS. The task probes the stored addresses at once and tells the
page to run its reconnect sweep. Once ADR 0031 moves the engine into Rust, it
tells the engine instead.

**10. The plugins match the Tauri in the tree.** autostart 2.5.1 and
single-instance 2.4.5 are the last releases that work with Tauri 2.11; the
current ones need 2.12. Moving to Tauri 2.12 is a change of its own.

**11. Scheduled backups come along.** ADR 0026 runs backups while the app is
open. With this, that means while it runs, window or not, and the backup page
says "while Oyot is running".

## Alternatives considered

**Minimise instead of hide.** It leaves a taskbar or Dock entry the user did
not ask for, and WebKit treats a minimised window as just as hidden as a
closed one, so it buys nothing on macOS.

**Quit on close, and sync from an OS service** (a launchd agent, a Windows
service, a systemd user unit) running a headless Oyot. The better end state
for a machine that is always on, and ADR 0031 makes a headless build possible.
Rejected for now: it needs install and uninstall steps on each OS, and the
engine does not run without the webview yet.

**Keep the webview awake with a trick,** such as playing silent audio, which
WebKit exempts from suspension. Rejected: a hack that costs battery and can
put a media indicator on screen, for a problem ADR 0031 fixes properly.

**Start at login by default.** Rejected: an app that adds itself to login
items unasked is the kind of app people uninstall.

**Turn WebRTC on in WebKitGTK for Linux.** It only works where the
distribution built WebKitGTK with WebRTC, which not all do. ADR 0032 removes
WebRTC from sync instead.

## Consequences

- People who expect closing to quit will be surprised once. Decision 2 is for
  them, and the setting turns it off.
- A hidden Oyot keeps its webview in memory. Once ADR 0031 moves sync out of
  the page, closing could destroy the window and free that memory instead of
  hiding it; that is left for later.
- Until ADR 0031 lands, how well a hidden Oyot syncs depends on the platform:
  on Windows it rests on a Tauri quirk, on macOS 14 and later on
  `backgroundThrottling` (whose author still saw timers slowed to about two
  seconds), macOS 10.13 to 13 is suspended after a while, and Linux depends on
  whether WebRTC works there at all.
- GNOME shows no tray icons without the AppIndicator extension. There, a
  hidden Oyot comes back by launching it again (decision 6).
- Linux packages have to declare `libayatana-appindicator3`, which the tray
  needs at run time.
- A sandboxed build (Mac App Store, MSIX, Flatpak) would need a different
  login mechanism than the plugin's. None is shipped today.
- Before building: pair a Linux machine to find out whether it syncs today,
  since that decides what this change can promise there.

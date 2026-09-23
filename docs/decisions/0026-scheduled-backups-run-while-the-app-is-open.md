# 0026: Scheduled backups run in Rust while the app is open, and every attempt is recorded

- **Status:** Proposed
- **Date:** 2026-09-23
- **Extends:** [0024](0024-back-up-the-crdt-and-import-by-merging.md), [0025](0025-remote-backups-behind-one-trait-google-drive-first.md)

## Context

A backup the user has to remember to make is usually weeks old by the time it
is needed. Backups have to run on a schedule as well as on demand, and the app
has to show when the last one was made.

Three things constrain it. Building a backup needs nothing from the webview
(ADR 0024, decision 3). The app only runs while it is open: there is no
background service, and Android and iOS suspend an app that is not in front.
And a scheduled backup has to reach its destination without asking the user
anything, which rules out a save dialog.

## Decision

**1. Manual and scheduled backups are one operation.**
`run_backup(destination, trigger)` builds, delivers and records a backup, with
`trigger` either `manual` or `scheduled`. Only one runs at a time. Asking for
another while one is running says so rather than queueing it.

**2. The scheduler is a Rust task that checks the clock, not a timer.** Every
five minutes it asks a pure function,
`next_run(now, schedule, last_success, recent_failures)`, whether a backup is
due, and runs one if it is. Checking instead of sleeping until a target time is
what makes a laptop that slept through 02:00 back up when it wakes, and what
makes a device whose clock or time zone changed follow the new one. A backup
that fell due while the app was closed runs about two minutes after the next
launch, once startup has settled.

**3. The options.**

- **Frequency:** Off, Daily or Weekly, at a time of day, plus a weekday for
  Weekly. Off is the default.
- **Destination:** a linked provider (ADR 0025) or a remembered folder
  (decision 6).
- **Skip if nothing changed:** on by default. A fingerprint over everything a
  backup would carry except the moment it was taken - every document row with
  its stamps and content hash, the set of images, the preferences - is
  compared with the last successful backup's, and an unchanged library is
  recorded as skipped instead of being backed up again. It is computed from
  the database alone, without reading a document.
- **Keep:** the newest N scheduled backups, 10 by default (decision 5).

When a destination is set up and the schedule is still Off, the page suggests
turning it on, once.

**4. Every attempt is a row.** The schema gains `backup_history`, which manual
backups use from the start, and `backup_schedule` when scheduling arrives. A
history row records the trigger, the destination and a label for it, when it
started and finished, a status (running, success, failed or skipped), the
error, the size, the counts, the fingerprint, and the remote file id or local
file name. A row still marked running at startup belonged to a process that
died mid-backup, and is marked failed.

The settings page shows the last successful backup (when, where, how many notes
and images), the next scheduled run, and the last failure if it is more recent
than the last success. A `backup-status-changed` event keeps it current while
it is open. Three scheduled failures in a row also raise a toast when the app
opens, because a failing schedule that only shows on a settings page will not
be noticed.

**5. Old scheduled backups are pruned. Manual ones never are.** After a
successful scheduled backup, this device's scheduled backups at that
destination beyond the newest N are deleted. N is 10 by default and adjustable
in settings. The only candidates are files that `backup_history` records this
device as having written, so pruning can never touch a backup another device
made or a file the user put there. A file that is already gone is not an error.

**6. A remembered folder is desktop-only for now.** A schedule cannot open a
save dialog, so the user picks a folder once, in a folder dialog opened by
Rust, and Rust keeps the path. The webview only receives a label to display. On
Android and iOS a folder chosen once is only reusable through a persisted
storage-access grant or a security-scoped bookmark, and both need native code.
Until that exists, a schedule on a phone can only target a linked provider.

**7. Failures retry, but not forever.** A failed scheduled backup retries after
5 minutes, then 15, then hourly, but never past the next regular slot, which
starts the sequence over. Retries are rows too, grouped together in the history
list.

**8. A scheduled backup does not wait for the editor.** A manual backup is
started from settings, and leaving the editor to get there has already written
its pending save. A scheduled one can run while a note is open, and takes what
is already saved: the debounce window is a few seconds, and the next backup
picks it up.

## Alternatives considered

**The operating system's scheduler** (launchd, Task Scheduler, cron) starting
the app without a window. It needs a headless entry point and a job registered
separately on each desktop OS, with install and uninstall steps to match, and
it does nothing on phones.

**Android WorkManager and iOS `BGTaskScheduler`.** The right answer for phones,
and the only way a backup there runs without the app open. Both need native
plugins, and iOS grants background time at its own discretion. Deferred; the
settings page says scheduled backups run while Oyot is open.

**A timer in the webview.** Browsers throttle and suspend timers in hidden
pages, a reload would stop the scheduler, and the webview is not needed to make
a backup at all.

**Keep the schedule in `config.json`.** That file holds the theme and nothing
that has to agree with anything else. The schedule and the history are read
together to decide what is due, so they belong in one transaction.

## Consequences

- **Scheduled means "while Oyot is open".** On a desktop that is left running,
  that is close to a real schedule. On a phone, a missed backup runs soon after
  the app is next opened, and the settings page says so.
- **"Last backup" can be older than the last check.** With skip-if-unchanged,
  a library that has not changed is not backed up again. The page shows the
  last backup and, separately, that nothing has changed since.
- **Retention is per device.** Two devices backing up to the same Drive each
  keep their own newest N, and never prune each other's.
- **The history grows by one row per attempt.** A few a day at most. Rows older
  than a year can be dropped if it ever matters.

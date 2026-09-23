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

**1. Manual and scheduled backups are one operation.** `run_backup` builds,
delivers and records a backup, whichever started it; its history row says
whether that was the user or the schedule. Only one runs at a time, and
reading a backup in to restore it counts as one: a scheduled backup prunes, and
must not remove the backup being restored. Asking for another while one is
running says so rather than queueing it, and a scheduled backup that finds one
running waits for the next check.

**2. The scheduler is a Rust task that checks the clock, not a timer.** Every
five minutes it asks a pure function, `next_run(now, schedule, attempts)`,
whether a backup is due, and runs one if it is. `attempts` is when the newest
scheduled backup was done (made, or skipped as unchanged) and the scheduled
failures recorded since. Checking instead of sleeping until a target time is
what makes a laptop that slept through 02:00 back up when it wakes, and what
makes a device whose clock or time zone changed follow the new one. A backup
that fell due while the app was closed runs about two minutes after the next
launch, once startup has settled. However many slots were missed, one backup
is owed, not one for each.

"Newest" is the last recorded, not the latest stamped, and a stamp later than
now is not trusted: it was written while the clock was ahead, and trusting it
would hold every backup back until real time caught up. A slot the clocks skip
(a DST gap) runs at the first minute after it, and one they repeat runs once.

**3. The options.**

- **Frequency:** Off, Daily or Weekly, at a time of day (02:00 by default),
  plus a weekday for Weekly. Off is the default. Turning a schedule on, or
  moving its time, never makes a backup due at once: a slot before the change
  is not owed. Pointing it somewhere else does not reset it: a backup already
  owed stays owed, so fixing a broken schedule makes the missed backup run.
- **Destination:** a linked provider (ADR 0025) or a remembered folder
  (decision 6). A provider can only be chosen while an account is linked.
- **Skip if nothing changed:** on by default. A fingerprint over everything a
  backup would carry except the moment it was taken - every document row with
  its stamps and content hash, the set of images, the preferences - is
  compared with the newest backup to the same place: the same folder, or the
  same provider and account. An unchanged library is recorded as skipped
  instead of being backed up again. It is computed from the database alone,
  without reading a document. The skip relies on that backup, so it only
  happens when nothing was left out of it and it is still there at the size it
  was written: the file in the folder, or the id in the provider's list.
- **Keep:** the newest N scheduled backups, 10 by default (decision 5).

Once an account is linked and the schedule is still Off, the page suggests
turning it on, until it is turned on or dismissed.

**4. Every attempt is a row.** The schema gains `backup_history`, which manual
backups use from the start, and `backup_schedule` when scheduling arrives. A
history row records the trigger, the destination and a label for it, when it
started and finished, a status (running, success, failed or skipped), the
error, the size, the counts, the fingerprint, where the backup can be found
again (a remote file id or a path, cleared once it is removed), and its
target: the place it went, as a provider and account or the scheduled folder,
so backups to one place are compared and pruned together. A row still marked
running at startup belonged to a process that died mid-backup, and is marked
failed.

A schedule whose account has been unlinked, or revoked by the user at
Google, or whose provider this build does not have, is **paused**: it records
nothing, and the page says why. Relinking any account resumes it.

The settings page shows the last successful backup (when, where, how many notes
and images), the next scheduled run, the last failure if it is more recent
than the last success, and, when a scheduled check found nothing new, that
nothing has changed since. A `backup-status-changed` event keeps it current
while it is open. Three scheduled failures in a row, or a paused schedule,
also raise a toast once a session, wherever the user is, because a failing
schedule that only shows on a settings page will not be noticed. The count
only covers failures since the schedule's timing or destination last changed,
and a schedule that is off is never reported.

**5. Old scheduled backups are pruned. Manual ones never are.** After a
successful scheduled backup, this device's scheduled backups at that target
beyond the newest N are deleted. N is 10 by default and adjustable in
settings. The only candidates are files that `backup_history` records this
device as having written there, so pruning can never touch a backup another
device made or a file the user put there. In a folder, it also only ever
removes a file named as a backup, directly in the folder.

Only backups that are still there count toward N: before choosing, rows whose
file is gone from the folder, or whose id is gone from the provider's list,
are forgotten, so backups the user deleted do not push out the ones they
kept. Nothing is forgotten on a guess. If presence cannot be known - the
folder is out of reach, a file in it cannot be looked at, the list fails, or
another account was linked while the backup ran - nothing is pruned or
forgotten that run. The backup just made is never in doubt, since a listing
taken straight after an upload need not show it yet.

Pruning removes backups for good: from a provider, past its bin, where they
would go on using the user's storage for weeks. Three safeguards keep it from
removing too much. At most two backups go per run, so lowering N takes effect
over a few runs. When the backup just made holds fewer than half the notes of
the largest one, the largest is kept as well: a library that suddenly lost
most of its notes, to a bug or a slip, would otherwise have every backup from
before it pruned away after N more runs. And when the backup just made had to
leave an image or a note out, the newest complete one is kept as well, so an
image file lost from this device is not pruned out of every backup that still
holds it. The page says what each backup left out, since a scheduled one has
nobody to tell when it is made.

**6. A remembered folder is desktop-only for now.** A schedule cannot open a
save dialog, so the user picks a folder once, in a folder dialog opened by
Rust, and Rust keeps the path. The webview only receives the folder's name,
and errors name files, never paths. On Android and iOS a folder chosen once
is only reusable through a persisted storage-access grant or a
security-scoped bookmark, and both need native code. Until that exists, a
schedule on a phone can only target a linked provider.

The folder may be shared, a NAS or a synced folder that another device backs
up to as well. File names carry a short tag for this device
(`oyot-backup-YYYY-MM-DD-HHmm-<device>.zip`), and a scheduled backup is always
written as a new file, never in place of one that is there, so two devices
never write over each other. A half-written file this device left behind is
removed before its next backup there.

**7. Failures retry, but not forever.** A failed scheduled backup retries after
5 minutes, then 15, then hourly, but never past the next regular slot, which
starts the sequence over. Retries are rows too, and consecutive scheduled
failures are shown as one entry in the history list.

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
- **The history grows by one row per attempt.** A few a day, or up to about 24
  while a schedule is failing and retrying hourly. Rows older than a year can
  be dropped if it ever matters.
- **On a phone, a schedule can only go to a linked account.** A phone has no
  folder it can keep (decision 6). A phone build without a Google client has
  nowhere to schedule to at all, and the page says so instead of offering
  controls that cannot be saved.

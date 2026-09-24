//! When a scheduled backup is due (ADR 0026).
//!
//! Nothing here sleeps until a target time. The scheduler asks `next_run`
//! every few minutes with the clock as it reads then, which is what makes a
//! laptop that slept through its slot back up when it wakes, and a device
//! whose clock or time zone changed follow the new one.

use chrono::{DateTime, Datelike, Duration, MappedLocalTime, NaiveDate, NaiveTime, TimeZone};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// The destination that is a folder on this device, as opposed to a
/// provider's id.
pub const FOLDER: &str = "folder";

/// 02:00. Whenever the app is not open then, the backup runs soon after it
/// next is.
pub const DEFAULT_TIME: u16 = 2 * 60;
pub const DEFAULT_KEEP: u32 = 10;
pub const MAX_KEEP: u32 = 100;
const MINUTES_PER_DAY: u16 = 24 * 60;

const MINUTE_MS: i64 = 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Frequency {
    Off,
    Daily,
    Weekly,
}

impl Frequency {
    fn as_str(self) -> &'static str {
        match self {
            Frequency::Off => "off",
            Frequency::Daily => "daily",
            Frequency::Weekly => "weekly",
        }
    }

    fn parse(s: &str) -> Frequency {
        match s {
            "daily" => Frequency::Daily,
            "weekly" => Frequency::Weekly,
            _ => Frequency::Off,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Schedule {
    pub frequency: Frequency,
    /// Minutes after local midnight.
    pub time_of_day: u16,
    /// For a weekly schedule: 0 is Monday.
    pub weekday: u8,
    /// `FOLDER`, or a provider's id.
    pub destination: Option<String>,
    /// The folder a schedule writes to, chosen once in a dialog. Stays on
    /// this side: the webview is only ever told its name.
    pub folder: Option<PathBuf>,
    /// Record an unchanged library as skipped instead of backing it up again.
    pub skip_unchanged: bool,
    /// How many scheduled backups to keep at a destination.
    pub keep: u32,
    /// When the frequency or the time last changed. A slot before it is not
    /// owed a backup: turning a schedule on or moving its time never makes a
    /// backup due at once.
    pub changed_at: i64,
    /// When the destination last changed. Failures before it were failures
    /// of somewhere else, and neither delay the next try nor count as this
    /// schedule failing. A backup already owed stays owed: pointing a broken
    /// schedule somewhere that works should make the missed backup run.
    pub destination_changed_at: i64,
    /// Whether the one-time suggestion to turn scheduling on has been dealt
    /// with.
    pub suggestion_dismissed: bool,
}

impl Default for Schedule {
    fn default() -> Self {
        Schedule {
            frequency: Frequency::Off,
            time_of_day: DEFAULT_TIME,
            weekday: 0,
            destination: None,
            folder: None,
            skip_unchanged: true,
            keep: DEFAULT_KEEP,
            changed_at: 0,
            destination_changed_at: 0,
            suggestion_dismissed: false,
        }
    }
}

impl Schedule {
    /// Whether moving from `self` to `next` changes when backups are made,
    /// which restarts the count of owed slots.
    pub fn timing_differs(&self, next: &Schedule) -> bool {
        self.frequency != next.frequency
            || self.time_of_day != next.time_of_day
            || (next.frequency == Frequency::Weekly && self.weekday != next.weekday)
    }

    /// Whether moving from `self` to `next` changes where backups go.
    pub fn destination_differs(&self, next: &Schedule) -> bool {
        self.destination != next.destination
            || (next.destination.as_deref() == Some(FOLDER) && self.folder != next.folder)
    }

    /// Stamp `next`, the schedule `self` is becoming, with what changed at
    /// `now`.
    pub fn stamp_changes(&self, next: &mut Schedule, now: i64) {
        if self.timing_differs(next) {
            next.changed_at = now;
        }
        if self.destination_differs(next) {
            next.destination_changed_at = now;
        }
    }

    /// The failures in `attempts` that count against this schedule as it is
    /// at `now`: those since its timing and its destination were last set.
    ///
    /// A stamp later than `now` was written while the clock was ahead, and
    /// is ignored rather than trusted: otherwise a clock put right would
    /// hold the schedule back until real time caught up with it.
    pub fn current_failures<'a>(
        &self,
        attempts: &'a Attempts,
        now: i64,
    ) -> impl Iterator<Item = i64> + 'a {
        let since = past(self.changed_at, now).max(past(self.destination_changed_at, now));
        attempts
            .failures
            .iter()
            .copied()
            .filter(move |&at| at >= since && at <= now)
    }
}

/// `stamp`, or 0 when it is later than `now` and so cannot be trusted.
fn past(stamp: i64, now: i64) -> i64 {
    if stamp > now {
        0
    } else {
        stamp
    }
}

/// The schedule as saved, or the defaults when none has been.
pub fn load(db: &Connection) -> Result<Schedule, String> {
    let row = db
        .query_row(
            "SELECT frequency, time_of_day, weekday, destination, folder, skip_unchanged, keep,
                    changed_at, destination_changed_at, suggestion_dismissed
               FROM backup_schedule WHERE id = 1",
            [],
            |row| {
                Ok(Schedule {
                    frequency: Frequency::parse(&row.get::<_, String>(0)?),
                    time_of_day: row.get(1)?,
                    weekday: row.get(2)?,
                    destination: row.get(3)?,
                    folder: row.get::<_, Option<String>>(4)?.map(PathBuf::from),
                    skip_unchanged: row.get::<_, i64>(5)? != 0,
                    keep: row.get(6)?,
                    changed_at: row.get(7)?,
                    destination_changed_at: row.get(8)?,
                    suggestion_dismissed: row.get::<_, i64>(9)? != 0,
                })
            },
        )
        .optional()
        .map_err(|e| format!("could not read the backup schedule: {e}"))?;
    Ok(row.unwrap_or_default())
}

pub fn save(db: &Connection, schedule: &Schedule) -> Result<(), String> {
    let folder = match &schedule.folder {
        Some(path) => Some(
            path.to_str()
                .ok_or("this folder's name cannot be stored; choose another")?
                .to_string(),
        ),
        None => None,
    };
    db.execute(
        "INSERT INTO backup_schedule (id, frequency, time_of_day, weekday, destination, folder,
                                      skip_unchanged, keep, changed_at, destination_changed_at,
                                      suggestion_dismissed)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
             frequency = excluded.frequency, time_of_day = excluded.time_of_day,
             weekday = excluded.weekday, destination = excluded.destination,
             folder = excluded.folder, skip_unchanged = excluded.skip_unchanged,
             keep = excluded.keep, changed_at = excluded.changed_at,
             destination_changed_at = excluded.destination_changed_at,
             suggestion_dismissed = excluded.suggestion_dismissed",
        params![
            schedule.frequency.as_str(),
            schedule.time_of_day,
            schedule.weekday,
            schedule.destination,
            folder,
            schedule.skip_unchanged,
            schedule.keep,
            schedule.changed_at,
            schedule.destination_changed_at,
            schedule.suggestion_dismissed,
        ],
    )
    .map_err(|e| format!("could not save the backup schedule: {e}"))?;
    Ok(())
}

/// What the history says about scheduled backups, as far as timing needs it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Attempts {
    /// When the newest scheduled backup that succeeded, or found nothing to
    /// back up, started. Newest by when it was recorded, not by its stamp,
    /// so a clock that was wrong then does not decide what is newest now.
    pub last_done: Option<i64>,
    /// When each scheduled attempt recorded after that one, and failed,
    /// started, newest first.
    pub failures: Vec<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Next {
    Off,
    /// A backup is owed now.
    Now,
    /// The next backup is due then, in epoch milliseconds.
    At(i64),
}

/// How long to wait after the `failures`th failure in a row before trying
/// again: 5 minutes, then 15, then hourly.
pub fn retry_delay(failures: usize) -> i64 {
    match failures {
        0 | 1 => 5 * MINUTE_MS,
        2 => 15 * MINUTE_MS,
        _ => 60 * MINUTE_MS,
    }
}

/// Whether a scheduled backup is owed at `now`, and if not, when one will be.
///
/// However many slots were missed, one backup is owed, not one for each.
/// Failures only count against the slot they were trying to fill: retries
/// back off, but never past the next slot, which starts the sequence over.
pub fn next_run<Tz: TimeZone>(
    now: &DateTime<Tz>,
    schedule: &Schedule,
    attempts: &Attempts,
) -> Next {
    if schedule.frequency == Frequency::Off {
        return Next::Off;
    }
    let now_ms = now.timestamp_millis();
    let following = following_slot(now, schedule).timestamp_millis();
    let slot = latest_slot(now, schedule).timestamp_millis();

    // A backup stamped later than now was made while the clock was ahead.
    // Trusting it would owe nothing until real time passed it; one backup
    // now puts a believable stamp in its place.
    let last_done = attempts.last_done.filter(|&done| done <= now_ms);
    let owed =
        slot >= past(schedule.changed_at, now_ms) && last_done.is_none_or(|done| done < slot);
    if !owed {
        return Next::At(following);
    }

    let failures: Vec<i64> = schedule
        .current_failures(attempts, now_ms)
        .filter(|&at| at >= slot)
        .collect();
    let Some(&latest) = failures.iter().max() else {
        return Next::Now;
    };
    let retry_at = latest + retry_delay(failures.len());
    if retry_at <= now_ms {
        Next::Now
    } else {
        Next::At(retry_at.min(following))
    }
}

/// A scheduled backup that this device made, and as far as it knows is still
/// where it put it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stored {
    /// Its history row.
    pub id: i64,
    /// A path in the folder, or the provider's id for it.
    pub location: String,
    pub document_count: i64,
    /// Whether everything went in: no image or note had to be left out.
    pub complete: bool,
}

/// The most backups one run removes. Lowering `keep` then takes effect over
/// a few runs, and no single change, a slip in the number or otherwise,
/// removes a whole set of backups at once.
pub const MAX_PRUNED_PER_RUN: usize = 2;

/// Which of `stored` to remove so that `keep` remain: the oldest beyond the
/// newest `keep`, a few at a time.
///
/// `stored` is newest first, and starts with the backup just made. Two more
/// may be kept beyond `keep`, each only while the newest backup is worse off
/// than an older one:
///
/// - the largest, when the newest holds fewer than half its notes. A library
///   that suddenly lost most of its notes, to a bug or a slip, would
///   otherwise have every backup from before it pruned away after `keep`
///   more runs.
/// - the newest complete one, when the newest had to leave an image or a
///   note out. An image file lost from this device would otherwise be pruned
///   out of every backup that still holds it.
pub fn to_prune(stored: &[Stored], keep: u32) -> Vec<&Stored> {
    let Some(newest) = stored.first() else {
        return Vec::new();
    };
    let largest = stored
        .iter()
        .max_by_key(|s| (s.document_count, s.id))
        .filter(|largest| newest.document_count.saturating_mul(2) < largest.document_count)
        .map(|largest| largest.id);
    let last_complete = if newest.complete {
        None
    } else {
        stored.iter().find(|s| s.complete).map(|s| s.id)
    };
    stored
        .iter()
        .skip(usize::try_from(keep).unwrap_or(usize::MAX).max(1))
        .rev()
        .filter(|s| Some(s.id) != largest && Some(s.id) != last_complete)
        .take(MAX_PRUNED_PER_RUN)
        .collect()
}

/// Whether a slot falls on `date`.
fn is_slot_day(date: NaiveDate, schedule: &Schedule) -> bool {
    match schedule.frequency {
        Frequency::Off => false,
        Frequency::Daily => true,
        Frequency::Weekly => date.weekday().num_days_from_monday() == u32::from(schedule.weekday),
    }
}

/// The instant of the slot on local `date`.
///
/// A time the clocks skip that day (a DST gap) moves to the first minute that
/// exists after it; a time that happens twice (the hour repeated when clocks
/// go back) is the first of the two.
fn slot_on<Tz: TimeZone>(tz: &Tz, date: NaiveDate, minutes: u16) -> DateTime<Tz> {
    let minutes = minutes.min(MINUTES_PER_DAY - 1);
    let time = NaiveTime::from_hms_opt(u32::from(minutes / 60), u32::from(minutes % 60), 0)
        .unwrap_or(NaiveTime::MIN);
    let local = date.and_time(time);
    // Gaps are an hour or so. Two days covers even a zone that skipped a
    // whole date, which has happened.
    for step in 0..=(2 * i64::from(MINUTES_PER_DAY)) {
        match tz.from_local_datetime(&(local + Duration::minutes(step))) {
            MappedLocalTime::Single(instant) => return instant,
            // Not `earliest()`: that is whichever of the two the zone lists
            // first, and chrono's Unix and Windows zones list them in
            // opposite orders.
            MappedLocalTime::Ambiguous(a, b) => return a.min(b),
            MappedLocalTime::None => {}
        }
    }
    tz.from_utc_datetime(&local)
}

/// The newest slot at or before `now`.
fn latest_slot<Tz: TimeZone>(now: &DateTime<Tz>, schedule: &Schedule) -> DateTime<Tz> {
    let tz = now.timezone();
    let today = now.date_naive();
    (0..=8)
        .filter_map(|back| today.checked_sub_signed(Duration::days(back)))
        .filter(|&date| is_slot_day(date, schedule))
        .map(|date| slot_on(&tz, date, schedule.time_of_day))
        .find(|slot| slot <= now)
        .unwrap_or_else(|| now.clone() - Duration::days(7))
}

/// The oldest slot after `now`.
fn following_slot<Tz: TimeZone>(now: &DateTime<Tz>, schedule: &Schedule) -> DateTime<Tz> {
    let tz = now.timezone();
    let today = now.date_naive();
    (-1..=8)
        .filter_map(|ahead| today.checked_add_signed(Duration::days(ahead)))
        .filter(|&date| is_slot_day(date, schedule))
        .map(|date| slot_on(&tz, date, schedule.time_of_day))
        .find(|slot| slot > now)
        .unwrap_or_else(|| now.clone() + Duration::days(7))
}

#[cfg(test)]
mod tests {
    use super::super::test_support::library;
    use super::*;
    use chrono::{FixedOffset, NaiveDateTime, Offset, Utc};

    const HOUR_MS: i64 = 60 * MINUTE_MS;

    /// A zone that moves its clocks once, at `change` (UTC), from `before` to
    /// `after`. Enough to test a DST gap and a repeated hour without a
    /// time-zone database.
    #[derive(Debug, Clone, Copy)]
    struct Shifting {
        change: NaiveDateTime,
        before: FixedOffset,
        after: FixedOffset,
    }

    #[derive(Debug, Clone, Copy)]
    struct ShiftingOffset {
        fixed: FixedOffset,
        zone: Shifting,
    }

    impl Offset for ShiftingOffset {
        fn fix(&self) -> FixedOffset {
            self.fixed
        }
    }

    impl Shifting {
        fn offset(&self, fixed: FixedOffset) -> ShiftingOffset {
            ShiftingOffset { fixed, zone: *self }
        }
    }

    impl TimeZone for Shifting {
        type Offset = ShiftingOffset;

        fn from_offset(offset: &ShiftingOffset) -> Self {
            offset.zone
        }

        fn offset_from_local_date(&self, local: &NaiveDate) -> MappedLocalTime<ShiftingOffset> {
            self.offset_from_local_datetime(&local.and_time(NaiveTime::MIN))
        }

        fn offset_from_local_datetime(
            &self,
            local: &NaiveDateTime,
        ) -> MappedLocalTime<ShiftingOffset> {
            let under_before = *local - Duration::seconds(i64::from(self.before.local_minus_utc()));
            let under_after = *local - Duration::seconds(i64::from(self.after.local_minus_utc()));
            match (under_before < self.change, under_after >= self.change) {
                // In the order chrono's Unix zones give them, smaller offset
                // first, which is the later instant first.
                (true, true) => {
                    let (small, large) =
                        if self.before.local_minus_utc() < self.after.local_minus_utc() {
                            (self.before, self.after)
                        } else {
                            (self.after, self.before)
                        };
                    MappedLocalTime::Ambiguous(self.offset(small), self.offset(large))
                }
                (true, false) => MappedLocalTime::Single(self.offset(self.before)),
                (false, true) => MappedLocalTime::Single(self.offset(self.after)),
                (false, false) => MappedLocalTime::None,
            }
        }

        fn offset_from_utc_date(&self, utc: &NaiveDate) -> ShiftingOffset {
            self.offset_from_utc_datetime(&utc.and_time(NaiveTime::MIN))
        }

        fn offset_from_utc_datetime(&self, utc: &NaiveDateTime) -> ShiftingOffset {
            if *utc < self.change {
                self.offset(self.before)
            } else {
                self.offset(self.after)
            }
        }
    }

    fn at<Tz: TimeZone>(zone: &Tz, y: i32, m: u32, d: u32, h: u32, min: u32) -> i64 {
        match zone.with_ymd_and_hms(y, m, d, h, min, 0) {
            MappedLocalTime::Single(t) => t.timestamp_millis(),
            MappedLocalTime::Ambiguous(a, b) => a.timestamp_millis().min(b.timestamp_millis()),
            MappedLocalTime::None => panic!("no such local time"),
        }
    }

    fn utc(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, h, min, 0).unwrap()
    }

    fn daily(time: u16) -> Schedule {
        Schedule {
            frequency: Frequency::Daily,
            time_of_day: time,
            destination: Some(FOLDER.to_string()),
            ..Schedule::default()
        }
    }

    fn weekly(weekday: u8, time: u16) -> Schedule {
        Schedule {
            frequency: Frequency::Weekly,
            weekday,
            ..daily(time)
        }
    }

    fn done(at: i64) -> Attempts {
        Attempts {
            last_done: Some(at),
            failures: Vec::new(),
        }
    }

    // 2026-09-23 is a Wednesday.

    #[test]
    fn an_off_schedule_is_never_due() {
        let now = utc(2026, 9, 23, 12, 0);
        let schedule = Schedule {
            frequency: Frequency::Off,
            ..daily(120)
        };
        assert_eq!(next_run(&now, &schedule, &Attempts::default()), Next::Off);
    }

    #[test]
    fn a_daily_slot_that_passed_without_a_backup_is_owed() {
        let now = utc(2026, 9, 23, 9, 0);
        assert_eq!(
            next_run(&now, &daily(120), &done(at(&Utc, 2026, 9, 22, 2, 1))),
            Next::Now
        );
    }

    #[test]
    fn a_slot_already_backed_up_waits_for_the_next() {
        let now = utc(2026, 9, 23, 9, 0);
        assert_eq!(
            next_run(&now, &daily(120), &done(at(&Utc, 2026, 9, 23, 2, 1))),
            Next::At(at(&Utc, 2026, 9, 24, 2, 0))
        );
    }

    #[test]
    fn the_slot_itself_is_due_on_the_minute() {
        let now = utc(2026, 9, 23, 2, 0);
        assert_eq!(
            next_run(&now, &daily(120), &done(at(&Utc, 2026, 9, 22, 2, 0))),
            Next::Now
        );
    }

    #[test]
    fn weeks_away_owe_one_backup_not_one_a_day() {
        let now = utc(2026, 9, 23, 9, 0);
        let schedule = daily(120);
        assert_eq!(
            next_run(&now, &schedule, &done(at(&Utc, 2026, 8, 1, 2, 0))),
            Next::Now
        );
        // Made now, it covers every one of the missed slots.
        assert_eq!(
            next_run(&now, &schedule, &done(now.timestamp_millis())),
            Next::At(at(&Utc, 2026, 9, 24, 2, 0))
        );
    }

    #[test]
    fn saving_a_schedule_does_not_make_a_backup_due_at_once() {
        let now = utc(2026, 9, 23, 15, 0);
        let schedule = Schedule {
            changed_at: now.timestamp_millis() - MINUTE_MS,
            ..daily(120)
        };
        // Never backed up, but today's slot came before the schedule did.
        assert_eq!(
            next_run(&now, &schedule, &Attempts::default()),
            Next::At(at(&Utc, 2026, 9, 24, 2, 0))
        );
        // The first slot after it is owed as usual.
        let later = utc(2026, 9, 24, 8, 0);
        assert_eq!(next_run(&later, &schedule, &Attempts::default()), Next::Now);
    }

    #[test]
    fn a_weekly_slot_falls_on_its_weekday() {
        // Friday at 18:30. The last one was a week ago Friday.
        let schedule = weekly(4, 18 * 60 + 30);
        let last = done(at(&Utc, 2026, 9, 18, 18, 30));
        assert_eq!(
            next_run(&utc(2026, 9, 23, 9, 0), &schedule, &last),
            Next::At(at(&Utc, 2026, 9, 25, 18, 30))
        );
        assert_eq!(
            next_run(&utc(2026, 9, 25, 18, 29), &schedule, &last),
            Next::At(at(&Utc, 2026, 9, 25, 18, 30))
        );
        assert_eq!(
            next_run(&utc(2026, 9, 25, 18, 30), &schedule, &last),
            Next::Now
        );
        // Missed on Friday, still owed on Monday.
        assert_eq!(
            next_run(&utc(2026, 9, 28, 7, 0), &schedule, &last),
            Next::Now
        );
    }

    #[test]
    fn a_failure_is_retried_after_5_then_15_minutes_then_hourly() {
        let slot = at(&Utc, 2026, 9, 23, 2, 0);
        let schedule = daily(120);
        let mut attempts = done(slot - 24 * HOUR_MS);

        attempts.failures = vec![slot + MINUTE_MS];
        let now = utc(2026, 9, 23, 2, 3);
        assert_eq!(
            next_run(&now, &schedule, &attempts),
            Next::At(slot + 6 * MINUTE_MS)
        );
        assert_eq!(
            next_run(&utc(2026, 9, 23, 2, 6), &schedule, &attempts),
            Next::Now
        );

        attempts.failures.insert(0, slot + 6 * MINUTE_MS);
        assert_eq!(
            next_run(&utc(2026, 9, 23, 2, 7), &schedule, &attempts),
            Next::At(slot + 21 * MINUTE_MS)
        );

        attempts.failures.insert(0, slot + 21 * MINUTE_MS);
        assert_eq!(
            next_run(&utc(2026, 9, 23, 2, 22), &schedule, &attempts),
            Next::At(slot + 81 * MINUTE_MS)
        );

        attempts.failures.insert(0, slot + 81 * MINUTE_MS);
        assert_eq!(
            next_run(&utc(2026, 9, 23, 3, 22), &schedule, &attempts),
            Next::At(slot + 141 * MINUTE_MS)
        );
    }

    #[test]
    fn retries_stop_at_the_next_slot_which_starts_again() {
        let schedule = daily(120);
        let next_slot = at(&Utc, 2026, 9, 24, 2, 0);
        let attempts = Attempts {
            last_done: Some(at(&Utc, 2026, 9, 22, 2, 0)),
            // Failing hourly since just before the next slot.
            failures: vec![
                next_slot - 10 * MINUTE_MS,
                next_slot - 70 * MINUTE_MS,
                next_slot - 130 * MINUTE_MS,
            ],
        };
        assert_eq!(
            next_run(&utc(2026, 9, 24, 1, 55), &schedule, &attempts),
            Next::At(next_slot)
        );
        // At the slot, the failures belong to the last one, and this one is
        // tried straight away.
        assert_eq!(
            next_run(&utc(2026, 9, 24, 2, 0), &schedule, &attempts),
            Next::Now
        );
    }

    #[test]
    fn follows_the_time_zone_the_clock_is_in_now() {
        // The same instant, read in two zones: 09:00 in UTC is before a 10:00
        // slot, 11:00 in UTC+2 is after it.
        let now = utc(2026, 9, 23, 9, 0);
        let schedule = daily(10 * 60);
        let last = done(at(&Utc, 2026, 9, 22, 10, 5));
        assert_eq!(
            next_run(&now, &schedule, &last),
            Next::At(at(&Utc, 2026, 9, 23, 10, 0))
        );
        let east = FixedOffset::east_opt(2 * 3600).unwrap();
        assert_eq!(
            next_run(&now.with_timezone(&east), &schedule, &last),
            Next::Now
        );
    }

    fn spring_forward() -> Shifting {
        // Clocks go from 02:00 to 03:00 local on 2026-03-29 (UTC+1 to UTC+2).
        Shifting {
            change: NaiveDate::from_ymd_opt(2026, 3, 29)
                .unwrap()
                .and_hms_opt(1, 0, 0)
                .unwrap(),
            before: FixedOffset::east_opt(3600).unwrap(),
            after: FixedOffset::east_opt(2 * 3600).unwrap(),
        }
    }

    fn fall_back() -> Shifting {
        // Clocks go from 03:00 back to 02:00 local on 2026-10-25 (UTC+2 to UTC+1).
        Shifting {
            change: NaiveDate::from_ymd_opt(2026, 10, 25)
                .unwrap()
                .and_hms_opt(1, 0, 0)
                .unwrap(),
            before: FixedOffset::east_opt(2 * 3600).unwrap(),
            after: FixedOffset::east_opt(3600).unwrap(),
        }
    }

    #[test]
    fn a_slot_the_clocks_skip_runs_when_the_gap_ends() {
        let zone = spring_forward();
        let schedule = daily(2 * 60 + 30);
        let last = done(at(&zone, 2026, 3, 28, 2, 30));
        // 02:30 does not exist that night; the slot is 03:00, the first
        // minute that does.
        let before = zone.with_ymd_and_hms(2026, 3, 29, 1, 59, 0).unwrap();
        assert_eq!(
            next_run(&before, &schedule, &last),
            Next::At(at(&zone, 2026, 3, 29, 3, 0))
        );
        let after = zone.with_ymd_and_hms(2026, 3, 29, 3, 0, 0).unwrap();
        assert_eq!(next_run(&after, &schedule, &last), Next::Now);
    }

    #[test]
    fn a_slot_in_the_repeated_hour_runs_once() {
        let zone = fall_back();
        let schedule = daily(2 * 60 + 30);
        let (a, b) = match zone.with_ymd_and_hms(2026, 10, 25, 2, 30, 0) {
            MappedLocalTime::Ambiguous(a, b) => (a, b),
            other => panic!("02:30 should happen twice, got {other:?}"),
        };
        let (first, second) = (a.min(b), a.max(b));
        assert_eq!(
            next_run(&first, &schedule, &done(at(&zone, 2026, 10, 24, 2, 30))),
            Next::Now
        );
        // Backed up at the first 02:30; the second is not another slot.
        assert_eq!(
            next_run(&second, &schedule, &done(first.timestamp_millis())),
            Next::At(at(&zone, 2026, 10, 26, 2, 30))
        );
    }

    #[test]
    fn a_clock_set_back_past_the_last_backup_backs_up_again() {
        // Backed up at today's slot, then the clock is put back before it.
        // The stamp is not trusted, which costs one backup more, rather
        // than trusted, which could cost every backup until real time
        // caught up with it.
        let schedule = daily(120);
        let last = done(at(&Utc, 2026, 9, 23, 2, 1));
        assert_eq!(
            next_run(&utc(2026, 9, 23, 1, 30), &schedule, &last),
            Next::Now
        );
    }

    #[test]
    fn only_timing_changes_restart_the_count_of_owed_slots() {
        let base = daily(120);
        let stamped = |next: Schedule| {
            let mut next = next;
            base.stamp_changes(&mut next, 99);
            (next.changed_at, next.destination_changed_at)
        };
        assert_eq!(
            stamped(Schedule {
                keep: 3,
                skip_unchanged: false,
                suggestion_dismissed: true,
                ..base.clone()
            }),
            (0, 0)
        );
        // A weekday means nothing to a daily schedule.
        assert_eq!(
            stamped(Schedule {
                weekday: 3,
                ..base.clone()
            }),
            (0, 0)
        );
        assert_eq!(stamped(daily(180)), (99, 0));
        assert_eq!(stamped(weekly(0, 120)), (99, 0));
        assert_eq!(
            stamped(Schedule {
                destination: Some("google-drive".to_string()),
                ..base.clone()
            }),
            (0, 99)
        );
        assert_eq!(
            stamped(Schedule {
                folder: Some(PathBuf::from("/elsewhere")),
                ..base.clone()
            }),
            (0, 99)
        );
    }

    #[test]
    fn a_new_destination_keeps_an_owed_backup_owed_and_forgets_old_failures() {
        let slot = at(&Utc, 2026, 9, 23, 2, 0);
        let now = utc(2026, 9, 23, 9, 0);
        let attempts = Attempts {
            last_done: Some(slot - 24 * HOUR_MS),
            // The old folder has been failing hourly.
            failures: vec![
                now.timestamp_millis() - 10 * MINUTE_MS,
                slot + HOUR_MS,
                slot + 5 * MINUTE_MS,
            ],
        };
        let failing = daily(120);
        assert_eq!(
            next_run(&now, &failing, &attempts),
            Next::At(now.timestamp_millis() + 50 * MINUTE_MS)
        );
        let moved = Schedule {
            destination: Some("google-drive".to_string()),
            destination_changed_at: now.timestamp_millis() - MINUTE_MS,
            ..failing
        };
        assert_eq!(next_run(&now, &moved, &attempts), Next::Now);
        assert_eq!(
            moved
                .current_failures(&attempts, now.timestamp_millis())
                .count(),
            0
        );
    }

    #[test]
    fn stamps_from_a_clock_that_was_ahead_do_not_hold_the_schedule_back() {
        let now = utc(2026, 9, 23, 9, 0);
        let ahead = at(&Utc, 2027, 1, 1, 2, 0);
        // A backup made, and a schedule saved, while the clock read 2027.
        let schedule = Schedule {
            changed_at: ahead,
            destination_changed_at: ahead,
            ..daily(120)
        };
        let attempts = Attempts {
            last_done: Some(ahead),
            failures: vec![ahead + HOUR_MS],
        };
        assert_eq!(next_run(&now, &schedule, &attempts), Next::Now);
        assert_eq!(
            schedule
                .current_failures(&attempts, now.timestamp_millis())
                .count(),
            0
        );
    }

    fn stored(counts: &[i64]) -> Vec<Stored> {
        // Newest first, ids counting down.
        counts
            .iter()
            .enumerate()
            .map(|(i, &count)| Stored {
                id: (counts.len() - i) as i64,
                location: format!("b{}", counts.len() - i),
                document_count: count,
                complete: true,
            })
            .collect()
    }

    fn ids(pruned: Vec<&Stored>) -> Vec<i64> {
        pruned.into_iter().map(|s| s.id).collect()
    }

    #[test]
    fn prunes_the_oldest_beyond_the_newest_few() {
        assert_eq!(ids(to_prune(&stored(&[5, 5, 5, 5]), 3)), vec![1]);
        assert!(to_prune(&stored(&[5, 5, 5]), 3).is_empty());
        assert!(to_prune(&[], 3).is_empty());
    }

    #[test]
    fn a_lower_keep_takes_effect_a_few_backups_at_a_time() {
        let all = stored(&[5; 10]);
        assert_eq!(ids(to_prune(&all, 1)), vec![1, 2]);
    }

    #[test]
    fn never_prunes_the_backup_just_made() {
        assert_eq!(ids(to_prune(&stored(&[5, 5]), 0)), vec![1]);
    }

    #[test]
    fn keeps_the_largest_backup_when_the_library_has_suddenly_shrunk() {
        // Down from 100 notes to 10: the 100-note backup stays.
        let shrunk = stored(&[10, 10, 10, 100, 100]);
        assert_eq!(ids(to_prune(&shrunk, 3)), vec![1]);
        // A library that shrank a little is pruned as usual.
        let trimmed = stored(&[60, 60, 60, 100, 100]);
        assert_eq!(ids(to_prune(&trimmed, 3)), vec![1, 2]);
    }

    #[test]
    fn keeps_the_last_complete_backup_while_newer_ones_leave_something_out() {
        // An image went missing after backup 2: 3, 4 and 5 lack it.
        let mut all = stored(&[5; 5]);
        for backup in &mut all[..3] {
            backup.complete = false;
        }
        assert_eq!(ids(to_prune(&all, 3)), vec![1]);
        // Once the newest is whole again, the older one goes as usual.
        all[0].complete = true;
        assert_eq!(ids(to_prune(&all, 3)), vec![1, 2]);
    }

    #[test]
    fn nothing_saved_reads_as_the_defaults() {
        let db = library();
        assert_eq!(load(&db).unwrap(), Schedule::default());
    }

    #[test]
    fn saves_and_reads_back_every_setting() {
        let db = library();
        let schedule = Schedule {
            frequency: Frequency::Weekly,
            time_of_day: 23 * 60 + 59,
            weekday: 6,
            destination: Some(FOLDER.to_string()),
            folder: Some(PathBuf::from("/Users/me/Backups")),
            skip_unchanged: false,
            keep: 3,
            changed_at: 42,
            destination_changed_at: 43,
            suggestion_dismissed: true,
        };
        save(&db, &schedule).unwrap();
        assert_eq!(load(&db).unwrap(), schedule);

        let off = Schedule::default();
        save(&db, &off).unwrap();
        assert_eq!(load(&db).unwrap(), off);
    }

    #[test]
    fn the_table_refuses_values_the_app_never_writes() {
        let db = library();
        save(&db, &Schedule::default()).unwrap();
        for bad in [
            "UPDATE backup_schedule SET frequency = 'hourly'",
            "UPDATE backup_schedule SET time_of_day = 1440",
            "UPDATE backup_schedule SET weekday = 7",
            "UPDATE backup_schedule SET keep = 0",
            "INSERT INTO backup_schedule (id) VALUES (2)",
        ] {
            assert!(db.execute(bad, []).is_err(), "{bad}");
        }
    }
}

//! The record of every background run (ADR 0034, decision 7).
//!
//! Without it, "background sync is broken" and "the system has not run us
//! today" look the same. The sync settings read the newest row to say when
//! the last background sync was, and with which device.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// How many runs are kept. Enough for a few days of a phone's runs, which is
/// as far back as anyone asking "is it working" needs.
const KEEP: i64 = 200;

/// One run, as recorded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    /// What started it: `workmanager`, `app-refresh`, `processing` or
    /// `leaving`.
    pub trigger: String,
    pub started_at: i64,
    pub ended_at: i64,
    /// The display names of the devices it reached.
    pub reached: Vec<String>,
    pub docs_received: u64,
    pub docs_sent: u64,
    pub images_received: u64,
    pub images_sent: u64,
    /// `synced`, `partial` (time ran out first), `unreachable`, `cancelled`
    /// or `failed`.
    pub outcome: String,
    pub error: Option<String>,
}

pub fn record(db: &Connection, run: &RunRecord) -> Result<(), String> {
    let reached = serde_json::to_string(&run.reached).map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO sync_runs (trigger, started_at, ended_at, reached, docs_received, docs_sent,
                                images_received, images_sent, outcome, error)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            run.trigger,
            run.started_at,
            run.ended_at,
            reached,
            run.docs_received as i64,
            run.docs_sent as i64,
            run.images_received as i64,
            run.images_sent as i64,
            run.outcome,
            run.error,
        ],
    )
    .map_err(|e| format!("could not record a background run: {e}"))?;
    db.execute(
        "DELETE FROM sync_runs WHERE id NOT IN
             (SELECT id FROM sync_runs ORDER BY id DESC LIMIT ?1)",
        params![KEEP],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The newest run, if there has been one.
pub fn last(db: &Connection) -> Result<Option<RunRecord>, String> {
    db.query_row(
        "SELECT trigger, started_at, ended_at, reached, docs_received, docs_sent,
                images_received, images_sent, outcome, error
           FROM sync_runs ORDER BY id DESC LIMIT 1",
        [],
        |row| {
            let reached: String = row.get(3)?;
            Ok(RunRecord {
                trigger: row.get(0)?,
                started_at: row.get(1)?,
                ended_at: row.get(2)?,
                reached: serde_json::from_str(&reached).unwrap_or_default(),
                docs_received: row.get::<_, i64>(4)?.max(0) as u64,
                docs_sent: row.get::<_, i64>(5)?.max(0) as u64,
                images_received: row.get::<_, i64>(6)?.max(0) as u64,
                images_sent: row.get::<_, i64>(7)?.max(0) as u64,
                outcome: row.get(8)?,
                error: row.get(9)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        crate::setup_database_tables(&db).unwrap();
        crate::run_migrations(&db).unwrap();
        db
    }

    fn run(at: i64) -> RunRecord {
        RunRecord {
            trigger: "workmanager".to_string(),
            started_at: at,
            ended_at: at + 5,
            reached: vec!["Desktop".to_string()],
            docs_received: 2,
            docs_sent: 1,
            images_received: 0,
            images_sent: 0,
            outcome: "synced".to_string(),
            error: None,
        }
    }

    #[test]
    fn the_newest_run_is_the_one_read_back() {
        let db = library();
        assert_eq!(last(&db).unwrap(), None);

        record(&db, &run(1)).unwrap();
        record(&db, &run(2)).unwrap();

        assert_eq!(last(&db).unwrap(), Some(run(2)));
    }

    #[test]
    fn only_the_newest_runs_are_kept() {
        let db = library();
        for at in 0..KEEP + 25 {
            record(&db, &run(at)).unwrap();
        }
        let (count, oldest): (i64, i64) = db
            .query_row("SELECT COUNT(*), MIN(started_at) FROM sync_runs", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(count, KEEP);
        assert_eq!(oldest, 25);
    }
}

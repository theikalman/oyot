//! What to do about one document, given how another copy of the library
//! describes it and how this device holds it (ADR 0003, ADR 0008).
//!
//! Ported from `reconcile.ts` rule for rule, tests included. Two things merge
//! another copy of the library into this one: a peer's manifest, and a backup
//! being imported (ADR 0024). Both decide here, so they cannot drift apart.

use super::protocol::{lifecycle_stamp, pin_stamp, ManifestEntry};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reconciliation {
    /// They deleted a document this device never held: record the tombstone,
    /// so the delete keeps propagating (ADR 0012).
    RecordTombstone,
    /// They deleted it after this device last saw it change: delete it here.
    Delete { deleted_at: i64 },
    /// Their tombstone is older than what this device has seen since.
    StaleTombstone,
    /// A document this device has never seen: create it and take its content.
    Create,
    /// They revived it after this device deleted it: revive it, take its content.
    Revive,
    /// This device deleted it at least as late as they last changed it.
    StaysDeleted,
    /// Both hold it: take a newer title or pin, and exchange content if it differs.
    Update {
        rename: bool,
        repin: bool,
        pull: bool,
    },
    /// Both hold it, the same.
    UpToDate,
}

pub fn reconcile(remote: &ManifestEntry, local: Option<&ManifestEntry>) -> Reconciliation {
    // `is_deleted` is a last-writer-wins register keyed on the lifecycle
    // stamp. Branching on the flag alone could not express "I revived this
    // after you deleted it", so a revived journal was re-deleted on the next
    // manifest exchange.
    let remote_stamp = lifecycle_stamp(remote);
    let local_stamp = local.map(lifecycle_stamp).unwrap_or(-1);

    if remote.is_deleted {
        let Some(_) = local else {
            return Reconciliation::RecordTombstone;
        };
        if remote_stamp > local_stamp {
            return Reconciliation::Delete {
                deleted_at: remote.deleted_at.unwrap_or(remote_stamp),
            };
        }
        return Reconciliation::StaleTombstone;
    }

    let Some(local) = local else {
        return Reconciliation::Create;
    };

    // This device holds a tombstone they do not. Ours wins only if we
    // observed it at least as late; otherwise they revived the document after
    // our delete, so the revival is accepted and its content taken.
    if local.is_deleted {
        return if local_stamp >= remote_stamp {
            Reconciliation::StaysDeleted
        } else {
            Reconciliation::Revive
        };
    }

    let rename = remote.title_updated_at > local.title_updated_at;
    let repin = pin_wins(remote, local);
    // A missing hash is an unknown, not a match: exchange rather than assume.
    let pull = match (&local.content_hash, &remote.content_hash) {
        (Some(ours), Some(theirs)) => ours != theirs,
        _ => true,
    };
    if rename || repin || pull {
        Reconciliation::Update {
            rename,
            repin,
            pull,
        }
    } else {
        Reconciliation::UpToDate
    }
}

/// Whether their pin is the later word on a document both sides hold.
///
/// A tie goes to pinned. Two devices hold different pins at one stamp only by
/// setting them independently, and with no rule for a tie each would keep its
/// own for good. `apply_pin_if_newer` breaks it the same way (ADR 0027).
fn pin_wins(remote: &ManifestEntry, local: &ManifestEntry) -> bool {
    let theirs = pin_stamp(remote);
    let ours = pin_stamp(local);
    if theirs != ours {
        return theirs > ours;
    }
    remote.pinned.unwrap_or(false) && !local.pinned.unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use Reconciliation::*;

    fn entry() -> ManifestEntry {
        ManifestEntry {
            id: "doc".into(),
            doc_type: "note".into(),
            title: "Doc".into(),
            title_updated_at: 10,
            created_at: 1,
            is_deleted: false,
            deleted_at: None,
            lifecycle_updated_at: Some(1),
            pinned: None,
            pinned_updated_at: None,
            content_hash: Some("hash-a".into()),
        }
    }

    fn with(f: impl FnOnce(&mut ManifestEntry)) -> ManifestEntry {
        let mut e = entry();
        f(&mut e);
        e
    }

    fn tombstone(at: i64) -> ManifestEntry {
        with(|e| {
            e.is_deleted = true;
            e.deleted_at = Some(at);
            e.lifecycle_updated_at = Some(at);
            e.content_hash = None;
        })
    }

    #[test]
    fn creates_a_document_this_device_has_never_seen() {
        assert_eq!(reconcile(&entry(), None), Create);
    }

    #[test]
    fn records_a_tombstone_for_a_document_this_device_never_held() {
        assert_eq!(reconcile(&tombstone(5), None), RecordTombstone);
    }

    #[test]
    fn applies_a_delete_made_after_this_device_last_saw_the_document_change() {
        let local = with(|e| e.lifecycle_updated_at = Some(20));
        assert_eq!(
            reconcile(&tombstone(50), Some(&local)),
            Delete { deleted_at: 50 }
        );
    }

    #[test]
    fn falls_back_to_the_lifecycle_stamp_when_a_tombstone_carries_no_delete_time() {
        let mut remote = tombstone(50);
        remote.deleted_at = None;
        let local = with(|e| e.lifecycle_updated_at = Some(20));
        assert_eq!(reconcile(&remote, Some(&local)), Delete { deleted_at: 50 });
    }

    #[test]
    fn ignores_a_tombstone_older_than_a_revival_this_device_observed() {
        let local = with(|e| e.lifecycle_updated_at = Some(50));
        assert_eq!(reconcile(&tombstone(20), Some(&local)), StaleTombstone);
    }

    #[test]
    fn revives_a_document_they_revived_after_this_device_deleted_it() {
        let remote = with(|e| e.lifecycle_updated_at = Some(60));
        assert_eq!(reconcile(&remote, Some(&tombstone(50))), Revive);
    }

    #[test]
    fn keeps_a_delete_at_least_as_new_as_their_copy() {
        let same = with(|e| e.lifecycle_updated_at = Some(50));
        let older = with(|e| e.lifecycle_updated_at = Some(40));
        assert_eq!(reconcile(&same, Some(&tombstone(50))), StaysDeleted);
        assert_eq!(reconcile(&older, Some(&tombstone(50))), StaysDeleted);
    }

    #[test]
    fn takes_a_newer_title_and_only_a_newer_one() {
        let local = with(|e| e.title_updated_at = 10);
        let newer = with(|e| {
            e.title = "New".into();
            e.title_updated_at = 11;
        });
        let older = with(|e| {
            e.title = "Old".into();
            e.title_updated_at = 9;
        });
        assert_eq!(
            reconcile(&newer, Some(&local)),
            Update {
                rename: true,
                repin: false,
                pull: false
            }
        );
        assert_eq!(reconcile(&older, Some(&local)), UpToDate);
    }

    #[test]
    fn exchanges_content_when_the_hashes_differ_or_one_is_unknown() {
        let local = entry();
        let other = with(|e| e.content_hash = Some("hash-b".into()));
        assert_eq!(
            reconcile(&other, Some(&local)),
            Update {
                rename: false,
                repin: false,
                pull: true
            }
        );
        let unknown = with(|e| e.content_hash = None);
        assert!(matches!(
            reconcile(&unknown, Some(&local)),
            Update { pull: true, .. }
        ));
        assert!(matches!(
            reconcile(&entry(), Some(&unknown)),
            Update { pull: true, .. }
        ));
    }

    #[test]
    fn does_nothing_for_an_identical_document() {
        assert_eq!(reconcile(&entry(), Some(&entry())), UpToDate);
    }

    // A pin is a register like the title: whichever side set it last, pinned
    // or unpinned, is the answer.
    #[test]
    fn takes_a_newer_pin_and_only_a_newer_one() {
        let local = with(|e| {
            e.pinned = Some(true);
            e.pinned_updated_at = Some(50);
        });
        let newer = with(|e| {
            e.pinned = Some(false);
            e.pinned_updated_at = Some(60);
        });
        let older = with(|e| {
            e.pinned = Some(false);
            e.pinned_updated_at = Some(40);
        });
        assert_eq!(
            reconcile(&newer, Some(&local)),
            Update {
                rename: false,
                repin: true,
                pull: false
            }
        );
        assert_eq!(reconcile(&older, Some(&local)), UpToDate);
    }

    #[test]
    fn takes_a_pin_on_a_note_this_device_never_pinned() {
        let pinned = with(|e| {
            e.pinned = Some(true);
            e.pinned_updated_at = Some(1);
        });
        assert!(matches!(
            reconcile(&pinned, Some(&entry())),
            Update { repin: true, .. }
        ));
    }

    // Without a rule for a tie, two devices that set different pins at one
    // stamp would each keep their own for good.
    #[test]
    fn breaks_a_tie_on_the_pin_stamp_in_favour_of_pinned_from_either_side() {
        let pinned = with(|e| {
            e.pinned = Some(true);
            e.pinned_updated_at = Some(50);
        });
        let unpinned = with(|e| {
            e.pinned = Some(false);
            e.pinned_updated_at = Some(50);
        });
        assert!(matches!(
            reconcile(&pinned, Some(&unpinned)),
            Update { repin: true, .. }
        ));
        assert_eq!(reconcile(&unpinned, Some(&pinned)), UpToDate);
    }

    // A manifest that carries no pin reads as "never pinned" rather than as
    // unpinning everything.
    #[test]
    fn changes_no_pin_for_a_manifest_that_carries_none() {
        let local = with(|e| {
            e.pinned = Some(true);
            e.pinned_updated_at = Some(50);
        });
        assert_eq!(reconcile(&entry(), Some(&local)), UpToDate);
    }
}

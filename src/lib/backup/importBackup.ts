import { reconcile, type Reconciliation } from '$lib/sync/reconcile';
import type { ManifestEntry } from '$lib/sync/protocol';

/**
 * Importing a backup: merging it into this library the way a peer's manifest
 * is merged, by the same `reconcile()`, with one difference. See
 * docs/decisions/0024-back-up-the-crdt-and-import-by-merging.md.
 *
 * Nothing here talks to Tauri. The plan is a pure function of the backup's
 * documents and this device's, and applying it goes through an interface the
 * document repository satisfies, so both can be tested without the app.
 */

/** What importing does with one document, for the preview and the summary. */
export type ImportOutcome =
    /** Not on this device: created from the backup. */
    | 'added'
    /** Deleted here before the backup's copy last changed: brought back. */
    | 'restored'
    /** On both, and the backup's copy differs: a newer title taken, content merged. */
    | 'updated'
    /** On both, the same. */
    | 'unchanged'
    /** Deleted in the backup, still here: kept. The one departure from sync. */
    | 'kept'
    /** Deleted here after the backup's copy last changed: stays deleted. */
    | 'stays-deleted'
    /** Deleted in the backup and not here to show: recorded, as sync would. */
    | 'tombstone';

/** A reconciliation, or keeping a live document sync would have deleted. */
export type ImportDecision = Reconciliation | { kind: 'keep' };

export interface ImportStep {
    entry: ManifestEntry;
    /** How this device held the document before the import. */
    local: ManifestEntry | undefined;
    decision: ImportDecision;
    outcome: ImportOutcome;
    /** Whether the backup's content is merged in. */
    merge: boolean;
}

export interface ImportCounts {
    added: number;
    restored: number;
    updated: number;
    unchanged: number;
    kept: number;
    staysDeleted: number;
}

export interface ImportPlan {
    steps: ImportStep[];
    counts: ImportCounts;
}

/** Decide what importing `backup` into a device holding `local` would do. */
export function planImport(backup: ManifestEntry[], local: ManifestEntry[]): ImportPlan {
    const here = new Map(local.map((entry) => [entry.id, entry]));
    const counts: ImportCounts = {
        added: 0,
        restored: 0,
        updated: 0,
        unchanged: 0,
        kept: 0,
        staysDeleted: 0,
    };
    const steps = backup.map((entry) => {
        const step = decide(entry, here.get(entry.id));
        switch (step.outcome) {
            case 'added':
                counts.added++;
                break;
            case 'restored':
                counts.restored++;
                break;
            case 'updated':
                counts.updated++;
                break;
            case 'unchanged':
                counts.unchanged++;
                break;
            case 'kept':
                counts.kept++;
                break;
            case 'stays-deleted':
                counts.staysDeleted++;
                break;
            case 'tombstone':
                break;
        }
        return step;
    });
    return { steps, counts };
}

function decide(entry: ManifestEntry, local: ManifestEntry | undefined): ImportStep {
    const decision = reconcile(entry, local);
    // A backup names a document's content by its hash, and names none when it
    // holds none: there is nothing to merge for a document nobody typed in.
    const hasContent = entry.contentHash !== null;
    const step = (outcome: ImportOutcome, merge = false, d: ImportDecision = decision) => ({
        entry,
        local,
        decision: d,
        outcome,
        merge,
    });

    switch (decision.kind) {
        case 'create':
            return step('added', hasContent);
        case 'revive':
            return step('restored', hasContent);
        case 'update': {
            const merge = decision.pull && hasContent;
            return decision.rename || merge
                ? step('updated', merge)
                : step('unchanged', false, { kind: 'up-to-date' });
        }
        case 'up-to-date':
            return step('unchanged');
        case 'delete':
            // The one departure from sync (ADR 0024, decision 4): an import
            // never deletes a document this device holds live. Sync applies
            // that tombstone because it records what the user did on another
            // device; an import is something the user does to get data back.
            if (local && !local.isDeleted) return step('kept', false, { kind: 'keep' });
            // A tombstone this device already holds: taking the newer stamp
            // removes nothing.
            return step('tombstone');
        case 'record-tombstone':
        case 'stale-tombstone':
            return step('tombstone');
        case 'stays-deleted':
            return step('stays-deleted');
    }
}

/** The part of `DocumentRepository` an import writes through. */
export interface ImportTarget {
    listSyncState(): Promise<ManifestEntry[]>;
    ensureDoc(entry: ManifestEntry): Promise<void>;
    ensureTombstone(entry: ManifestEntry): Promise<void>;
    applyRename(docId: string, title: string, titleUpdatedAt: number): Promise<void>;
    applyDelete(docId: string, deletedAt: number): Promise<boolean>;
    mergeDelta(docId: string, updateB64: string): Promise<void>;
}

/**
 * Tells connected devices what arrived, so they need not wait for their next
 * reconnect to see a restored note. The same messages a user's own edit sends.
 */
export interface ImportAnnouncer {
    created(entry: ManifestEntry): void;
    updated(docId: string, state: string): void;
    renamed(docId: string, title: string, titleUpdatedAt: number): void;
}

export interface ImportResult {
    added: number;
    restored: number;
    /**
     * Documents on both sides that the backup actually changed. Differing is
     * not the same as changing: a copy here that already contains everything
     * the backup's does hashes differently and gains nothing from it.
     */
    changed: number;
    /** Titles of documents that could not be imported. */
    failedTitles: string[];
}

function hasWork(step: ImportStep): boolean {
    switch (step.decision.kind) {
        case 'create':
        case 'revive':
        case 'record-tombstone':
        case 'delete':
            return true;
        case 'update':
            return step.decision.rename || step.merge;
        default:
            return false;
    }
}

/**
 * Carry out a plan. One document at a time, each through the same repository
 * calls a peer's changes take, so an open note takes the change live and its
 * derived rows are rebuilt as they would be for a peer's edit.
 *
 * A document that fails is named in the result and the rest continue: losing
 * one note out of three hundred is not a reason to import none of them.
 */
export async function applyImport(
    plan: ImportPlan,
    readState: (docId: string) => Promise<string | null>,
    target: ImportTarget,
    announce: ImportAnnouncer,
    onProgress: (done: number, total: number) => void = () => {},
): Promise<ImportResult> {
    const work = plan.steps.filter(hasWork);
    const result: ImportResult = { added: 0, restored: 0, changed: 0, failedTitles: [] };
    const updated: ImportStep[] = [];

    const mergeFromBackup = async (docId: string): Promise<void> => {
        const state = await readState(docId);
        if (!state) return;
        await target.mergeDelta(docId, state);
        announce.updated(docId, state);
    };

    onProgress(0, work.length);
    for (const [index, step] of work.entries()) {
        const { entry, decision } = step;
        try {
            switch (decision.kind) {
                case 'record-tombstone':
                    await target.ensureTombstone(entry);
                    break;
                case 'delete':
                    // Only a tombstone this device already holds reaches here.
                    await target.applyDelete(entry.id, decision.deletedAt);
                    break;
                case 'create':
                case 'revive':
                    await target.ensureDoc(entry);
                    announce.created(entry);
                    if (step.merge) await mergeFromBackup(entry.id);
                    if (decision.kind === 'create') result.added++;
                    else result.restored++;
                    break;
                case 'update':
                    if (decision.rename) {
                        await target.applyRename(entry.id, entry.title, entry.titleUpdatedAt);
                        announce.renamed(entry.id, entry.title, entry.titleUpdatedAt);
                    }
                    if (step.merge) await mergeFromBackup(entry.id);
                    updated.push(step);
                    break;
                default:
                    break;
            }
        } catch (e) {
            console.warn(`[backup] could not import ${entry.id}:`, e);
            result.failedTitles.push(entry.title.trim() || 'Untitled');
        }
        onProgress(index + 1, work.length);
    }

    if (updated.length > 0) {
        const after = new Map((await target.listSyncState()).map((e) => [e.id, e]));
        for (const step of updated) {
            const now = after.get(step.entry.id);
            if (!now || !step.local) continue;
            if (now.contentHash !== step.local.contentHash || now.title !== step.local.title) {
                result.changed++;
            }
        }
    }
    return result;
}

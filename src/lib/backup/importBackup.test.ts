import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { applyImport, planImport, type ImportAnnouncer } from './importBackup';
import { reconcile } from '$lib/sync/reconcile';
import { bytesToBase64, type ManifestEntry } from '$lib/sync/protocol';
import { FakeRepo } from '../../test/FakeRepo';

/**
 * A backup of `device` as Rust writes one: every row, tombstones included,
 * and a state only for a live document with content, whose hash is the
 * document's content hash.
 */
async function backupOf(device: FakeRepo) {
    const documents = await device.listSyncState();
    const states = new Map<string, string>();
    for (const entry of documents) {
        if (entry.isDeleted || entry.contentHash === null) continue;
        states.set(entry.id, bytesToBase64(Y.encodeStateAsUpdate(device.docs.get(entry.id)!.ydoc)));
    }
    const readState = async (docId: string) => states.get(docId) ?? null;
    return { documents, readState };
}

function recorder() {
    const calls = {
        created: [] as string[],
        updated: [] as string[],
        renamed: [] as string[],
    };
    const announce: ImportAnnouncer = {
        created: (entry: ManifestEntry) => void calls.created.push(entry.id),
        updated: (docId) => void calls.updated.push(docId),
        renamed: (docId) => void calls.renamed.push(docId),
    };
    return { calls, announce };
}

/** Copy one document from `from` to `to`, as a sync would have. */
function share(from: FakeRepo, to: FakeRepo, id: string): void {
    const source = from.docs.get(id)!;
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(source.ydoc));
    to.docs.set(id, { ...source, ydoc });
}

async function importInto(device: FakeRepo, backup: Awaited<ReturnType<typeof backupOf>>) {
    const plan = planImport(backup.documents, await device.listSyncState());
    const { calls, announce } = recorder();
    const result = await applyImport(plan, backup.readState, device as never, announce);
    return { plan, result, calls };
}

describe('importing a backup', () => {
    it('restores a whole library onto a device that has nothing', async () => {
        const old = new FakeRepo();
        old.seed('groceries', 'milk, eggs');
        old.seed('23 Sep 2026', 'a quiet day');
        old.seed('empty', '');
        old.seed('gone', 'deleted later');
        old.remove('gone', 50);

        const fresh = new FakeRepo();
        const { plan, result, calls } = await importInto(fresh, await backupOf(old));

        expect(plan.counts).toMatchObject({ added: 3, updated: 0, kept: 0 });
        expect(result).toMatchObject({ added: 3, restored: 0, failedTitles: [] });
        expect(fresh.text('groceries')).toBe('milk, eggs');
        expect(fresh.text('23 Sep 2026')).toBe('a quiet day');
        expect(fresh.docs.get('empty')?.isDeleted).toBe(false);
        // The tombstone comes along, so the delete keeps propagating from here.
        expect(fresh.docs.get('gone')?.isDeleted).toBe(true);

        // Connected devices hear about each note, and about the content of the
        // ones that have any.
        expect(calls.created.sort()).toEqual(['23 Sep 2026', 'empty', 'groceries']);
        expect(calls.updated.sort()).toEqual(['23 Sep 2026', 'groceries']);
    });

    it('merges diverged edits rather than choosing between them', async () => {
        const backedUp = new FakeRepo();
        backedUp.seed('doc', 'shared ');
        const here = new FakeRepo();
        share(backedUp, here, 'doc');

        backedUp.docs.get('doc')!.ydoc.getText('content').insert(7, 'from the backup');
        here.docs.get('doc')!.ydoc.getText('content').insert(0, 'from here: ');

        const { plan, result } = await importInto(here, await backupOf(backedUp));
        expect(plan.counts.updated).toBe(1);
        expect(result.changed).toBe(1);
        const text = here.text('doc');
        expect(text).toContain('from here: ');
        expect(text).toContain('from the backup');
    });

    it('never deletes a note that is still here, whatever the backup says', async () => {
        const backedUp = new FakeRepo();
        backedUp.seed('doc', 'keep me');
        const here = new FakeRepo();
        share(backedUp, here, 'doc');
        backedUp.remove('doc', 50);

        const backup = await backupOf(backedUp);
        // Sync would delete it: this is the one place the import differs.
        const local = (await here.listSyncState())[0];
        expect(reconcile(backup.documents[0], local).kind).toBe('delete');

        const { plan } = await importInto(here, backup);
        expect(plan.counts.kept).toBe(1);
        expect(here.docs.get('doc')?.isDeleted).toBe(false);
        expect(here.text('doc')).toBe('keep me');
    });

    it('leaves deleted a note removed here after the backup was made', async () => {
        const backedUp = new FakeRepo();
        backedUp.seed('doc', 'old news');
        const here = new FakeRepo();
        share(backedUp, here, 'doc');
        here.remove('doc', 50);

        const { plan } = await importInto(here, await backupOf(backedUp));
        expect(plan.counts.staysDeleted).toBe(1);
        expect(here.docs.get('doc')?.isDeleted).toBe(true);
    });

    it('brings back a note the backup revived after it was deleted here', async () => {
        const backedUp = new FakeRepo();
        backedUp.seed('doc', 'first');
        const here = new FakeRepo();
        share(backedUp, here, 'doc');
        here.remove('doc', 20);
        backedUp.revive('doc', 30, 'written again');

        const { plan, result } = await importInto(here, await backupOf(backedUp));
        expect(plan.counts.restored).toBe(1);
        expect(result.restored).toBe(1);
        expect(here.docs.get('doc')?.isDeleted).toBe(false);
        expect(here.text('doc')).toBe('written again');
    });

    it('takes a newer title and leaves an older one', async () => {
        const backedUp = new FakeRepo();
        backedUp.seed('renamed-there', 'body', 20);
        backedUp.seed('renamed-here', 'body', 1);
        const here = new FakeRepo();
        share(backedUp, here, 'renamed-there');
        share(backedUp, here, 'renamed-here');
        backedUp.docs.get('renamed-there')!.title = 'New title';
        here.docs.get('renamed-there')!.titleUpdatedAt = 10;
        here.docs.get('renamed-here')!.title = 'Mine';
        here.docs.get('renamed-here')!.titleUpdatedAt = 30;

        const { result, calls } = await importInto(here, await backupOf(backedUp));
        expect(here.docs.get('renamed-there')?.title).toBe('New title');
        expect(here.docs.get('renamed-here')?.title).toBe('Mine');
        expect(calls.renamed).toEqual(['renamed-there']);
        expect(result.changed).toBe(1);
    });

    it('changes nothing the second time the same backup is imported', async () => {
        const old = new FakeRepo();
        old.seed('a', 'alpha');
        old.seed('b', 'beta');
        const backup = await backupOf(old);
        const device = new FakeRepo();
        await importInto(device, backup);

        const again = await importInto(device, backup);
        expect(again.plan.counts).toMatchObject({ added: 0, restored: 0, updated: 0 });
        expect(again.plan.counts.unchanged).toBe(2);
        expect(again.result.changed).toBe(0);
        expect(device.text('a')).toBe('alpha');
    });

    it('does not count a merge that brought nothing new as a change', async () => {
        const backedUp = new FakeRepo();
        backedUp.seed('doc', 'shared');
        const here = new FakeRepo();
        share(backedUp, here, 'doc');
        // Only this side moved on, so the copies differ but the backup has
        // nothing this device lacks.
        here.docs.get('doc')!.ydoc.getText('content').insert(6, ', and more');

        const { plan, result } = await importInto(here, await backupOf(backedUp));
        expect(plan.counts.updated).toBe(1);
        expect(result.changed).toBe(0);
        expect(here.text('doc')).toBe('shared, and more');
    });

    it('names a note it could not import and carries on with the rest', async () => {
        const old = new FakeRepo();
        old.seed('fine', 'ok');
        old.seed('broken', 'not ok');
        const backup = await backupOf(old);
        const readState = async (docId: string) => {
            if (docId === 'broken') throw new Error('damaged entry');
            return backup.readState(docId);
        };

        const device = new FakeRepo();
        const plan = planImport(backup.documents, await device.listSyncState());
        const progress: Array<[number, number]> = [];
        const result = await applyImport(
            plan,
            readState,
            device as never,
            recorder().announce,
            (done, total) => void progress.push([done, total]),
        );

        expect(result.failedTitles).toEqual(['broken']);
        expect(device.text('fine')).toBe('ok');
        expect(progress[0]).toEqual([0, 2]);
        expect(progress.at(-1)).toEqual([2, 2]);
    });
});

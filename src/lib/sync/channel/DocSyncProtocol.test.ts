import { describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';
import { DocSyncProtocol, ATTACH_TIMEOUT_MS, type SyncProgressSink } from './DocSyncProtocol';
import { base64ToBytes, type SyncMessage } from '../protocol';
import { FakeRepo } from '../../../test/FakeRepo';

function silentSink(): SyncProgressSink {
    return { onPhase: () => {}, onProgress: () => {}, onSynced: () => {} };
}

// Runs two protocols against each other over an in-memory link until quiescent.
async function converge(a: FakeRepo, b: FakeRepo): Promise<{ syncedA: boolean; syncedB: boolean }> {
    const queue: Array<{ to: 'a' | 'b'; msg: SyncMessage }> = [];
    let syncedA = false;
    let syncedB = false;

    const sinkA: SyncProgressSink = { ...silentSink(), onSynced: () => (syncedA = true) };
    const sinkB: SyncProgressSink = { ...silentSink(), onSynced: () => (syncedB = true) };

    const protoA = new DocSyncProtocol(
        a as never,
        (m) => void queue.push({ to: 'b', msg: m }),
        sinkA,
    );
    const protoB = new DocSyncProtocol(
        b as never,
        (m) => void queue.push({ to: 'a', msg: m }),
        sinkB,
    );

    await protoA.start();
    await protoB.start();

    let guard = 0;
    while (queue.length > 0) {
        if (guard++ > 10_000) throw new Error('did not converge');
        const { to, msg } = queue.shift()!;
        await (to === 'a' ? protoA : protoB).handle(msg);
    }

    protoA.dispose();
    protoB.dispose();
    return { syncedA, syncedB };
}

function assertConverged(a: FakeRepo, b: FakeRepo): void {
    const ids = new Set([...a.docs.keys(), ...b.docs.keys()]);
    for (const id of ids) {
        const da = a.docs.get(id);
        const db = b.docs.get(id);
        expect(!!da, `${id} missing on A`).toBe(true);
        expect(!!db, `${id} missing on B`).toBe(true);
        expect(da!.isDeleted, `${id} isDeleted mismatch`).toBe(db!.isDeleted);
        if (!da!.isDeleted) {
            expect(a.text(id), `${id} content mismatch`).toBe(b.text(id));
            expect(da!.title, `${id} title mismatch`).toBe(db!.title);
        }
    }
}

describe('DocSyncProtocol', () => {
    it('fresh pair: A has documents, B is empty', async () => {
        const a = new FakeRepo();
        const b = new FakeRepo();
        a.seed('d1', 'hello');
        a.seed('d2', 'world');
        a.seed('d3', 'again');

        const { syncedA, syncedB } = await converge(a, b);

        expect(syncedA && syncedB).toBe(true);
        assertConverged(a, b);
        expect(b.text('d2')).toBe('world');
    });

    it('disjoint non-empty sets converge both directions', async () => {
        const a = new FakeRepo();
        const b = new FakeRepo();
        a.seed('a1', 'alpha');
        a.seed('shared', 'from-a');
        b.seed('b1', 'beta');

        await converge(a, b);
        assertConverged(a, b);
        expect(a.text('b1')).toBe('beta');
        expect(b.text('a1')).toBe('alpha');
    });

    it('concurrent divergent edits on the same document merge', async () => {
        const a = new FakeRepo();
        const b = new FakeRepo();
        a.seed('doc', 'base ');
        // b starts from the same base, then each side edits independently
        b.docs.set('doc', { ...a.docs.get('doc')!, ydoc: new Y.Doc() });
        Y.applyUpdate(b.docs.get('doc')!.ydoc, Y.encodeStateAsUpdate(a.docs.get('doc')!.ydoc));

        a.docs.get('doc')!.ydoc.getText('content').insert(5, 'A-edit ');
        b.docs.get('doc')!.ydoc.getText('content').insert(5, 'B-edit ');

        await converge(a, b);
        assertConverged(a, b);
        const merged = a.text('doc');
        expect(merged).toContain('A-edit');
        expect(merged).toContain('B-edit');
    });

    // A journal id is derived from its date, so deleting one and letting the
    // app recreate it reuses the same row. Before the lifecycle stamp existed
    // the peer's surviving tombstone re-deleted the revival on the next
    // exchange, and the journal vanished again.
    it('revival beats an older tombstone on both sides', async () => {
        const a = new FakeRepo();
        const b = new FakeRepo();
        a.seed('14 Sep 2026', 'first draft');
        b.docs.set('14 Sep 2026', { ...a.docs.get('14 Sep 2026')!, ydoc: new Y.Doc() });
        Y.applyUpdate(
            b.docs.get('14 Sep 2026')!.ydoc,
            Y.encodeStateAsUpdate(a.docs.get('14 Sep 2026')!.ydoc),
        );

        // Both observe the delete, then A recreates the journal afterwards.
        a.remove('14 Sep 2026', 100);
        b.remove('14 Sep 2026', 100);
        a.revive('14 Sep 2026', 200, 'second draft');

        await converge(a, b);

        expect(a.docs.get('14 Sep 2026')!.isDeleted).toBe(false);
        expect(b.docs.get('14 Sep 2026')!.isDeleted).toBe(false);
        assertConverged(a, b);
        expect(b.text('14 Sep 2026')).toBe('second draft');
    });

    it('a tombstone newer than a revival still wins', async () => {
        const a = new FakeRepo();
        const b = new FakeRepo();
        a.seed('doc', 'content');
        b.docs.set('doc', { ...a.docs.get('doc')!, ydoc: new Y.Doc() });

        a.revive('doc', 100, 'revived');
        b.remove('doc', 300);

        await converge(a, b);

        expect(a.docs.get('doc')!.isDeleted).toBe(true);
        expect(b.docs.get('doc')!.isDeleted).toBe(true);
    });

    it('delete and revive in opposite orders converge', async () => {
        const a = new FakeRepo();
        const b = new FakeRepo();
        a.seed('doc', 'base');
        b.docs.set('doc', { ...a.docs.get('doc')!, ydoc: new Y.Doc() });

        // A deletes late; B revived earlier. The later observation must win on
        // both sides regardless of which side reports it.
        a.remove('doc', 500);
        b.revive('doc', 400, 'stale revival');

        await converge(a, b);

        expect(a.docs.get('doc')!.isDeleted).toBe(true);
        expect(b.docs.get('doc')!.isDeleted).toBe(true);
    });

    it('a plain tombstone still propagates to a peer that has the document', async () => {
        const a = new FakeRepo();
        const b = new FakeRepo();
        a.seed('doc', 'content');
        b.docs.set('doc', { ...a.docs.get('doc')!, ydoc: new Y.Doc() });

        a.remove('doc', 100);

        await converge(a, b);

        expect(b.docs.get('doc')!.isDeleted).toBe(true);
    });

    it('rename race: higher title_updated_at wins on both sides', async () => {
        const a = new FakeRepo();
        const b = new FakeRepo();
        a.seed('doc', 'x', 10);
        b.docs.set('doc', { ...a.docs.get('doc')!, ydoc: new Y.Doc() });
        Y.applyUpdate(b.docs.get('doc')!.ydoc, Y.encodeStateAsUpdate(a.docs.get('doc')!.ydoc));

        a.docs.get('doc')!.title = 'from-a';
        a.docs.get('doc')!.titleUpdatedAt = 20;
        b.docs.get('doc')!.title = 'from-b';
        b.docs.get('doc')!.titleUpdatedAt = 30;

        await converge(a, b);
        expect(a.docs.get('doc')!.title).toBe('from-b');
        expect(b.docs.get('doc')!.title).toBe('from-b');
    });

    it('delete propagates to a peer that still has the document', async () => {
        const a = new FakeRepo();
        const b = new FakeRepo();
        a.seed('gone', 'bye');
        b.seed('gone', 'bye');
        await a.applyDelete('gone', 100);

        await converge(a, b);
        expect(b.docs.get('gone')!.isDeleted).toBe(true);
    });

    // Three devices, meeting in pairs. C never held the document, so before
    // this the tombstone died at C: it was dropped on arrival, never went into
    // C's manifest, and B then handed the document back to C on the next
    // exchange. The delete flapped until all three had met since it happened,
    // and never settled at all once A was gone.
    it('a delete reaches a third device through one that never held the document', async () => {
        const a = new FakeRepo();
        const b = new FakeRepo();
        const c = new FakeRepo();
        a.seed('gone', 'bye');
        b.seed('gone', 'bye');
        await a.applyDelete('gone', 100);

        // A meets C, which has never heard of this document.
        await converge(a, c);
        expect(c.docs.get('gone')?.isDeleted).toBe(true);

        // B, still holding it, now meets only C. C must carry the delete
        // rather than accept the document back.
        await converge(b, c);
        expect(b.docs.get('gone')!.isDeleted).toBe(true);
        expect(c.docs.get('gone')!.isDeleted).toBe(true);
    });

    it('a recorded tombstone does not resurrect as an empty document', async () => {
        // The failure mode if a tombstone were materialised as a live row:
        // the peer sees a document it does not have and pulls it, leaving an
        // untitled empty note on every device.
        const a = new FakeRepo();
        const c = new FakeRepo();
        a.seed('gone', 'bye');
        await a.applyDelete('gone', 100);

        await converge(a, c);

        expect(c.docs.get('gone')!.isDeleted).toBe(true);
        expect(c.text('gone')).toBe('');
    });

    it('reconnect after an offline edit transfers only the delta', async () => {
        const a = new FakeRepo();
        const b = new FakeRepo();
        a.seed('doc', 'shared');
        b.docs.set('doc', { ...a.docs.get('doc')!, ydoc: new Y.Doc() });
        Y.applyUpdate(b.docs.get('doc')!.ydoc, Y.encodeStateAsUpdate(a.docs.get('doc')!.ydoc));

        await converge(a, b); // first sync
        b.docs.get('doc')!.ydoc.getText('content').insert(6, ' MORE');

        let deltaBytes = 0;
        const origCompute = b.computeDelta.bind(b);
        b.computeDelta = async (id, sv) => {
            const r = await origCompute(id, sv);
            if (r) deltaBytes = base64ToBytes(r).length;
            return r;
        };

        const { syncedA, syncedB } = await converge(a, b);
        assertConverged(a, b);
        expect(a.text('doc')).toBe('shared MORE');
        // a real delta moved, and it is smaller than a full re-encode
        expect(deltaBytes).toBeGreaterThan(0);
        expect(deltaBytes).toBeLessThan(Y.encodeStateAsUpdate(a.docs.get('doc')!.ydoc).length);
        // the side that had nothing to send (A) still settles the doc and
        // reaches "synced" - it is not left waiting on B's `sync-need`.
        expect(syncedA && syncedB).toBe(true);
    });

    it('a `sync-need` the holder cannot fill is answered with `sync-none`', async () => {
        const a = new FakeRepo();
        const b = new FakeRepo();
        // Same doc, but B is strictly ahead - A has no delta for B's request.
        a.seed('doc', 'base');
        b.docs.set('doc', { ...a.docs.get('doc')!, ydoc: new Y.Doc() });
        Y.applyUpdate(b.docs.get('doc')!.ydoc, Y.encodeStateAsUpdate(a.docs.get('doc')!.ydoc));
        b.docs.get('doc')!.ydoc.getText('content').insert(4, '!');

        const queue: Array<{ to: 'a' | 'b'; msg: SyncMessage }> = [];
        const pa = new DocSyncProtocol(
            a as never,
            (m) => void queue.push({ to: 'b', msg: m }),
            silentSink(),
        );
        const pb = new DocSyncProtocol(
            b as never,
            (m) => void queue.push({ to: 'a', msg: m }),
            silentSink(),
        );

        await pa.start();
        await pb.start();

        let aSentNone = false;
        let guard = 0;
        while (queue.length > 0) {
            if (guard++ > 5000) throw new Error('did not converge');
            const { to, msg } = queue.shift()!;
            if (to === 'b' && msg.t === 'sync-none') aSentNone = true;
            await (to === 'a' ? pa : pb).handle(msg);
        }
        pa.dispose();
        pb.dispose();

        expect(aSentNone).toBe(true); // A answered rather than going silent
        expect(a.text('doc')).toBe('base!'); // and B's edit still reached A
    });

    it('idle reconnect of an identical set is a no-op', async () => {
        const a = new FakeRepo();
        const b = new FakeRepo();
        a.seed('doc', 'same');
        b.seed('doc', 'same');
        await converge(a, b); // hashes now equal on both

        let deltas = 0;
        const origA = a.computeDelta.bind(a);
        a.computeDelta = async (id, sv) => {
            deltas++;
            return origA(id, sv);
        };

        await converge(a, b);
        expect(deltas).toBe(0);
    });

    it('a peer pulls attachment bytes it is missing', async () => {
        const a = new FakeRepo();
        const b = new FakeRepo();
        a.attachments.set('abc123', { mime: 'image/png', data: 'AAAA' });
        a.attachments.set('def456', { mime: 'image/jpeg', data: 'BBBB' });
        b.attachments.set('abc123', { mime: 'image/png', data: 'AAAA' }); // already has one

        await converge(a, b);

        expect(b.attachments.get('def456')).toEqual({ mime: 'image/jpeg', data: 'BBBB' });
        expect(a.attachments.size).toBe(2); // unchanged
    });

    it('attachment transfer does not block the document finish gate', async () => {
        const a = new FakeRepo();
        const b = new FakeRepo();
        a.seed('d1', 'hello');
        a.attachments.set('img', { mime: 'image/png', data: 'X'.repeat(1000) });

        const { syncedA, syncedB } = await converge(a, b);

        expect(syncedA && syncedB).toBe(true);
        expect(b.attachments.has('img')).toBe(true);
    });

    it('a holder that lost the bytes answers attach-missing without crashing', async () => {
        const b = new FakeRepo();
        // A advertises a hash (via a hand-rolled manifest) it cannot actually serve.
        const sent: SyncMessage[] = [];
        const proto = new DocSyncProtocol(b as never, (m) => void sent.push(m), silentSink());
        await proto.start();
        await proto.handle({
            t: 'attach-manifest',
            items: [{ hash: 'ghost', mime: 'image/png', size: 1 }],
        });
        await proto.handle({ t: 'attach-missing', hash: 'ghost' });

        expect(b.attachments.has('ghost')).toBe(false);
        proto.dispose();
    });

    // The retry counter used to live in the in-flight map, which the timeout
    // handler cleared before requeueing. Every read therefore missed and the
    // count reset to 1, so MAX_ATTACH_ATTEMPTS was unreachable and a silent
    // peer was polled every 30s for the life of the connection.
    it('gives up on an attachment after the attempt limit', async () => {
        vi.useFakeTimers();
        try {
            const b = new FakeRepo();
            const sent: SyncMessage[] = [];
            const proto = new DocSyncProtocol(b as never, (m) => void sent.push(m), silentSink());
            await proto.start();

            // A peer that advertises a hash and then never answers attach-need.
            await proto.handle({
                t: 'attach-manifest',
                items: [{ hash: 'ghost', mime: 'image/png', size: 1 }],
            });

            const needs = () => sent.filter((m) => m.t === 'attach-need').length;
            expect(needs()).toBe(1);

            // Two timeout windows past the limit: the count must not restart.
            await vi.advanceTimersByTimeAsync(ATTACH_TIMEOUT_MS + 1);
            expect(needs()).toBe(2);

            await vi.advanceTimersByTimeAsync(ATTACH_TIMEOUT_MS + 1);
            await vi.advanceTimersByTimeAsync(ATTACH_TIMEOUT_MS + 1);
            expect(needs()).toBe(2);

            proto.dispose();
        } finally {
            vi.useRealTimers();
        }
    });

    it('a retried attachment still lands if the peer answers late', async () => {
        vi.useFakeTimers();
        try {
            const b = new FakeRepo();
            const sent: SyncMessage[] = [];
            const proto = new DocSyncProtocol(b as never, (m) => void sent.push(m), silentSink());
            await proto.start();

            await proto.handle({
                t: 'attach-manifest',
                items: [{ hash: 'slow', mime: 'image/png', size: 1 }],
            });
            await vi.advanceTimersByTimeAsync(ATTACH_TIMEOUT_MS + 1);

            await proto.handle({
                t: 'attach-data',
                hash: 'slow',
                mime: 'image/png',
                data: 'ZZZZ',
            });

            expect(b.attachments.get('slow')).toEqual({ mime: 'image/png', data: 'ZZZZ' });
            proto.dispose();
        } finally {
            vi.useRealTimers();
        }
    });
});

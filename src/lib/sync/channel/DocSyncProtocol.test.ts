import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { DocSyncProtocol, type SyncProgressSink } from './DocSyncProtocol';
import { bytesToBase64, base64ToBytes, type ManifestEntry, type SyncMessage } from '../protocol';
import { contentHashBase64 } from '../hash';

// A DocumentRepository stand-in backed by real Y.Docs. Mirrors the semantics
// the protocol relies on (deterministic update encoding, empty-update sentinel,
// LWW rename, tombstones) without Tauri.
class FakeRepo {
    docs = new Map<
        string,
        { docType: string; title: string; titleUpdatedAt: number; createdAt: number; isDeleted: boolean; deletedAt: number | null; ydoc: Y.Doc }
    >();

    seed(id: string, text: string, titleUpdatedAt = 1): void {
        const ydoc = new Y.Doc();
        ydoc.getText('content').insert(0, text);
        this.docs.set(id, { docType: 'note', title: id, titleUpdatedAt, createdAt: 1, isDeleted: false, deletedAt: null, ydoc });
    }

    text(id: string): string {
        return this.docs.get(id)?.ydoc.getText('content').toString() ?? '';
    }

    async listSyncState(): Promise<ManifestEntry[]> {
        const out: ManifestEntry[] = [];
        for (const [id, d] of this.docs) {
            const state = Y.encodeStateAsUpdate(d.ydoc);
            out.push({
                id,
                docType: d.docType,
                title: d.title,
                titleUpdatedAt: d.titleUpdatedAt,
                createdAt: d.createdAt,
                isDeleted: d.isDeleted,
                deletedAt: d.deletedAt,
                contentHash: state.length <= 2 ? null : await contentHashBase64(state),
            });
        }
        return out;
    }

    async localStateVector(id: string): Promise<string> {
        const d = this.docs.get(id);
        return bytesToBase64(Y.encodeStateVector(d ? d.ydoc : new Y.Doc()));
    }

    async computeDelta(id: string, svB64: string): Promise<string | null> {
        const d = this.docs.get(id);
        if (!d) return null;
        const diff = svB64
            ? Y.encodeStateAsUpdate(d.ydoc, base64ToBytes(svB64))
            : Y.encodeStateAsUpdate(d.ydoc);
        return diff.length <= 2 ? null : bytesToBase64(diff);
    }

    async mergeDelta(id: string, updateB64: string): Promise<void> {
        const d = this.docs.get(id);
        if (!d) throw new Error(`mergeDelta for unknown ${id}`);
        Y.applyUpdate(d.ydoc, base64ToBytes(updateB64));
    }

    async ensureDoc(entry: ManifestEntry): Promise<void> {
        if (this.docs.has(entry.id)) return;
        this.docs.set(entry.id, {
            docType: entry.docType,
            title: entry.title,
            titleUpdatedAt: entry.titleUpdatedAt,
            createdAt: entry.createdAt,
            isDeleted: false,
            deletedAt: null,
            ydoc: new Y.Doc(),
        });
    }

    async applyRename(id: string, title: string, titleUpdatedAt: number): Promise<void> {
        const d = this.docs.get(id);
        if (d && (d.titleUpdatedAt ?? 0) < titleUpdatedAt) {
            d.title = title;
            d.titleUpdatedAt = titleUpdatedAt;
        }
    }

    async applyDelete(id: string, deletedAt: number): Promise<void> {
        const d = this.docs.get(id);
        if (d) {
            d.isDeleted = true;
            d.deletedAt = deletedAt;
            d.ydoc = new Y.Doc();
        }
    }
}

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

    const protoA = new DocSyncProtocol(a as never, (m) => void queue.push({ to: 'b', msg: m }), sinkA);
    const protoB = new DocSyncProtocol(b as never, (m) => void queue.push({ to: 'a', msg: m }), sinkB);

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

        await converge(a, b);
        assertConverged(a, b);
        expect(a.text('doc')).toBe('shared MORE');
        // a real delta moved, and it is smaller than a full re-encode
        expect(deltaBytes).toBeGreaterThan(0);
        expect(deltaBytes).toBeLessThan(Y.encodeStateAsUpdate(a.docs.get('doc')!.ydoc).length);
    });

    it('idle reconnect of an identical set is a no-op', async () => {
        const a = new FakeRepo();
        const b = new FakeRepo();
        a.seed('doc', 'same');
        b.seed('doc', 'same');
        await converge(a, b); // hashes now equal on both

        let deltas = 0;
        const origA = a.computeDelta.bind(a);
        a.computeDelta = async (id, sv) => { deltas++; return origA(id, sv); };

        await converge(a, b);
        expect(deltas).toBe(0);
    });
});

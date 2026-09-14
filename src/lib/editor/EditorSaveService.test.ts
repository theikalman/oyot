import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';

// The service talks to Tauri through the repository and to peers through the
// sync layer; neither exists under vitest. Capture the calls instead.
const saved: Array<{ docId: string; state: Uint8Array }> = [];
const broadcast: Array<{ docId: string; update: string }> = [];
let saveShouldThrow = false;

vi.mock('$lib/sync', () => ({
    documentRepository: {
        saveLocalUpdate: async (docId: string, mergedState: Uint8Array) => {
            if (saveShouldThrow) throw new Error('boom');
            saved.push({ docId, state: mergedState });
        },
    },
    broadcastLocalUpdate: (docId: string, update: string) => {
        broadcast.push({ docId, update });
    },
}));

const counts: Array<{ docId: string; todo: number; done: number }> = [];
vi.mock('$lib/stores/app', () => ({
    appStore: {
        markDocumentHasContent: () => {},
        setDocumentCounts: (docId: string, todo: number, done: number) =>
            counts.push({ docId, todo, done }),
    },
}));

vi.mock('$lib/services/toast', () => ({
    toasts: { error: () => {} },
}));

const { EditorSaveService, persistSnapshot } = await import('./EditorSaveService');

function docWith(text: string): Y.Doc {
    const ydoc = new Y.Doc();
    ydoc.getText('content').insert(0, text);
    return ydoc;
}

function asDocument(id: string) {
    return { id } as never;
}

// Text a Yjs update decodes to, so a test can assert *which* document's content
// was written rather than just that something was.
function textOf(state: Uint8Array): string {
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, state);
    return ydoc.getText('content').toString();
}

describe('EditorSaveService', () => {
    beforeEach(() => {
        saved.length = 0;
        broadcast.length = 0;
        counts.length = 0;
        saveShouldThrow = false;
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('flushNow writes the document that was set, not one set later', async () => {
        // The regression this guards: the old flush read `this.ydoc` after the
        // editor had already been swapped, writing the incoming document's
        // state under the outgoing document's id.
        const svc = new EditorSaveService();
        svc.setDocument(asDocument('doc-a'));
        svc.setYDoc(docWith('alpha'));

        const pending = svc.flushNow();

        // Swap in a different document before the write settles.
        svc.setDocument(asDocument('doc-b'));
        svc.setYDoc(docWith('beta'));

        await pending;

        expect(saved).toHaveLength(1);
        expect(saved[0].docId).toBe('doc-a');
        expect(textOf(saved[0].state)).toBe('alpha');
    });

    it('triggerSave coalesces a burst into a single write', async () => {
        const svc = new EditorSaveService({ debounceMs: 100 });
        svc.setDocument(asDocument('doc'));
        svc.setYDoc(docWith('hello'));

        svc.triggerSave();
        svc.triggerSave();
        svc.triggerSave();
        expect(saved).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(100);
        expect(saved).toHaveLength(1);
    });

    it('flushNow cancels a pending debounce so the edit is written once', async () => {
        const svc = new EditorSaveService({ debounceMs: 100 });
        svc.setDocument(asDocument('doc'));
        svc.setYDoc(docWith('hello'));

        svc.triggerSave();
        expect(svc.hasPendingWrite()).toBe(true);

        await svc.flushNow();
        expect(svc.hasPendingWrite()).toBe(false);
        expect(saved).toHaveLength(1);

        // The cancelled timer must not fire a second write.
        await vi.advanceTimersByTimeAsync(200);
        expect(saved).toHaveLength(1);
    });

    it('flushNow after destroy is a no-op', async () => {
        const svc = new EditorSaveService();
        svc.setDocument(asDocument('doc'));
        svc.setYDoc(docWith('hello'));

        svc.destroy();

        expect(svc.flushNow()).toBeNull();
        expect(saved).toHaveLength(0);
    });

    it('destroy cancels a pending write', async () => {
        const svc = new EditorSaveService({ debounceMs: 100 });
        svc.setDocument(asDocument('doc'));
        svc.setYDoc(docWith('hello'));

        svc.triggerSave();
        svc.destroy();

        await vi.advanceTimersByTimeAsync(200);
        expect(saved).toHaveLength(0);
    });

    it('an untouched document is not written', () => {
        // A fresh Y.Doc encodes to a 2-byte "empty update", never zero length,
        // so a `=== 0` guard here would let every opened-but-unedited document
        // write a row and broadcast it to every peer.
        const svc = new EditorSaveService();
        svc.setDocument(asDocument('doc'));
        svc.setYDoc(new Y.Doc());

        expect(svc.flushNow()).toBeNull();
        expect(saved).toHaveLength(0);
        expect(broadcast).toHaveLength(0);
    });

    it('a save broadcasts the edit it recorded', async () => {
        const ydoc = docWith('shared');
        const svc = new EditorSaveService();
        svc.setDocument(asDocument('doc'));
        svc.setYDoc(ydoc);

        const updates: Uint8Array[] = [];
        ydoc.on('update', (u: Uint8Array) => updates.push(u));
        ydoc.getText('content').insert(6, '!');
        svc.recordUpdate(updates[0]);

        await svc.flushNow();

        expect(broadcast).toHaveLength(1);
        expect(broadcast[0].docId).toBe('doc');
        const peer = new Y.Doc();
        Y.applyUpdate(peer, saved[0].state);
        expect(peer.getText('content').toString()).toBe('shared!');
    });

    // The sidebar badge read whatever the counts had been when the app
    // opened, however many tasks had been ticked since: nothing pushed the
    // new numbers into the store after a save.
    it('pushes the task counts it extracted into the store', async () => {
        const svc = new EditorSaveService();
        svc.setDocument(asDocument('doc'));
        svc.setYDoc(docWith('two tasks'));
        svc.setIndexReader(() => ({
            text: 'two tasks',
            linkTargets: [],
            attachmentHashes: [],
            todoCount: 2,
            completedTodoCount: 1,
        }));

        await svc.flushNow();

        expect(counts).toEqual([{ docId: 'doc', todo: 2, done: 1 }]);
    });

    it('a failed save reports instead of rejecting the caller', async () => {
        saveShouldThrow = true;
        const svc = new EditorSaveService();
        svc.setDocument(asDocument('doc'));
        svc.setYDoc(docWith('hello'));

        // Teardown paths call this without awaiting, so it must not produce an
        // unhandled rejection.
        await expect(svc.flushNow()).resolves.toBeUndefined();
        expect(broadcast).toHaveLength(0);
    });
});

describe('delta broadcasting', () => {
    beforeEach(() => {
        saved.length = 0;
        broadcast.length = 0;
        counts.length = 0;
        saveShouldThrow = false;
        vi.useFakeTimers();
    });
    afterEach(() => vi.useRealTimers());

    // Peers only need what changed; the full state is what goes to disk,
    // because crdt_state is a materialised column.
    it('broadcasts only the recorded edits, not the whole document', async () => {
        const ydoc = docWith('a long pre-existing body of text');
        // A peer that already has this document, i.e. shares its history. A
        // lookalike doc with the same text would not do: it has different
        // client ids, so a delta would have nothing to attach to.
        const peer = new Y.Doc();
        Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));

        const svc = new EditorSaveService();
        svc.setDocument(asDocument('doc'));
        svc.setYDoc(ydoc);

        // Capture the update Yjs emits for one small edit.
        const updates: Uint8Array[] = [];
        ydoc.on('update', (u: Uint8Array) => updates.push(u));
        ydoc.getText('content').insert(0, '!');
        expect(updates).toHaveLength(1);

        svc.recordUpdate(updates[0]);
        await svc.flushNow();

        const persisted = saved[0].state;
        const sent = Uint8Array.from(atob(broadcast[0].update), (c) => c.charCodeAt(0));
        expect(sent.length).toBeLessThan(persisted.length);

        // And the delta still carries the edit.
        Y.applyUpdate(peer, sent);
        expect(peer.getText('content').toString()).toBe(ydoc.getText('content').toString());
    });

    it('coalesces several edits into one delta', async () => {
        const ydoc = docWith('base');
        const peer = new Y.Doc();
        Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));

        const svc = new EditorSaveService({ debounceMs: 50 });
        svc.setDocument(asDocument('doc'));
        svc.setYDoc(ydoc);

        const updates: Uint8Array[] = [];
        ydoc.on('update', (u: Uint8Array) => updates.push(u));
        ydoc.getText('content').insert(4, ' one');
        ydoc.getText('content').insert(8, ' two');
        expect(updates).toHaveLength(2);
        for (const u of updates) svc.recordUpdate(u);

        await vi.advanceTimersByTimeAsync(50);

        // Two edits, one broadcast carrying both.
        expect(broadcast).toHaveLength(1);
        const sent = Uint8Array.from(atob(broadcast[0].update), (c) => c.charCodeAt(0));
        Y.applyUpdate(peer, sent);
        expect(peer.getText('content').toString()).toBe('base one two');
    });

    it('writes but sends nothing when no local edit was recorded', async () => {
        // The regression this guards: falling back to the whole document here
        // meant a peer's edit arriving in the open document triggered a save
        // that sent the entire document straight back to that peer, once per
        // remote keystroke batch.
        const svc = new EditorSaveService();
        svc.setDocument(asDocument('doc'));
        svc.setYDoc(docWith('content'));

        await svc.flushNow();

        expect(saved).toHaveLength(1);
        expect(broadcast).toHaveLength(0);
    });

    it('does not carry a pending delta across a document switch', async () => {
        const ydoc = docWith('first');
        const svc = new EditorSaveService();
        svc.setDocument(asDocument('doc-a'));
        svc.setYDoc(ydoc);

        const updates: Uint8Array[] = [];
        ydoc.on('update', (u: Uint8Array) => updates.push(u));
        ydoc.getText('content').insert(0, 'x');
        svc.recordUpdate(updates[0]);

        // Switching documents must drop it: broadcasting one document's edit
        // under another's id would corrupt the peer's copy.
        svc.setDocument(asDocument('doc-b'));
        expect(svc.takePendingDelta()).toBeNull();
    });

    it('a delta is consumed once', async () => {
        const ydoc = docWith('base');
        const svc = new EditorSaveService();
        svc.setDocument(asDocument('doc'));
        svc.setYDoc(ydoc);

        const updates: Uint8Array[] = [];
        ydoc.on('update', (u: Uint8Array) => updates.push(u));
        ydoc.getText('content').insert(0, 'y');
        svc.recordUpdate(updates[0]);

        expect(svc.takePendingDelta()).not.toBeNull();
        expect(svc.takePendingDelta()).toBeNull();
    });

    it('recordUpdate after destroy is ignored', () => {
        const svc = new EditorSaveService();
        svc.setDocument(asDocument('doc'));
        svc.setYDoc(docWith('x'));
        svc.destroy();

        svc.recordUpdate(new Uint8Array([1, 2, 3]));
        expect(svc.hasPendingWrite()).toBe(false);
        expect(svc.takePendingDelta()).toBeNull();
    });
});

describe('persistSnapshot', () => {
    beforeEach(() => {
        saved.length = 0;
        broadcast.length = 0;
        saveShouldThrow = false;
    });

    it('writes and broadcasts exactly what it was handed', async () => {
        const state = Y.encodeStateAsUpdate(docWith('captured'));
        await persistSnapshot('doc-x', state, state);

        expect(saved).toEqual([{ docId: 'doc-x', state }]);
        expect(broadcast[0].docId).toBe('doc-x');
    });

    it('writes without broadcasting when handed no delta', async () => {
        const state = Y.encodeStateAsUpdate(docWith('captured'));
        await persistSnapshot('doc-x', state, null);

        expect(saved).toHaveLength(1);
        expect(broadcast).toHaveLength(0);
    });

    it('skips an empty snapshot', async () => {
        await persistSnapshot('doc-x', new Uint8Array(), null);
        expect(saved).toHaveLength(0);
    });

    it('skips the bare empty Yjs update', async () => {
        const empty = Y.encodeStateAsUpdate(new Y.Doc());
        await persistSnapshot('doc-x', empty, empty);
        expect(saved).toHaveLength(0);
        expect(broadcast).toHaveLength(0);
    });
});

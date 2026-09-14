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

vi.mock('$lib/stores/app', () => ({
    appStore: { markDocumentHasContent: () => {} },
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

    it('a save broadcasts the same content it persisted', async () => {
        const svc = new EditorSaveService();
        svc.setDocument(asDocument('doc'));
        svc.setYDoc(docWith('shared'));

        await svc.flushNow();

        expect(broadcast).toHaveLength(1);
        expect(broadcast[0].docId).toBe('doc');
        const decoded = Uint8Array.from(atob(broadcast[0].update), (c) => c.charCodeAt(0));
        expect(textOf(decoded)).toBe('shared');
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

describe('persistSnapshot', () => {
    beforeEach(() => {
        saved.length = 0;
        broadcast.length = 0;
        saveShouldThrow = false;
    });

    it('writes and broadcasts exactly what it was handed', async () => {
        const state = Y.encodeStateAsUpdate(docWith('captured'));
        await persistSnapshot('doc-x', state);

        expect(saved).toEqual([{ docId: 'doc-x', state }]);
        expect(broadcast[0].docId).toBe('doc-x');
    });

    it('skips an empty snapshot', async () => {
        await persistSnapshot('doc-x', new Uint8Array());
        expect(saved).toHaveLength(0);
    });

    it('skips the bare empty Yjs update', async () => {
        await persistSnapshot('doc-x', Y.encodeStateAsUpdate(new Y.Doc()));
        expect(saved).toHaveLength(0);
        expect(broadcast).toHaveLength(0);
    });
});

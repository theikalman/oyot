import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as Y from 'yjs';

// Every command the repository calls, recorded rather than performed. `state`
// stands in for the `crdt_state` column.
const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
let storedState = '';
let onSave: (() => void) | null = null;

vi.mock('@tauri-apps/api/core', () => ({
    invoke: async (cmd: string, args: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === 'get_yjs_state') return { doc_id: args.docId, state: storedState };
        if (cmd === 'save_yjs_update') {
            storedState = args.mergedState as string;
            onSave?.();
            return undefined;
        }
        return undefined;
    },
}));

const { DocumentRepository } = await import('./DocumentRepository');
const { getOpenDoc, registerOpenDoc, unregisterOpenDoc } = await import('../editor/openDocs');
const { bytesToBase64, base64ToBytes } = await import('./protocol');
const { getSchema } = await import('@tiptap/core');
const { prosemirrorJSONToYDoc } = await import('@tiptap/y-tiptap');
const { createContentExtensions } = await import('../editor/extensions');

// A Y.Doc holding a real ProseMirror document, the way one authored in the
// editor on another device arrives here.
function authored(text: string): Y.Doc {
    return prosemirrorJSONToYDoc(
        getSchema(createContentExtensions()),
        { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
        'content',
    );
}

function docWith(text: string): Y.Doc {
    const doc = new Y.Doc();
    doc.getText('content').insert(0, text);
    return doc;
}

function textOfB64(b64: string): string {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, base64ToBytes(b64));
    return doc.getText('content').toString();
}

// An update carrying `edit` applied on top of `base`'s history, which is what a
// peer's delta looks like: it only attaches to a document that shares the
// history.
function deltaFrom(base: Y.Doc, edit: (doc: Y.Doc) => void): string {
    const fork = new Y.Doc();
    Y.applyUpdate(fork, Y.encodeStateAsUpdate(base));
    const before = Y.encodeStateVector(fork);
    edit(fork);
    return bytesToBase64(Y.encodeStateAsUpdate(fork, before));
}

describe('DocumentRepository', () => {
    beforeEach(() => {
        calls.length = 0;
        storedState = '';
        onSave = null;
    });

    it('merges into the open document rather than reloading it', async () => {
        const repo = new DocumentRepository();
        const live = docWith('hello');
        storedState = bytesToBase64(Y.encodeStateAsUpdate(live));
        registerOpenDoc('doc', live);

        const delta = deltaFrom(live, (d) => d.getText('content').insert(5, ' world'));
        await repo.mergeDelta('doc', delta);

        // The peer's edit is on screen, because it went into the document the
        // editor is holding.
        expect(live.getText('content').toString()).toBe('hello world');
        expect(calls.some((c) => c.cmd === 'get_yjs_state')).toBe(false);

        const saved = calls.find((c) => c.cmd === 'save_yjs_update');
        expect(textOfB64(saved?.args.mergedState as string)).toBe('hello world');

        unregisterOpenDoc('doc', live);
    });

    it('tags the merge so the editor does not rebroadcast it', async () => {
        const repo = new DocumentRepository();
        const live = docWith('base');
        storedState = bytesToBase64(Y.encodeStateAsUpdate(live));
        registerOpenDoc('doc', live);

        const origins: unknown[] = [];
        live.on('update', (_u: Uint8Array, origin: unknown) => origins.push(origin));

        await repo.mergeDelta(
            'doc',
            deltaFrom(live, (d) => d.getText('content').insert(4, '!')),
        );

        // The editor's listener skips REMOTE_ORIGIN; anything else would echo
        // the peer's own edit straight back at it.
        expect(origins).toEqual(['oyot:remote']);
        unregisterOpenDoc('doc', live);
    });

    it('loads from storage when the document is not open', async () => {
        const repo = new DocumentRepository();
        const stored = docWith('stored');
        storedState = bytesToBase64(Y.encodeStateAsUpdate(stored));

        await repo.mergeDelta(
            'doc',
            deltaFrom(stored, (d) => d.getText('content').insert(6, '!')),
        );

        expect(calls.some((c) => c.cmd === 'get_yjs_state')).toBe(true);
        expect(textOfB64(storedState)).toBe('stored!');
    });

    it('openDocument registers the document it returns', async () => {
        const repo = new DocumentRepository();
        storedState = bytesToBase64(Y.encodeStateAsUpdate(docWith('opened')));

        const ydoc = await repo.openDocument('doc');

        expect(ydoc.getText('content').toString()).toBe('opened');
        expect(getOpenDoc('doc')).toBe(ydoc);
        unregisterOpenDoc('doc', ydoc);
    });

    it('does not open on state a queued merge has already superseded', async () => {
        // The window this closes: read the stored state, a peer's merge lands,
        // then the editor registers and opens on the copy from before the
        // merge, which its next save would write back over the newer one.
        const repo = new DocumentRepository();
        const base = docWith('base');
        storedState = bytesToBase64(Y.encodeStateAsUpdate(base));

        const merge = repo.mergeDelta(
            'doc',
            deltaFrom(base, (d) => d.getText('content').insert(4, ' plus peer')),
        );
        const open = repo.openDocument('doc');

        await Promise.all([merge, open]);
        const ydoc = await open;

        expect(ydoc.getText('content').toString()).toBe('base plus peer');
        unregisterOpenDoc('doc', ydoc);
    });

    it('does not lose a merge that lands between encoding a save and writing it', async () => {
        // The editor encodes its snapshot synchronously and then queues. A
        // merge queued ahead of that save is not in the snapshot, so writing
        // the snapshot verbatim would drop the peer's edit from storage while
        // the open document still shows it.
        const repo = new DocumentRepository();
        const live = docWith('typed');
        storedState = bytesToBase64(Y.encodeStateAsUpdate(live));
        registerOpenDoc('doc', live);

        const snapshotBeforeMerge = Y.encodeStateAsUpdate(live);
        const merge = repo.mergeDelta(
            'doc',
            deltaFrom(live, (d) => d.getText('content').insert(5, ' and synced')),
        );
        const save = repo.saveLocalUpdate('doc', snapshotBeforeMerge);

        await Promise.all([merge, save]);

        expect(textOfB64(storedState)).toBe('typed and synced');
        unregisterOpenDoc('doc', live);
    });

    // Before this, a document that arrived from a peer was written with no
    // index: invisible to search, contributing no backlinks and counted as
    // having no tasks, until someone happened to open and edit it here.
    it('indexes a document it merged but never displayed', async () => {
        const repo = new DocumentRepository();
        const delta = bytesToBase64(Y.encodeStateAsUpdate(authored('shopping list')));

        await repo.mergeDelta('doc', delta);

        const saved = calls.find((c) => c.cmd === 'save_yjs_update');
        expect((saved?.args.index as { text: string } | null)?.text).toBe('shopping list');
    });

    it('indexes a merge into the open document too', async () => {
        const repo = new DocumentRepository();
        const live = new Y.Doc();
        registerOpenDoc('doc', live);

        await repo.mergeDelta('doc', bytesToBase64(Y.encodeStateAsUpdate(authored('from a peer'))));

        const saved = calls.find((c) => c.cmd === 'save_yjs_update');
        expect((saved?.args.index as { text: string } | null)?.text).toBe('from a peer');
        unregisterOpenDoc('doc', live);
    });

    it('keeps a newer registration when a replaced editor unregisters late', async () => {
        // Switching away from a document and straight back gives two Y.Docs
        // for one id. The outgoing editor must not evict the incoming one.
        const first = docWith('first');
        const second = docWith('second');
        registerOpenDoc('doc', first);
        registerOpenDoc('doc', second);

        unregisterOpenDoc('doc', first);

        expect(getOpenDoc('doc')).toBe(second);
        unregisterOpenDoc('doc', second);
        expect(getOpenDoc('doc')).toBeUndefined();
    });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import { stateDigest } from '../../test/contentDigest';

// Every command the repository calls, recorded rather than performed.
// `storedState` stands in for the `crdt_state` column, which Rust merges each
// saved update into (ADR 0031, decision 3), and `unindexed` for the documents
// `list_unindexed_documents` reports.
const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
let storedState = '';
let unindexed: string[] = [];

const fromB64 = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));
const toB64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const hashOfStored = () => (storedState ? stateDigest(fromB64(storedState)) : null);

vi.mock('@tauri-apps/api/core', () => ({
    invoke: async (cmd: string, args: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === 'get_yjs_state') {
            return { doc_id: args.docId, state: storedState, content_hash: hashOfStored() };
        }
        if (cmd === 'save_yjs_update') {
            const update = fromB64(args.update as string);
            const merged = storedState ? Y.mergeUpdates([fromB64(storedState), update]) : update;
            storedState = toB64(merged);
            const doc = new Y.Doc();
            Y.applyUpdate(doc, merged);
            return { state_vector: toB64(Y.encodeStateVector(doc)) };
        }
        // As Rust does: an index read from a state the store has moved on
        // from is dropped.
        if (cmd === 'save_document_index') {
            return args.contentHash === null || args.contentHash === hashOfStored();
        }
        if (cmd === 'list_unindexed_documents') return unindexed;
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
        unindexed = [];
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

        expect(textOfB64(storedState)).toBe('hello world');

        unregisterOpenDoc('doc', live);
    });

    // An imported note's content arrives after its row, and whatever reached
    // the note in between, typed or synced, has to survive it (ADR 0029).
    it('merges imported content into what the note holds, never over it', async () => {
        const repo = new DocumentRepository();
        storedState = bytesToBase64(Y.encodeStateAsUpdate(authored('typed while it ran')));

        const index = await repo.importContent('doc', Y.encodeStateAsUpdate(authored('imported')));

        const saved = calls.find((c) => c.cmd === 'save_yjs_update');
        // Saved quietly: peers pull it when the note is announced with the
        // rest of its batch.
        expect(saved?.args.quiet).toBe(true);
        const merged = new Y.Doc();
        Y.applyUpdate(merged, base64ToBytes(storedState));
        const text = merged.getXmlFragment('content').toString();
        expect(text).toContain('typed while it ran');
        expect(text).toContain('imported');
        // The index describes the merged note, and comes back for the counts.
        expect(index?.text).toContain('typed while it ran');
        expect(index?.text).toContain('imported');
    });

    it('tags the merge so the editor does not save it again', async () => {
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

        // The editor's listener skips REMOTE_ORIGIN; anything else would be
        // saved a second time.
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

    // Before this, a document that arrived from elsewhere was written with no
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

    // ADR 0031, decision 4: once the store has said what it holds, a save
    // carries only what it is missing, not the whole note every time.
    it('sends only what the store is missing once it knows what it holds', async () => {
        const repo = new DocumentRepository();
        const live = docWith('hello');
        registerOpenDoc('doc', live);

        await repo.saveLocalUpdate('doc', Y.encodeStateAsUpdate(live));
        live.getText('content').insert(5, ' world');
        await repo.saveLocalUpdate('doc', Y.encodeStateAsUpdate(live));

        const saves = calls.filter((c) => c.cmd === 'save_yjs_update');
        const second = new Y.Doc();
        Y.applyUpdate(second, base64ToBytes(saves[1].args.update as string));
        // Only " world", which cannot even be placed without "hello".
        expect(second.getText('content').toString()).toBe('');
        expect(textOfB64(storedState)).toBe('hello world');
        unregisterOpenDoc('doc', live);
    });

    // The save is what tells connected devices, so a closed document saves
    // the rename itself, and only the rename.
    it('renames a tag in a closed document by saving only what changed', async () => {
        const repo = new DocumentRepository();
        const tagged = prosemirrorJSONToYDoc(
            getSchema(createContentExtensions()),
            {
                type: 'doc',
                content: [
                    {
                        type: 'paragraph',
                        content: [
                            { type: 'text', text: 'a long note about planning '.repeat(20) },
                            { type: 'tag', attrs: { name: 'work' } },
                        ],
                    },
                ],
            },
            'content',
        );
        storedState = bytesToBase64(Y.encodeStateAsUpdate(tagged));

        expect(await repo.renameTagIn('doc', 'work', 'job')).toBe(1);
        expect(await repo.renameTagIn('doc', 'holiday', 'leave')).toBe(0);

        const saves = calls.filter((c) => c.cmd === 'save_yjs_update');
        expect(saves).toHaveLength(1);
        expect((saves[0].args.update as string).length).toBeLessThan(storedState.length / 4);
        expect((saves[0].args.index as { tags: string[] }).tags).toEqual(['job']);
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

// A peer's update arrives already merged: Rust stored it, and the page puts it
// on screen and into the index (ADR 0031, decisions 5 and 7).
describe('a peer update Rust has merged', () => {
    beforeEach(() => {
        calls.length = 0;
        storedState = '';
        unindexed = [];
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('lands in the open document without being saved again', async () => {
        const repo = new DocumentRepository();
        const live = await (async () => {
            storedState = bytesToBase64(Y.encodeStateAsUpdate(docWith('hello')));
            return repo.openDocument('doc');
        })();
        const origins: unknown[] = [];
        live.on('update', (_u: Uint8Array, origin: unknown) => origins.push(origin));

        await repo.peerMerged(
            'doc',
            deltaFrom(live, (d) => d.getText('content').insert(5, ' world')),
        );

        expect(live.getText('content').toString()).toBe('hello world');
        expect(origins).toEqual(['oyot:remote']);
        expect(calls.some((c) => c.cmd === 'save_yjs_update')).toBe(false);
        unregisterOpenDoc('doc', live);
    });

    it('indexes the open document once the edits stop', async () => {
        const repo = new DocumentRepository();
        const live = new Y.Doc();
        registerOpenDoc('doc', live);

        const update = bytesToBase64(Y.encodeStateAsUpdate(authored('from a peer')));
        await repo.peerMerged('doc', update);
        await repo.peerMerged('doc', update);
        expect(calls.some((c) => c.cmd === 'save_document_index')).toBe(false);

        await vi.advanceTimersByTimeAsync(1_000);

        const indexed = calls.filter((c) => c.cmd === 'save_document_index');
        expect(indexed).toHaveLength(1);
        expect((indexed[0].args.index as { text: string }).text).toBe('from a peer');
        expect(indexed[0].args.contentHash).toBeNull();
        unregisterOpenDoc('doc', live);
    });

    it('indexes a closed document from the state it read', async () => {
        const repo = new DocumentRepository();
        storedState = bytesToBase64(Y.encodeStateAsUpdate(authored('arrived while closed')));

        await repo.peerMerged('doc', storedState);

        const indexed = calls.find((c) => c.cmd === 'save_document_index');
        expect((indexed?.args.index as { text: string }).text).toBe('arrived while closed');
        expect(indexed?.args.contentHash).toBe(hashOfStored());
    });

    // Rust merged it after the document was read, so the event comes after
    // the opening in the queue, and finds the copy the editor holds.
    it('reaches a document that was being opened when it was merged', async () => {
        const repo = new DocumentRepository();
        const base = docWith('base');
        storedState = bytesToBase64(Y.encodeStateAsUpdate(base));

        const opening = repo.openDocument('doc');
        const delta = deltaFrom(base, (d) => d.getText('content').insert(4, ' plus peer'));
        storedState = bytesToBase64(Y.mergeUpdates([fromB64(storedState), fromB64(delta)]));
        const applying = repo.peerMerged('doc', delta);

        const ydoc = await opening;
        await applying;
        expect(ydoc.getText('content').toString()).toBe('base plus peer');
        unregisterOpenDoc('doc', ydoc);
    });

    it('catches up on documents merged while no page was running', async () => {
        const repo = new DocumentRepository();
        storedState = bytesToBase64(Y.encodeStateAsUpdate(authored('merged in the background')));
        unindexed = ['doc'];

        expect(await repo.backfillIndex()).toBe(1);
        const indexed = calls.find((c) => c.cmd === 'save_document_index');
        expect(indexed?.args.contentHash).toBe(hashOfStored());
    });
});

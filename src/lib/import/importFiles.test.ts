import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import type { DocumentIndex } from '$lib/editor/documentIndex';
import { rootFromYDoc } from '$lib/editor/headlessIndex';
import { importFiles, linkedFileName, type ImportTarget } from './importFiles';

const HASH = 'b'.repeat(64);
const OTHER_HASH = 'c'.repeat(64);

/** Records what an import does, the way the app's repository would hold it. */
class FakeTarget implements ImportTarget {
    created: { id: string; title: string }[] = [];
    saved = new Map<string, { state: Uint8Array; index: DocumentIndex }>();
    deleted: string[] = [];
    held = new Set<string>();
    failCreate = new Set<string>();
    failSave = new Set<string>();

    async createNote(title: string) {
        if (this.failCreate.has(title)) throw new Error('create failed');
        const note = { id: `note-${this.created.length + 1}`, title };
        this.created.push(note);
        return note;
    }

    async saveContent(docId: string, state: Uint8Array, index: DocumentIndex) {
        const title = this.created.find((note) => note.id === docId)?.title ?? '';
        if (this.failSave.has(title)) throw new Error('save failed');
        this.saved.set(docId, { state, index });
    }

    async deleteNote(docId: string) {
        this.deleted.push(docId);
    }

    async heldAttachments(hashes: string[]) {
        return new Set(hashes.filter((hash) => this.held.has(hash)));
    }

    idOf(title: string): string {
        const note = this.created.find((n) => n.title === title);
        if (!note) throw new Error(`no note called ${title}`);
        return note.id;
    }

    /** A saved note's content, read back out of the CRDT it was saved as. */
    content(title: string) {
        const saved = this.saved.get(this.idOf(title));
        if (!saved) return null;
        const ydoc = new Y.Doc();
        Y.applyUpdate(ydoc, saved.state);
        const json = rootFromYDoc(ydoc).toJSON();
        ydoc.destroy();
        return json.content;
    }
}

const file = (name: string, text: string) => ({ name, text });

describe('importFiles', () => {
    it('makes a note of each file, with its content saved as the editor would', async () => {
        const target = new FakeTarget();
        const result = await importFiles(
            [file('groceries.md', '# Groceries\n\n- [ ] milk\n- [x] bread #shopping')],
            target,
        );

        expect(result.notes).toEqual([{ id: 'note-1', title: 'Groceries' }]);
        expect(result.skipped).toEqual([]);
        expect(target.content('Groceries')).toEqual([
            {
                type: 'taskList',
                content: [
                    {
                        type: 'taskItem',
                        attrs: { checked: false },
                        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'milk' }] }],
                    },
                    {
                        type: 'taskItem',
                        attrs: { checked: true },
                        content: [
                            {
                                type: 'paragraph',
                                content: [
                                    { type: 'text', text: 'bread ' },
                                    { type: 'tag', attrs: { name: 'shopping' } },
                                ],
                            },
                        ],
                    },
                ],
            },
        ]);

        // The index is what search, the tag pages and the todo counts read.
        const { index } = target.saved.get('note-1')!;
        expect(index.tags).toEqual(['shopping']);
        expect(index.todoCount).toBe(2);
        expect(index.completedTodoCount).toBe(1);
    });

    // A link to another file being imported can only point at that note once
    // the note exists, which is why every note is made before any is filled.
    it('turns a link between two imported files into a link between the notes', async () => {
        const target = new FakeTarget();
        await importFiles(
            [
                file('trip.md', '# Trip\n\nSee [what to pack](Packing%20list.md).'),
                file('Packing list.md', '# Packing list\n\n- passport'),
            ],
            target,
        );

        const packing = target.idOf('Packing list');
        expect(target.content('Trip')).toEqual([
            {
                type: 'paragraph',
                content: [
                    { type: 'text', text: 'See what to pack ' },
                    { type: 'documentLink', attrs: { targetId: packing, title: 'Packing list' } },
                    { type: 'text', text: '.' },
                ],
            },
        ]);
        expect(target.saved.get(target.idOf('Trip'))!.index.linkTargets).toEqual([packing]);
    });

    it('leaves a link to a file that was not imported a link', async () => {
        const target = new FakeTarget();
        await importFiles([file('trip.md', '[packing](packing.md)')], target);
        const [paragraph] = target.content('trip')!;
        expect(paragraph.content[0].marks[0].attrs.href).toBe('packing.md');
    });

    it('links to neither of two files with the same name', async () => {
        const target = new FakeTarget();
        await importFiles(
            [file('index.md', '[a](Notes.md)'), file('Notes.md', 'one'), file('notes.md', 'two')],
            target,
        );
        const [paragraph] = target.content('index')!;
        expect(paragraph.content[0].type).toBe('text');
    });

    it('makes the notes in the order of their names, the last first', async () => {
        const target = new FakeTarget();
        const result = await importFiles(
            [file('b.md', 'b'), file('a10.md', 'a10'), file('a2.md', 'a2')],
            target,
        );
        // The Notes page lists the newest first, so this reads a2, a10, b.
        expect(target.created.map((note) => note.title)).toEqual(['b', 'a10', 'a2']);
        expect(result.notes.map((note) => note.title)).toEqual(['a2', 'a10', 'b']);
    });

    it('does not save content for a file with nothing in it', async () => {
        const target = new FakeTarget();
        const result = await importFiles([file('Empty.md', '')], target);
        expect(result.notes).toEqual([{ id: 'note-1', title: 'Empty' }]);
        expect(target.saved.size).toBe(0);
    });

    it('names a file whose note could not be made, and carries on', async () => {
        const target = new FakeTarget();
        target.failCreate.add('Broken');
        const result = await importFiles([file('Broken.md', 'x'), file('Fine.md', 'y')], target);
        expect(result.notes.map((note) => note.title)).toEqual(['Fine']);
        expect(result.skipped).toEqual([{ name: 'Broken.md', reason: 'failed' }]);
    });

    // An empty note under the file's title would look imported and not be.
    it('takes back a note whose content could not be saved', async () => {
        const target = new FakeTarget();
        target.failSave.add('Broken');
        const result = await importFiles([file('Broken.md', 'x'), file('Fine.md', 'y')], target);
        expect(result.notes.map((note) => note.title)).toEqual(['Fine']);
        expect(result.skipped).toEqual([{ name: 'Broken.md', reason: 'failed' }]);
        expect(target.deleted).toEqual([target.idOf('Broken')]);
    });

    it('counts the images kept as text, and the attachments not on this device', async () => {
        const target = new FakeTarget();
        target.held.add(HASH);
        const result = await importFiles(
            [
                file(
                    'photos.md',
                    `![](../attachments/${HASH}.png)\n\n![](../attachments/${OTHER_HASH}.jpg)\n\n![](beside.png)`,
                ),
            ],
            target,
        );
        expect(result.imagesKeptAsText).toBe(1);
        expect(result.missingImages).toBe(1);
        expect(target.saved.get('note-1')!.index.attachmentHashes).toEqual([HASH, OTHER_HASH]);
    });

    it('reports progress as each note is filled in', async () => {
        const target = new FakeTarget();
        const seen: [number, number][] = [];
        await importFiles([file('a.md', 'a'), file('b.md', 'b')], target, (done, total) =>
            seen.push([done, total]),
        );
        expect(seen).toEqual([
            [0, 2],
            [1, 2],
            [2, 2],
        ]);
    });
});

describe('linkedFileName', () => {
    it('names the file a relative link points at', () => {
        expect(linkedFileName('other-note.md')).toBe('other-note.md');
        expect(linkedFileName('../notes/Packing%20list.md#passport')).toBe('Packing list.md');
        expect(linkedFileName('caf%C3%A9.md?x=1')).toBe('café.md');
    });

    it('names nothing for an address that is not a file beside the note', () => {
        expect(linkedFileName('https://example.com/a.md')).toBeNull();
        expect(linkedFileName('mailto:a@b.com')).toBeNull();
        expect(linkedFileName('//example.com/a.md')).toBeNull();
        expect(linkedFileName('#section')).toBeNull();
    });

    it('keeps a name with a stray percent sign as written', () => {
        expect(linkedFileName('100%.md')).toBe('100%.md');
    });
});

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { indexFromYDoc, rootFromYDoc } from '$lib/editor/headlessIndex';
import { importFiles, linkedFileName, type ImportTarget, type PublishedNote } from './importFiles';

const HASH = 'b'.repeat(64);
const OTHER_HASH = 'c'.repeat(64);

/**
 * Records what an import does, holding each note's content as the app's
 * repository does: merged into what the note already holds.
 */
class FakeTarget implements ImportTarget {
    created: { id: string; title: string }[] = [];
    docs = new Map<string, Y.Doc>();
    published: PublishedNote[][] = [];
    deleted: string[] = [];
    held = new Set<string>();
    failCreate = new Set<string>();
    failSave = new Set<string>();

    async createNote(id: string, title: string) {
        if (this.failCreate.has(title)) throw new Error('create failed');
        this.created.push({ id, title });
        this.docs.set(id, new Y.Doc());
    }

    async saveContent(id: string, update: Uint8Array) {
        const title = this.created.find((note) => note.id === id)?.title ?? '';
        if (this.failSave.has(title)) throw new Error('save failed');
        const doc = this.docs.get(id);
        if (!doc) throw new Error(`no note ${id}`);
        Y.applyUpdate(doc, update);
        return indexFromYDoc(doc);
    }

    publish(notes: PublishedNote[]) {
        this.published.push(notes);
    }

    async deleteNote(id: string) {
        this.deleted.push(id);
    }

    async heldAttachments(hashes: string[]) {
        return new Set(hashes.filter((hash) => this.held.has(hash)));
    }

    idOf(title: string): string {
        const note = this.created.find((n) => n.title === title);
        if (!note) throw new Error(`no note called ${title}`);
        return note.id;
    }

    /** A note's content, read back out of the CRDT it was saved as. */
    content(title: string) {
        const doc = this.docs.get(this.idOf(title));
        return doc ? rootFromYDoc(doc).toJSON().content : null;
    }

    publishedNote(title: string): PublishedNote | undefined {
        const id = this.idOf(title);
        return this.published.flat().find((note) => note.id === id);
    }
}

const file = (name: string, text: string) => ({ name, text });

/** Ids the test can predict: `note-1` for the first file by name, and so on. */
function ids(): () => string {
    let n = 0;
    return () => `note-${++n}`;
}

describe('importFiles', () => {
    it('makes a note of each file, and lists it with what its content counts', async () => {
        const target = new FakeTarget();
        const result = await importFiles(
            [file('groceries.md', '# Groceries\n\n- [ ] milk\n- [x] bread #shopping')],
            target,
            undefined,
            ids(),
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
        const listed = target.publishedNote('Groceries');
        expect(listed?.hasContent).toBe(true);
        expect(listed?.index?.tags).toEqual(['shopping']);
        expect(listed?.index?.todoCount).toBe(2);
        expect(listed?.index?.completedTodoCount).toBe(1);
    });

    // Each note's id is chosen before any note is made, so a link can point at
    // a note that is written after the note linking to it.
    it('turns a link between two imported files into a link between the notes', async () => {
        const target = new FakeTarget();
        await importFiles(
            [
                file('trip.md', '# Trip\n\nSee [what to pack](Packing%20list.md).'),
                file('Packing list.md', '# Packing list\n\n- passport'),
            ],
            target,
            undefined,
            ids(),
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
        expect(target.publishedNote('Trip')?.index?.linkTargets).toEqual([packing]);
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

    // A note's row and its content are written one after the other, so a
    // note is never left empty for longer than it takes to save it.
    it('writes each note whole before making the next', async () => {
        const target = new FakeTarget();
        const order: string[] = [];
        const create = target.createNote.bind(target);
        const save = target.saveContent.bind(target);
        target.createNote = async (id, title) => {
            order.push(`create ${title}`);
            await create(id, title);
        };
        target.saveContent = async (id, update) => {
            order.push(`save ${target.created.find((note) => note.id === id)?.title}`);
            return save(id, update);
        };
        await importFiles([file('a.md', 'a'), file('b.md', 'b')], target);
        expect(order).toEqual(['create b', 'save b', 'create a', 'save a']);
    });

    it('merges into what a note already holds rather than writing over it', async () => {
        const target = new FakeTarget();
        const create = target.createNote.bind(target);
        // Something reaches the note between its row and its content: a
        // peer's edit, or the user typing in it.
        target.createNote = async (id, title) => {
            await create(id, title);
            const typed = new Y.Doc();
            const paragraph = new Y.XmlElement('paragraph');
            paragraph.insert(0, [new Y.XmlText('typed')]);
            typed.getXmlFragment('content').insert(0, [paragraph]);
            Y.applyUpdate(target.docs.get(id)!, Y.encodeStateAsUpdate(typed));
        };
        await importFiles([file('a.md', 'imported')], target);
        const words = target
            .content('a')!
            .map((block: { content?: { text: string }[] }) => block.content?.[0]?.text);
        expect(words.sort()).toEqual(['imported', 'typed']);
    });

    it('lists the notes in batches', async () => {
        const target = new FakeTarget();
        const files = Array.from({ length: 30 }, (_, i) => file(`n${i}.md`, `words ${i}`));
        await importFiles(files, target);
        expect(target.published.map((batch) => batch.length)).toEqual([25, 5]);
    });

    it('saves no content for a file with nothing in it', async () => {
        const target = new FakeTarget();
        const result = await importFiles([file('Empty.md', '')], target, undefined, ids());
        expect(result.notes).toEqual([{ id: 'note-1', title: 'Empty' }]);
        expect(target.docs.get('note-1')?.getXmlFragment('content').length).toBe(0);
        expect(target.publishedNote('Empty')).toEqual({
            id: 'note-1',
            hasContent: false,
            index: null,
        });
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
        expect(target.publishedNote('Fine')).toBeDefined();
        expect(target.published.flat().map((note) => note.id)).not.toContain(target.idOf('Broken'));
    });

    // Made last to first, so `b` fails before `a` is read, and the link in
    // `a` is left a link rather than pointing at a note that is gone.
    it('keeps a link to a note that failed as a link', async () => {
        const target = new FakeTarget();
        target.failSave.add('b');
        await importFiles([file('a.md', 'see [b](b.md)'), file('b.md', 'bee')], target);
        const [paragraph] = target.content('a')!;
        expect(paragraph.content[1].marks[0].attrs.href).toBe('b.md');
    });

    // The same files can be imported twice, and the caller may still need them.
    it('leaves the files it was given as they were', async () => {
        const files = [file('a.md', 'words')];
        await importFiles(files, new FakeTarget());
        expect(files[0].text).toBe('words');
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
        expect(target.publishedNote('photos')?.index?.attachmentHashes).toEqual([HASH, OTHER_HASH]);
    });

    it('reports progress as each note is written', async () => {
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

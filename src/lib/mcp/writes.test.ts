import { describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';
import { CONTENT_FIELD } from '$lib/editor/contentField';
import { rootFromYDoc } from '$lib/editor/headlessIndex';
import { renderNote, revisionOf } from './noteMarkdown';
import { doc, fakeDeps, HASH, image, p, t, task, tasks, ydocOf } from './testDocs';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const { appendToNote, createNoteWith, editNote, MAX_EDITABLE_BYTES, toggleTodo } =
    await import('./writes');

function setup(...content: unknown[]) {
    const ydoc = ydocOf(doc(...content));
    const docs = new Map([['n1', ydoc]]);
    return { ydoc, docs, ...fakeDeps(docs) };
}

const markdownOf = (ydoc: Y.Doc) => renderNote(rootFromYDoc(ydoc)).markdown;
const revisionNow = (ydoc: Y.Doc) => revisionOf(markdownOf(ydoc));

describe('editNote', () => {
    it('applies a rewrite and gives the new revision', async () => {
        const { ydoc, deps } = setup(p(t('one')), p(t('two')), p(t('three')));
        const result = await editNote(
            'n1',
            'one\n\nTWO\n\nthree\n',
            await revisionNow(ydoc),
            false,
            deps,
        );
        expect(result).toEqual({ status: 'changed', revision: await revisionNow(ydoc), blocks: 1 });
        expect(markdownOf(ydoc)).toBe('one\n\nTWO\n\nthree\n');
    });

    it('refuses a rewrite of a revision the note has moved on from, and gives it as it is now', async () => {
        const { ydoc, deps } = setup(p(t('one')));
        const stale = await revisionNow(ydoc);
        // The user types after the assistant read the note.
        const paragraph = ydoc.getXmlFragment(CONTENT_FIELD).get(0) as Y.XmlElement;
        (paragraph.get(0) as Y.XmlText).insert(3, '!');

        const result = await editNote('n1', 'ONE\n', stale, false, deps);

        expect(result).toEqual({
            status: 'conflict',
            markdown: 'one!\n',
            revision: await revisionNow(ydoc),
        });
        expect(markdownOf(ydoc)).toBe('one!\n');
    });

    it('says when nothing changed', async () => {
        const { ydoc, deps } = setup(p(t('one')));
        const result = await editNote('n1', 'one\n', await revisionNow(ydoc), false, deps);
        expect(result.status).toBe('unchanged');
    });

    it('refuses to rewrite what Markdown cannot carry unless told it may', async () => {
        const sized = image({ src: `oyot-attachment://${HASH}`, alt: `oyot:${HASH}`, width: 320 });
        const { ydoc, deps } = setup(p(t('a')), sized);
        const rewrite = `a\n\n![A cat](oyot-attachment://${HASH})\n`;

        const refused = await editNote('n1', rewrite, await revisionNow(ydoc), false, deps);
        expect(refused).toMatchObject({
            status: 'lossy',
            lossy: [{ index: 1, losses: ["an image's size"] }],
        });
        expect(rootFromYDoc(ydoc).child(1).attrs.width).toBe(320);

        const accepted = await editNote('n1', rewrite, await revisionNow(ydoc), true, deps);
        expect(accepted.status).toBe('changed');
        expect(rootFromYDoc(ydoc).child(1).attrs.alt).toBe('A cat');
    });

    it('refuses to rewrite a note too long to have been read whole', async () => {
        const long = 'x'.repeat(MAX_EDITABLE_BYTES + 1);
        const { ydoc, deps } = setup(p(t(long)));
        const result = await editNote('n1', 'short\n', await revisionNow(ydoc), false, deps);
        expect(result).toEqual({ status: 'too_long', bytes: MAX_EDITABLE_BYTES + 2 });
        expect(markdownOf(ydoc).length).toBe(MAX_EDITABLE_BYTES + 2);
    });
});

describe('appendToNote', () => {
    it('adds to the end of a note', async () => {
        const { ydoc, deps } = setup(p(t('first')));
        const result = await appendToNote('n1', '- [ ] buy milk\n', deps);
        expect(markdownOf(ydoc)).toBe('first\n\n-   [ ] buy milk\n');
        expect(result).toEqual({ status: 'changed', revision: await revisionNow(ydoc) });
    });

    it('fills a new, empty note rather than leaving a blank line above', async () => {
        const { ydoc, deps } = setup(p());
        await appendToNote('n1', '# Plan\n', deps);
        expect(rootFromYDoc(ydoc).toJSON().content).toEqual([
            { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Plan' }] },
        ]);
    });

    it('changes nothing for nothing', async () => {
        const { deps } = setup(p(t('first')));
        expect((await appendToNote('n1', '   \n', deps)).status).toBe('unchanged');
    });
});

describe('toggleTodo', () => {
    it('ticks a task, and gives the tasks as they are when it moved', async () => {
        const { ydoc, deps } = setup(tasks(task('milk'), task('bread')));
        expect(await toggleTodo('n1', 1, 'bread', true, deps)).toEqual({ status: 'changed' });
        expect(markdownOf(ydoc)).toBe('-   [ ] milk\n-   [x] bread\n');
        expect(await toggleTodo('n1', 0, 'bread', true, deps)).toEqual({
            status: 'moved',
            todos: [
                { ordinal: 0, text: 'milk', checked: false, depth: 0 },
                { ordinal: 1, text: 'bread', checked: true, depth: 0 },
            ],
        });
    });
});

describe('createNoteWith', () => {
    it("makes a note through the sidebar's action, then fills it", async () => {
        const { docs, deps, created } = setup(p());
        const { id, revision } = await createNoteWith('Ideas', 'one idea\n', deps);
        expect(created).toEqual(['Ideas']);
        expect(markdownOf(docs.get(id)!)).toBe('one idea\n');
        expect(revision).toBe(await revisionNow(docs.get(id)!));
    });
});

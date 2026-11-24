// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { contentSchema, indexFromYDoc, rootFromYDoc } from '$lib/editor/headlessIndex';
import { importFiles, type ImportTarget } from './importFiles';
import { noteDocument, prepareNote, type NoteFile } from './note';
import { blocksOf } from '../../test/blockJson';

/** HTML files through the import, from the file to the note's content. */

const schema = contentSchema();
const PNG = 'data:image/png;base64,AAAA';
const HASH = 'd'.repeat(64);

const html = (name: string, text: string): NoteFile => ({ name, text, format: 'html' });
const markdown = (name: string, text: string): NoteFile => ({ name, text, format: 'markdown' });
const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

function note(file: NoteFile) {
    const prepared = prepareNote(file);
    return {
        title: prepared.title,
        tags: prepared.tags,
        content: blocksOf(noteDocument(prepared, schema).doc),
    };
}

/** Records what an import does, in order, and holds what it wrote. */
class FakeTarget implements ImportTarget {
    log: string[] = [];
    titles = new Map<string, string>();
    docs = new Map<string, Y.Doc>();
    failImages = false;

    async createNote(id: string, title: string) {
        this.log.push(`create ${title}`);
        this.titles.set(title, id);
        this.docs.set(id, new Y.Doc());
    }
    async saveContent(id: string, update: Uint8Array) {
        this.log.push(`save ${id}`);
        const doc = this.docs.get(id)!;
        Y.applyUpdate(doc, update);
        return indexFromYDoc(doc);
    }
    async saveImage(data: string, mime: string) {
        this.log.push(`image ${mime} ${data}`);
        if (this.failImages) throw 'image is too large';
        return HASH;
    }
    publish() {}
    async deleteNote() {}
    async heldAttachments(hashes: string[]) {
        return new Set(hashes);
    }
    content(title: string) {
        return blocksOf(rootFromYDoc(this.docs.get(this.titles.get(title)!)!));
    }
}

describe('an HTML file as a note', () => {
    it('is called what the page is, without saying it twice', () => {
        const title = '<title>Trip to Kyoto</title>';
        expect(
            note(html('a.html', `${title}<div><h1>Trip  to <b>kyoto</b></h1></div><p>x</p>`)),
        ).toEqual({ title: 'Trip to Kyoto', tags: [], content: [para('x')] });
        expect(note(html('a.html', '<h1>Trip</h1><p>x</p>'))).toEqual({
            title: 'Trip',
            tags: [],
            content: [para('x')],
        });
        // Nothing but its title.
        expect(note(html('a.html', '<h1>Trip</h1>')).content).toEqual([{ type: 'paragraph' }]);
    });

    it('keeps a heading that is not at the top, or says something else', () => {
        const heading = (text: string) => ({
            type: 'heading',
            attrs: { level: 1 },
            content: [{ type: 'text', text }],
        });
        expect(note(html('a.html', '<p>x</p><h1>Trip</h1>'))).toMatchObject({
            title: 'Trip',
            content: [para('x'), heading('Trip')],
        });
        expect(note(html('a.html', '<title>Trip - Site</title><h1>Trip</h1>'))).toMatchObject({
            title: 'Trip - Site',
            content: [heading('Trip')],
        });
    });

    it('is called what the file is when the page does not say', () => {
        expect(note(html('Packing list.html', '<p>x</p>')).title).toBe('Packing list');
        expect(note(html('old.HTM', '<p>x</p>')).title).toBe('old');
        expect(note(html('', '<p>x</p>')).title).toBe('Untitled');
    });
});

describe('importing HTML files', () => {
    it('stores the pictures inside a file before its note is made', async () => {
        const target = new FakeTarget();
        const result = await importFiles(
            [html('a.html', `<p>x</p><img src="${PNG}" alt="sea">`)],
            target,
            undefined,
            () => 'n1',
        );
        expect(target.log).toEqual(['image image/png AAAA', 'create a', 'save n1']);
        expect(target.content('a')[1].attrs).toMatchObject({
            src: `oyot-attachment://${HASH}`,
            alt: 'sea',
        });
        expect(result).toMatchObject({ leftOut: 0, imagesKeptAsText: 0, missingImages: 0 });
    });

    it('makes the note without a picture that could not be stored, and counts it', async () => {
        const target = new FakeTarget();
        target.failImages = true;
        const result = await importFiles(
            [html('a.html', `<p>x</p><img src="${PNG}" alt="sea"><canvas></canvas>`)],
            target,
        );
        expect(target.content('a')).toEqual([para('x'), para('sea')]);
        expect(result).toMatchObject({ leftOut: 2, skipped: [] });
        expect(result.notes).toHaveLength(1);
    });

    it("leaves a Markdown file's picture as it was written", async () => {
        const target = new FakeTarget();
        await importFiles([markdown('a.md', `![sea](${PNG})`)], target);
        expect(target.log.some((entry) => entry.startsWith('image'))).toBe(false);
        expect(target.content('a')[0].attrs.src).toBe(PNG);
    });

    it('links the notes of files imported together, whichever each is written in', async () => {
        const target = new FakeTarget();
        let n = 0;
        await importFiles(
            [html('a.html', '<a href="./b.md">b</a>'), markdown('b.md', '[a](a.html#part)')],
            target,
            undefined,
            () => `n${++n}`,
        );
        const chip = (targetId: string, title: string) => [
            {
                type: 'paragraph',
                content: [{ type: 'documentLink', attrs: { targetId, title } }],
            },
        ];
        expect(target.content('a')).toEqual(chip('n2', 'b'));
        expect(target.content('b')).toEqual(chip('n1', 'a'));
    });

    it('saves no content for a page with nothing in it', async () => {
        const target = new FakeTarget();
        await importFiles([html('a.html', '<html><body></body></html>')], target);
        expect(target.log).toEqual(['create a']);
    });
});

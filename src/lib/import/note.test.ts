import { describe, it, expect } from 'vitest';
import { contentSchema } from '$lib/editor/headlessIndex';
import { renderNote } from '$lib/export/note';
import { noteDocument, prepareNote, titleFromFileName } from './note';

const schema = contentSchema();

function prepared(text: string, name = 'file.md') {
    return prepareNote({ name, text });
}

function content(text: string, name = 'file.md') {
    return noteDocument(prepared(text, name), schema).doc.toJSON().content;
}

const tag = (name: string) => ({ type: 'tag', attrs: { name } });
const text = (value: string) => ({ type: 'text', text: value });

describe('prepareNote: the title', () => {
    it('takes the front matter title first', () => {
        expect(prepared('---\ntitle: From the front\n---\n\nbody', 'name.md').title).toBe(
            'From the front',
        );
    });

    it('takes a heading that opens the file next, and takes it out of the body', () => {
        const note = prepared('# Trip to Kyoto\n\ntwo nights', 'trip.md');
        expect(note.title).toBe('Trip to Kyoto');
        expect(note.body.trim()).toBe('two nights');
    });

    it('takes an underlined heading out whole', () => {
        const note = prepared('Trip\n====\n\ntwo nights');
        expect(note.title).toBe('Trip');
        expect(note.body.trim()).toBe('two nights');
    });

    it('takes the file name last', () => {
        expect(prepared('## Agenda\n\nitems', 'Weekly sync.md').title).toBe('Weekly sync');
        expect(prepared('just words', 'notes.MARKDOWN').title).toBe('notes');
    });

    it('calls a note with nothing to go on Untitled', () => {
        expect(prepared('just words', '').title).toBe('Untitled');
        expect(prepared('', '.md').title).toBe('Untitled');
    });

    // The exporter writes the title in both places.
    it('takes out a heading that repeats the front matter title', () => {
        const note = prepared('---\ntitle: Groceries\n---\n\n# groceries\n\nmilk');
        expect(note.title).toBe('Groceries');
        expect(note.body.trim()).toBe('milk');
    });

    it('keeps a heading that says something other than the front matter title', () => {
        const note = prepared('---\ntitle: Groceries\n---\n\n# This week\n\nmilk');
        expect(note.title).toBe('Groceries');
        expect(note.body.trim()).toBe('# This week\n\nmilk');
    });

    it('reads a heading with markup in it as plain words', () => {
        expect(prepared('# Trip to *Kyoto*\n').title).toBe('Trip to Kyoto');
    });

    it('reads a file written on Windows, byte order mark and all', () => {
        const note = prepared('\uFEFF---\r\ntitle: A\r\n---\r\n\r\n# A\r\n\r\nbody\r\n');
        expect(note.title).toBe('A');
        expect(note.body.trim()).toBe('body');
    });
});

describe('prepareNote: the tags', () => {
    it('reads the tags from the front matter, normalized', () => {
        expect(prepared('---\ntags: ["Work", "#home", "house  move"]\n---\n').tags).toEqual([
            'work',
            'home',
            'house move',
        ]);
    });

    it('reads a string of tags, split by commas or else by spaces', () => {
        expect(prepared('---\ntags: work, house move\n---\n').tags).toEqual(['work', 'house move']);
        expect(prepared('---\ntags: work home\n---\n').tags).toEqual(['work', 'home']);
        expect(prepared('---\ntag: solo\n---\n').tags).toEqual(['solo']);
    });

    it('has no tags without front matter', () => {
        expect(prepared('#inline only').tags).toEqual([]);
    });
});

describe('noteDocument', () => {
    it('puts the front matter tags the words do not carry at the top', () => {
        expect(content('---\ntags: [work, home]\n---\n\nfor #work')).toEqual([
            { type: 'paragraph', content: [tag('home')] },
            { type: 'paragraph', content: [text('for '), tag('work')] },
        ]);
    });

    it('makes a note of only tags the line of tags, with nothing under it', () => {
        expect(content('---\ntags: [a, b]\n---\n')).toEqual([
            { type: 'paragraph', content: [tag('a'), text(' '), tag('b')] },
        ]);
    });

    it('reads a tag with a space in it that the front matter names', () => {
        expect(content('---\ntags: [house move]\n---\n\npack for the #house move')).toEqual([
            { type: 'paragraph', content: [text('pack for the '), tag('house move')] },
        ]);
    });

    it('leaves an empty file an empty note', () => {
        expect(content('')).toEqual([{ type: 'paragraph' }]);
    });
});

describe('titleFromFileName', () => {
    it('leaves off the folder and a note extension, and nothing else', () => {
        expect(titleFromFileName('Notes/2026/Trip.md')).toBe('Trip');
        expect(titleFromFileName('C:\\notes\\Plan.markdown')).toBe('Plan');
        expect(titleFromFileName('v1.2 release.md')).toBe('v1.2 release');
        expect(titleFromFileName('archive.zip')).toBe('archive.zip');
    });
});

// What the exporter writes for a note, read back.
describe('the round trip through the exporter', () => {
    it('brings back the title, the tags and only the body', () => {
        const exported = renderNote(
            {
                id: 'doc-1',
                title: 'Moving house',
                docType: 'note',
                createdAt: Date.UTC(2026, 8, 20),
                updatedAt: Date.UTC(2026, 8, 22),
                tags: ['house move', 'todo'],
            },
            '-   [ ] book the van #house move\n-   [ ] #todo call the agent\n',
        );
        const note = prepared(exported, 'moving-house.md');
        expect(note.title).toBe('Moving house');
        expect(note.tags).toEqual(['house move', 'todo']);

        const doc = noteDocument(note, schema).doc.toJSON().content;
        expect(doc).toEqual([
            {
                type: 'taskList',
                content: [
                    {
                        type: 'taskItem',
                        attrs: { checked: false },
                        content: [
                            {
                                type: 'paragraph',
                                content: [text('book the van '), tag('house move')],
                            },
                        ],
                    },
                    {
                        type: 'taskItem',
                        attrs: { checked: false },
                        content: [
                            {
                                type: 'paragraph',
                                content: [tag('todo'), text(' call the agent')],
                            },
                        ],
                    },
                ],
            },
        ]);
    });

    it('brings back an untitled note as Untitled', () => {
        const exported = renderNote(
            { id: 'x', title: '', docType: 'note', createdAt: 0, updatedAt: 0, tags: [] },
            'words',
        );
        const note = prepared(exported, 'untitled.md');
        expect(note.title).toBe('Untitled');
        expect(note.body.trim()).toBe('words');
    });
});

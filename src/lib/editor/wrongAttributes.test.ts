// @vitest-environment jsdom
//
// Notes holding attributes of the wrong type, in the editor's real extensions
// bound to a real Y.Doc, and in everything that reads a note without one. The
// readings themselves are tested in tiptap/attributeTypes.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Editor, getSchema } from '@tiptap/core';
import type { Extensions } from '@tiptap/core';
import { DOMSerializer } from '@tiptap/pm/model';
import type { Node } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { serializeDocument } from '$lib/export/markdown';
import { renderNote } from '$lib/mcp/noteMarkdown';
import { toggleTodoInDoc } from '$lib/mcp/todos';
import { renameTagInDoc } from '$lib/tags/renameInDoc';
import { CodeBlockLanguage } from './codeBlockLanguage';
import { CodeHighlight } from './codeHighlight';
import { CONTENT_FIELD } from './contentField';
import { createContentExtensions } from './extensions';
import { contentSchema, indexFromYDoc, rootFromYDoc } from './headlessIndex';
import { createCollaborationExtension } from './yjs';

vi.mock('$lib/sync', () => ({ pullAttachmentFromPeers: () => {} }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: () => Promise.resolve(null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }));

// What JSON has, which is all a paste can say, or the formatting of a text.
const WRONG_JSON: Record<string, () => unknown> = {
    'an array': () => [1, { a: 1 }],
    'an object': () => ({ a: 1 }),
    'an object with a toString of its own': () => ({ toString: 'x' }),
    'a number': () => 7,
    'a boolean': () => true,
    null: () => null,
};

// What a paired device can put on an element besides.
const WRONG: Record<string, () => unknown> = {
    ...WRONG_JSON,
    'a shared type': () => new Y.Map(),
    'a bigint': () => 10n,
    bytes: () => new Uint8Array([1]),
};

/** Every attribute in the schema, by the node or mark it is on. */
const EVERY = [...Object.values(contentSchema().nodes), ...Object.values(contentSchema().marks)]
    // Never stored, so nothing can put a wrong value on one there.
    .filter((type) => !type.name.startsWith('unknown'))
    .flatMap((type) =>
        Object.keys(type.spec.attrs ?? {}).map((name) => [type.name, name] as const),
    );

// --- notes -----------------------------------------------------------------

const open: Editor[] = [];
afterEach(() => {
    for (const editor of open.splice(0)) editor.destroy();
});

function openEditor(ydoc: Y.Doc, extensions: Extensions = createContentExtensions()): Editor {
    const editor = new Editor({
        element: document.createElement('div'),
        extensions: [
            ...extensions,
            createCollaborationExtension(ydoc),
            CodeBlockLanguage,
            CodeHighlight,
        ],
    });
    open.push(editor);
    return editor;
}

function element(name: string, attrs: object, ...children: (Y.XmlElement | Y.XmlText)[]) {
    const made = new Y.XmlElement(name);
    // Yjs types an attribute as a string, and stores whatever it is given.
    for (const [key, value] of Object.entries(attrs)) made.setAttribute(key, value as string);
    made.insert(0, children);
    return made;
}

const words = (text: string) => new Y.XmlText(text);
const para = (text: string) => element('paragraph', {}, words(text));
const row = (...cells: Y.XmlElement[]) => element('tableRow', {}, ...cells);
const cell = (text: string) => element('tableCell', {}, para(text));

/** The blocks a note has when `attrs` are on its `owner`, which is beside or around "words". */
function blocksWith(owner: string, attrs: object): Y.XmlElement[] {
    switch (owner) {
        case 'paragraph':
        case 'heading':
        case 'codeBlock':
            return [element(owner, attrs, words('words'))];
        case 'bulletList':
        case 'orderedList':
            return [element(owner, attrs, element('listItem', {}, para('words')))];
        case 'taskList':
            return [element(owner, attrs, element('taskItem', { checked: false }, para('words')))];
        case 'taskItem':
            return [element('taskList', {}, element(owner, attrs, para('words')))];
        case 'image':
            return [element(owner, attrs), para('words')];
        case 'tableCell':
        case 'tableHeader':
            return [
                element(
                    'table',
                    {},
                    row(element(owner, attrs, para('words')), cell('b')),
                    row(cell('c'), cell('d')),
                ),
            ];
        case 'documentLink':
        case 'tag':
            return [element('paragraph', {}, words('words'), element(owner, attrs))];
        case 'link': {
            const text = new Y.XmlText();
            text.insert(0, 'words', { link: attrs });
            return [element('paragraph', {}, text)];
        }
        default:
            throw new Error(`no note to put a ${owner} in`);
    }
}

function noteWith(owner: string, name: string, value: unknown): Y.Doc {
    const ydoc = new Y.Doc();
    ydoc.getXmlFragment(CONTENT_FIELD).insert(0, [
        para('first'),
        ...blocksWith(owner, { [name]: value }),
        para('last'),
    ]);
    return ydoc;
}

/** A second device's copy of `ydoc`, as it would arrive. */
function copyOf(ydoc: Y.Doc): Y.Doc {
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(ydoc));
    return copy;
}

const textOfEditor = (editor: Editor) =>
    editor.state.doc.textBetween(0, editor.state.doc.content.size, ' ');

/** Where the node of type `owner`, or the text with the mark, is. */
function positionOf(editor: Editor, text: string): number {
    let found = -1;
    editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text!.includes(text)) found = pos + node.text!.indexOf(text);
    });
    if (found < 0) throw new Error(`"${text}" is not in the note`);
    return found;
}

function type(editor: Editor, after: string, text: string): void {
    const { state, view } = editor;
    const at = positionOf(editor, after) + after.length;
    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, at)).insertText(text));
}

// --- what is already stored --------------------------------------------------

describe.each(EVERY)('a note holding a %s with a wrong %s', (owner, name) => {
    const kinds = Object.keys(owner === 'link' ? WRONG_JSON : WRONG);

    it.each(kinds)('opens, is edited and reopens, when it is %s', (kind) => {
        const ydoc = noteWith(owner, name, WRONG[kind]());
        let updates = 0;
        ydoc.on('update', () => updates++);
        const editor = openEditor(ydoc);
        expect(textOfEditor(editor)).toContain('words');

        // Drawn as the page has it, and as it is copied and read out.
        expect(() => editor.getHTML()).not.toThrow();
        expect(() => editor.getText()).not.toThrow();

        // Opening it is not a change to it. A table whose cells do not add up
        // is the exception, as it is when nothing in it is the wrong type.
        editor.commands.setTextSelection(3);
        const mended = /span$|^colwidth$/.test(name) && /array|number|bigint/.test(kind);
        if (!mended) expect(updates).toBe(0);

        // Another block, the one holding the value, and one after it.
        type(editor, 'first', ' typed');
        type(editor, 'words', ' more');
        type(editor, 'last', ' of all');

        const text = textOfEditor(editor);
        expect(text).toMatch(/first typed.*words more.*last of all/);
        if (owner.startsWith('table')) expect(text).toMatch(/b.*c.*d/);

        // Nothing was left behind in this editor: what was stored has it all,
        // the node still among it, and it opens on the next device.
        const reopened = openEditor(copyOf(ydoc));
        expect(textOfEditor(reopened)).toBe(text);
        expect(JSON.stringify(reopened.getJSON())).toContain(`"${owner}"`);
    });

    it.each(kinds)('is read without an editor, when it is %s', (kind) => {
        const ydoc = noteWith(owner, name, WRONG[kind]());
        const before = Y.encodeStateAsUpdate(ydoc);

        expect(indexFromYDoc(ydoc).text).toContain('words');
        const options = { attachmentPath: () => null, notePath: () => null };
        expect(serializeDocument(rootFromYDoc(ydoc), options)).toContain('words');
        expect(renderNote(rootFromYDoc(ydoc)).markdown).toContain('words');
        renameTagInDoc(ydoc, 'a', 'b');

        // Reading is all it was: y-tiptap deletes what it cannot make.
        expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
    });
});

describe('a wrong value', () => {
    it('stays stored until its own node is edited', () => {
        const ydoc = noteWith('heading', 'indent', { toString: 'x' });
        const stored = () =>
            (ydoc.getXmlFragment(CONTENT_FIELD).get(1) as Y.XmlElement).getAttribute('indent');
        const editor = openEditor(ydoc);

        type(editor, 'first', ' typed');
        expect(stored()).toEqual({ toString: 'x' });

        type(editor, 'words', ' more');
        expect(stored()).toBeUndefined();
    });

    it('arriving from a peer does not close the note it arrives in', () => {
        const ydoc = new Y.Doc();
        ydoc.getXmlFragment(CONTENT_FIELD).insert(0, [para('first'), para('last')]);
        const editor = openEditor(ydoc);

        const peer = copyOf(ydoc);
        const blocks = peer.getXmlFragment(CONTENT_FIELD);
        const bad = { toString: 'x' } as unknown as string;
        peer.transact(() => {
            (blocks.get(0) as Y.XmlElement).setAttribute('indent', bad);
            for (const [owner, name] of EVERY) {
                blocks.insert(1, blocksWith(owner, { [name]: { toString: 'x' } }));
            }
        });
        Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer), 'remote');

        expect(textOfEditor(editor)).toBe(textOfEditor(openEditor(copyOf(peer))));
        type(editor, 'first', ' typed');
        expect(textOfEditor(openEditor(copyOf(ydoc)))).toContain('first typed');
    });

    it('is one thing to the editor and to the index', () => {
        // The tick a task shows is the one the todo page counts.
        for (const value of [1, 'yes', {}, [], 'true', true]) {
            const ydoc = noteWith('taskItem', 'checked', value);
            const ticked = openEditor(ydoc).view.dom.querySelector('input')!.checked;
            expect(ticked).toBe(value === 'true' || value === true);
            expect(indexFromYDoc(ydoc).completedTodoCount).toBe(ticked ? 1 : 0);
            expect(toggleTodoInDoc(ydoc, 0, 'words', !ticked)).toBe('changed');
            expect(indexFromYDoc(ydoc).completedTodoCount).toBe(ticked ? 0 : 1);
        }
        // A tag is renamed by the name it is listed under.
        const ydoc = noteWith('tag', 'name', 2024);
        expect(indexFromYDoc(ydoc).tags).toEqual(['2024']);
        expect(renameTagInDoc(ydoc, '2024', 'last year')).toBe(1);
        expect(indexFromYDoc(ydoc).tags).toEqual(['last year']);
    });

    it('does not cost a table its cells', () => {
        for (const value of [0, -1, 0.5, NaN, 1e9, '2', {}]) {
            for (const name of ['colspan', 'rowspan']) {
                const editor = openEditor(noteWith('tableCell', name, value));
                type(editor, 'first', ' typed');
                expect(textOfEditor(editor)).toMatch(/words.*b.*c.*d/);
            }
        }
    });
});

// --- what is pasted ----------------------------------------------------------

function paste(editor: Editor, html: string): void {
    // jsdom has no ClipboardEvent.
    editor.view.pasteHTML(html, new Event('paste') as ClipboardEvent);
}

/** HTML whose `data-pm-slice` says what is around its words, attributes and all. */
function sliceHtml(context: unknown[]): string {
    const span = document.createElement('span');
    span.setAttribute('data-pm-slice', `0 0 ${JSON.stringify(context)}`);
    span.textContent = 'pasted';
    return span.outerHTML;
}

/** What is around the words when they are pasted as if from `owner`. */
function contextWith(owner: string, attrs: object): unknown[] {
    switch (owner) {
        case 'bulletList':
        case 'orderedList':
            return [owner, attrs, 'listItem', null, 'paragraph', null];
        case 'taskList':
            return [owner, attrs, 'taskItem', null, 'paragraph', null];
        case 'taskItem':
            return ['taskList', null, owner, attrs, 'paragraph', null];
        case 'tableCell':
        case 'tableHeader':
            return ['table', null, 'tableRow', null, owner, attrs, 'paragraph', null];
        case 'documentLink':
        case 'tag':
            return ['paragraph', null, owner, attrs];
        case 'paragraph':
            // In something, or only its words are taken.
            return ['blockquote', null, owner, attrs];
        default:
            return [owner, attrs];
    }
}

/** The schema with nothing fitted, which reads what a note holds as it is. */
const plainSchema = getSchema(createContentExtensions());

// A mark is never around what is pasted, only on it, and is read from HTML.
const EVERY_NODE = EVERY.filter(([owner]) => owner in contentSchema().nodes);

describe.each(EVERY_NODE)('pasting a %s with a wrong %s', (owner, name) => {
    // Nothing can be around words that can have nothing in it, and ProseMirror
    // refuses the whole paste when it is told so.
    const leaf = contentSchema().nodes[owner]?.isLeaf ?? false;

    it.each(Object.keys(WRONG_JSON))('leaves a note that reopens, when it is %s', (kind) => {
        const ydoc = new Y.Doc();
        ydoc.getXmlFragment(CONTENT_FIELD).insert(0, [para('first'), element('paragraph', {})]);
        const editor = openEditor(ydoc);
        const html = sliceHtml(contextWith(owner, { [name]: WRONG_JSON[kind]() }));
        // In the empty line, which takes the node and not only its words.
        editor.commands.focus('end', { scrollIntoView: false });
        if (leaf) {
            expect(() => paste(editor, html)).toThrow();
        } else {
            paste(editor, html);
            // Of a table, only the words in it.
            const taken = !owner.startsWith('table');
            if (taken) expect(JSON.stringify(editor.getJSON())).toContain(`"${owner}"`);
            type(editor, 'pasted', ' more');
        }

        const text = textOfEditor(editor);
        expect(text).toMatch(leaf ? /^first/ : /^first.*pasted more/);
        expect(textOfEditor(openEditor(copyOf(ydoc)))).toBe(text);

        // It is not in what was stored either, only read as if it were not.
        const fitted = rootFromYDoc(ydoc).toJSON();
        const stored = yXmlFragmentToProseMirrorRootNode(
            ydoc.getXmlFragment(CONTENT_FIELD),
            plainSchema,
        );
        expect(stored.toJSON()).toEqual(fitted);
    });
});

describe('a node made without any of this', () => {
    // The extensions of our own that draw an attribute do not count on it
    // having been fitted.
    const schema = plainSchema;
    const bad = { toString: 'x' };
    const drawn = (node: Node) => {
        const holder = document.createElement('div');
        holder.append(DOMSerializer.fromSchema(schema).serializeNode(node));
        return holder.innerHTML;
    };

    it('is drawn as if the attribute were not set', () => {
        const { tag, documentLink, paragraph, image } = schema.nodes;
        for (const [node, without] of [
            [tag.create({ name: bad }), tag.create()],
            [documentLink.create({ targetId: bad, title: bad }), documentLink.create()],
            [paragraph.create({ indent: bad }), paragraph.create()],
            [image.create({ align: bad }), image.create()],
        ]) {
            expect(drawn(node)).toBe(drawn(without));
        }
        expect(drawn(tag.create({ name: 5 }))).toBe(drawn(tag.create({ name: '5' })));
        expect(drawn(documentLink.create({ title: 5 }))).toBe(
            drawn(documentLink.create({ title: '5' })),
        );
    });
});

describe('pasting', () => {
    it('takes a word for a number only where the attribute is one', () => {
        // Tiptap reads both of these as values, not as the text they are.
        const editor = openEditor(new Y.Doc());
        paste(editor, '<img src="https://a.example/b.png" alt="2024" title="true" width="300">');
        expect(editor.state.doc.firstChild!.attrs).toMatchObject({
            alt: '2024',
            title: 'true',
            width: 300,
        });
    });
});

// --- ordinary notes ------------------------------------------------------------

describe('an ordinary note', () => {
    const ORDINARY = [
        '<h2 data-indent="2">Heading</h2><p data-indent="1">One <a href="https://a.example" title="t">link</a>, <b>bold</b> and <code>code</code>.</p>',
        '<ul data-indent="3"><li><p>a</p><ul><li><p>b</p></li></ul></li></ul>',
        '<ol start="4" type="a"><li><p>four</p></li></ol><ol type="1"><li><p>one</p></li></ol>',
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>done</p></li><li data-type="taskItem" data-checked="false"><p>open</p></li></ul>',
        '<pre><code class="language-ts">const a = 1;</code></pre><pre><code>plain</code></pre>',
        `<img src="oyot-attachment://${'a'.repeat(64)}" alt="oyot:${'a'.repeat(64)}" width="300" height="200" data-align="center">`,
        '<img src="https://a.example/b.png" alt="A picture" title="Title" width="50%" height="auto">',
        '<table><tr><th colwidth="100" colspan="1">h</th><th style="text-align: right">i</th></tr><tr><td colspan="2" colwidth="100,0">j</td></tr><tr><td rowspan="2">k</td><td>l</td></tr><tr><td>m</td></tr></table>',
        '<p>To <span data-type="document-link" data-target-id="id" data-title="A note"></span> and <span data-type="tag" data-name="work"></span></p>',
        '<blockquote><p>quoted</p></blockquote><hr><p>line<br>break</p>',
        sliceHtml(['blockquote', null, 'heading', { indent: null, level: 3 }]),
    ];

    /** A note that has everything in it pasted, typed in and changed. */
    function written(extensions: Extensions): Uint8Array {
        const ydoc = new Y.Doc();
        // So that two notes written the same way are the same bytes.
        ydoc.clientID = 1;
        const editor = openEditor(ydoc, extensions);
        for (const html of ORDINARY) {
            editor.commands.focus('end', { scrollIntoView: false });
            paste(editor, html);
            editor.commands.focus('end', { scrollIntoView: false });
            editor.commands.createParagraphNear();
        }
        for (const text of ['Heading', 'four', 'done', 'const', 'j', 'l', 'To', 'quoted']) {
            type(editor, text, ' typed');
        }
        editor.commands.setTextSelection(positionOf(editor, 'Heading'));
        editor.commands.indent();
        return Y.encodeStateAsUpdate(ydoc);
    }

    const without = () => createContentExtensions().filter(({ name }) => name !== 'attributeTypes');

    it('is stored as it is without any of this', () => {
        expect(without()).toHaveLength(createContentExtensions().length - 1);
        const stored = written(createContentExtensions());
        expect(stored).toEqual(written(without()));

        // Everything was in it, so that says something.
        const ydoc = new Y.Doc();
        Y.applyUpdate(ydoc, stored);
        const root = rootFromYDoc(ydoc);
        const seen = new Set<string>();
        root.descendants((node) => {
            seen.add(node.type.name);
            node.marks.forEach((mark) => seen.add(mark.type.name));
        });
        for (const [owner] of EVERY) expect(seen, owner).toContain(owner);
    });

    it('is not written to by being opened, and is edited by the same few changes', () => {
        const stored = written(createContentExtensions());
        const edited = [createContentExtensions(), without()].map((extensions) => {
            const ydoc = new Y.Doc();
            ydoc.clientID = 2;
            Y.applyUpdate(ydoc, stored);
            const updates: Uint8Array[] = [];
            ydoc.on('update', (update: Uint8Array) => updates.push(update));
            const editor = openEditor(ydoc, extensions);
            expect(updates).toEqual([]);
            for (const text of ['Heading', 'four', 'done', 'const', 'j', 'l', 'To', 'quoted']) {
                type(editor, text, ' again');
            }
            return updates;
        });
        expect(edited[0].length).toBeGreaterThan(0);
        expect(edited[0]).toEqual(edited[1]);
    });
});

// Yjs and yrs agree about documents the editor writes (ADR 0031, ADR 0033).
//
// The editor is Yjs; merging moves to yrs in Rust. They share a format, not
// code, so this pins down the two things that have to hold across them:
//
// - the content hash, a digest of the state vector and delete set, comes out
//   the same whichever library holds the document;
// - each can read what the other wrote, and the note renders the same.
//
// This side writes the fixtures (src-tauri/tests/fixtures/crdt/*.json) from
// real editor documents and checks they are up to date; the Rust side checks
// yrs against them and writes what yrs encodes (yrs/*.bin), which this side
// reads back. Regenerate with `WRITE_CRDT_FIXTURES=1 npx vitest run
// src/lib/sync/crdtInterop.test.ts` after changing a scenario, then
// `OYOT_WRITE_FIXTURES=1 cargo test crdt` in src-tauri.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap';
import { createContentExtensions } from '$lib/editor/extensions';
import { CONTENT_FIELD } from '$lib/editor/contentField';
import { indexFromYDoc } from '$lib/editor/headlessIndex';
import { base64ToBytes, bytesToBase64, EMPTY_CONTENT_HASH } from './protocol';
import { contentDigest } from '../../test/contentDigest';

const FIXTURES = resolve(__dirname, '../../../src-tauri/tests/fixtures/crdt');
const WRITE = process.env.WRITE_CRDT_FIXTURES === '1';

const schema = getSchema(createContentExtensions());

// --- documents the editor would write ---------------------------------------

const HASH = 'ab'.repeat(32);

const text = (t: string, marks?: unknown[]) =>
    marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };
const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const task = (label: string, checked: boolean, children: unknown[] = []) => ({
    type: 'taskItem',
    attrs: { checked },
    content: [para(text(label)), ...children],
});
const cell = (label: string, type = 'tableCell') => ({ type, content: [para(text(label))] });

/** Everything a note is made of, with text outside ASCII. */
const RICH = {
    type: 'doc',
    content: [
        { type: 'heading', attrs: { level: 1 }, content: [text('Trip to Kyōto 🍵')] },
        para(
            text('Pack '),
            text('light', [{ type: 'bold' }]),
            text(' and '),
            text('early', [{ type: 'italic' }]),
            text(', see '),
            text('the map', [{ type: 'link', attrs: { href: 'https://example.com/map' } }]),
            text(' '),
            { type: 'tag', attrs: { name: 'travel' } },
            text(' '),
            { type: 'documentLink', attrs: { targetId: 'doc-2', title: 'Itinerary' } },
        ),
        {
            type: 'bulletList',
            content: [
                { type: 'listItem', content: [para(text('Passport'))] },
                { type: 'listItem', content: [para(text('Yen ¥'))] },
            ],
        },
        {
            type: 'taskList',
            content: [
                task('Book hotel', true, [
                    { type: 'taskList', content: [task('Check in 15:00', false)] },
                ]),
                task('Buy JR pass', false),
            ],
        },
        {
            type: 'table',
            content: [
                {
                    type: 'tableRow',
                    content: [cell('Day', 'tableHeader'), cell('Plan', 'tableHeader')],
                },
                { type: 'tableRow', content: [cell('Mon'), cell('Fushimi Inari ⛩')] },
                { type: 'tableRow', content: [cell('Tue'), cell('Arashiyama')] },
            ],
        },
        { type: 'image', attrs: { src: `oyot-attachment://${HASH}`, alt: `oyot:${HASH}` } },
    ],
};

function docOf(client: number): Y.Doc {
    const doc = new Y.Doc();
    doc.clientID = client;
    return doc;
}

function written(client: number, json: unknown): Y.Doc {
    const doc = docOf(client);
    prosemirrorJSONToYXmlFragment(schema, json, doc.getXmlFragment(CONTENT_FIELD));
    return doc;
}

function paragraphText(doc: Y.Doc, index: number): Y.XmlText {
    const paragraph = doc.getXmlFragment(CONTENT_FIELD).get(index) as Y.XmlElement;
    return paragraph.get(0) as Y.XmlText;
}

interface Fixture {
    name: string;
    /** Incremental updates, in the order they were made. */
    updates: string[];
    /** The merged state, as Yjs encodes it. */
    state: string;
    /** The content hash, or null while updates are pending. */
    digest: string | null;
    /** The searchable text, as the headless indexer reads it. */
    text: string;
    /** For a pending document: the update it is missing, and the result. */
    missing?: string;
    completeDigest?: string;
    completeText?: string;
}

function describeDoc(name: string, updates: Uint8Array[], extra: Partial<Fixture> = {}): Fixture {
    const merged = new Y.Doc();
    for (const update of updates) Y.applyUpdate(merged, update);
    return {
        name,
        updates: updates.map(bytesToBase64),
        state: bytesToBase64(Y.encodeStateAsUpdate(merged)),
        digest: contentDigest(merged),
        text: contentDigest(merged) === null ? '' : indexFromYDoc(merged).text,
        ...extra,
    };
}

function scenarios(): Fixture[] {
    // One device writes a whole note.
    const rich = written(101, RICH);

    // Three devices: one writes the note, two others edit it at the same
    // time, both deleting, so the delete set has several clients in it (the
    // ordering Yjs and yrs encode differently).
    const base = written(201, RICH);
    const baseUpdate = Y.encodeStateAsUpdate(base);
    const second = docOf(202);
    Y.applyUpdate(second, baseUpdate);
    const third = docOf(203);
    Y.applyUpdate(third, baseUpdate);

    const before202 = Y.encodeStateVector(second);
    const intro = paragraphText(second, 1);
    intro.insert(0, 'Please ');
    intro.delete(7, 5);
    const tasks = second.getXmlFragment(CONTENT_FIELD).get(3) as Y.XmlElement;
    (tasks.get(1) as Y.XmlElement).setAttribute('checked', true as unknown as string);
    const edit202 = Y.encodeStateAsUpdate(second, before202);

    const before203 = Y.encodeStateVector(third);
    const table = third.getXmlFragment(CONTENT_FIELD).get(4) as Y.XmlElement;
    table.delete(2, 1);
    const heading = (third.getXmlFragment(CONTENT_FIELD).get(0) as Y.XmlElement).get(
        0,
    ) as Y.XmlText;
    heading.delete(0, 5);
    const added = new Y.XmlElement('paragraph');
    added.insert(0, [new Y.XmlText('Added later on another device 📱')]);
    third.getXmlFragment(CONTENT_FIELD).insert(2, [added]);
    const edit203 = Y.encodeStateAsUpdate(third, before203);

    // An update whose predecessor has not arrived.
    const writer = docOf(301);
    const body = writer.getXmlFragment(CONTENT_FIELD);
    const first = new Y.XmlElement('paragraph');
    first.insert(0, [new Y.XmlText('first')]);
    body.insert(0, [first]);
    const firstUpdate = Y.encodeStateAsUpdate(writer);
    const svAfterFirst = Y.encodeStateVector(writer);
    const nextPara = new Y.XmlElement('paragraph');
    nextPara.insert(0, [new Y.XmlText('second')]);
    body.insert(1, [nextPara]);
    const secondUpdate = Y.encodeStateAsUpdate(writer, svAfterFirst);
    const complete = new Y.Doc();
    Y.applyUpdate(complete, secondUpdate);
    Y.applyUpdate(complete, firstUpdate);

    return [
        describeDoc('rich', [Y.encodeStateAsUpdate(rich)]),
        describeDoc('edited', [baseUpdate, edit202, edit203]),
        describeDoc('empty', [Y.encodeStateAsUpdate(new Y.Doc())]),
        describeDoc('pending', [secondUpdate], {
            missing: bytesToBase64(firstUpdate),
            completeDigest: contentDigest(complete) ?? undefined,
            completeText: indexFromYDoc(complete).text,
        }),
    ];
}

function fixturePath(name: string): string {
    return resolve(FIXTURES, `${name}.json`);
}

describe('crdt fixtures', () => {
    const fresh = scenarios();

    it('are the documents this build writes', () => {
        if (WRITE) {
            mkdirSync(FIXTURES, { recursive: true });
            for (const fixture of fresh) {
                writeFileSync(fixturePath(fixture.name), JSON.stringify(fixture, null, 2) + '\n');
            }
        }
        for (const fixture of fresh) {
            const stored = JSON.parse(readFileSync(fixturePath(fixture.name), 'utf8'));
            expect(stored).toEqual(fixture);
        }
    });

    it('hash the same whatever order the updates arrive in', () => {
        const edited = fresh.find((f) => f.name === 'edited')!;
        const [a, b, c] = edited.updates.map(base64ToBytes);
        for (const order of [
            [a, b, c],
            [a, c, b],
            [c, b, a],
        ]) {
            const doc = new Y.Doc();
            for (const update of order) Y.applyUpdate(doc, update);
            expect(contentDigest(doc)).toBe(edited.digest);
        }
    });

    it('give an empty document the empty hash, and a pending one none', () => {
        expect(fresh.find((f) => f.name === 'empty')!.digest).toBe(EMPTY_CONTENT_HASH);
        expect(contentDigest(new Y.Doc())).toBe(EMPTY_CONTENT_HASH);
        expect(fresh.find((f) => f.name === 'pending')!.digest).toBeNull();
    });
});

describe('what yrs writes', () => {
    for (const name of ['rich', 'edited', 'empty', 'pending']) {
        const path = resolve(FIXTURES, 'yrs', `${name}.bin`);
        it.skipIf(!existsSync(path))(`reads back the same in Yjs: ${name}`, () => {
            const fixture = JSON.parse(readFileSync(fixturePath(name), 'utf8')) as Fixture;
            const doc = new Y.Doc();
            Y.applyUpdate(doc, new Uint8Array(readFileSync(path)));
            expect(contentDigest(doc)).toBe(fixture.digest);
            if (fixture.digest !== null) expect(indexFromYDoc(doc).text).toBe(fixture.text);

            // A pending document keeps what it could not apply, and finishes
            // once the missing update arrives.
            if (fixture.missing) {
                Y.applyUpdate(doc, base64ToBytes(fixture.missing));
                expect(contentDigest(doc)).toBe(fixture.completeDigest);
                expect(indexFromYDoc(doc).text).toBe(fixture.completeText);
            }
        });
    }
});

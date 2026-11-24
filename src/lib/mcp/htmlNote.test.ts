// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { rootFromYDoc } from '$lib/editor/headlessIndex';
import { findHtmlBlocks, isWholePage } from '$lib/editor/htmlPreview/blocks';
import { renderNote } from './noteMarkdown';
import { fakeDeps, HASH } from './testDocs';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const { createNoteFromHtml, editNote } = await import('./writes');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

async function make(html: string, mode: 'page' | 'editable' = 'page') {
    const docs = new Map();
    const fake = fakeDeps(docs);
    const made = await createNoteFromHtml('Report', html, mode, fake.deps);
    const root = rootFromYDoc(docs.get(made.id)!);
    return { ...made, ...fake, root, markdown: renderNote(root).markdown };
}

const unseen = async (html: string) => {
    const { scripts, outside } = (await make(html)).losses;
    return { scripts, outside };
};

describe('a page kept as it is', () => {
    it('is one block the viewer shows as a page', async () => {
        const html = '<!DOCTYPE html>\n<html><body><h1>Hi</h1></body></html>';
        const { root, created } = await make(`\uFEFF${html.replace('\n', '\r\n')}\n\n`);
        expect(created).toEqual(['Report']);
        expect(root.childCount).toBe(1);
        expect(findHtmlBlocks(root).map((b) => b.source)).toEqual([html]);
    });

    it('is given a doctype when it has none, as an artifact does not', async () => {
        const { root } = await make('<title>Q3</title><style>p{color:red}</style><p>Hi</p>');
        const [block] = findHtmlBlocks(root);
        expect(isWholePage(block.source)).toBe(true);
        expect(block.source).toMatch(/^<!doctype html>\n<title>Q3/);
    });

    it('can be read and changed as any note can', async () => {
        const page = '<!doctype html>\n<pre>\n```\ncode\n```\n\n    in\n</pre>\n<p>one & #two</p>';
        const { id, revision, markdown, deps } = await make(page);
        const same = await editNote(id, markdown, revision, false, deps);
        expect(same.status).toBe('unchanged');
        const changed = await editNote(id, markdown.replace('one', '1'), revision, false, deps);
        expect(changed.status).toBe('changed');
    });

    it('says when it has scripts', async () => {
        const some = { scripts: true, outside: false };
        expect(await unseen('<script>go()</script>')).toEqual(some);
        expect(await unseen('<script type="module">go()</script>')).toEqual(some);
        expect(await unseen('<button onclick="go()">go</button>')).toEqual(some);
        expect((await unseen('<script type="application/json">{}</script>')).scripts).toBe(false);
    });

    it('says when it names what will not be loaded', async () => {
        for (const html of [
            '<img src="https://example.com/a.png">',
            '<img src="a.png">',
            '<link rel="stylesheet" href="a.css">',
            '<style>@import "a.css";</style>',
            '<style>p { background: url( "a.png" ) }</style>',
            '<p style="background:url(https://example.com/a.png)">x</p>',
            '<style>@font-face { src: url(data:font/woff2;base64,AA) }</style>',
        ]) {
            expect(await unseen(html), html).toEqual({ scripts: false, outside: true });
        }
    });

    it('says nothing of a page that holds all it needs', async () => {
        for (const html of [
            `<img src="${PNG}"><a href="https://example.com">link</a>`,
            `<style>p { background: url( '${PNG}' ) } a { fill: url(#g) }</style>`,
            '<svg><use href="#a"/></svg>',
        ]) {
            expect(await unseen(html), html).toEqual({ scripts: false, outside: false });
        }
    });

    it('says when it is too long to be read whole', async () => {
        expect((await make('<p>x</p>')).tooLong).toBe(false);
        expect((await make(`<p>${'x'.repeat(200_000)}</p>`)).tooLong).toBe(true);
    });
});

describe('a page made editable', () => {
    it('becomes what it says, without its title again or its styles', async () => {
        const { markdown } = await make(
            '<style>p{}</style><h1>Report</h1><p>One <b>two</b></p>' +
                '<p><a href="oyot://note/n1">Kyoto trip</a></p>',
            'editable',
        );
        expect(markdown).toBe('One **two**\n\n[Kyoto trip](oyot://note/n1)\n');
    });

    it('stores the pictures in it, and counts what it could not keep', async () => {
        const { markdown, losses } = await make(
            `<p>a</p><img src="${PNG}" alt="Cat"><img src="b.png"><canvas></canvas>`,
            'editable',
        );
        expect(markdown).toContain(`![Cat](oyot-attachment://${HASH})`);
        expect(losses).toMatchObject({ imagesKeptAsText: 1, leftOut: 1 });
    });

    it('makes no note of a page with nothing to keep', async () => {
        const { deps, created } = fakeDeps(new Map());
        await expect(
            createNoteFromHtml('x', '<div id="root"></div><script>go()</script>', 'editable', deps),
        ).rejects.toThrow('no note was made');
        expect(created).toEqual([]);
    });
});

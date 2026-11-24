// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { TableMap } from '@tiptap/pm/tables';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { contentSchema } from '$lib/editor/headlessIndex';
import { htmlTitle, parseHtml, readHtml, type HtmlReadOptions } from './html';
import { blocksOf } from '../../test/blockJson';

const schema = contentSchema();
const HASH = 'a'.repeat(64);
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function readAll(html: string, options: HtmlReadOptions = {}) {
    return readHtml(parseHtml(html), schema, options);
}

function read(html: string, options: HtmlReadOptions = {}) {
    return blocksOf(readAll(html, options).doc);
}

const text = (value: string, ...marks: unknown[]) =>
    marks.length > 0 ? { type: 'text', text: value, marks } : { type: 'text', text: value };
const para = (...content: unknown[]) =>
    content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
const heading = (level: number, ...content: unknown[]) => ({
    type: 'heading',
    attrs: { level },
    content,
});
const item = (...content: unknown[]) => ({ type: 'listItem', content });
const bullets = (...content: unknown[]) => ({ type: 'bulletList', content });
const task = (checked: boolean, ...content: unknown[]) => ({
    type: 'taskItem',
    attrs: { checked },
    content,
});
const bold = { type: 'bold' };
const italic = { type: 'italic' };
const underline = { type: 'underline' };
const strike = { type: 'strike' };
const code = { type: 'code' };
const br = { type: 'hardBreak' };
const link = (href: string, title: string | null = null) => ({
    type: 'link',
    attrs: expect.objectContaining({ href, title }),
});
const image = (src: string, alt: string | null) =>
    expect.objectContaining({ type: 'image', attrs: expect.objectContaining({ src, alt }) });

describe('readHtml: text', () => {
    it('reads headings and paragraphs', () => {
        expect(read('<h2>Trip</h2><p>two nights in Kyoto</p>')).toEqual([
            heading(2, text('Trip')),
            para(text('two nights in Kyoto')),
        ]);
    });

    it('gives an empty page one empty paragraph, as the editor has', () => {
        expect(read('')).toEqual([para()]);
        expect(read('<body>\n  <div>\n </div>\n</body>')).toEqual([para()]);
    });

    it('reads white space the way a browser shows it', () => {
        expect(read('<p>\n  two\n  <b> nights</b>\tin <i>Kyoto </i> now </p>')).toEqual([
            para(
                text('two '),
                text('nights', bold),
                text(' in '),
                text('Kyoto ', italic),
                text('now'),
            ),
        ]);
    });

    it('gives loose text a paragraph, ended where a block begins', () => {
        expect(read('before<div>inside<p>deeper</p>after</div>beyond')).toEqual([
            para(text('before')),
            para(text('inside')),
            para(text('deeper')),
            para(text('after')),
            para(text('beyond')),
        ]);
    });

    it('lets go of what only arranges a page, and keeps what is in it', () => {
        expect(
            read(
                '<header><nav><a href="/">Home</a></nav></header><main><article><section>' +
                    '<p>words</p></section></article></main><custom-box>more</custom-box>',
            ),
        ).toEqual([para(text('Home', link('/'))), para(text('words')), para(text('more'))]);
    });

    it('breaks a line at a <br>, but not at the end of a block', () => {
        expect(read('<p>one<br> two<br></p>')).toEqual([para(text('one'), br, text('two'))]);
    });

    it('reads a block of nothing but space as the empty line it makes', () => {
        expect(read('<p>a</p><p>&nbsp;</p><div><br></div><p></p><p>b</p>')).toEqual([
            para(text('a')),
            para(),
            para(),
            para(text('b')),
        ]);
    });

    it('does not read what is not content', () => {
        expect(
            read(
                '<head><style>p{}</style></head><script>alert(1)</script><style>b{}</style>' +
                    '<template><p>t</p></template><noscript>n</noscript><!-- c -->' +
                    '<p hidden>h</p><p style="DISPLAY : none">d</p><dialog>closed</dialog>' +
                    '<select><option>o</option></select><p>words</p>',
            ),
        ).toEqual([para(text('words'))]);
    });

    it('quotes what a <q> quotes', () => {
        expect(read('<p>she said <q>no</q></p>')).toEqual([para(text('she said “no”'))]);
    });

    it('reads a quote, with the paragraphs inside it', () => {
        expect(read('<blockquote><p>one</p><p>two</p></blockquote>')).toEqual([
            { type: 'blockquote', content: [para(text('one')), para(text('two'))] },
        ]);
    });

    it('does not make a tag of a #word', () => {
        expect(read('<p>#ff0000 and #home</p>')).toEqual([para(text('#ff0000 and #home'))]);
    });
});

describe('readHtml: emphasis', () => {
    it('reads the emphasis a note has, by its tag', () => {
        expect(
            read(
                '<p><strong>a</strong><em>b</em><ins>c</ins><del>d</del><kbd>e</kbd>' +
                    '<mark>f</mark><sup>g</sup></p>',
            ),
        ).toEqual([
            para(
                text('a', bold),
                text('b', italic),
                text('c', underline),
                text('d', strike),
                text('e', code),
                text('fg'),
            ),
        ]);
    });

    it('reads emphasis from a style', () => {
        expect(
            read(
                '<p><span style="font-weight:700">a</span><span style="font-style: Italic">b</span>' +
                    '<span style="text-decoration:underline">c</span>' +
                    '<span style="text-decoration-line: line-through">d</span></p>',
            ),
        ).toEqual([
            para(text('a', bold), text('b', italic), text('c', underline), text('d', strike)),
        ]);
    });

    // What Google Docs wraps everything it copies in.
    it('takes emphasis away where a style does', () => {
        expect(
            read('<b style="font-weight:normal">a<i>b<em style="font-style:normal">c</em></i></b>'),
        ).toEqual([para(text('a'), text('b', italic), text('c'))]);
    });

    it('carries emphasis into the blocks inside it', () => {
        expect(read('<b><p>one</p><ul><li>two</li></ul></b>')).toEqual([
            para(text('one', bold)),
            bullets(item(para(text('two', bold)))),
        ]);
    });

    it('keeps the link rather than the code when something is both', () => {
        expect(read('<p><code><a href="https://a.b/c">x</a></code></p>')).toEqual([
            para(text('x', link('https://a.b/c'))),
        ]);
    });
});

describe('readHtml: links', () => {
    it('keeps a link and its title', () => {
        expect(read('<a href="https://a.b/c?d=1" title="T">x</a>')).toEqual([
            para(text('x', link('https://a.b/c?d=1', 'T'))),
        ]);
    });

    it('does not add the underline a link already has', () => {
        expect(
            read(
                '<a href="https://a.b" style="text-decoration:underline">x</a>' +
                    '<a href="https://a.b"><span style="text-decoration:underline">y</span></a>',
            ),
        ).toEqual([para(text('xy', link('https://a.b')))]);
    });

    it('keeps only the words of a link that leads nowhere from a note', () => {
        const hrefs = [
            '#part',
            '',
            'javascript:alert(1)',
            ' JavaScript:alert(1)',
            'java&#9;script:alert(1)',
            '&#1;javascript:alert(1)',
            'data:text/html,x',
            'vbscript:x',
            'file:///etc/passwd',
            'C:\\notes.html',
        ];
        for (const href of hrefs) {
            expect(read(`<a href="${href}">x</a>`), href).toEqual([para(text('x'))]);
        }
        expect(read('<a name="part">x</a>')).toEqual([para(text('x'))]);
    });

    it('makes a relative address whole only when the page says what it is relative to', () => {
        expect(read('<a href="/b">x</a>')).toEqual([para(text('x', link('/b')))]);
        expect(
            read('<head><base href="https://a.com/c/"></head><body><a href="../b">x</a>'),
        ).toEqual([para(text('x', link('https://a.com/b')))]);
        expect(read('<head><base href="javascript:x"></head><body><a href="b">x</a>')).toEqual([
            para(text('x', link('b'))),
        ]);
    });

    it('links to a note imported with it, keeping words of its own', () => {
        const options = {
            noteLink: (href: string) =>
                href === 'packing.html' ? { id: 'n1', title: 'Packing' } : null,
        };
        const chip = { type: 'documentLink', attrs: { targetId: 'n1', title: 'Packing' } };
        expect(read('<p>see <a href="packing.html"> packing </a></p>', options)).toEqual([
            para(text('see '), chip),
        ]);
        expect(read('<p><a href="packing.html">the <b>list</b></a>.</p>', options)).toEqual([
            para(text('the '), text('list', bold), text(' '), chip, text('.')),
        ]);
    });
});

describe('readHtml: lists', () => {
    it('reads lists, and lists inside their items', () => {
        expect(
            read('<ul>\n<li>a\n<ol start="3"><li>b</li></ol></li>\n<li><p>c</p></li>\n</ul>'),
        ).toEqual([
            bullets(
                item(para(text('a')), {
                    type: 'orderedList',
                    attrs: expect.objectContaining({ start: 3 }),
                    content: [item(para(text('b')))],
                }),
                item(para(text('c'))),
            ),
        ]);
    });

    it('gives a list written straight inside a list to the item above', () => {
        expect(read('<ul><li>a</li><ul><li>b</li></ul></ul>')).toEqual([
            bullets(item(para(text('a')), bullets(item(para(text('b')))))),
        ]);
    });

    it('makes an item of what is in a list without being one', () => {
        expect(read('<ul>loose<li>a</li><div>b</div></ul>')).toEqual([
            bullets(item(para(text('loose'))), item(para(text('a'))), item(para(text('b')))),
        ]);
    });

    it('reads an item that begins with a checkbox as a task', () => {
        expect(
            read(
                '<ul><li><input type="checkbox" checked> a</li>' +
                    '<li><label><input type=CHECKBOX><span>b</span></label></li></ul>',
            ),
        ).toEqual([
            {
                type: 'taskList',
                content: [task(true, para(text('a'))), task(false, para(text('b')))],
            },
        ]);
    });

    it('reads a task as the editor writes one', () => {
        expect(
            read('<ul data-type="taskList"><li data-checked="true"><div><p>a</p></div></li></ul>'),
        ).toEqual([{ type: 'taskList', content: [task(true, para(text('a')))] }]);
    });

    it('splits a list that mixes tasks and items', () => {
        expect(read('<ul><li>a</li><li><input type=checkbox>b</li></ul>')).toEqual([
            bullets(item(para(text('a')))),
            { type: 'taskList', content: [task(false, para(text('b')))] },
        ]);
    });

    it('does not read a checkbox after words as a task', () => {
        expect(read('<ul><li>a <input type="checkbox"></li></ul>')).toEqual([
            bullets(item(para(text('a')))),
        ]);
    });

    it('puts an empty paragraph before an item that opens with something else', () => {
        expect(read('<ul><li><h3>a</h3></li><li></li></ul>')).toEqual([
            bullets(item(para(), heading(3, text('a'))), item(para())),
        ]);
    });
});

describe('readHtml: code', () => {
    const block = (language: string | null, content: string) => ({
        type: 'codeBlock',
        attrs: expect.objectContaining({ language }),
        content: [text(content)],
    });

    it('keeps code as it is written', () => {
        expect(read('<pre>\nif (a)\n    <span class="k">b</span>()<br>c&nbsp;d\n</pre>')).toEqual([
            block(null, 'if (a)\n    b()\nc d'),
        ]);
    });

    it('knows the language a highlighter was told', () => {
        expect(read('<pre><code class="hljs language-c++">a</code></pre>')).toEqual([
            block('c++', 'a'),
        ]);
        expect(read('<pre class="lang-ts"><code>a</code></pre>')).toEqual([block('ts', 'a')]);
        expect(read('<div class="highlight highlight-source-rust"><pre>a</pre></div>')).toEqual([
            block('rust', 'a'),
        ]);
    });

    it('drops an empty block of code', () => {
        expect(read('<pre> \n</pre><p>a</p>')).toEqual([para(text('a'))]);
    });
});

describe('readHtml: tables', () => {
    /** The first table, and what the editor would find wrong with it. */
    function table(html: string): { node: ProseMirrorNode; problems: unknown } {
        let node: ProseMirrorNode | null = null;
        readAll(html).doc.descendants((child) => {
            if (child.type.name === 'table') node ??= child;
        });
        if (!node) throw new Error('no table');
        return { node, problems: TableMap.get(node).problems };
    }

    /** Each row as its cells: their text, with any span. */
    function rows(node: ProseMirrorNode): string[][] {
        return node.children.map((row) =>
            row.children.map((cell) => {
                const { colspan, rowspan } = cell.attrs;
                const span = colspan > 1 || rowspan > 1 ? ` ${colspan}x${rowspan}` : '';
                return `${cell.type.name === 'tableHeader' ? '*' : ''}${cell.textContent}${span}`;
            }),
        );
    }

    it('reads a table, its caption before it and its footer last', () => {
        const html =
            '<table><caption>Costs</caption><tfoot><tr><td>sum<td>3</tfoot>' +
            '<thead><tr><th>what<td>cost</thead><tbody><tr><td>tea<td align="right">3</table>';
        expect(read(html)[0]).toEqual(para(text('Costs')));
        const { node, problems } = table(html);
        expect(rows(node)).toEqual([
            ['*what', '*cost'],
            ['tea', '3'],
            ['sum', '3'],
        ]);
        expect(node.child(1).child(1).attrs.align).toBe('right');
        expect(problems).toBeNull();
    });

    it('keeps blocks in a cell', () => {
        const { node } = table(
            '<table><tr><td><p>a</p><ul><li>b</li></ul></td><td></td></tr></table>',
        );
        expect(
            node
                .child(0)
                .child(0)
                .children.map((block) => block.type.name),
        ).toEqual(['paragraph', 'bulletList']);
        expect(
            node
                .child(0)
                .child(1)
                .children.map((block) => block.type.name),
        ).toEqual(['paragraph']);
    });

    it('keeps cells that span', () => {
        const { node, problems } = table(
            '<table><tr><td rowspan=2>a<td colspan=2>b<tr><td>c<td>d</table>',
        );
        expect(rows(node)).toEqual([
            ['a 1x2', 'b 2x1'],
            ['c', 'd'],
        ]);
        expect(problems).toBeNull();
    });

    // Each is a grid the editor would change the note to mend on opening it.
    it('makes a full grid of a table that is not one', () => {
        const broken = [
            '<table><tr><td>a<tr><td>b<td>c<td>d</table>',
            '<table><tr><td rowspan=9>a<td>b<tr><td>c</table>',
            '<table><tr><td rowspan=0>a<td>b<tr><td>c<tr><td>d</table>',
            '<table><tr><td>a<td rowspan=2>b<tr><td colspan=3>c</table>',
            '<table><tr><td rowspan=2>a<td rowspan=2>b<tr></tr><tr><td>c</table>',
            '<table><thead><tr><th rowspan=3>a<th>b</thead><tbody><tr><td>c<td>d</table>',
            '<table><tr><td>a<td>b<td rowspan=3>c<tr><td>d<tr><td>e</table>',
            '<table><tr><td colspan=-1 rowspan=x>a<td>b</table>',
        ];
        for (const html of broken) expect(table(html).problems, html).toBeNull();
        expect(rows(table(broken[0]).node)).toEqual([
            ['a', '', ''],
            ['b', 'c', 'd'],
        ]);
    });

    it('lets go of a table that only arranges a page', () => {
        const flat = [para(text('a')), para(text('b'))];
        expect(read('<table role=presentation><tr><td>a<td>b</table>')).toEqual(flat);
        expect(
            read('<table><tr><td><table><tr><td>a</table></td></tr><tr><td>b</td></tr></table>'),
        ).toEqual(flat);
        expect(read('<table><tr><td><p>a</p><p>b</p></td></tr></table>')).toEqual(flat);
    });

    it('lets go of a table that claims a grid far larger than it is', () => {
        const wide = `<tr>${'<td colspan=100>x'.repeat(6)}</tr>`;
        const html = `<table>${wide}${'<tr><td>y</tr>'.repeat(100)}</table>`;
        expect(read(html).every((block: { type: string }) => block.type === 'paragraph')).toBe(
            true,
        );
        expect(read(html)).toHaveLength(106);
    });
});

describe('readHtml: images and what else is shown', () => {
    it('keeps a picture inside the file for the caller to store', () => {
        expect(read(`<p>a <img src="${PNG}" alt=" the  sea "> b</p>`)).toEqual([
            para(text('a')),
            image(PNG, 'the sea'),
            para(text('b')),
        ]);
    });

    it('keeps an image that names an attachment', () => {
        expect(read(`<img src="attachments/${HASH}.png">`)).toEqual([
            image(`oyot-attachment://${HASH}`, `oyot:${HASH}`),
        ]);
    });

    it('keeps any other image as its Markdown, and counts it', () => {
        const { doc, imagesKeptAsText, leftOut } = readAll(
            '<p><img src="beside.png" alt="sea"><img src="https://a.b/c.png"></p>',
        );
        expect(blocksOf(doc)).toEqual([para(text('![sea](beside.png)![](https://a.b/c.png)'))]);
        expect([imagesKeptAsText, leftOut]).toEqual([2, 0]);
    });

    it('never takes an address on the web for an attachment', () => {
        const src = `https://a.b/attachments/${HASH}.png`;
        expect(read(`<img src="${src}">`)).toEqual([para(text(`![](${src})`))]);
    });

    it('finds the picture a page meant to load later', () => {
        expect(read(`<img src="${PNG}" data-src="https://a.b/c.png">`)).toEqual([
            para(text('![](https://a.b/c.png)')),
        ]);
        expect(read('<img srcset="https://a.b/s.png 1x, https://a.b/l.png 2x">')).toEqual([
            para(text('![](https://a.b/s.png)')),
        ]);
    });

    it('does not keep a pixel that counts who opened the page', () => {
        const { doc, imagesKeptAsText } = readAll(
            '<p>a<img src="https://a.b/t.gif" width="1" height="1"></p>',
        );
        expect(blocksOf(doc)).toEqual([para(text('a'))]);
        expect(imagesKeptAsText).toBe(0);
    });

    it('leaves out a picture a note cannot hold, keeping what describes it', () => {
        const { doc, leftOut } = readAll(
            '<p><img src="data:image/svg+xml,%3Csvg%3E" alt="chart"></p>' +
                '<p><img src="cid:1"></p><p><img alt="no picture"></p>',
        );
        expect(blocksOf(doc)).toEqual([para(text('chart')), para(text('no picture'))]);
        expect(leftOut).toBe(2);
    });

    it('counts a drawing, but not an icon', () => {
        const { doc, leftOut } = readAll(
            '<svg width="600" height="400"><title>t</title><text>words</text></svg><canvas></canvas>' +
                '<svg aria-hidden="true"></svg><svg width="16" height="16"></svg>' +
                '<a href="https://a.b"><svg></svg>x</a>',
        );
        expect(blocksOf(doc)).toEqual([para(text('x', link('https://a.b')))]);
        expect(leftOut).toBe(2);
    });

    it('makes a link of a player, and counts one that has no address', () => {
        const { doc, leftOut } = readAll(
            '<p><iframe src="https://v.com/1" title="Talk"></iframe></p>' +
                '<video><source src="https://v.com/2.mp4">no video</video>' +
                '<iframe srcdoc="<p>x</p>"></iframe><iframe src="javascript:x"></iframe>',
        );
        expect(blocksOf(doc)).toEqual([
            para(text('Talk', link('https://v.com/1'))),
            para(text('https://v.com/2.mp4', link('https://v.com/2.mp4'))),
        ]);
        expect(leftOut).toBe(2);
    });

    it('reads a formula once, as its TeX', () => {
        expect(
            read(
                '<p>so <span class="katex"><span class="katex-mathml"><math><mi>x</mi>' +
                    '<annotation encoding="application/x-tex">x^2</annotation></math></span>' +
                    '<span class="katex-html" aria-hidden="true">x2</span></span></p>',
            ),
        ).toEqual([para(text('so '), text('x^2', code))]);
    });
});

describe('readHtml: a page that is trouble', () => {
    it('runs nothing in it', () => {
        const before = Object.keys(globalThis).length;
        read(
            '<script>globalThis.ran = 1</script><img src=x onerror="globalThis.ran = 1">' +
                '<svg onload="globalThis.ran = 1"></svg><body onload="globalThis.ran = 1">',
        );
        expect('ran' in globalThis).toBe(false);
        expect(Object.keys(globalThis).length).toBe(before);
    });

    it('reads a page cut short', () => {
        expect(read('<ul><li>a<table><tr><td>b<td>c')).toEqual([
            bullets(item(para(text('a')), expect.objectContaining({ type: 'table' }))),
        ]);
    });

    it('reads a long page in good time', () => {
        const html = `<p>${'a '.repeat(200_000)}</p>${'<p>b</p>'.repeat(20_000)}`;
        const started = performance.now();
        expect(readAll(html).doc.childCount).toBe(20_001);
        expect(performance.now() - started).toBeLessThan(15_000);
    });
});

describe('htmlTitle', () => {
    const title = (html: string) => htmlTitle(parseHtml(html));

    it('is the title the page gives, on one line', () => {
        expect(title('<title> Trip\n to Kyoto </title><h1>Other</h1>')).toBe('Trip to Kyoto');
    });

    it('is the first heading when the page gives none', () => {
        expect(title('<h2>a</h2><h1> </h1><h1 hidden>x</h1><h1>Trip <b>two</b></h1>')).toBe(
            'Trip two',
        );
        expect(title('<title> </title><h1>Trip</h1>')).toBe('Trip');
    });

    it('is nothing when the page has neither', () => {
        expect(title('<p>a</p><svg><title>icon</title></svg>')).toBe('');
    });
});

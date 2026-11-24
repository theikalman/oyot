// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createFrame, disarmLinks, previewDocument } from './frame';

describe('createFrame', () => {
    // The one thing that must never change by accident: with scripts as well
    // as the app's origin, the page in the frame could do all the app can.
    it('lets nothing in the frame run, go anywhere or open anything', () => {
        const frame = createFrame('<p>x</p>');
        expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');
        expect(frame.hasAttribute('src')).toBe(false);
        expect(frame.hasAttribute('allow')).toBe(false);
    });
});

describe('previewDocument', () => {
    const parse = (source: string) =>
        new DOMParser().parseFromString(previewDocument(source), 'text/html');

    it('puts its own base and policy ahead of anything the page says', () => {
        for (const source of [
            '<p>x</p>',
            '<!doctype html><html lang="en"><head><base href="https://a.b/"><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body class="c">x</body></html>',
            '<!-- never closed',
            '</head></html>',
        ]) {
            const page = parse(source);
            const [base, policy] = page.head.children;
            expect(base.outerHTML, source).toBe('<base href="about:srcdoc" target="_blank">');
            expect(policy.getAttribute('content'), source).toBe(
                "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
            );
        }
    });

    it('keeps the page as it was written', () => {
        const page = parse(
            '<!doctype html><html lang="en"><head><title>T</title></head><body class="c"><p>x</p></body></html>',
        );
        expect(page.documentElement.lang).toBe('en');
        expect(page.title).toBe('T');
        expect(page.body.outerHTML).toBe('<body class="c"><p>x</p></body>');
    });
});

describe('disarmLinks', () => {
    function disarmed(html: string): Element[] {
        const page = new DOMParser().parseFromString(html, 'text/html');
        disarmLinks(page.documentElement);
        return [...page.querySelectorAll('a, area')];
    }

    it('aims a link out of the page where the sandbox lets nothing open', () => {
        for (const target of ['', 'target="_self"', 'target="_top"', 'target="x"']) {
            const [link] = disarmed(`<a href="https://a.b/c" ${target}>x</a>`);
            expect(link.getAttribute('target')).toBe('_blank');
            expect(link.getAttribute('href')).toBe('https://a.b/c');
            expect(link.getAttribute('title')).toBe('https://a.b/c');
        }
    });

    it('keeps a title the page gave', () => {
        expect(disarmed('<a href="https://a.b" title="T">x</a>')[0].getAttribute('title')).toBe(
            'T',
        );
    });

    it('leaves a link within the page working', () => {
        const [link] = disarmed('<a href=" #far" target="_blank">x</a>');
        expect(link.getAttribute('target')).toBe('_self');
        expect(link.hasAttribute('title')).toBe(false);
    });

    it('finds the ones that are not plain links', () => {
        const links = disarmed(
            '<map><area href="https://a.b"></map>' +
                '<svg><a href="https://a.b"></a><a xlink:href="https://a.b"></a></svg>',
        );
        expect(links.map((link) => link.getAttribute('target'))).toEqual([
            '_blank',
            '_blank',
            '_blank',
        ]);
    });

    it('leaves a link with no address alone', () => {
        expect(disarmed('<a name="x">x</a>')[0].outerHTML).toBe('<a name="x">x</a>');
    });
});

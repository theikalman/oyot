import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    COLOR_SCHEMES,
    DEFAULT_COLOR_SCHEME,
    colorSchemeFamilies,
    parseColorScheme,
} from './schemes';

const root = resolve(__dirname, '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

/** Each block in schemes.css, by the scheme id in its selector. */
function cssBlocks(): Map<string, Map<string, string>> {
    const css = read('src/lib/theme/schemes.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const blocks = new Map<string, Map<string, string>>();
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        const id = selector.match(/\[data-scheme='([a-z-]+)'\]/)?.[1];
        if (!id) continue;
        const vars = new Map<string, string>();
        for (const [, name, value] of body.matchAll(/(--[a-z-]+):\s*([^;]+);/g)) {
            vars.set(name, value.trim());
        }
        blocks.set(id, vars);
    }
    return blocks;
}

function luminance(hex: string): number {
    const [r, g, b] = [1, 3, 5].map((i) => {
        const v = parseInt(hex.slice(i, i + 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
}

const ids = COLOR_SCHEMES.map((s) => s.id);

describe('colour schemes', () => {
    it('has a block in schemes.css for every scheme, and no other', () => {
        expect([...cssBlocks().keys()].sort()).toEqual([...ids].sort());
    });

    it('defines every colour in every scheme', () => {
        const blocks = cssBlocks();
        const names = [...blocks.get(DEFAULT_COLOR_SCHEME)!.keys()].sort();
        for (const [id, vars] of blocks) {
            expect([...vars.keys()].sort(), id).toEqual(names);
        }
    });

    it('gives each scheme the appearance its list entry says', () => {
        const css = read('src/lib/theme/schemes.css');
        for (const scheme of COLOR_SCHEMES) {
            const block = css.slice(css.indexOf(`[data-scheme='${scheme.id}']`));
            expect(block.match(/color-scheme:\s*(light|dark)/)?.[1], scheme.id).toBe(
                scheme.appearance,
            );
        }
    });

    it('makes the default stand in for the root element without outranking a scheme', () => {
        const css = read('src/lib/theme/schemes.css').replace(/\/\*[\s\S]*?\*\//g, '');
        expect(css).toMatch(
            new RegExp(`:where\\(:root\\),\\s*\\[data-scheme='${DEFAULT_COLOR_SCHEME}'\\]`),
        );
        // A bare :root in a block that sets colours is as specific as a
        // scheme's own selector, so it would win over every scheme listed
        // before it. The one it may appear in sets only the aliases.
        for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
            if (!/(^|[\s,]):root/.test(selector)) continue;
            const names = [...body.matchAll(/(--[a-z-]+):/g)].map((m) => m[1]);
            expect(names, selector.trim()).toEqual(['--status-synced', '--status-offline']);
        }
    });

    // The pairs the app draws text or small marks with. 4.5:1 for words,
    // 3:1 for the accent and for marks, and less for muted text, which is
    // for what can be missed.
    const pairs: [string, string, number][] = [
        ['--text-primary', '--bg-primary', 4.5],
        ['--text-primary', '--bg-secondary', 4.5],
        ['--text-primary', '--code-bg', 4.5],
        ['--text-secondary', '--bg-primary', 4.5],
        ['--text-secondary', '--bg-secondary', 4.5],
        ['--text-muted', '--bg-primary', 2.5],
        ['--accent-color', '--bg-primary', 3],
        ['--accent-color', '--accent-bg', 3],
        ['--on-accent', '--btn-primary-bg', 4.5],
        ['--on-accent', '--btn-primary-hover', 4.5],
        ['--on-danger', '--status-error', 3],
        ['--on-danger', '--danger-hover', 3],
        ['--status-error', '--bg-primary', 3],
        ['--todo-open', '--bg-primary', 3],
        ['--todo-open', '--bg-accent', 3],
        ['--ok-text', '--ok-bg', 4.5],
        ['--warn-text', '--warn-bg', 4.5],
        ['--error-text', '--error-bg', 4.5],
        ['--info-text', '--info-bg', 4.5],
    ];

    it.each(ids)('keeps text readable in %s', (id) => {
        const vars = cssBlocks().get(id)!;
        for (const [fg, bg, min] of pairs) {
            const ratio = contrast(vars.get(fg)!, vars.get(bg)!);
            expect(ratio, `${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
        }
    });

    it('lists the same schemes in the bootstrap script in app.html', () => {
        const html = read('src/app.html');
        const listed = [...html.matchAll(/'([a-z]+-[a-z]+)': '(light|dark)'/g)].map(
            ([, id, appearance]) => ({ id, appearance }),
        );
        expect(listed).toEqual(COLOR_SCHEMES.map(({ id, appearance }) => ({ id, appearance })));
        expect(html).toContain(`var id = '${DEFAULT_COLOR_SCHEME}';`);
        expect(html).toContain(
            `legacy = { light: '${parseColorScheme('light')}', dark: '${parseColorScheme('dark')}' }`,
        );
    });

    it('lists the same schemes in Rust, which keeps a stored choice to one', () => {
        const rust = read('src-tauri/src/commands/config.rs');
        const list = rust.match(/COLOR_SCHEMES: \[&str; \d+\] = \[([^\]]*)\]/)![1];
        expect([...list.matchAll(/"([a-z-]+)"/g)].map((m) => m[1])).toEqual(ids);
    });
});

describe('parseColorScheme', () => {
    it('takes every scheme id', () => {
        for (const id of ids) expect(parseColorScheme(id)).toBe(id);
    });

    it('reads light and dark, stored before there were schemes', () => {
        expect(parseColorScheme('light')).toBe('catppuccin-latte');
        expect(parseColorScheme('dark')).toBe('catppuccin-macchiato');
    });

    it('refuses anything else', () => {
        for (const value of [null, undefined, '', 'solarized', 'Catppuccin-Mocha', 1, {}]) {
            expect(parseColorScheme(value)).toBeNull();
        }
    });
});

describe('colorSchemeFamilies', () => {
    it('groups the schemes by family, in their order', () => {
        expect(
            colorSchemeFamilies().map(({ family, schemes }) => [
                family,
                schemes.map((s) => s.name),
            ]),
        ).toEqual([
            ['Catppuccin', ['Latte', 'Frappé', 'Macchiato', 'Mocha']],
            ['Solarized', ['Light', 'Dark']],
        ]);
    });

    it('defaults to Catppuccin Macchiato', () => {
        expect(DEFAULT_COLOR_SCHEME).toBe('catppuccin-macchiato');
    });
});

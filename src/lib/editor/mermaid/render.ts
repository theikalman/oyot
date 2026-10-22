import type { Mermaid } from 'mermaid';

/**
 * Drawing a Mermaid definition as an SVG, in the colours of the scheme in use.
 *
 * Mermaid is loaded the first time a diagram is drawn, so a note without one
 * never pays for it. Diagrams are drawn one at a time, because Mermaid's
 * configuration is global and a scheme change between two drawings would
 * otherwise colour the second with the first one's settings.
 */

/** What drawing a diagram came to: the SVG, or why there is none. */
export type Drawing = { svg: string } | { error: string };

// Enough for the diagrams of the notes opened recently, so going back to one
// is instant, without holding on to every SVG ever drawn.
const CACHE_LIMIT = 50;
const cache = new Map<string, Drawing>();

let mermaidPromise: Promise<Mermaid> | null = null;
let configuredFor: string | null = null;
// Each drawing waits for the one before it.
let queue: Promise<unknown> = Promise.resolve();
let nextId = 0;

/** The colour scheme in use, as the root element names it (ADR 0036). */
export function currentScheme(): string {
    return document.documentElement.dataset.scheme ?? '';
}

/** A drawing already made for this key, if there is one. */
export function cachedDrawing(key: string): Drawing | undefined {
    const hit = cache.get(key);
    if (hit) {
        // Most recently used goes last, so the oldest is the first to go.
        cache.delete(key);
        cache.set(key, hit);
    }
    return hit;
}

/**
 * Draws `source` in the scheme in use. A definition Mermaid cannot read comes
 * back as an error rather than a rejection, since showing why is the point.
 */
export function drawDiagram(key: string, source: string): Promise<Drawing> {
    const hit = cachedDrawing(key);
    if (hit) return Promise.resolve(hit);

    const drawing = queue.then(async (): Promise<Drawing> => {
        try {
            const mermaid = await loadMermaid();
            configure(mermaid);
            const { svg } = await mermaid.render(`oyot-mermaid-${nextId++}`, source);
            return { svg };
        } catch (error) {
            return { error: firstLine(error) };
        }
    });
    queue = drawing;
    return drawing.then((result) => {
        remember(key, result);
        return result;
    });
}

function loadMermaid(): Promise<Mermaid> {
    if (mermaidPromise === null) {
        const loading = import('mermaid').then((module) => module.default);
        // A failed load is tried again next time, not remembered.
        loading.catch(() => {
            if (mermaidPromise === loading) mermaidPromise = null;
        });
        mermaidPromise = loading;
    }
    return mermaidPromise;
}

// Mermaid's settings are global, so they are set again whenever the scheme
// has changed since they were last set.
function configure(mermaid: Mermaid): void {
    const scheme = currentScheme();
    if (configuredFor === scheme) return;
    mermaid.initialize({
        startOnLoad: false,
        // Notes arrive from paired devices and through MCP, so a definition
        // is untrusted: no click handlers, no HTML in labels, and the output
        // goes through Mermaid's sanitiser.
        securityLevel: 'strict',
        // An error comes back to the caller, rather than being drawn into the
        // page as Mermaid's own error graphic.
        suppressErrorRendering: true,
        theme: 'base',
        themeVariables: themeVariablesFromCss(),
    });
    configuredFor = scheme;
}

/**
 * The scheme's colours, read from the CSS variables every scheme defines, so
 * a diagram matches whichever scheme is chosen without a mapping for each.
 * Mermaid's base theme works out the shades it needs from these.
 */
export function themeVariablesFromCss(): Record<string, string | boolean> {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    const css = (name: string) => style.getPropertyValue(name).trim();

    const background = css('--bg-primary');
    const surface = css('--bg-secondary');
    const text = css('--text-primary');
    const border = css('--border-light');
    return {
        darkMode: root.dataset.theme === 'dark',
        fontFamily: getComputedStyle(document.body).fontFamily,
        background,
        mainBkg: surface,
        primaryColor: surface,
        primaryTextColor: text,
        primaryBorderColor: border,
        secondaryColor: css('--bg-accent'),
        tertiaryColor: css('--code-bg'),
        lineColor: css('--text-secondary'),
        textColor: text,
        nodeBorder: border,
        noteBkgColor: css('--bg-accent'),
        noteTextColor: text,
        // Behind the words on a line, which the base theme otherwise draws
        // in a shade of its own that clashes with most schemes.
        edgeLabelBackground: background,
        // The first slice in the accent, so a pie reads at a glance. The
        // rest the base theme works out from the colours above.
        pie1: css('--accent-color'),
        pieStrokeColor: border,
        pieOuterStrokeColor: border,
    };
}

function remember(key: string, drawing: Drawing): void {
    cache.set(key, drawing);
    while (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
}

// Mermaid's parse errors run to several lines, pointing at the column with a
// row of dashes. The first line says what is wrong, which is enough here.
function firstLine(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const first = message.split('\n')[0].trim().replace(/:$/, '');
    return first || 'Unknown error';
}

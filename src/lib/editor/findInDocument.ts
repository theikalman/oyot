import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/** A run of the document's text that matches what is being looked for. */
export interface Match {
    from: number;
    to: number;
}

/**
 * Every place `query` is in the document, in order, ignoring case. Looked
 * for within one paragraph, heading or other block of text at a time, and
 * not across a tag, a link to another document or a line break, which are
 * not text: a match is a run of characters a reader would see together.
 */
export function findMatches(doc: ProseMirrorNode, query: string): Match[] {
    const needle = query.toLocaleLowerCase();
    if (needle === '') return [];
    const matches: Match[] = [];
    doc.descendants((node, pos) => {
        if (!node.isTextblock) return true;
        // Each run of text nodes side by side, with where it starts.
        let run = '';
        let runFrom = pos + 1;
        const flush = () => {
            const haystack = run.toLocaleLowerCase();
            // Lower-casing can change a string's length (İ), and then the
            // offsets would not be the document's.
            if (haystack.length === run.length) {
                let at = haystack.indexOf(needle);
                while (at !== -1) {
                    matches.push({ from: runFrom + at, to: runFrom + at + needle.length });
                    at = haystack.indexOf(needle, at + needle.length);
                }
            }
            run = '';
        };
        node.forEach((child, offset) => {
            if (child.isText) {
                if (run === '') runFrom = pos + 1 + offset;
                run += child.text ?? '';
            } else {
                flush();
            }
        });
        flush();
        return false;
    });
    return matches;
}

/** What is being looked for, where it was found, and which one is current. */
export interface FindState {
    query: string;
    matches: readonly Match[];
    /** Index into `matches`, or -1 when there are none. */
    current: number;
}

type FindMeta = { query: string } | { current: number };

export const findKey = new PluginKey<FindState>('findInDocument');

const NOTHING: FindState = { query: '', matches: [], current: -1 };

function clamp(current: number, count: number): number {
    if (count === 0) return -1;
    return ((current % count) + count) % count;
}

// The match nearest after `pos`, so looking again after an edit stays
// where the reader was rather than going back to the first.
function nearest(matches: readonly Match[], pos: number): number {
    if (matches.length === 0) return -1;
    const after = matches.findIndex((m) => m.from >= pos);
    return after === -1 ? 0 : after;
}

/**
 * Finding text in the open note or journal, while reading and while
 * editing.
 *
 * Decorations, as the code colours are, so nothing found is ever part of
 * the document or stored. The query and the current match are the plugin's
 * state, set through `setFindQuery` and `stepFind`, and found again
 * whenever the document changes, a peer's edit included.
 */
export function findPlugin(): Plugin<FindState> {
    return new Plugin<FindState>({
        key: findKey,
        state: {
            init: () => NOTHING,
            apply(tr, found) {
                const meta = tr.getMeta(findKey) as FindMeta | undefined;
                if (meta && 'query' in meta) {
                    const matches = findMatches(tr.doc, meta.query);
                    const from = tr.selection.from;
                    return { query: meta.query, matches, current: nearest(matches, from) };
                }
                if (meta && 'current' in meta) {
                    return { ...found, current: clamp(meta.current, found.matches.length) };
                }
                if (!tr.docChanged || found.query === '') return found;
                const matches = findMatches(tr.doc, found.query);
                const was = found.matches[found.current];
                const pos = was ? tr.mapping.map(was.from) : 0;
                return { ...found, matches, current: nearest(matches, pos) };
            },
        },
        props: {
            decorations(state) {
                const { matches, current } = findKey.getState(state) ?? NOTHING;
                if (matches.length === 0) return DecorationSet.empty;
                return DecorationSet.create(
                    state.doc,
                    matches.map(({ from, to }, i) =>
                        Decoration.inline(from, to, {
                            class: i === current ? 'find-match current' : 'find-match',
                        }),
                    ),
                );
            },
        },
    });
}

export const FindInDocument = Extension.create({
    name: 'findInDocument',

    addProseMirrorPlugins() {
        return [findPlugin()];
    },
});

/** What the editor needs to be told what to find, which an EditorView has. */
interface View {
    readonly state: EditorState;
    dispatch(tr: Transaction): void;
}

/** Look for `query` in the document, or stop looking with an empty one. */
export function setFindQuery(view: View, query: string): void {
    const meta: FindMeta = { query };
    view.dispatch(view.state.tr.setMeta(findKey, meta).setMeta('addToHistory', false));
}

/** Make the match `by` places on from the current one current, wrapping round. */
export function stepFind(view: View, by: number): void {
    const found = findKey.getState(view.state);
    if (!found || found.matches.length === 0) return;
    const meta: FindMeta = { current: found.current + by };
    view.dispatch(view.state.tr.setMeta(findKey, meta).setMeta('addToHistory', false));
}

/** What is being looked for now. */
export function findState(state: EditorState): FindState {
    return findKey.getState(state) ?? NOTHING;
}

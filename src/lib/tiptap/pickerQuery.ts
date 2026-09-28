import { PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';

/**
 * What has been typed into the note since a picker opened, which is what the
 * picker narrows its list by.
 *
 * Read from the document, not from key events. A phone's keyboard composes a
 * word before it commits it, and the key events it sends meanwhile carry no
 * character at all: Chrome on Android reports each one as `Unidentified`. A
 * picker listening for keys never learned what was typed. The letters went
 * into the note, the list never narrowed, and a tag that did not exist yet
 * could not be created. Whatever a keyboard, autocorrect, a swipe or
 * dictation does ends up as text in the document, which makes the document
 * the one place every way of typing can be read from. It is also where the
 * slash menu has always read its own query.
 *
 * Kept free of the popup and the view so the rules can be tested as the pure
 * functions they are.
 */
export interface PickerQuery {
    /** Where the typed text starts: the caret, when the picker opened. */
    from: number;
    /** Where it ends: the caret now. */
    to: number;
    /** The text between the two. */
    query: string;
}

export const pickerQueryKey = new PluginKey<PickerQuery | null>('pickerQuery');

/** Set as a transaction's meta for `pickerQueryKey`: start reading at the
 * caret, or stop reading. */
export type PickerQueryMeta = 'open' | 'close';

/**
 * The typed text after `tr`, or null once there is no longer any to read.
 *
 * `composing` is whether an input method is part way through a word, which is
 * the one time a selection that is not a caret still means typing.
 */
export function nextPickerQuery(
    tr: Transaction,
    prev: PickerQuery | null,
    state: EditorState,
    composing: boolean,
): PickerQuery | null {
    const meta = tr.getMeta(pickerQueryKey) as PickerQueryMeta | undefined;
    if (meta === 'close') return null;

    let from: number | null;
    if (meta === 'open') from = state.selection.from;
    else if (prev) from = follow(tr, prev, state);
    else return null;

    return from === null ? null : readFrom(state, from, composing);
}

function follow(tr: Transaction, prev: PickerQuery, state: EditorState): number | null {
    // Leftward, so what is typed at the very start of the query lands after
    // the start rather than pushing it along.
    const mapped = tr.mapping.mapResult(prev.from, -1);
    if (!mapped.deletedAcross) return mapped.pos;

    // A peer's edit is merged in by replacing the whole document, which maps
    // every position in it to the start. The collaboration binding carries the
    // caret across, and the text typed so far is still in front of it, so it
    // is found again there. The same test lets go of the query when an undo or
    // a paste over it has taken the text away.
    const { $to } = state.selection;
    const from = $to.pos - prev.query.length;
    if (from < $to.start()) return null;
    return state.doc.textBetween(from, $to.pos) === prev.query ? from : null;
}

function readFrom(state: EditorState, from: number, composing: boolean): PickerQuery | null {
    const { selection } = state;
    // A selection is someone doing something other than typing, except that
    // an input method can hold one over the word it is composing.
    if (!selection.empty && !composing) return null;

    // Moved back past where the typing started, or out of its paragraph:
    // typing elsewhere is not more of the query.
    const { $to } = selection;
    if (from > $to.pos || from < $to.start()) return null;

    return { from, to: $to.pos, query: state.doc.textBetween(from, $to.pos) };
}

import type { Editor } from '@tiptap/core';
import { exitSuggestion } from '@tiptap/suggestion';
import { commandRegistry, type SlashCommand, type CommandSelectProps } from '../CommandRegistry';
import { caretClientRect, closeAnyPicker, openPickerPopup, type PickerPopup } from '../pickerPopup';
import {
    mergeTagNames,
    tagPickerItems,
    TAG_NODE_NAME,
    type TagPickerItem,
    type TagSummary,
} from '../tags';
import { extractDocumentIndex } from '$lib/editor/documentIndex';
import { loadAllTags } from '$lib/services/tags';

const TAG_ICON =
    '<svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 9h.01M3.6 13.83l6.58 6.58a2 2 0 0 0 2.83 0l6.59-6.59a2 2 0 0 0 .58-1.41V4a2 2 0 0 0-2-2h-7.83a2 2 0 0 0-1.41.58L3.6 11a2 2 0 0 0 0 2.83"/></svg>';
const NEW_TAG_ICON =
    '<svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>';

// The editor the open picker will insert into, and the rows it is showing.
//
// Module-level, like the registry the command lives in: the picker is mounted
// outside the editor and hands back nothing but a row id, so the id has to be
// resolvable against the list that produced it. Both are cleared when the
// picker closes, so nothing here outlives the popup that needs it.
let currentEditor: Editor | null = null;
let visible: TagPickerItem[] = [];
let known: TagSummary[] = [];
let picker: PickerPopup | null = null;

export function registerTagCommand(): void {
    const command: SlashCommand = {
        id: 'tag',
        label: 'Insert Tag',
        icon: TAG_ICON,
        onSelect: (props: CommandSelectProps) => {
            const editor = props.editor as Editor;
            const rect = caretClientRect(editor, props.range);

            editor.chain().focus().deleteRange(props.range).run();

            if (rect) openTagPicker(editor, rect);

            exitSuggestion(editor.view);
        },
    };

    commandRegistry.register(command);
}

function openTagPicker(editor: Editor, rect: DOMRect): void {
    // Before a thing is assigned. Opening a picker closes whatever was open,
    // and closing is what forgets the editor and the rows, so state set first
    // would be wiped by the very call that is meant to use it.
    closeAnyPicker();

    // Whatever the open document already holds, straight away. The list from
    // SQL is a round trip, and opening on an empty popup and filling it a
    // moment later reads as a stutter; the tags in front of the user are also
    // the ones most likely to be wanted again.
    known = mergeTagNames([], tagsInEditor(editor));
    currentEditor = editor;

    picker = openPickerPopup({
        className: 'tag-suggestion-popup',
        rect,
        items: (query) => {
            visible = tagPickerItems(known, query);
            return visible.map((item) => ({
                id: item.id,
                title: item.title,
                subtitle: item.subtitle,
                icon: item.isNew ? NEW_TAG_ICON : TAG_ICON,
            }));
        },
        onSelect: insertChosenTag,
        onClose: forgetPicker,
        // An empty list here is not a failed filter, it is a corpus with no
        // tags in it yet, which is every user's first time.
        emptyLabel: 'Type a name to create a tag',
    });
    const mine = picker;

    void loadAllTags().then((tags) => {
        // Compared by identity, not merely checked for null: the picker may
        // have been closed and another opened while this was in flight, and
        // filling that one with this document's tags would be worse than
        // filling neither.
        if (picker !== mine) return;
        known = mergeTagNames(tags, tagsInEditor(editor));
        mine.refresh();
    });
}

/**
 * The tags in the document being typed in.
 *
 * Read through the indexer rather than by walking for them here, so the picker
 * cannot come to disagree with the rows about what counts as a tag in a
 * document. It does more work than this needs; it is one document, on a
 * keystroke that is opening a popup.
 */
function tagsInEditor(editor: Editor): string[] {
    return extractDocumentIndex(editor.state.doc).tags;
}

function insertChosenTag(id: string): void {
    const item = visible.find((candidate) => candidate.id === id);
    const editor = currentEditor;

    // Both of these are the shape of bug that made choosing a document do
    // nothing at all for as long as it did: the popup closes, nothing is
    // inserted, and nothing anywhere says so.
    if (!item) {
        console.error(`[tags] '${id}' is no longer in the list, nothing inserted`);
        return;
    }
    if (!editor) {
        console.error('[tags] no editor to insert into, the tag was dropped');
        return;
    }

    editor
        .chain()
        .focus()
        .insertContent([
            { type: TAG_NODE_NAME, attrs: { name: item.name } },
            // A space after the chip, so the next thing typed is a word and not
            // more of the tag. Without it the caret sits flush against an atom
            // and the line reads as one token.
            { type: 'text', text: ' ' },
        ])
        .run();
}

function forgetPicker(): void {
    picker = null;
    currentEditor = null;
    visible = [];
    known = [];
}

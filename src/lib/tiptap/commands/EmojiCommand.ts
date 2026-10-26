import type { Content, Editor } from '@tiptap/core';
import { exitSuggestion } from '@tiptap/suggestion';
import { commandRegistry, type SlashCommand, type CommandSelectProps } from '../CommandRegistry';
import { caretClientRect, closeAnyPicker, openPickerPopup, type PickerPopup } from '../pickerPopup';
import type { PopupItem } from '../../components/SlashSuggestionPopup.svelte';
import { loadEmoji, loadedEmoji, searchEmoji, type Emoji } from '$lib/emoji/emoji';

const EMOJI_ICON =
    '<svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01M22 12c0 5.523-4.477 10-10 10S2 17.523 2 12 6.477 2 12 2s10 4.477 10 10"/></svg>';

// The rows the open picker is showing, for the same reason TagCommand keeps
// its own: the popup hands back nothing but a row id.
let visible: Emoji[] = [];
let picker: PickerPopup | null = null;

/** A row for an emoji, in this list or the `/emoji` picker. */
export function emojiPopupItem(emoji: Emoji): PopupItem {
    return {
        id: emoji.hexcode,
        title: emoji.name,
        subtitle: emoji.shortcodes.map((code) => `:${code}:`).join(' ') || undefined,
        glyph: emoji.emoji,
    };
}

/**
 * `/emoji`, for finding one by browsing or by name. The same list a colon
 * opens, for a keyboard where a colon is a second page away, and for anyone
 * who does not know the shortcodes are there.
 */
export function registerEmojiCommand(): void {
    const command: SlashCommand = {
        id: 'emoji',
        label: 'Insert Emoji',
        icon: EMOJI_ICON,
        onSelect: (props: CommandSelectProps) => {
            const editor = props.editor as Editor;
            const rect = caretClientRect(editor, props.range);

            editor.chain().focus().deleteRange(props.range).run();

            if (rect) openEmojiPicker(editor, rect);

            exitSuggestion(editor.view);
        },
    };

    commandRegistry.register(command);
}

function openEmojiPicker(editor: Editor, rect: DOMRect): void {
    // Before a thing is assigned, since closing the open picker is what
    // forgets the rows.
    closeAnyPicker();

    picker = openPickerPopup({
        editor,
        className: 'emoji-picker-popup',
        rect,
        items: (query) => {
            const list = loadedEmoji();
            visible = list ? searchEmoji(list, query) : [];
            return visible.map(emojiPopupItem);
        },
        contentFor: (id) => chosenEmoji(id),
        onClose: forgetPicker,
        emptyLabel: 'No emoji found',
    });
    const mine = picker;

    if (!loadedEmoji()) {
        loadEmoji().then(
            () => {
                // Compared by identity: this picker may have closed and another
                // opened while the data was loading.
                if (picker === mine) mine.refresh();
            },
            (err) => console.error('[emoji] could not load the emoji', err),
        );
    }
}

function chosenEmoji(id: string): Content {
    const emoji = visible.find((candidate) => candidate.hexcode === id);
    if (!emoji) {
        console.error(`[emoji] '${id}' is no longer in the list, nothing inserted`);
        return null;
    }
    return emoji.emoji;
}

function forgetPicker(): void {
    picker = null;
    visible = [];
}

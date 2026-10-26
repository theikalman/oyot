import { Extension, InputRule } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { emojiForShortcode, loadEmoji, searchEmoji, type Emoji } from '$lib/emoji/emoji';
import { emojiPopupItem } from './commands/EmojiCommand';
import { pickerQueryKey } from './pickerQuery';
import { suggestionPopup } from './suggestionPopup';

/**
 * Emoji by shortcode: a colon and a couple of letters lists the emoji that
 * match, and a whole shortcode with its closing colon, `:tada:`, turns into
 * its emoji as it is typed.
 *
 * Both insert the character itself (see emoji.ts for why not a node).
 *
 * A colon is common in prose, so the list waits for two letters, needs the
 * colon to start a word, which leaves `10:30` and `https:` alone, and stays
 * out of sight while nothing matches, so `:-)` does not open a list saying
 * so.
 */
export const EmojiSuggestion = Extension.create({
    name: 'emojiSuggestion',

    onCreate() {
        // Warmed while the note opens, so the first `:tada:` typed converts
        // and the first list does not wait on a load.
        void loadEmoji().catch((err) => console.error('[emoji] could not load the emoji', err));
    },

    addInputRules() {
        return [
            new InputRule({
                find: /(?:^|\s)(:([a-z0-9_+-]+):)$/i,
                handler: ({ state, range, match }) => {
                    const emoji = emojiForShortcode(match[2]);
                    if (!emoji) return null;
                    const start = range.from + match[0].indexOf(match[1]);
                    state.tr.insertText(emoji.emoji, start, range.to);
                },
            }),
        ];
    },

    addProseMirrorPlugins() {
        return [
            Suggestion<Emoji>({
                // Its own key: two suggestion plugins sharing the default one
                // would overwrite each other's state.
                pluginKey: new PluginKey('emojiSuggestion'),
                editor: this.editor,
                char: ':',
                minQueryLength: 2,
                // Not in code, where a colon is syntax, and not while a picker
                // is reading what is typed.
                allow: ({ state, range }) => {
                    if (pickerQueryKey.getState(state)) return false;
                    const $from = state.doc.resolve(range.from);
                    if ($from.parent.type.spec.code) return false;
                    return !$from.marks().some((mark) => mark.type.spec.code);
                },
                items: async ({ query }) => {
                    try {
                        return searchEmoji(await loadEmoji(), query);
                    } catch {
                        return [];
                    }
                },
                render: suggestionPopup<Emoji>({
                    className: 'emoji-suggestion-popup',
                    toItem: emojiPopupItem,
                    hideWhenEmpty: true,
                    choose: (emoji, { editor, range }) => {
                        editor.chain().focus().insertContentAt(range, emoji.emoji).run();
                    },
                }),
            }),
        ];
    },
});

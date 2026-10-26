import { Extension } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';
import type { Editor, Range } from '@tiptap/core';
import { commandRegistry, type CommandSuggestion } from './CommandRegistry';
import { pickerPlugin } from './pickerPopup';
import { pickerQueryKey } from './pickerQuery';
import { suggestionPopup } from './suggestionPopup';

export const SlashCommand = Extension.create({
    name: 'slashCommand',

    addOptions() {
        return {
            suggestion: {
                char: '/',
                startOfLine: false,
            },
        };
    },

    addProseMirrorPlugins() {
        return [
            // For the pickers some of these commands open, the tag and the
            // document-link ones. Ahead of the menu, so a picker's query is
            // up to date by the time the menu asks whether one is open.
            pickerPlugin(this.editor),
            Suggestion({
                editor: this.editor,
                char: this.options.suggestion.char,
                startOfLine: this.options.suggestion.startOfLine,
                // Not while a picker is reading what is typed. A slash in a
                // tag's name is part of the name, not a second menu over the
                // picker's list.
                allow: ({ state }) => !pickerQueryKey.getState(state),
                items: ({ query }: { query: string }) => commandRegistry.filterCommands(query),
                command: ({
                    editor,
                    range,
                    props,
                }: {
                    editor: Editor;
                    range: Range;
                    props: CommandSuggestion;
                }) => {
                    commandRegistry.getCommand(props.id)?.onSelect({ editor, range, props: {} });
                },
                render: suggestionPopup<CommandSuggestion>({
                    className: 'slash-command-popup',
                    toItem: (item) => ({ id: item.id, title: item.title, icon: item.icon }),
                    choose: (item, { editor, range }) => {
                        commandRegistry.getCommand(item.id)?.onSelect({ editor, range, props: {} });
                    },
                }),
            }),
        ];
    },
});

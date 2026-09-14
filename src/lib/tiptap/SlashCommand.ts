import { Extension } from '@tiptap/core';
import Suggestion, {
    type SuggestionProps,
    type SuggestionKeyDownProps,
    exitSuggestion,
} from '@tiptap/suggestion';
import type { Editor, Range } from '@tiptap/core';
import { commandRegistry, type CommandSuggestion } from './CommandRegistry';
import SlashSuggestionPopup, { type PopupItem } from '../components/SlashSuggestionPopup.svelte';
import { mount, unmount } from 'svelte';
import { get, writable } from 'svelte/store';

function toPopupItem(item: CommandSuggestion): PopupItem {
    return { id: item.id, title: item.title, icon: item.icon };
}

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
            Suggestion({
                editor: this.editor,
                char: this.options.suggestion.char,
                startOfLine: this.options.suggestion.startOfLine,
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
                render: () => {
                    let popup: HTMLElement | null = null;
                    // The mounted component, so it can be taken down again.
                    // `onUpdate` fires on every keystroke and used to mount a
                    // fresh one each time without ever unmounting: the DOM was
                    // replaced, but each component's effects and store
                    // subscriptions lived on for the life of the editor.
                    let view: Record<string, unknown> | null = null;

                    // One source of truth for the selection. It used to be
                    // held both here and in a store, and hovering updated only
                    // the store, so Enter ran whichever item the arrow keys had
                    // last landed on rather than the one under the cursor.
                    const items = writable<PopupItem[]>([]);
                    const selectedIndex = writable(0);

                    // Read at call time rather than captured, because the
                    // component is mounted once and outlives any single
                    // suggestion callback.
                    let current: { editor: Editor; range: Range } | null = null;

                    function runCommand(id: string): void {
                        if (!current) return;
                        commandRegistry.getCommand(id)?.onSelect({
                            editor: current.editor,
                            range: current.range,
                            props: {},
                        });
                    }

                    function place(props: SuggestionProps<CommandSuggestion>): void {
                        const rect = props.clientRect?.();
                        if (!rect || !popup) return;
                        popup.style.left = `${rect.left}px`;
                        popup.style.top = `${rect.bottom + 8}px`;
                    }

                    function sync(props: SuggestionProps<CommandSuggestion>): void {
                        current = { editor: props.editor, range: props.range };
                        items.set((props.items as CommandSuggestion[]).map(toPopupItem));
                        selectedIndex.set(0);
                        place(props);
                    }

                    function close(): void {
                        if (current?.editor.view) exitSuggestion(current.editor.view);
                    }

                    return {
                        onBeforeStart: (props: SuggestionProps<CommandSuggestion>) => {
                            popup = document.createElement('div');
                            popup.className = 'slash-command-popup';
                            popup.style.position = 'fixed';
                            popup.style.zIndex = '1000';
                            place(props);
                            document.body.appendChild(popup);

                            view = mount(SlashSuggestionPopup, {
                                target: popup,
                                props: { items, selectedIndex, onCommand: runCommand },
                            });
                        },

                        onStart: sync,
                        onUpdate: sync,

                        onKeyDown: (props: SuggestionKeyDownProps) => {
                            const list = get(items);
                            const key = props.event.key;

                            if (key === 'Escape') {
                                close();
                                return true;
                            }

                            // With nothing to choose from, every key belongs to
                            // the editor. Arrow keys used to compute a modulo
                            // of zero and store NaN, and Enter claimed the
                            // keystroke without doing anything, swallowing the
                            // newline.
                            if (list.length === 0) return false;

                            if (key === 'ArrowUp') {
                                selectedIndex.update((i) => (i - 1 + list.length) % list.length);
                                return true;
                            }
                            if (key === 'ArrowDown') {
                                selectedIndex.update((i) => (i + 1) % list.length);
                                return true;
                            }
                            if (key === 'Enter') {
                                const chosen = list[get(selectedIndex)];
                                if (chosen) runCommand(chosen.id);
                                return true;
                            }
                            return false;
                        },

                        onExit: () => {
                            if (view) {
                                void unmount(view);
                                view = null;
                            }
                            popup?.remove();
                            popup = null;
                            current = null;
                            items.set([]);
                            selectedIndex.set(0);
                        },
                    };
                },
            }),
        ];
    },
});

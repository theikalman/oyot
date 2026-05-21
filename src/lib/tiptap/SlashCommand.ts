import { Extension } from '@tiptap/core';
import Suggestion, { type SuggestionProps, type SuggestionKeyDownProps, exitSuggestion } from '@tiptap/suggestion';
import type { Editor, Range } from '@tiptap/core';
import { commandRegistry, type CommandSuggestion } from './CommandRegistry';
import SlashSuggestionPopup from '../components/SlashSuggestionPopup.svelte';
import { mount } from 'svelte';

interface PopupState {
    items: CommandSuggestion[];
    selectedIndex: number;
}

export const SlashCommand = Extension.create({
    name: 'slashCommand',

    addOptions() {
        return {
            suggestion: {
                char: '/',
                startOfLine: false,
            }
        };
    },

    addProseMirrorPlugins() {
        return [
            Suggestion({
                editor: this.editor,
                char: this.options.suggestion.char,
                startOfLine: this.options.suggestion.startOfLine,
                items: ({ query }: { query: string }) => {
                    return commandRegistry.filterCommands(query);
                },
                command: ({ editor, range, props }: { editor: Editor; range: Range; props: CommandSuggestion }) => {
                    const cmd = commandRegistry.getCommand(props.id);
                    if (cmd) {
                        cmd.onSelect({
                            editor,
                            range,
                            props: {}
                        });
                    }
                },
                render: () => {
                    let popup: HTMLElement | null = null;
                    let state: PopupState = { items: [], selectedIndex: 0 };
                    let savedEditor: Editor | null = null;
                    let savedRange: Range | null = null;

                    return {
                        onBeforeStart: (props: SuggestionProps<CommandSuggestion>) => {
                            if (!popup) {
                                popup = document.createElement('div');
                                popup.className = 'slash-command-popup';
                            }

                            const rect = props.clientRect?.();
                            if (rect) {
                                popup.style.position = 'fixed';
                                popup.style.left = `${rect.left}px`;
                                popup.style.top = `${rect.bottom + 8}px`;
                                popup.style.zIndex = '1000';
                            }

                            document.body.appendChild(popup);
                        },

                        onStart: (props: SuggestionProps<CommandSuggestion>) => {
                            state.items = props.items as CommandSuggestion[];
                            state.selectedIndex = 0;
                            savedEditor = props.editor;
                            savedRange = props.range;

                            const rect = props.clientRect?.();
                            if (rect && popup) {
                                popup.style.left = `${rect.left}px`;
                                popup.style.top = `${rect.bottom + 8}px`;
                            }

                            while (popup?.firstChild) {
                                popup.removeChild(popup.firstChild);
                            }

                            if (popup) {
                                mount(SlashSuggestionPopup, {
                                    target: popup,
                                    props: {
                                        items: state.items.map(item => ({
                                            id: item.id,
                                            title: item.title,
                                            icon: item.icon
                                        })),
                                        selectedIndex: state.selectedIndex,
                                        command: (item: { id: string; title: string; icon?: string }) => {
                                            const cmd = commandRegistry.getCommand(item.id);
                                            if (cmd && props.range) {
                                                cmd.onSelect({
                                                    editor: props.editor,
                                                    range: props.range,
                                                    props: {}
                                                });
                                            }
                                        },
                                        onClose: () => {
                                            if (props.editor && props.editor.view) {
                                                exitSuggestion(props.editor.view);
                                            }
                                        }
                                    }
                                });
                            }
                        },

                        onUpdate: (props: SuggestionProps<CommandSuggestion>) => {
                            state.items = props.items as CommandSuggestion[];
                            state.selectedIndex = 0;
                            savedEditor = props.editor;
                            savedRange = props.range;

                            const rect = props.clientRect?.();
                            if (rect && popup) {
                                popup.style.left = `${rect.left}px`;
                                popup.style.top = `${rect.bottom + 8}px`;
                            }

                            while (popup?.firstChild) {
                                popup.removeChild(popup.firstChild);
                            }

                            if (popup) {
                                mount(SlashSuggestionPopup, {
                                    target: popup,
                                    props: {
                                        items: state.items.map(item => ({
                                            id: item.id,
                                            title: item.title,
                                            icon: item.icon
                                        })),
                                        selectedIndex: state.selectedIndex,
                                        command: (item: { id: string; title: string; icon?: string }) => {
                                            const cmd = commandRegistry.getCommand(item.id);
                                            if (cmd && props.range) {
                                                cmd.onSelect({
                                                    editor: props.editor,
                                                    range: props.range,
                                                    props: {}
                                                });
                                            }
                                        },
                                        onClose: () => {
                                            if (props.editor && props.editor.view) {
                                                exitSuggestion(props.editor.view);
                                            }
                                        }
                                    }
                                });
                            }
                        },

                        onKeyDown: (props: SuggestionKeyDownProps) => {
                            if (props.event.key === 'ArrowUp') {
                                state.selectedIndex = (state.selectedIndex - 1 + state.items.length) % state.items.length;
                                return true;
                            }

                            if (props.event.key === 'ArrowDown') {
                                state.selectedIndex = (state.selectedIndex + 1) % state.items.length;
                                return true;
                            }

                            if (props.event.key === 'Enter') {
                                if (state.items[state.selectedIndex]) {
                                    const cmd = commandRegistry.getCommand(state.items[state.selectedIndex].id);
                                    const range = props.range ?? savedRange;
                                    if (cmd && savedEditor && range) {
                                        cmd.onSelect({
                                            editor: savedEditor,
                                            range,
                                            props: {}
                                        });
                                    }
                                }
                                return true;
                            }

                            return false;
                        },

                        onExit: () => {
                            if (popup && popup.parentNode) {
                                popup.parentNode.removeChild(popup);
                            }
                            popup = null;
                            state = { items: [], selectedIndex: 0 };
                            savedEditor = null;
                            savedRange = null;
                        }
                    };
                }
            })
        ];
    }
});
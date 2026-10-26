import type { Editor, Range } from '@tiptap/core';
import {
    type SuggestionKeyDownProps,
    type SuggestionOptions,
    type SuggestionProps,
    exitSuggestion,
} from '@tiptap/suggestion';
import { mount, unmount } from 'svelte';
import { get, writable } from 'svelte/store';
import SlashSuggestionPopup, { type PopupItem } from '../components/SlashSuggestionPopup.svelte';
import { placePopup } from './popupPlacement';

/**
 * The popup a suggestion plugin shows while its trigger is being typed: the
 * slash menu, and the emoji list a colon opens.
 *
 * It was written for the slash menu alone, and the emoji list would otherwise
 * have been a copy of it, free to relearn every lesson in the comments below
 * on its own.
 */
export interface SuggestionPopupOptions<T> {
    /** A hook for styling and for finding it in the DOM. */
    className: string;
    toItem: (item: T) => PopupItem;
    /** Run for the row chosen by Enter or by click. */
    choose: (item: T, at: { editor: Editor; range: Range }) => void;
    /**
     * Hide the popup while nothing matches, rather than say so. For a trigger
     * as common in prose as a colon, where most of what follows one is not an
     * attempt at an emoji at all.
     */
    hideWhenEmpty?: boolean;
}

type Render<T> = NonNullable<SuggestionOptions<T>['render']>;

export function suggestionPopup<T>(options: SuggestionPopupOptions<T>): Render<T> {
    return () => {
        let popup: HTMLElement | null = null;
        // The mounted component, so it can be taken down again. `onUpdate`
        // fires on every keystroke and used to mount a fresh one each time
        // without ever unmounting: the DOM was replaced, but each component's
        // effects and store subscriptions lived on for the life of the editor.
        let view: Record<string, unknown> | null = null;

        // One source of truth for the selection. It used to be held both here
        // and in a store, and hovering updated only the store, so Enter ran
        // whichever item the arrow keys had last landed on rather than the one
        // under the cursor.
        const items = writable<PopupItem[]>([]);
        const selectedIndex = writable(0);
        // What the rows were made from, in the same order, so a row's id can
        // be taken back to the thing it shows.
        let raw: T[] = [];

        // Read at call time rather than captured, because the component is
        // mounted once and outlives any single suggestion callback.
        let current: { editor: Editor; range: Range } | null = null;

        function run(id: string): void {
            if (!current) return;
            const index = get(items).findIndex((item) => item.id === id);
            const chosen = raw[index];
            if (chosen !== undefined) options.choose(chosen, current);
        }

        function place(props: SuggestionProps<T>): void {
            const rect = props.clientRect?.();
            if (!rect || !popup) return;
            placePopup(popup, rect);
        }

        function sync(props: SuggestionProps<T>): void {
            current = { editor: props.editor, range: props.range };
            raw = props.items;
            items.set(raw.map(options.toItem));
            selectedIndex.set(0);
            if (popup && options.hideWhenEmpty) {
                popup.style.display = raw.length === 0 ? 'none' : '';
            }
            place(props);
        }

        function close(): void {
            if (current?.editor.view) exitSuggestion(current.editor.view);
        }

        return {
            onBeforeStart: (props: SuggestionProps<T>) => {
                popup = document.createElement('div');
                popup.className = options.className;
                popup.style.position = 'fixed';
                popup.style.zIndex = '1000';
                // Hidden until the first rows arrive, which for a list loaded
                // on first use can be a moment after the trigger was typed.
                if (options.hideWhenEmpty) popup.style.display = 'none';
                place(props);
                document.body.appendChild(popup);

                view = mount(SlashSuggestionPopup, {
                    target: popup,
                    props: { items, selectedIndex, onCommand: run },
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

                // With nothing to choose from, every key belongs to the editor.
                // Arrow keys used to compute a modulo of zero and store NaN,
                // and Enter claimed the keystroke without doing anything,
                // swallowing the newline.
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
                    if (chosen) run(chosen.id);
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
                raw = [];
                items.set([]);
                selectedIndex.set(0);
            },
        };
    };
}

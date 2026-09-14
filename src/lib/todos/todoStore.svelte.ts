import { invoke } from '@tauri-apps/api/core';
import {
    groupTodos,
    countAll,
    countOpen,
    EMPTY_SECTIONS,
    type TodoHit,
    type TodoSections,
} from './grouping';

/**
 * The state behind the todo index page.
 *
 * Its own module for the same reason the search box's is: a sequence number
 * and two flags that have to stay in step, which they do not reliably do as
 * loose variables inside a component that is also doing layout.
 */
export function createTodoIndex() {
    let sections = $state<TodoSections>(EMPTY_SECTIONS);
    // Starts true: the page's first render is before the first query has
    // answered, and showing "nothing to do" there would be a lie the user
    // sees every single time they open it.
    let loading = $state(true);
    // A failed load must not render as an empty list, which reads as an
    // answer when it is the absence of one.
    let failed = $state(false);

    let seq = 0;

    async function load(): Promise<void> {
        const mine = ++seq;
        loading = true;
        try {
            const hits = await invoke<TodoHit[]>('get_all_todos');
            // Drop a response something newer has already superseded. Edits
            // arrive while this is in flight, and each one triggers a reload.
            if (mine !== seq) return;
            sections = groupTodos(hits);
            failed = false;
        } catch (err) {
            if (mine !== seq) return;
            console.error('[todos] failed to load:', err);
            sections = EMPTY_SECTIONS;
            failed = true;
        } finally {
            if (mine === seq) loading = false;
        }
    }

    return {
        get sections() {
            return sections;
        },
        get loading() {
            return loading;
        },
        get failed() {
            return failed;
        },
        get openCount() {
            return countOpen(sections);
        },
        get totalCount() {
            return countAll(sections);
        },
        get isEmpty() {
            return sections.journals.length === 0 && sections.notes.length === 0;
        },
        load,
    };
}

export type TodoIndex = ReturnType<typeof createTodoIndex>;

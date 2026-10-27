<script lang="ts">
    import { tick, untrack } from 'svelte';
    import type { Editor } from '@tiptap/core';
    import { TextSelection } from '@tiptap/pm/state';
    import Icon from '$lib/components/Icon.svelte';
    import { findState, setFindQuery, stepFind } from './findInDocument';

    // Finding text in the open note or journal: a box over the top of the
    // document, the matches lit up in it and the current one brighter.
    // Opened by the find shortcut, which the editor around this answers.
    interface Props {
        editor: Editor | null;
        /** A new one for each press of the find shortcut. */
        request: { text: string };
        onClose: () => void;
    }

    let { editor, request, onClose }: Props = $props();

    let input = $state<HTMLInputElement | null>(null);
    let query = $state('');
    let count = $state(0);
    let current = $state(-1);

    // Each time the find shortcut is pressed: the caret goes in the box,
    // with what is in it selected, and the text the document had selected
    // in it first, if any.
    $effect(() => {
        const { text } = request;
        untrack(() => {
            if (text !== '') query = text;
        });
        // Into the box before it is selected, or only what was there before is.
        void tick().then(() => {
            input?.focus();
            input?.select();
        });
    });

    // Read back from the editor after every transaction, so the count
    // follows an edit, the reader's own or a peer's.
    $effect(() => {
        const ed = editor;
        if (!ed) return;
        const read = () => {
            const found = findState(ed.state);
            count = found.matches.length;
            current = found.current;
        };
        ed.on('transaction', read);
        read();
        return () => {
            ed.off('transaction', read);
        };
    });

    // Looked for again as it is typed, and in a document opened while the
    // box is open.
    $effect(() => {
        const ed = editor;
        const text = query;
        if (!ed || ed.isDestroyed) return;
        setFindQuery(ed.view, text);
        showCurrent(ed);
    });

    // Stop looking when the box goes, so nothing stays lit up.
    $effect(() => {
        const ed = editor;
        return () => {
            if (ed && !ed.isDestroyed) setFindQuery(ed.view, '');
        };
    });

    function step(by: number) {
        if (!editor || editor.isDestroyed) return;
        stepFind(editor.view, by);
        showCurrent(editor);
    }

    // The current match, brought into view in the middle of the document.
    function showCurrent(ed: Editor) {
        const lit = ed.view.dom.querySelector('.find-match.current');
        lit?.scrollIntoView({ block: 'center', behavior: 'auto' });
    }

    // Closing leaves the selection on the current match, so writing carries
    // on there once editing, and Edit puts the caret there while reading.
    function close() {
        const ed = editor;
        if (ed && !ed.isDestroyed) {
            const found = findState(ed.state);
            const match = found.matches[found.current];
            if (match) {
                const selection = TextSelection.create(ed.state.doc, match.from, match.to);
                ed.view.dispatch(ed.state.tr.setSelection(selection));
            }
            if (ed.isEditable) ed.commands.focus(null, { scrollIntoView: false });
        }
        onClose();
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Enter') {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            close();
        }
    }

    let status = $derived(
        query === '' ? '' : count === 0 ? 'No results' : `${current + 1} of ${count}`,
    );
</script>

<div class="find-bar" role="search">
    <Icon name="search" size={15} />
    <input
        bind:this={input}
        bind:value={query}
        onkeydown={handleKeydown}
        type="text"
        placeholder="Find in page"
        aria-label="Find in page"
        spellcheck="false"
        autocomplete="off"
    />
    <span class="status" class:none={query !== '' && count === 0} aria-live="polite">{status}</span>
    <button
        onclick={() => step(-1)}
        disabled={count === 0}
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"><Icon name="chevron-up" size={16} /></button
    >
    <button
        onclick={() => step(1)}
        disabled={count === 0}
        title="Next match (Enter)"
        aria-label="Next match"><Icon name="chevron-down" size={16} /></button
    >
    <button onclick={close} title="Close (Esc)" aria-label="Close find"
        ><Icon name="x" size={16} /></button
    >
</div>

<style>
    .find-bar {
        position: absolute;
        top: 10px;
        right: 16px;
        z-index: 25;
        display: flex;
        align-items: center;
        gap: 2px;
        width: min(360px, calc(100% - 32px));
        padding: 4px 4px 4px 10px;
        background: var(--bg-raised);
        border-radius: 10px;
        box-shadow: var(--shadow-pop);
        color: var(--text-muted);
    }

    input {
        flex: 1;
        min-width: 0;
        height: 28px;
        padding: 0 6px;
        border: none;
        outline: none;
        background: none;
        color: var(--text-primary);
        font: inherit;
        font-size: 14px;
    }

    .status {
        flex-shrink: 0;
        padding: 0 6px;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
    }

    .status.none {
        color: var(--status-error);
    }

    button {
        flex-shrink: 0;
        width: 28px;
        height: 28px;
        display: grid;
        place-items: center;
        padding: 0;
        border: none;
        border-radius: var(--radius-md);
        background: none;
        color: var(--text-secondary);
        cursor: pointer;
    }

    button:hover:not(:disabled) {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    button:disabled {
        opacity: 0.4;
        cursor: default;
    }

    @media (max-width: 480px) {
        .find-bar {
            top: 8px;
            right: 8px;
            width: calc(100% - 16px);
        }
    }
</style>

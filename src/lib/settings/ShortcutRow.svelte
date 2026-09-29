<script lang="ts">
    import { tick } from 'svelte';
    import { customShortcuts } from '$lib/keyboard/customShortcuts.svelte';
    import { conflictsWith, readPress, type Conflict } from '$lib/keyboard/bindings';
    import { formatKeys, shortcutLabel, type KeyPress } from '$lib/keyboard/keys';
    import { changeableShortcut, type ChangeableShortcut } from '$lib/keyboard/shortcuts';
    import { toasts } from '$lib/services/toast';
    import Keys from '$lib/help/Keys.svelte';

    // One shortcut on the Keyboard shortcuts page: the keys that do it now,
    // and a way to give it others. Change listens for the next keys pressed,
    // and taking keys another shortcut has is asked about first, since that
    // one loses them.
    interface Props {
        shortcut: ChangeableShortcut;
        /** Whether this is the row being changed. Only one is at a time. */
        active: boolean;
        onStart: () => void;
        onEnd: () => void;
        /** Say something to a screen reader: what was done, or why not. */
        announce: (text: string) => void;
    }

    let { shortcut, active, onStart, onEnd, announce }: Props = $props();

    const command = customShortcuts.command;
    let keys = $derived(customShortcuts.keysFor(shortcut.id));
    let changed = $derived(customShortcuts.isChanged(shortcut.id));

    // Keys chosen that another shortcut has, while asking whether to take them.
    let asking = $state<{ keys: string[]; conflicts: Conflict[] } | null>(null);
    let recording = $derived(active && asking === null);
    // The modifiers held so far, shown while listening.
    let held = $state('');
    // Why the last keys pressed cannot be a shortcut.
    let refusal = $state<string | null>(null);

    let changeButton = $state<HTMLButtonElement | null>(null);
    let recorder = $state<HTMLButtonElement | null>(null);
    let cancelButton = $state<HTMLButtonElement | null>(null);
    let confirmButton = $state<HTMLButtonElement | null>(null);

    // Another row started, or this one finished: back to showing the keys.
    $effect(() => {
        if (active) return;
        asking = null;
        held = '';
        refusal = null;
    });

    const deleteKey = shortcutLabel('Backspace', command);

    function labelOf(keysList: readonly string[]): string {
        return keysList.map((k) => shortcutLabel(k, command)).join(' or ');
    }

    function nameOf(id: string): string {
        return changeableShortcut(id)?.action ?? id;
    }

    async function start() {
        onStart();
        await tick();
        recorder?.focus();
    }

    async function finish() {
        asking = null;
        held = '';
        refusal = null;
        onEnd();
        await tick();
        changeButton?.focus();
    }

    // The modifiers of a press, the way the keys are labelled, with a gap
    // for the key still to come.
    function heldLabel(event: KeyPress): string {
        const chord = {
            key: '…',
            mod: command ? event.metaKey : event.ctrlKey,
            ctrl: command && event.ctrlKey,
            alt: event.altKey,
            shift: event.shiftKey,
        };
        return shortcutLabel(formatKeys(chord), command);
    }

    function handleKeydown(event: KeyboardEvent) {
        if (!recording) return;
        const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
        // Tab moves on, as it does anywhere: to Cancel, or away, which stops
        // listening and leaves the shortcut as it was.
        if (plain && event.key === 'Tab') return;
        // Nothing else this press would do happens while listening: not the
        // app's own shortcuts, and not the page scrolling.
        event.preventDefault();
        event.stopPropagation();
        if (plain && !event.shiftKey && event.key === 'Escape') {
            void finish();
            return;
        }
        if (plain && !event.shiftKey && (event.key === 'Backspace' || event.key === 'Delete')) {
            void choose([]);
            return;
        }
        const press = readPress(event, command);
        if (press.kind === 'held') {
            held = heldLabel(event);
        } else if (press.kind === 'refused') {
            held = '';
            refusal = press.reason;
            announce(press.reason);
        } else {
            void choose([press.keys]);
        }
    }

    function handleKeyup(event: KeyboardEvent) {
        if (!recording) return;
        event.preventDefault();
        event.stopPropagation();
        // Only letting go of a modifier changes what is held. The key of a
        // shortcut was read when it went down.
        const up = event.key;
        if (up !== 'Meta' && up !== 'Control' && up !== 'Alt' && up !== 'Shift') return;
        // It is up, whatever the event says: some browsers report a modifier
        // as still held on its own keyup.
        const still = {
            key: up,
            metaKey: event.metaKey && up !== 'Meta',
            ctrlKey: event.ctrlKey && up !== 'Control',
            altKey: event.altKey && up !== 'Alt',
            shiftKey: event.shiftKey && up !== 'Shift',
        };
        const any = still.metaKey || still.ctrlKey || still.altKey || still.shiftKey;
        held = any ? heldLabel(still) : '';
    }

    // Leaving the recorder and its Cancel button stops listening, so keys
    // pressed elsewhere are never taken for a shortcut.
    function handleBlur(event: FocusEvent) {
        if (!recording) return;
        if (event.relatedTarget === recorder || event.relatedTarget === cancelButton) return;
        onEnd();
    }

    async function choose(next: string[]) {
        const conflicts = conflictsWith(shortcut.id, next, customShortcuts.bindings, command);
        if (conflicts.length > 0) {
            asking = { keys: next, conflicts };
            await tick();
            confirmButton?.focus();
            return;
        }
        await save(next);
    }

    async function save(next: readonly string[]) {
        try {
            await customShortcuts.set(shortcut.id, next);
            announce(
                next.length > 0
                    ? `${shortcut.action} is now ${labelOf(next)}.`
                    : `${shortcut.action} has no shortcut now.`,
            );
        } catch (error) {
            console.error('Failed to save the shortcut:', error);
            toasts.error(`Could not change the shortcut: ${message(error)}`);
        }
        await finish();
    }

    // Its own keys back, which may be another shortcut's by now.
    async function reset() {
        onStart();
        await choose([...shortcut.keys]);
    }

    function describe(conflict: Conflict): string {
        const name = nameOf(conflict.id);
        const lost = labelOf(conflict.lost);
        const after =
            conflict.kept.length > 0
                ? `It would keep ${labelOf(conflict.kept)}.`
                : 'It would be left without a shortcut.';
        return `${lost} already does “${name}”. ${after}`;
    }

    function handleAskKeydown(event: KeyboardEvent) {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        void finish();
    }

    // A Tauri command rejects with a string, not an Error.
    function message(error: unknown): string {
        if (typeof error === 'string') return error;
        return error instanceof Error ? error.message : 'unknown error';
    }
</script>

<div class="shortcut-row" class:active>
    <div class="shortcut-info">
        <span class="shortcut-name">{shortcut.action}</span>
        {#if changed && !active}
            <span class="shortcut-normally">
                Normally <Keys keys={shortcut.keys} {command} />
            </span>
        {/if}
    </div>

    <div class="shortcut-controls">
        {#if recording}
            <button
                class="recorder"
                bind:this={recorder}
                onkeydown={handleKeydown}
                onkeyup={handleKeyup}
                onblur={handleBlur}
                aria-label="New keys for {shortcut.action}"
                aria-describedby="shortcut-hint-{shortcut.id}"
            >
                {held || 'Press the keys…'}
            </button>
            <button class="row-btn" bind:this={cancelButton} onclick={finish} onblur={handleBlur}
                >Cancel</button
            >
        {:else}
            <span class="shortcut-keys">
                {#if asking}
                    <Keys keys={asking.keys} {command} />
                {:else if keys.length > 0}
                    <Keys {keys} {command} />
                {:else}
                    <span class="no-keys">None</span>
                {/if}
            </span>
            {#if !asking}
                {#if changed}
                    <button
                        class="row-btn"
                        onclick={reset}
                        aria-label="Reset {shortcut.action} to {labelOf(shortcut.keys)}"
                        title="Back to {labelOf(shortcut.keys)}">Reset</button
                    >
                {/if}
                <button
                    class="row-btn"
                    bind:this={changeButton}
                    onclick={start}
                    aria-label="Change the shortcut for {shortcut.action}">Change</button
                >
            {/if}
        {/if}
    </div>

    {#if recording}
        <p class="shortcut-note" class:refused={refusal !== null} id="shortcut-hint-{shortcut.id}">
            {#if refusal}
                {refusal}
            {:else}
                Press the keys to use, or Esc to cancel. {deleteKey} leaves it without a shortcut.
            {/if}
        </p>
    {:else if asking}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
            class="shortcut-ask"
            role="group"
            aria-label="Take the keys?"
            onkeydown={handleAskKeydown}
        >
            <p class="shortcut-note">
                {#each asking.conflicts as conflict (conflict.id)}{describe(conflict)}
                {/each}
            </p>
            <div class="ask-buttons">
                <button
                    class="row-btn primary"
                    bind:this={confirmButton}
                    onclick={() => save(asking!.keys)}
                    >{asking.keys.length === 1 ? 'Use it here' : 'Use them here'}</button
                >
                <button class="row-btn" onclick={finish}>Cancel</button>
            </div>
        </div>
    {/if}
</div>

<style>
    .shortcut-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 8px 12px;
        padding: 12px 16px;
    }

    .shortcut-row + :global(.shortcut-row) {
        border-top: 1px solid var(--border-color);
    }

    /* The row being changed stands out from the card it is on. */
    .shortcut-row.active {
        background: var(--bg-primary);
    }

    /* Narrow enough that a row fits one line on a phone, the name wrapping
       within it; a row with Reset as well takes two. */
    .shortcut-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
        flex: 1 1 120px;
    }

    .shortcut-name {
        font-size: 15px;
        font-weight: 500;
        color: var(--text-primary);
    }

    .shortcut-normally {
        font-size: 12px;
        color: var(--text-muted);
    }

    .shortcut-controls {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-left: auto;
    }

    .shortcut-keys {
        min-width: 48px;
        text-align: right;
    }

    .no-keys {
        font-size: 13px;
        color: var(--text-muted);
    }

    .row-btn {
        min-height: 36px;
        padding: 6px 14px;
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        font-size: 13px;
        font-weight: 500;
        color: var(--text-primary);
        cursor: pointer;
        transition: background-color 0.15s;
        white-space: nowrap;
    }

    .row-btn:hover {
        background: var(--bg-hover);
    }

    .row-btn.primary {
        background: var(--btn-primary-bg);
        border-color: var(--btn-primary-bg);
        color: white;
    }

    .row-btn.primary:hover {
        background: var(--btn-primary-hover);
    }

    /* Listening: the one place keys go, so it looks like a field. */
    .recorder {
        min-width: 150px;
        min-height: 36px;
        padding: 6px 12px;
        background: var(--bg-primary);
        border: 2px solid var(--accent-color);
        border-radius: 8px;
        font-family: inherit;
        font-size: 14px;
        color: var(--text-secondary);
        cursor: default;
        text-align: center;
    }

    .recorder:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px var(--accent-bg);
    }

    .shortcut-note {
        flex-basis: 100%;
        margin: 0;
        font-size: 13px;
        color: var(--text-secondary);
    }

    .shortcut-note.refused {
        color: var(--status-error);
    }

    .shortcut-ask {
        flex-basis: 100%;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .ask-buttons {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
    }

    /* A phone or a tablet, where buttons are pressed with a finger. */
    @media (pointer: coarse) {
        .row-btn,
        .recorder {
            min-height: 44px;
        }
    }
</style>

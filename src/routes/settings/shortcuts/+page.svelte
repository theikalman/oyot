<script lang="ts">
    import { tick } from 'svelte';
    import { customShortcuts } from '$lib/keyboard/customShortcuts.svelte';
    import { SHORTCUT_GROUPS, type ChangeableShortcut } from '$lib/keyboard/shortcuts';
    import { toasts } from '$lib/services/toast';
    import { isMobile } from '$lib/utils/platform';
    import { ShortcutRow } from '$lib/settings';

    // Giving shortcuts keys of the user's own (ADR 0035). Each group of the
    // help page's list that has any shortcut that can be changed, with just
    // those; Enter, Tab and the rest keep their keys.

    const command = customShortcuts.command;

    const groups = SHORTCUT_GROUPS.map((group) => ({
        ...group,
        shortcuts: group.shortcuts.filter((s): s is ChangeableShortcut => s.id !== undefined),
    })).filter((group) => group.shortcuts.length > 0);

    // The row being changed. One at a time, so there is only ever one place
    // the keys pressed are going.
    let activeId = $state<string | null>(null);

    let changedCount = $derived(customShortcuts.changedCount);
    let confirmingReset = $state(false);
    // Focus moves between these as the reset is asked about, so the keyboard
    // is never left nowhere when the buttons it was on go away.
    let resetButton = $state<HTMLButtonElement | null>(null);
    let cancelResetButton = $state<HTMLButtonElement | null>(null);

    // What a screen reader is told as shortcuts change, one thing at a time.
    let announcement = $state('');

    // Cancel is where focus goes to ask, since it is the answer that loses
    // nothing.
    async function askReset() {
        if (changedCount === 0) return;
        confirmingReset = true;
        await tick();
        cancelResetButton?.focus();
    }

    async function stopAsking() {
        confirmingReset = false;
        await tick();
        resetButton?.focus();
    }

    async function resetAll() {
        activeId = null;
        try {
            await customShortcuts.resetAll();
            announcement = 'Every shortcut has its own keys again.';
            toasts.success('Every shortcut has its own keys again');
        } catch (error) {
            console.error('Failed to reset the shortcuts:', error);
            toasts.error(`Could not reset the shortcuts: ${message(error)}`);
        }
        await stopAsking();
    }

    // A Tauri command rejects with a string, not an Error.
    function message(error: unknown): string {
        if (typeof error === 'string') return error;
        return error instanceof Error ? error.message : 'unknown error';
    }
</script>

<div class="settings-page">
    <p class="intro">
        Press Change beside a shortcut, then the keys you want for it. A shortcut uses {command
            ? '⌘ or ⌃'
            : 'Ctrl'}, so it never types into a note. These keys are for this device only.
        {#if isMobile}On a phone or tablet, shortcuts need a keyboard attached.{/if}
    </p>

    {#each groups as group (group.id)}
        <section class="settings-section" aria-labelledby="group-{group.id}">
            <h2 class="section-title" id="group-{group.id}">{group.title}</h2>
            <p class="section-where">{group.where}</p>
            <div class="section-card">
                {#each group.shortcuts as shortcut (shortcut.id)}
                    <ShortcutRow
                        {shortcut}
                        active={activeId === shortcut.id}
                        onStart={() => (activeId = shortcut.id)}
                        onEnd={() => {
                            if (activeId === shortcut.id) activeId = null;
                        }}
                        announce={(text) => (announcement = text)}
                    />
                {/each}
            </div>
        </section>
    {/each}

    <section class="settings-section">
        <div class="section-card">
            <div class="setting-row">
                <div class="setting-info">
                    <span class="setting-label">Reset all shortcuts</span>
                    <span class="setting-desc">
                        {#if confirmingReset}
                            Give every shortcut its own keys back?
                        {:else if changedCount > 0}
                            {changedCount} changed. Give every shortcut its own keys back.
                        {:else}
                            Every shortcut has its own keys.
                        {/if}
                    </span>
                </div>
                {#if confirmingReset}
                    <div class="reset-buttons">
                        <button class="action-btn danger" onclick={resetAll}>Reset all</button>
                        <button
                            class="action-btn"
                            bind:this={cancelResetButton}
                            onclick={stopAsking}
                        >
                            Cancel
                        </button>
                    </div>
                {:else}
                    <!-- aria-disabled rather than disabled, so it keeps focus
                         once the reset it did leaves nothing to reset. -->
                    <button
                        class="action-btn"
                        bind:this={resetButton}
                        onclick={askReset}
                        aria-disabled={changedCount === 0}
                    >
                        Reset all…
                    </button>
                {/if}
            </div>
        </div>
    </section>

    <p class="visually-hidden" aria-live="polite">{announcement}</p>
</div>

<style>
    .settings-page {
        max-width: 600px;
        margin: 0 auto;
        padding: 24px;
    }

    .intro {
        margin: 0 0 24px 0;
        font-size: 14px;
        line-height: 1.5;
        color: var(--text-secondary);
    }

    .settings-section {
        margin-bottom: 32px;
    }

    .section-title {
        margin: 0 0 4px 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }

    .section-where {
        margin: 0 0 12px 0;
        font-size: 13px;
        color: var(--text-muted);
    }

    .section-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        overflow: hidden;
    }

    .setting-row {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        padding: 16px;
    }

    .setting-info {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .setting-label {
        font-weight: 500;
        color: var(--text-primary);
        font-size: 15px;
    }

    .setting-desc {
        font-size: 13px;
        color: var(--text-muted);
    }

    .reset-buttons {
        display: flex;
        gap: 8px;
        margin-left: auto;
    }

    .action-btn {
        padding: 10px 18px;
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 10px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        color: var(--text-primary);
        transition: background-color 0.15s;
        white-space: nowrap;
    }

    .action-btn:hover:not([aria-disabled='true']) {
        background: var(--bg-hover);
    }

    .action-btn[aria-disabled='true'] {
        cursor: default;
        color: var(--text-muted);
    }

    .action-btn.danger {
        border-color: var(--status-error);
        color: var(--status-error);
    }

    .visually-hidden {
        position: absolute;
        width: 1px;
        height: 1px;
        margin: -1px;
        padding: 0;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
        border: 0;
    }
</style>

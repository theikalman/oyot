<script lang="ts">
    import { setPinned } from '../services/documentActions';
    import { toasts } from '../services/toast';

    // Pins a note to the sidebar, or unpins it. The label says what pressing
    // it will do, and the icon, filled or outlined, says which it is now.
    interface Props {
        docId: string;
        pinned: boolean;
    }

    let { docId, pinned }: Props = $props();

    let busy = $state(false);
    let label = $derived(pinned ? 'Unpin from the sidebar' : 'Pin to the sidebar');

    async function toggle() {
        if (busy) return;
        busy = true;
        try {
            await setPinned(docId, !pinned);
        } catch (error) {
            console.error('[notes] could not change the pin:', error);
            toasts.error(pinned ? 'Could not unpin this note' : 'Could not pin this note');
        } finally {
            busy = false;
        }
    }
</script>

<button
    class="pin-toggle"
    class:pinned
    onclick={toggle}
    disabled={busy}
    title={label}
    aria-label={label}
>
    <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
    >
        <path d="M12 17v5" />
        <path
            fill={pinned ? 'currentColor' : 'none'}
            d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"
        />
    </svg>
</button>

<style>
    .pin-toggle {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        padding: 0;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: var(--text-muted);
        cursor: pointer;
    }

    .pin-toggle:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    .pin-toggle.pinned {
        color: var(--accent-color);
    }

    .pin-toggle:disabled {
        cursor: default;
        opacity: 0.6;
    }
</style>

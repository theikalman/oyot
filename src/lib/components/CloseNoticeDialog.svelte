<script lang="ts">
    import { onMount } from 'svelte';
    import { trayPlace } from '$lib/desktop';
    import Modal from './Modal.svelte';

    // Shown the first time the window is closed with "Keep Oyot running"
    // on (ADR 0030, decision 2). Escape and the backdrop mean "Keep running",
    // the default: they dismiss the notice, and quitting is the choice that
    // has to be made on purpose.
    interface Props {
        onAnswer: (keepRunning: boolean) => void;
    }

    let { onAnswer }: Props = $props();

    let place = $state('the system tray');

    onMount(async () => {
        place = await trayPlace();
    });
</script>

<Modal title="Oyot keeps syncing in the background" onClose={() => onAnswer(true)}>
    <p class="modal-text">
        Closing the window leaves Oyot running, so your notes keep syncing with your other devices.
        To quit, use the Oyot icon in {place}.
    </p>
    <p class="modal-text">You can change this in Settings.</p>
    {#snippet actions()}
        <button class="modal-btn secondary" data-secondary onclick={() => onAnswer(false)}>
            Quit instead
        </button>
        <button class="modal-btn" onclick={() => onAnswer(true)}>Keep running</button>
    {/snippet}
</Modal>

<style>
    .modal-text {
        margin: 0 0 8px 0;
        font-size: 13px;
        color: var(--text-secondary);
        line-height: 1.4;
    }

    .modal-btn {
        padding: 6px 16px;
        background: var(--btn-primary-bg);
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
    }

    .modal-btn:hover {
        background: var(--btn-primary-hover);
    }

    .modal-btn.secondary {
        background: transparent;
        color: var(--text-primary);
        border: 1px solid var(--border-color);
    }

    .modal-btn.secondary:hover {
        background: var(--bg-hover);
    }
</style>

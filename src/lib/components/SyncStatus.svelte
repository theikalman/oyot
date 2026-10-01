<script lang="ts">
    import { goto } from '$app/navigation';
    import { resolve } from '$app/paths';
    import { canSignal, connectedPeers, aggregateSyncPhase } from '$lib/stores/sync';
    import { SYNC_TONE_COLORS, syncBadge } from '$lib/sync/syncBadge';

    let reachable = $derived($canSignal);
    let peers = $derived($connectedPeers);
    let phase = $derived($aggregateSyncPhase);

    // The rule, and the bug it was extracted for, are in sync/syncBadge.ts.
    let badge = $derived(syncBadge({ peers: peers.length, phase, reachable }));
    let tone = $derived(badge.tone);
    let label = $derived(badge.label);

    let devices = $derived(
        peers.length > 0 ? `${peers.length} device${peers.length !== 1 ? 's' : ''}` : '',
    );
    // Spelled out for the dot alone, which is all phones and tablets show.
    let description = $derived(devices ? `${label}, ${devices}` : label);

    function openSettings() {
        goto(resolve('/settings/sync'));
    }
</script>

<button
    class="sync-status"
    onclick={openSettings}
    title="{description} - Sync settings"
    aria-label="Sync: {description}"
>
    <span class="status-dot" style="background-color: {SYNC_TONE_COLORS[tone]}"></span>
    <span class="status-label">{label}</span>
    {#if devices}
        <span class="peer-count">{devices}</span>
    {/if}
</button>

<style>
    .sync-status {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        background: var(--bg-primary);
        border: 1px solid var(--border-light);
        border-radius: 16px;
        cursor: pointer;
        font-size: 12px;
        color: var(--text-secondary);
        transition:
            background-color 0.2s,
            border-color 0.2s;
    }

    .sync-status:hover {
        background: var(--bg-hover);
        border-color: var(--border-color);
    }

    .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
    }

    .status-label {
        font-weight: 500;
    }

    .peer-count {
        color: var(--text-muted);
    }

    /* Phones and tablets, as the header title reckons them: only the dot,
       so the title keeps the room. The wording is still in the button's
       label and its tooltip. A 32px circle, the height of every row in the
       header, so it is still something to tap. */
    @media (max-width: 768px), (pointer: coarse) {
        .sync-status {
            width: 32px;
            height: 32px;
            padding: 0;
            justify-content: center;
            flex-shrink: 0;
        }

        .status-dot {
            width: 10px;
            height: 10px;
        }

        .status-label,
        .peer-count {
            display: none;
        }
    }
</style>

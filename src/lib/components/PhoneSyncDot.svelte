<script lang="ts">
    import { goto } from '$app/navigation';
    import { resolve } from '$app/paths';
    import { canSignal, connectedPeers, aggregateSyncPhase } from '$lib/stores/sync';
    import { SYNC_TONE_COLORS, syncBadge } from '$lib/sync/syncBadge';

    // How sync stands, in a phone's header: the dot alone, on a 44px target
    // that opens Devices & sync. The words are in its label.
    let badge = $derived(
        syncBadge({
            peers: $connectedPeers.length,
            phase: $aggregateSyncPhase,
            reachable: $canSignal,
        }),
    );
</script>

<button
    class="m-btn"
    onclick={() => goto(resolve('/settings/sync'))}
    aria-label="Sync: {badge.label}. Devices and sync"
>
    <span class="dot" style="background-color: {SYNC_TONE_COLORS[badge.tone]}"></span>
</button>

<style>
    .dot {
        width: 9px;
        height: 9px;
        border-radius: 50%;
    }
</style>

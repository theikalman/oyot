<script lang="ts">
    import type { OnlinePeer } from '$lib/stores/sync';
    import { pairedDevices as allPairedDevices } from '$lib/stores/sync';

    interface Props {
        peers: OnlinePeer[];
        onConnect: (peer: OnlinePeer) => void;
    }

    let { peers, onConnect }: Props = $props();

    let pairedIds = $derived($allPairedDevices.map((d: { peer_node_id: string }) => d.peer_node_id));
    let availablePeers = $derived(peers.filter((p: OnlinePeer) => !pairedIds.includes(p.id)));
</script>

    <section class="section">
    <h2>Available Devices</h2>
    {#if availablePeers.length === 0}
        <p class="empty-state">No other devices online. Make sure both devices are connected to the same signaling server.</p>
    {:else}
        <ul class="peer-list">
            {#each availablePeers as peer}
                <li class="peer-item">
                    <div class="peer-info">
                        <div class="peer-header">
                            <span class="peer-icon">📱</span>
                            <span class="peer-name">{peer.display_name}</span>
                        </div>
                        <span class="peer-id">{peer.id}</span>
                    </div>
                    <button class="btn-connect" onclick={() => onConnect(peer)}>
                        Connect
                    </button>
                </li>
            {/each}
        </ul>
    {/if}
</section>

<style>
    .section {
        margin-bottom: 32px;
    }
    .section h2 {
        margin: 0 0 16px 0;
        font-size: 16px;
        font-weight: 600;
        color: var(--text-primary);
    }
    .empty-state {
        color: var(--text-muted);
        font-size: 14px;
    }
    .peer-list {
        list-style: none;
        padding: 0;
        margin: 0;
    }
    .peer-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px;
        border: 1px solid var(--border-color);
        border-radius: 8px;
        margin-bottom: 8px;
        background: var(--bg-primary);
    }
    .peer-info {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
    }
    .peer-header {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .peer-icon {
        font-size: 16px;
    }
    .peer-name {
        font-weight: 500;
        color: var(--text-primary);
    }
    .peer-id {
        font-family: monospace;
        font-size: 10px;
        color: var(--text-muted);
        word-break: break-all;
    }
    .btn-connect {
        padding: 6px 12px;
        background: var(--accent-color);
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        flex-shrink: 0;
    }
    .btn-connect:hover {
        opacity: 0.9;
    }
</style>
<script lang="ts">
    import type { ConnectedPeer, DeviceEndpoint } from '$lib/stores/sync';
    import { peerConnection, peerStatusLabel, type PeerConnection } from '$lib/sync/peerStatus';
    import { formatLastSync, reconnectingPeerIds, roomSync } from '$lib/stores/sync';
    import PeerAddresses from './PeerAddresses.svelte';

    interface Props {
        pairedDevices: Array<{
            peer_node_id: string;
            peer_display_name: string;
            room_id: string;
            last_synchronized: number | null;
        }>;
        connectedPeers: ConnectedPeer[];
        /** Every stored address, for every device (ADR 0023). */
        endpoints: DeviceEndpoint[];
        /** Devices answering at an address stored for them. */
        onStoredAddress: Set<string>;
        onDisconnect: (roomId: string) => void;
        onReconnect: (peerNodeId: string) => void;
        onRemove: (peerNodeId: string) => void;
        onAddAddress: (peerNodeId: string, address: string) => Promise<void>;
        onForgetAddress: (peerNodeId: string, host: string, port: number) => Promise<void>;
    }

    let {
        pairedDevices,
        connectedPeers,
        endpoints,
        onStoredAddress,
        onDisconnect,
        onReconnect,
        onRemove,
        onAddAddress,
        onForgetAddress,
    }: Props = $props();

    // A device's addresses belong on its own row rather than in a section of
    // their own: the row already says which device this is, so nothing has to
    // ask again, and "where can this be reached" is read where the device is
    // looked up.
    function addressesFor(peerNodeId: string): DeviceEndpoint[] {
        return endpoints.filter((e) => e.peer_node_id === peerNodeId);
    }

    function isConnected(roomId: string): boolean {
        return connectedPeers.some((p) => p.room_id === roomId);
    }

    // The app reconnects paired devices automatically (on startup, when signaling
    // recovers, and with backoff after a drop). The "Reconnect" action lets the
    // user bypass the backoff wait and force an attempt right now.
    function peerStatus(pair: { peer_node_id: string; room_id: string }): PeerConnection {
        return peerConnection(
            isConnected(pair.room_id),
            $reconnectingPeerIds.has(pair.peer_node_id),
        );
    }

    // Fine-grained label for a connected peer, from the document-sync phase.
    //
    // The wording comes from the shared helper, so this page and the sidebar
    // cannot describe the same peer in the same state differently, which they
    // previously did. Only the "synced at" case is local, because only this
    // page has room to show a time.
    function syncLabel(pair: { room_id: string; last_synchronized: number | null }): string {
        const rs = $roomSync[pair.room_id];
        if (rs?.phase === 'synced') {
            const at = rs.lastSyncedAt ?? pair.last_synchronized;
            return at ? `Synced · ${formatLastSync(at)}` : 'Synced';
        }
        return peerStatusLabel('connected', rs);
    }
</script>

<section class="section">
    <h2>Paired Devices</h2>
    {#if pairedDevices.length === 0}
        <p class="empty-state">No paired devices yet. Scan a QR code or enter a Node ID to pair.</p>
    {:else}
        <ul class="peer-list">
            {#each pairedDevices as pair (pair.peer_node_id)}
                {@const pstatus = peerStatus(pair)}
                <li class="peer-item">
                    <div class="peer-info">
                        <div class="peer-header">
                            <span class="peer-icon">📱</span>
                            <span class="peer-name">{pair.peer_display_name}</span>
                            <span
                                class="peer-status {pstatus === 'connected' ? 'online' : pstatus}"
                            >
                                {pstatus === 'connected'
                                    ? 'Connected'
                                    : pstatus === 'connecting'
                                      ? 'Connecting…'
                                      : 'Offline'}
                            </span>
                        </div>
                        <span class="peer-id">{pair.peer_node_id}</span>
                        {#if pstatus === 'connected'}
                            <!-- No route badge here: the addresses below say
                                 which are answering, and a row that said both
                                 said it twice in different words. -->
                            <span class="peer-sync">{syncLabel(pair)}</span>
                        {:else if pair.last_synchronized}
                            <span class="peer-sync"
                                >Last sync: {formatLastSync(pair.last_synchronized)}</span
                            >
                        {/if}
                        <PeerAddresses
                            nodeId={pair.peer_node_id}
                            addresses={addressesFor(pair.peer_node_id)}
                            answering={onStoredAddress.has(pair.peer_node_id)}
                            onAdd={onAddAddress}
                            onForget={onForgetAddress}
                        />
                    </div>
                    <div class="peer-actions">
                        {#if pstatus === 'connected'}
                            <button class="btn-danger" onclick={() => onDisconnect(pair.room_id)}>
                                Disconnect
                            </button>
                        {:else}
                            <button
                                class="btn-secondary"
                                title="Reconnect now, bypassing the retry wait"
                                onclick={() => onReconnect(pair.peer_node_id)}
                            >
                                {pstatus === 'connecting' ? 'Reconnect now' : 'Reconnect'}
                            </button>
                            <button class="btn-danger" onclick={() => onRemove(pair.peer_node_id)}>
                                Remove
                            </button>
                        {/if}
                    </div>
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
        flex: 1;
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
    .peer-status {
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 10px;
        font-weight: 500;
    }
    .peer-status.online {
        background: #dcfce7;
        color: #166534;
    }
    .peer-status.offline {
        background: var(--bg-hover);
        color: var(--text-muted);
    }
    .peer-status.connecting {
        background: #fef3c7;
        color: #92400e;
    }
    :global([data-theme='dark']) .peer-status.online {
        background: #14532d;
        color: #86efac;
    }
    :global([data-theme='dark']) .peer-status.connecting {
        background: #451a03;
        color: #fcd34d;
    }
    .peer-id {
        font-family: monospace;
        font-size: 10px;
        color: var(--text-muted);
        word-break: break-all;
    }
    .peer-sync {
        font-size: 10px;
        color: var(--text-muted);
    }
    .peer-actions {
        display: flex;
        gap: 6px;
        flex-shrink: 0;
    }
    .btn-danger {
        padding: 6px 12px;
        background: transparent;
        color: #ef4444;
        border: 1px solid #ef4444;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
    }
    .btn-danger:hover {
        background: #fef2f2;
    }
    .btn-secondary {
        padding: 6px 12px;
        background: transparent;
        color: var(--text-primary);
        border: 1px solid var(--border-color);
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
    }
    .btn-secondary:hover {
        background: var(--bg-hover);
    }
</style>

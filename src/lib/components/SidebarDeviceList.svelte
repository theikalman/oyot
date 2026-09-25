<script lang="ts">
    import {
        pairedDevices,
        connectedPeerIds,
        reconnectingPeerIds,
        roomSync,
        canSignal,
    } from '$lib/stores/sync';
    import { reconnectPeer } from '$lib/sync';
    import { peerConnection, peerStatusLabel } from '$lib/sync/peerStatus';

    interface Props {
        /** Open the sync settings page. */
        onManage: () => void;
    }

    let { onManage }: Props = $props();

    // Which row's menu is open. Local, because nothing outside this list
    // needs to know.
    let openMenuId = $state<string | null>(null);

    function toggleMenu(e: MouseEvent, peerNodeId: string) {
        e.stopPropagation();
        openMenuId = openMenuId === peerNodeId ? null : peerNodeId;
    }

    function reconnect(peerNodeId: string) {
        openMenuId = null;
        void reconnectPeer(peerNodeId);
    }
</script>

<svelte:window onclick={() => (openMenuId = null)} />

<div class="sidebar-section">
    <h3>
        Connected Devices
        <button class="manage-btn" onclick={onManage} title="Manage devices">
            <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                ><path
                    d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
                /></svg
            >
        </button>
    </h3>
    {#if $pairedDevices.length === 0}
        <p class="empty-hint">No paired devices yet</p>
    {:else}
        <ul class="device-list">
            {#each $pairedDevices as device (device.peer_node_id)}
                {@const online = $connectedPeerIds.has(device.peer_node_id)}
                {@const reconnecting = $reconnectingPeerIds.has(device.peer_node_id)}
                {@const rs = $roomSync[device.room_id]}
                <li class="device-item">
                    <span class="device-dot" class:online></span>
                    <span class="device-name">{device.peer_display_name}</span>
                    <span class="device-status">
                        {peerStatusLabel(peerConnection(online, reconnecting), rs, {
                            compact: true,
                        })}
                    </span>
                    <button
                        class="device-menu-btn"
                        onclick={(e) => toggleMenu(e, device.peer_node_id)}
                        title="Device options"
                        aria-expanded={openMenuId === device.peer_node_id}
                    >
                        <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            ><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle
                                cx="12"
                                cy="19"
                                r="1"
                            /></svg
                        >
                    </button>
                    {#if openMenuId === device.peer_node_id}
                        <div class="device-menu">
                            <button
                                class="doc-menu-item"
                                disabled={online || !$canSignal}
                                onclick={() => reconnect(device.peer_node_id)}
                            >
                                {reconnecting ? 'Reconnect now' : 'Reconnect'}
                            </button>
                        </div>
                    {/if}
                </li>
            {/each}
        </ul>
    {/if}
</div>

<style>
    /* Svelte scopes styles to the component that declares them, so the
       `.sidebar-section` and `h3` rules in Sidebar.svelte never reached this
       markup even though it uses their class names. The section sat flush
       against the sidebar's edge with an unstyled heading and a default
       browser button beside it, while every other section was inset. */
    .sidebar-section {
        padding: 12px;
    }

    .sidebar-section h3 {
        font-size: 12px;
        text-transform: uppercase;
        color: var(--text-secondary);
        margin: 0 0 8px 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
    }

    .manage-btn {
        background: none;
        border: none;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
        display: flex;
        align-items: center;
        color: var(--text-secondary);
    }

    .manage-btn:hover {
        color: var(--text-primary);
    }

    .empty-hint {
        margin: 0;
        font-size: 13px;
        color: var(--text-muted);
    }

    .device-list {
        list-style: none;
        padding: 0;
        margin: 0;
    }

    /* Nothing on the right, so the menu button ends where the pinned notes'
       do, under the gear in the heading. With the right padding, a column of
       menu buttons sat out of line with the one above it. */
    .device-item {
        position: relative;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 0 6px 8px;
        border-radius: 4px;
        font-size: 14px;
        color: var(--text-primary);
    }

    .device-dot {
        flex-shrink: 0;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--text-muted);
    }

    .device-dot.online {
        background: var(--status-ok, #22c55e);
        box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.2);
    }

    .device-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .device-status {
        flex-shrink: 0;
        font-size: 11px;
        color: var(--text-muted);
    }

    /* Always shown, like the menu on a pinned note, and for the same
       reason: it used to appear only under the pointer, which a touch
       screen does not have. */
    .device-menu-btn {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        border-radius: 4px;
        cursor: pointer;
    }

    .device-menu-btn[aria-expanded='true'] {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    /* Only where the pointer can hover, as on a pinned note's button: a
       phone leaves the last button tapped looking hovered. */
    @media (hover: hover) {
        .device-menu-btn:hover {
            background: var(--bg-hover);
            color: var(--text-primary);
        }
    }

    /* Sized for a finger, as on a pinned note: a 44px-wide target the full
       height of the row, around a button that looks the same. */
    @media (pointer: coarse) {
        .device-menu-btn {
            position: relative;
            -webkit-tap-highlight-color: transparent;
        }

        .device-menu-btn::after {
            content: '';
            position: absolute;
            inset: -6px -10px;
        }
    }

    .device-menu {
        position: absolute;
        top: calc(100% + 2px);
        right: 0;
        z-index: 50;
        min-width: 140px;
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 6px;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
        padding: 4px;
        display: flex;
        flex-direction: column;
    }

    /* The reconnect button in a device menu. Shared shape with the
       document menus, which live in DocumentList. */
    .doc-menu-item {
        text-align: left;
        padding: 6px 8px;
        border: none;
        background: transparent;
        cursor: pointer;
        border-radius: 4px;
        font-size: 13px;
        color: var(--text-primary);
    }

    .doc-menu-item:hover {
        background: var(--bg-hover);
    }

    .doc-menu-item:disabled {
        opacity: 0.5;
        cursor: default;
    }

    .doc-menu-item:disabled:hover {
        background: transparent;
    }
</style>

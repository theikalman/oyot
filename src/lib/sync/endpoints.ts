// Addresses the user has stored for devices that are not on this network.
//
// A thin layer over the Rust commands whose only job is to keep the store in
// step with the table: every one of these changes what the settings screen and
// the pairing form are allowed to say, so refreshing from Rust after each is
// cheaper than mirroring the write here and hoping it matches.
//
// See docs/decisions/0023-reach-a-peer-at-an-address-you-already-know.md.

import { invoke } from '@tauri-apps/api/core';
import { syncStore, type DeviceEndpoint } from '$lib/stores/sync';

export async function refreshEndpoints(): Promise<void> {
    syncStore.setEndpoints(await invoke<DeviceEndpoint[]>('list_peer_endpoints'));
}

/**
 * Store an address for a device and probe it at once.
 *
 * Returns what Rust made of the address, which is not always what was typed:
 * a bare host takes the default port, and seeing that is how someone finds out
 * they did not need to type one.
 */
export async function saveEndpoint(peerNodeId: string, address: string): Promise<DeviceEndpoint> {
    const saved = await invoke<DeviceEndpoint>('save_peer_endpoint', { peerNodeId, address });
    await refreshEndpoints();
    return saved;
}

export async function forgetEndpoint(
    peerNodeId: string,
    host: string,
    port: number,
): Promise<void> {
    await invoke('forget_peer_endpoint', { peerNodeId, host, port });
    await refreshEndpoints();
}

/** Try every stored address now rather than at the next interval. */
export async function probeStoredAddresses(): Promise<void> {
    await invoke('probe_stored_addresses');
}

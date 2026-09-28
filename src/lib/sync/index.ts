// Public surface of the page's side of sync. The engine itself runs in Rust
// (ADR 0031); this is what the page shows of it and asks of it.
//
//   client.ts           - Rust's events into the stores, and the pairing and
//                         connection controls.
//   endpoints.ts        - addresses stored for devices that are not on this
//                         network (ADR 0023).
//   DocumentRepository  - the only place Tauri doc commands and Yjs meet.

export {
    initSync,
    shutdownSync,
    refreshSyncStatus,
    sendPairRequest,
    respondToPairRequest,
    disconnectPeer,
    reconnectPeer,
    documentRepository,
    pullAttachmentFromPeers,
} from './client';

export { refreshEndpoints, saveEndpoint, forgetEndpoint, probeStoredAddresses } from './endpoints';

export { DocumentRepository } from './DocumentRepository';
export type { ManifestEntry } from './protocol';

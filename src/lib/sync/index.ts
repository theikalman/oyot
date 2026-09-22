// Public surface of the peer-to-peer sync layer.
//
//   transport.ts            - signaling + WebRTC perfect negotiation +
//                             per-peer reconnect (ADR 0002, 0018, 0022).
//   endpoints.ts            - addresses stored for devices that are not on
//                             this network (ADR 0023).
//   channel/DocSyncProtocol - two-phase whole-document-set reconciliation +
//                             steady-state live messages (ADR 0003).
//   channel/Framing         - chunked, back-pressured message transport.
//   DocumentRepository      - the only place Tauri doc commands and Yjs meet.

export {
    initSync,
    shutdownSync,
    sendPairRequest,
    respondToPairRequest,
    disconnectPeer,
    reconnectPeer,
    documentRepository,
    broadcastLocalUpdate,
    broadcastDocCreated,
    broadcastDocRenamed,
    broadcastDocDeleted,
    broadcastAttachmentAvailable,
    pullAttachmentFromPeers,
} from './transport';

export { refreshEndpoints, saveEndpoint, forgetEndpoint, probeStoredAddresses } from './endpoints';

export { DocumentRepository } from './DocumentRepository';
export type { ManifestEntry, SyncMessage } from './protocol';

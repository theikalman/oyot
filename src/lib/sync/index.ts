// Public surface of the peer-to-peer sync layer.
//
//   transport.ts            - MQTT signaling + WebRTC perfect negotiation +
//                             per-peer reconnect (ADR 0002).
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

export { DocumentRepository } from './DocumentRepository';
export type { ManifestEntry, SyncMessage } from './protocol';

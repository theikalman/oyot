import { writable, derived } from 'svelte/store';
import type { Document, DocumentSummary, SearchResult, Theme, ViewMode } from '../types';

function createAppStore() {
    const { subscribe, set, update } = writable({
        workspacePath: null as string | null,
        documents: [] as DocumentSummary[],
        currentDocument: null as Document | null,
        isLoading: false,
        theme: 'light' as Theme
    });

    return {
        subscribe,
        setWorkspacePath: (path: string) => update(s => ({ ...s, workspacePath: path })),
        setDocuments: (documents: DocumentSummary[]) => update(s => ({ ...s, documents })),
        setCurrentDocument: (doc: Document | null) => update(s => ({ ...s, currentDocument: doc })),
        setLoading: (loading: boolean) => update(s => ({ ...s, isLoading: loading })),
        setTheme: (theme: Theme) => update(s => ({ ...s, theme })),
        updateDocumentInList: (updatedDoc: DocumentSummary) => update(s => ({
            ...s,
            documents: s.documents.map(d => d.id === updatedDoc.id ? updatedDoc : d),
            currentDocument: s.currentDocument?.id === updatedDoc.id ? s.currentDocument : s.currentDocument
        })),
        addDocument: (doc: DocumentSummary) => update(s => {
            const exists = s.documents.some(d => d.id === doc.id);
            if (exists) return s;
            return {
                ...s,
                documents: [...s.documents, doc]
            };
        }),
        removeDocument: (docId: string) => update(s => ({
            ...s,
            documents: s.documents.filter(d => d.id !== docId),
            currentDocument: s.currentDocument?.id === docId ? null : s.currentDocument
        })),
        reset: () => set({
            workspacePath: null,
            documents: [],
            currentDocument: null,
            isLoading: false,
            theme: 'light'
        })
    };
}

export const appStore = createAppStore();

export const currentDocument = derived(appStore, $s => $s.currentDocument);
export const documents = derived(appStore, $s => $s.documents);
export const workspacePath = derived(appStore, $s => $s.workspacePath);
export const isLoading = derived(appStore, $s => $s.isLoading);
export const theme = derived(appStore, $s => $s.theme);

export interface SyncPeer {
    node_id: string;
    device_name: string;
    last_synchronized: number | null;
    is_online: boolean;
}

export type SyncStatus = 'synced' | 'syncing' | 'offline';

function createSyncStore() {
    const { subscribe, set, update } = writable({
        nodeId: null as string | null,
        peers: [] as SyncPeer[],
        status: 'offline' as SyncStatus,
        isEnabled: false
    });

    return {
        subscribe,
        setNodeId: (nodeId: string) => update(s => ({ ...s, nodeId })),
        setPeers: (peers: SyncPeer[]) => update(s => ({ ...s, peers })),
        addPeer: (peer: SyncPeer) => update(s => ({
            ...s,
            peers: [...s.peers.filter(p => p.node_id !== peer.node_id), peer]
        })),
        removePeer: (nodeId: string) => update(s => ({
            ...s,
            peers: s.peers.filter(p => p.node_id !== nodeId)
        })),
        setStatus: (status: SyncStatus) => update(s => ({ ...s, status })),
        setEnabled: (enabled: boolean) => update(s => ({ ...s, isEnabled: enabled })),
        markPeerOnline: (nodeId: string) => update(s => ({
            ...s,
            peers: s.peers.map(p => p.node_id === nodeId ? { ...p, is_online: true } : p)
        })),
        markPeerOffline: (nodeId: string) => update(s => ({
            ...s,
            peers: s.peers.map(p => p.node_id === nodeId ? { ...p, is_online: false } : p)
        }))
    };
}

export const syncStore = createSyncStore();
export const nodeId = derived(syncStore, $s => $s.nodeId);
export const syncPeers = derived(syncStore, $s => $s.peers);
export const syncStatus = derived(syncStore, $s => $s.status);
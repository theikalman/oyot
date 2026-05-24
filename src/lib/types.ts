export interface Document {
    id: string;
    doc_type: 'journal' | 'note';
    title: string;
    created_at: number;
    updated_at: number;
}

export interface DocumentSummary {
    id: string;
    doc_type: string;
    title: string;
    created_at: number;
    updated_at: number;
}

export interface SearchResult {
    id: string;
    title: string;
    line_content: string;
}

export interface IndexData {
    documents: DocumentSummary[];
}

export type Theme = 'light' | 'dark';

export type ViewMode = 'reading' | 'index' | 'journals';

export interface JournalEntry {
    id: string;
    doc_type: string;
    title: string;
    created_at: number;
}

export interface Attachment {
    hash: string;
    mime_type: string;
    local_path: string | null;
    is_fully_downloaded: boolean;
    created_at: number;
}

export interface SyncPeer {
    node_id: string;
    device_name: string;
    last_synchronized: number | null;
    is_online: boolean;
}

export interface AppState {
    documents: DocumentSummary[];
    currentDocument: Document | null;
    viewMode: ViewMode;
    searchQuery: string;
    searchResults: SearchResult[];
    isLoading: boolean;
}

export interface Document {
    id: string;
    doc_type: 'journal' | 'note';
    title: string;
    content_json: string;
    created_at?: string;
    updated_at?: string;
}

export interface DocumentLink {
    source_id: string;
    target_id: string;
}

export interface Todo {
    id: string;
    document_id: string;
    text: string;
    is_completed: boolean;
    created_at?: string;
}

export interface SearchResult {
    id: string;
    title: string;
    line_number: number;
    line_content: string;
}

export interface IndexData {
    documents: Document[];
    links: DocumentLink[];
    all_links: string[];
    todos: Todo[];
}

export type Theme = 'light' | 'dark';

export type ViewMode = 'reading' | 'index' | 'journals';

export interface JournalEntry {
    id: string;
    doc_type: string;
    title: string;
    content_json: string;
    created_at?: string;
}

export interface AppState {
    workspacePath: string | null;
    documents: Document[];
    links: DocumentLink[];
    allLinks: string[];
    todos: Todo[];
    currentDocument: Document | null;
    viewMode: ViewMode;
    searchQuery: string;
    searchResults: SearchResult[];
    indexType: 'notes' | 'links' | 'todos';
    isLoading: boolean;
}
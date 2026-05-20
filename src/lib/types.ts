export interface FileEntry {
    path: string;
    title: string;
    content: string;
}

export interface LinkReference {
    source: string;
    target: string;
}

export interface SearchResult {
    path: string;
    title: string;
    line_number: number;
    line_content: string;
}

export interface IndexData {
    files: FileEntry[];
    backlinks: LinkReference[];
    all_links: string[];
}

export type ViewMode = 'reading' | 'index' | 'journals';

export interface JournalEntry {
    date: string;
    content: string;
}

export interface AppState {
    workspacePath: string | null;
    files: FileEntry[];
    backlinks: LinkReference[];
    allLinks: string[];
    currentFile: FileEntry | null;
    viewMode: ViewMode;
    searchQuery: string;
    searchResults: SearchResult[];
    indexType: 'files' | 'links' | 'search' | 'todos';
    isLoading: boolean;
}
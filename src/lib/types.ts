export interface Document {
    id: string;
    doc_type: 'journal' | 'note';
    title: string;
    created_at: number;
    updated_at: number;
    title_updated_at: number;
    is_deleted: boolean;
    deleted_at?: number | null;
    lifecycle_updated_at?: number | null;
}

export interface DocumentSummary {
    id: string;
    doc_type: string;
    title: string;
    todo_count: number;
    completed_todo_count: number;
    created_at: number;
    updated_at: number;
    has_content: boolean;
}

export interface IndexData {
    documents: DocumentSummary[];
}

export type Theme = 'light' | 'dark';

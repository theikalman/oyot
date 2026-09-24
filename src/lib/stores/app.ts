import { writable, derived } from 'svelte/store';
import type { Document, DocumentSummary, Theme } from '../types';

function createAppStore() {
    const { subscribe, set, update } = writable({
        documents: [] as DocumentSummary[],
        currentDocument: null as Document | null,
        isLoading: false,
        theme: 'light' as Theme,
    });

    return {
        subscribe,
        setDocuments: (documents: DocumentSummary[]) => update((s) => ({ ...s, documents })),
        setCurrentDocument: (doc: Document | null) =>
            update((s) => ({ ...s, currentDocument: doc })),
        setLoading: (loading: boolean) => update((s) => ({ ...s, isLoading: loading })),
        setTheme: (theme: Theme) => update((s) => ({ ...s, theme })),
        updateDocumentInList: (updatedDoc: DocumentSummary) =>
            update((s) => ({
                ...s,
                documents: s.documents.map((d) => (d.id === updatedDoc.id ? updatedDoc : d)),
                currentDocument:
                    s.currentDocument?.id === updatedDoc.id ? s.currentDocument : s.currentDocument,
            })),
        // Task counts are derived from the document's content, so they can
        // only change when something writes that content. Loading them once at
        // startup and never again meant the sidebar badge was whatever it had
        // been when the app opened, however many tasks had been ticked since.
        setDocumentCounts: (docId: string, todoCount: number, completedTodoCount: number) =>
            update((s) => ({
                ...s,
                documents: s.documents.map((d) =>
                    d.id === docId &&
                    (d.todo_count !== todoCount || d.completed_todo_count !== completedTodoCount)
                        ? { ...d, todo_count: todoCount, completed_todo_count: completedTodoCount }
                        : d,
                ),
            })),
        markDocumentHasContent: (docId: string) =>
            update((s) => ({
                ...s,
                documents: s.documents.map((d) =>
                    d.id === docId && !d.has_content ? { ...d, has_content: true } : d,
                ),
            })),
        // The open document is kept in step too, so nothing reading the pin
        // off it is left holding the one it had when it was opened.
        setDocumentPinned: (docId: string, pinned: boolean, pinnedUpdatedAt: number) =>
            update((s) => ({
                ...s,
                documents: s.documents.map((d) =>
                    d.id === docId && d.pinned !== pinned ? { ...d, pinned } : d,
                ),
                currentDocument:
                    s.currentDocument?.id === docId
                        ? { ...s.currentDocument, pinned, pinned_updated_at: pinnedUpdatedAt }
                        : s.currentDocument,
            })),
        addDocument: (doc: DocumentSummary) =>
            update((s) => {
                const exists = s.documents.some((d) => d.id === doc.id);
                if (exists) return s;
                return {
                    ...s,
                    documents: [...s.documents, doc],
                };
            }),
        removeDocument: (docId: string) =>
            update((s) => ({
                ...s,
                documents: s.documents.filter((d) => d.id !== docId),
                currentDocument: s.currentDocument?.id === docId ? null : s.currentDocument,
            })),
        reset: () =>
            set({
                documents: [],
                currentDocument: null,
                isLoading: false,
                theme: 'light',
            }),
    };
}

export const appStore = createAppStore();

export const currentDocument = derived(appStore, ($s) => $s.currentDocument);
export const documents = derived(appStore, ($s) => $s.documents);
export const isLoading = derived(appStore, ($s) => $s.isLoading);
export const theme = derived(appStore, ($s) => $s.theme);

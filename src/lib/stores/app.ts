import { writable, derived } from 'svelte/store';
import type { Document, DocumentLink, Todo, Theme } from '../types';

function createAppStore() {
    const { subscribe, set, update } = writable({
        workspacePath: null as string | null,
        documents: [] as Document[],
        links: [] as DocumentLink[],
        allLinks: [] as string[],
        todos: [] as Todo[],
        currentDocument: null as Document | null,
        isLoading: false,
        theme: 'light' as Theme
    });

    return {
        subscribe,
        setWorkspacePath: (path: string) => update(s => ({ ...s, workspacePath: path })),
        setDocuments: (documents: Document[]) => update(s => ({ ...s, documents })),
        setLinks: (links: DocumentLink[]) => update(s => ({ ...s, links })),
        setAllLinks: (links: string[]) => update(s => ({ ...s, allLinks: links })),
        setTodos: (todos: Todo[]) => update(s => ({ ...s, todos })),
        setCurrentDocument: (doc: Document | null) => update(s => ({ ...s, currentDocument: doc })),
        setLoading: (loading: boolean) => update(s => ({ ...s, isLoading: loading })),
        setTheme: (theme: Theme) => update(s => ({ ...s, theme })),
        updateDocumentInList: (updatedDoc: Document) => update(s => ({
            ...s,
            documents: s.documents.map(d => d.id === updatedDoc.id ? updatedDoc : d),
            currentDocument: s.currentDocument?.id === updatedDoc.id ? updatedDoc : s.currentDocument
        })),
        updateDocumentInListOnly: (updatedDoc: Document) => update(s => ({
            ...s,
            documents: s.documents.map(d => d.id === updatedDoc.id ? updatedDoc : d)
        })),
        addDocument: (doc: Document) => update(s => {
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
            links: [],
            allLinks: [],
            todos: [],
            currentDocument: null,
            isLoading: false,
            theme: 'light'
        })
    };
}

export const appStore = createAppStore();

export const currentDocument = derived(appStore, $s => $s.currentDocument);
export const documents = derived(appStore, $s => $s.documents);
export const allLinks = derived(appStore, $s => $s.allLinks);
export const links = derived(appStore, $s => $s.links);
export const todos = derived(appStore, $s => $s.todos);
export const workspacePath = derived(appStore, $s => $s.workspacePath);
export const isLoading = derived(appStore, $s => $s.isLoading);
export const theme = derived(appStore, $s => $s.theme);
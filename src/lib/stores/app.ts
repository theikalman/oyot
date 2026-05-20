import { writable, derived } from 'svelte/store';
import type { FileEntry, LinkReference, SearchResult, ViewMode } from '../types';

function createAppStore() {
    const { subscribe, set, update } = writable({
        workspacePath: null as string | null,
        files: [] as FileEntry[],
        backlinks: [] as LinkReference[],
        allLinks: [] as string[],
        currentFile: null as FileEntry | null,
        viewMode: 'index' as ViewMode,
        searchQuery: '',
        searchResults: [] as SearchResult[],
        indexType: 'files' as 'files' | 'links' | 'search' | 'todos',
        isLoading: false
    });

    return {
        subscribe,
        setWorkspacePath: (path: string) => update(s => ({ ...s, workspacePath: path })),
        setFiles: (files: FileEntry[]) => update(s => ({ ...s, files })),
        setBacklinks: (backlinks: LinkReference[]) => update(s => ({ ...s, backlinks })),
        setAllLinks: (links: string[]) => update(s => ({ ...s, allLinks: links })),
        setCurrentFile: (file: FileEntry | null) => update(s => ({ ...s, currentFile: file, viewMode: 'reading' })),
        setViewMode: (mode: ViewMode) => update(s => ({ ...s, viewMode: mode })),
        setSearchQuery: (query: string) => update(s => ({ ...s, searchQuery: query })),
        setSearchResults: (results: SearchResult[]) => update(s => ({ ...s, searchResults: results, indexType: 'search' })),
        setIndexType: (type: 'files' | 'links' | 'search' | 'todos') => update(s => ({ ...s, indexType: type })),
        setLoading: (loading: boolean) => update(s => ({ ...s, isLoading: loading })),
        reset: () => set({
            workspacePath: null,
            files: [],
            backlinks: [],
            allLinks: [],
            currentFile: null,
            viewMode: 'index',
            searchQuery: '',
            searchResults: [],
            indexType: 'files',
            isLoading: false
        })
    };
}

export const appStore = createAppStore();

export const currentFile = derived(appStore, $s => $s.currentFile);
export const files = derived(appStore, $s => $s.files);
export const allLinks = derived(appStore, $s => $s.allLinks);
export const backlinks = derived(appStore, $s => $s.backlinks);
export const viewMode = derived(appStore, $s => $s.viewMode);
export const workspacePath = derived(appStore, $s => $s.workspacePath);
export const isLoading = derived(appStore, $s => $s.isLoading);
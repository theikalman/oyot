import type { Editor, Range } from '@tiptap/core';
import { commandRegistry, type SlashCommand, type CommandSelectProps } from '../CommandRegistry';
import SlashSuggestionPopup, { type PopupItem } from '../../components/SlashSuggestionPopup.svelte';
import { mount, unmount } from 'svelte';
import { get, writable } from 'svelte/store';
import { documents as documentsStore, currentDocument } from '../../stores/app';
import type { DocumentSummary } from '../../types';
import { exitSuggestion } from '@tiptap/suggestion';

interface DocumentSuggestionItem {
    id: string;
    title: string;
    icon?: string;
    description?: string;
}

let currentEditor: Editor | null = null;
let documentPopupComponent: Record<string, unknown> | null = null;
let documentPopup: HTMLElement | null = null;
let keydownHandler: ((e: KeyboardEvent) => void) | null = null;
let clickOutsideHandler: ((e: MouseEvent) => void) | null = null;
const popupItems = writable<PopupItem[]>([]);
const popupSelectedIndex = writable(0);
// What has been typed to narrow the list, shown in the popup so the user can
// see what they are filtering by.
const queryStore = writable('');
let query = '';

export function registerDocumentLinkCommand(): void {
    const command: SlashCommand = {
        id: 'document',
        label: 'Link Document',
        icon: '<svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2.27V6.4c0 .56 0 .84.109 1.054a1 1 0 0 0 .437.437c.214.11.494.11 1.054.11h4.13M14 17H8m8-4H8m12-3.012V17.2c0 1.68 0 2.52-.327 3.162a3 3 0 0 1-1.311 1.311C17.72 22 16.88 22 15.2 22H8.8c-1.68 0-2.52 0-3.162-.327a3 3 0 0 1-1.311-1.311C4 19.72 4 18.88 4 17.2V6.8c0-1.68 0-2.52.327-3.162a3 3 0 0 1-1.311-1.311C6.28 2 7.12 2 8.8 2h3.212c.733 0 1.1 0 1.446.083.306.073.598.195.867.36.303.185.562.444 1.08.963l3.19 3.188c.518.519.777.778.963 1.081a3 3 0 0 1 .36.867c.082.346.082.712.082 1.446"/></svg>',
        onSelect: (props: CommandSelectProps) => {
            currentEditor = props.editor as Editor;

            const rect = getAnchorClientRect(props.editor as Editor, props.range);

            (props.editor as Editor).chain().focus().deleteRange(props.range).run();

            if (rect) {
                showDocumentSuggestionPopup(rect);
            }

            exitSuggestion((props.editor as Editor).view);
        },
    };

    commandRegistry.register(command);
}

function getAnchorClientRect(editor: Editor, _range: Range): DOMRect | null {
    try {
        const pos = editor.state.selection.$anchor.pos;
        const coords = editor.view.coordsAtPos(pos);
        return new DOMRect(
            coords.left,
            coords.top,
            coords.right - coords.left,
            coords.bottom - coords.top,
        );
    } catch {
        return null;
    }
}

// Keys are taken on the capture phase, before ProseMirror sees them.
//
// The editor keeps focus while this popup is open, so a bubbling listener ran
// after ProseMirror had already handled the keystroke: Enter split the
// paragraph and then inserted the link into the new one, and the arrow keys
// moved the caret as well as the selection.
const KEY_CAPTURE = true;

function refreshItems(): void {
    popupItems.set(searchDocuments(query));
    popupSelectedIndex.set(0);
    queryStore.set(query);
}

function onPopupKeydown(e: KeyboardEvent): void {
    const items = get(popupItems);

    const take = () => {
        e.preventDefault();
        e.stopPropagation();
    };

    if (e.key === 'Escape') {
        take();
        closeDocumentPopup();
        return;
    }
    if (e.key === 'Backspace') {
        take();
        query = query.slice(0, -1);
        refreshItems();
        return;
    }
    // A single printable character, with no modifier: typing to narrow the
    // list. `searchDocuments` existed for this and was never called.
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        take();
        query += e.key;
        refreshItems();
        return;
    }

    if (items.length === 0) return;

    if (e.key === 'ArrowUp') {
        take();
        popupSelectedIndex.update((i) => (i - 1 + items.length) % items.length);
    } else if (e.key === 'ArrowDown') {
        take();
        popupSelectedIndex.update((i) => (i + 1) % items.length);
    } else if (e.key === 'Enter') {
        take();
        const chosen = items[get(popupSelectedIndex)];
        if (chosen) handleDocumentSelect(chosen.id);
    }
}

function showDocumentSuggestionPopup(rect: DOMRect): void {
    closeDocumentPopup();

    documentPopup = document.createElement('div');
    documentPopup.className = 'document-suggestion-popup';
    documentPopup.style.position = 'fixed';
    documentPopup.style.left = `${rect.left}px`;
    documentPopup.style.top = `${rect.bottom + 8}px`;
    documentPopup.style.zIndex = '1001';
    document.body.appendChild(documentPopup);

    query = '';
    refreshItems();

    keydownHandler = onPopupKeydown;
    clickOutsideHandler = (e: MouseEvent) => {
        if (documentPopup && !documentPopup.contains(e.target as Node)) {
            closeDocumentPopup();
        }
    };
    // Deferred by a tick so the click or keystroke that opened the popup does
    // not immediately close it again.
    setTimeout(() => {
        if (keydownHandler) {
            document.addEventListener('keydown', keydownHandler, KEY_CAPTURE);
        }
        if (clickOutsideHandler) {
            document.addEventListener('mousedown', clickOutsideHandler);
        }
    }, 0);

    documentPopupComponent = mount(SlashSuggestionPopup, {
        target: documentPopup,
        props: {
            items: popupItems,
            selectedIndex: popupSelectedIndex,
            onCommand: handleDocumentSelect,
            queryLabel: queryStore,
        },
    });
}

function handleDocumentSelect(id: string): void {
    const item = get(popupItems).find((i) => i.id === id);
    if (item && currentEditor) {
        currentEditor
            .chain()
            .focus()
            .insertContent({
                type: 'documentLink',
                attrs: {
                    targetId: item.id,
                    title: item.title,
                },
            })
            .run();
    }
    closeDocumentPopup();
}

function closeDocumentPopup(): void {
    if (keydownHandler) {
        document.removeEventListener('keydown', keydownHandler, KEY_CAPTURE);
        keydownHandler = null;
    }
    if (clickOutsideHandler) {
        document.removeEventListener('mousedown', clickOutsideHandler);
        clickOutsideHandler = null;
    }
    if (documentPopupComponent) {
        void unmount(documentPopupComponent);
        documentPopupComponent = null;
    }
    if (documentPopup && documentPopup.parentNode) {
        documentPopup.parentNode.removeChild(documentPopup);
    }
    documentPopup = null;
    currentEditor = null;
    query = '';
    queryStore.set('');
    popupItems.set([]);
    popupSelectedIndex.set(0);
}

export function searchDocuments(query: string): DocumentSuggestionItem[] {
    const docs = get(documentsStore);
    const currentDocId = get(currentDocument)?.id;
    const normalizedQuery = query.toLowerCase();

    return docs
        .filter(
            (doc: DocumentSummary) =>
                doc.id !== currentDocId && doc.title.toLowerCase().includes(normalizedQuery),
        )
        .map((doc: DocumentSummary) => ({
            id: doc.id,
            title: doc.title,
            icon: '📄',
        }));
}

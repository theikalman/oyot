import { invoke } from '@tauri-apps/api/core';
import type { Editor, Range } from '@tiptap/core';
import { commandRegistry, type SlashCommand, type CommandSelectProps } from '../CommandRegistry';
import SlashSuggestionPopup from '../../components/SlashSuggestionPopup.svelte';
import { mount } from 'svelte';
import { get, writable, type Writable } from 'svelte/store';
import { documents as documentsStore } from '../../stores/app';
import type { Document } from '../../types';
import { exitSuggestion } from '@tiptap/suggestion';

interface DocumentSuggestionItem {
    id: string;
    title: string;
    icon?: string;
    description?: string;
}

let currentEditor: Editor | null = null;
let currentRange: Range | null = null;
let documentPopupComponent: unknown | null = null;
let documentPopup: HTMLElement | null = null;
let keydownHandler: ((e: KeyboardEvent) => void) | null = null;
let clickOutsideHandler: ((e: MouseEvent) => void) | null = null;
let popupItems: DocumentSuggestionItem[] = [];
let popupSelectedIndexStore: Writable<number> = writable(0);

export function registerDocumentLinkCommand(editor: Editor): void {
    const command: SlashCommand = {
        id: 'document',
        label: 'Link Document',
        icon: '📄',
        onTrigger: (props) => {
            currentEditor = props.editor;
            currentRange = props.range;
        },
        onSelect: (props: CommandSelectProps) => {
            currentEditor = props.editor as Editor;
            currentRange = props.range;

            // Capture rect before deleting the text (position changes after deletion)
            const rect = getAnchorClientRect(props.editor as Editor, props.range);

            // Remove the typed slash command text (e.g. "/doc") from the editor immediately
            (props.editor as Editor).chain().focus().deleteRange(props.range).run();

            if (rect) {
                showDocumentSuggestionPopup(rect);
            }

            // Exit the slash suggestion so its popup is removed from the DOM
            exitSuggestion((props.editor as Editor).view);
        }
    };

    commandRegistry.register(command);
}

function getAnchorClientRect(editor: Editor, range: Range): DOMRect | null {
    try {
        const pos = editor.state.selection.$anchor.pos;
        const coords = editor.view.coordsAtPos(pos);
        return new DOMRect(coords.left, coords.top, coords.right - coords.left, coords.bottom - coords.top);
    } catch {
        return null;
    }
}

function showDocumentSuggestionPopup(rect: DOMRect): void {
    if (documentPopup) {
        documentPopup.remove();
    }

    documentPopup = document.createElement('div');
    documentPopup.className = 'document-suggestion-popup';
    documentPopup.style.position = 'fixed';
    documentPopup.style.left = `${rect.left}px`;
    documentPopup.style.top = `${rect.bottom + 8}px`;
    documentPopup.style.zIndex = '1001';

    document.body.appendChild(documentPopup);

    // Escape / ArrowUp / ArrowDown / Enter navigation for the document popup.
    // Deferred by one tick so the Enter key that opened this popup (still
    // propagating up to `document`) doesn't immediately select an item.
    keydownHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeDocumentPopup();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            popupSelectedIndexStore.update(i => (i - 1 + popupItems.length) % popupItems.length);
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            popupSelectedIndexStore.update(i => (i + 1) % popupItems.length);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const idx = get(popupSelectedIndexStore);
            if (popupItems[idx]) {
                handleDocumentSelect(popupItems[idx]);
            }
        }
    };
    setTimeout(() => {
        if (keydownHandler) {
            document.addEventListener('keydown', keydownHandler);
        }
    }, 0);

    // Click outside closes the document popup (defer by one tick so the
    // click that triggered the popup doesn't immediately close it)
    clickOutsideHandler = (e: MouseEvent) => {
        if (documentPopup && !documentPopup.contains(e.target as Node)) {
            closeDocumentPopup();
        }
    };
    setTimeout(() => {
        if (clickOutsideHandler) {
            document.addEventListener('mousedown', clickOutsideHandler);
        }
    }, 0);

    let items: DocumentSuggestionItem[] = [];

    const docs = get(documentsStore);
    items = docs.map((doc: Document) => ({
        id: doc.id,
        title: doc.title,
        icon: '📄'
    }));

    popupItems = items;
    popupSelectedIndexStore = writable(0);

    documentPopupComponent = mount(SlashSuggestionPopup, {
        target: documentPopup,
        props: {
            items,
            selectedIndexStore: popupSelectedIndexStore,
            command: handleDocumentSelect,
            onClose: closeDocumentPopup
        }
    });
}

function handleDocumentSelect(item: DocumentSuggestionItem): void {
    if (currentEditor) {
        currentEditor.chain()
            .focus()
            .insertContent({
                type: 'documentLink',
                attrs: {
                    targetId: item.id,
                    title: item.title
                }
            })
            .run();
    }
    closeDocumentPopup();
}

function closeDocumentPopup(): void {
    if (keydownHandler) {
        document.removeEventListener('keydown', keydownHandler);
        keydownHandler = null;
    }
    if (clickOutsideHandler) {
        document.removeEventListener('mousedown', clickOutsideHandler);
        clickOutsideHandler = null;
    }
    if (documentPopup && documentPopup.parentNode) {
        documentPopup.parentNode.removeChild(documentPopup);
    }
    documentPopup = null;
    documentPopupComponent = null;
    currentEditor = null;
    currentRange = null;
}

export function searchDocuments(query: string): DocumentSuggestionItem[] {
    const docs = get(documentsStore);
    const normalizedQuery = query.toLowerCase();

    return docs
        .filter((doc: Document) => doc.title.toLowerCase().includes(normalizedQuery))
        .map((doc: Document) => ({
            id: doc.id,
            title: doc.title,
            icon: '📄'
        }));
}

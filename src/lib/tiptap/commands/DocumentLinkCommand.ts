import type { Editor, Range } from '@tiptap/core';
import { commandRegistry, type SlashCommand, type CommandSelectProps } from '../CommandRegistry';
import SlashSuggestionPopup from '../../components/SlashSuggestionPopup.svelte';
import { mount } from 'svelte';
import { get, writable, type Writable } from 'svelte/store';
import { documents as documentsStore } from '../../stores/app';
import type { DocumentSummary } from '../../types';
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

export function registerDocumentLinkCommand(_editor: Editor): void {
    const command: SlashCommand = {
        id: 'document',
        label: 'Link Document',
        icon: '<svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2.27V6.4c0 .56 0 .84.109 1.054a1 1 0 0 0 .437.437c.214.11.494.11 1.054.11h4.13M14 17H8m8-4H8m12-3.012V17.2c0 1.68 0 2.52-.327 3.162a3 3 0 0 1-1.311 1.311C17.72 22 16.88 22 15.2 22H8.8c-1.68 0-2.52 0-3.162-.327a3 3 0 0 1-1.311-1.311C4 19.72 4 18.88 4 17.2V6.8c0-1.68 0-2.52.327-3.162a3 3 0 0 1-1.311-1.311C6.28 2 7.12 2 8.8 2h3.212c.733 0 1.1 0 1.446.083.306.073.598.195.867.36.303.185.562.444 1.08.963l3.19 3.188c.518.519.777.778.963 1.081a3 3 0 0 1 .36.867c.082.346.082.712.082 1.446"/></svg>',
        onTrigger: (props) => {
            currentEditor = props.editor;
            currentRange = props.range;
        },
        onSelect: (props: CommandSelectProps) => {
            currentEditor = props.editor as Editor;
            currentRange = props.range;

            const rect = getAnchorClientRect(props.editor as Editor, props.range);

            (props.editor as Editor).chain().focus().deleteRange(props.range).run();

            if (rect) {
                showDocumentSuggestionPopup(rect);
            }

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

    const docs = get(documentsStore);
    popupItems = docs.map((doc: DocumentSummary) => ({
        id: doc.id,
        title: doc.title,
        icon: '📄'
    }));

    popupSelectedIndexStore = writable(0);

    documentPopupComponent = mount(SlashSuggestionPopup, {
        target: documentPopup,
        props: {
            items: popupItems,
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
        .filter((doc: DocumentSummary) => doc.title.toLowerCase().includes(normalizedQuery))
        .map((doc: DocumentSummary) => ({
            id: doc.id,
            title: doc.title,
            icon: '📄'
        }));
}
import { invoke } from '@tauri-apps/api/core';
import type { Editor, Range } from '@tiptap/core';
import { commandRegistry, type SlashCommand, type CommandSelectProps } from '../CommandRegistry';
import SlashSuggestionPopup from '../../components/SlashSuggestionPopup.svelte';
import { mount } from 'svelte';
import { get } from 'svelte/store';
import { documents as documentsStore } from '../../stores/app';
import type { Document } from '../../types';
import { exitSuggestion } from '@tiptap/suggestion';

interface SvelteComponentInstance {
    $set?: (props: Record<string, unknown>) => void;
    $on?: (type: string, callback: (e: any) => void) => () => void;
    $destroy?: () => void;
}

interface DocumentSuggestionItem {
    id: string;
    title: string;
    icon?: string;
    description?: string;
}

let currentEditor: Editor | null = null;
let currentRange: Range | null = null;
let documentPopupComponent: SvelteComponentInstance | null = null;
let documentPopup: HTMLElement | null = null;
let keydownHandler: ((e: KeyboardEvent) => void) | null = null;
let clickOutsideHandler: ((e: MouseEvent) => void) | null = null;

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

            const rect = getAnchorClientRect(props.editor as Editor, props.range);
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

    // Escape key closes the document popup
    keydownHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeDocumentPopup();
        }
    };
    document.addEventListener('keydown', keydownHandler);

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

    let selectedIndex = 0;
    let items: DocumentSuggestionItem[] = [];

    const docs = get(documentsStore);
    items = docs.map((doc: Document) => ({
        id: doc.id,
        title: doc.title,
        icon: '📄'
    }));

    documentPopupComponent = mount(SlashSuggestionPopup, {
        target: documentPopup,
        props: {
            items,
            selectedIndex,
            command: handleDocumentSelect,
            onClose: closeDocumentPopup
        }
    }) as any;
}

function handleDocumentSelect(item: DocumentSuggestionItem): void {
    if (currentEditor && currentRange) {
        currentEditor.chain()
            .focus()
            .deleteRange(currentRange)
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

import type { Editor } from '@tiptap/core';
import { get } from 'svelte/store';
import { exitSuggestion } from '@tiptap/suggestion';
import { commandRegistry, type SlashCommand, type CommandSelectProps } from '../CommandRegistry';
import { caretClientRect, closeAnyPicker, openPickerPopup } from '../pickerPopup';
import { documents as documentsStore, currentDocument } from '../../stores/app';
import type { DocumentSummary } from '../../types';

interface DocumentSuggestionItem {
    id: string;
    title: string;
    icon?: string;
    description?: string;
}

const DOCUMENT_ICON =
    '<svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2.27V6.4c0 .56 0 .84.109 1.054a1 1 0 0 0 .437.437c.214.11.494.11 1.054.11h4.13M14 17H8m8-4H8m12-3.012V17.2c0 1.68 0 2.52-.327 3.162a3 3 0 0 1-1.311 1.311C17.72 22 16.88 22 15.2 22H8.8c-1.68 0-2.52 0-3.162-.327a3 3 0 0 1-1.311-1.311C4 19.72 4 18.88 4 17.2V6.8c0-1.68 0-2.52.327-3.162a3 3 0 0 1-1.311-1.311C6.28 2 7.12 2 8.8 2h3.212c.733 0 1.1 0 1.446.083.306.073.598.195.867.36.303.185.562.444 1.08.963l3.19 3.188c.518.519.777.778.963 1.081a3 3 0 0 1 .36.867c.082.346.082.712.082 1.446"/></svg>';

// The editor the open picker will insert into, and the rows it is showing, for
// the same reason the tag picker keeps them: the popup is mounted outside the
// editor and hands back nothing but a row id. Both are dropped when the picker
// closes.
let currentEditor: Editor | null = null;
let visible: DocumentSuggestionItem[] = [];

export function registerDocumentLinkCommand(): void {
    const command: SlashCommand = {
        id: 'document',
        label: 'Link Document',
        icon: DOCUMENT_ICON,
        onSelect: (props: CommandSelectProps) => {
            const editor = props.editor as Editor;
            const rect = caretClientRect(editor, props.range);

            editor.chain().focus().deleteRange(props.range).run();

            if (rect) showDocumentSuggestionPopup(editor, rect);

            exitSuggestion(editor.view);
        },
    };

    commandRegistry.register(command);
}

function showDocumentSuggestionPopup(editor: Editor, rect: DOMRect): void {
    // Before the editor is assigned, never after: opening closes any previous
    // popup, and closing forgets the editor, so an assignment before this line
    // was wiped by the very call that was meant to use it.
    closeAnyPicker();
    currentEditor = editor;

    openPickerPopup({
        className: 'document-suggestion-popup',
        rect,
        items: (query) => {
            visible = searchDocuments(query);
            return visible.map((item) => ({
                id: item.id,
                title: item.title,
                // The constant `searchDocuments` attaches, not the command's
                // own icon: the popup renders it as html, so it must never be
                // anything a document could have put there.
                icon: item.icon,
            }));
        },
        onSelect: insertDocumentLink,
        onClose: () => {
            currentEditor = null;
            visible = [];
        },
    });
}

function insertDocumentLink(id: string): void {
    const item = visible.find((candidate) => candidate.id === id);
    // Both of these were a silent no-op, which is how choosing a document came
    // to do nothing at all and stay that way: the popup closed, no link was
    // inserted, and nothing anywhere said so.
    if (!item) {
        console.error(`[document-link] '${id}' is no longer in the list, nothing inserted`);
        return;
    }
    if (!currentEditor) {
        console.error('[document-link] no editor to insert into, the link was dropped');
        return;
    }

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

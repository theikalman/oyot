import Collaboration from '@tiptap/extension-collaboration';
import { ySyncPluginKey, yUndoPluginKey } from '@tiptap/y-tiptap';
import type { Plugin } from '@tiptap/pm/state';
import * as Y from 'yjs';
import { CONTENT_FIELD } from './contentField';
import { noteSyncPlugin, withNoteSelection } from './noteBinding/noteSync';

// The Yjs helpers EditorInstance needs. Loading a document's state now goes
// through `DocumentRepository.openDocument`, which registers the resulting
// Y.Doc as the open copy in the same queued step, so the sync layer can apply a
// peer's edit straight into it.

// Tiptap's own, with the binding that keeps what it cannot show (ADR 0044) in
// place of y-tiptap's, which deletes it.
const NoteCollaboration = Collaboration.extend({
    addProseMirrorPlugins() {
        const { document, field } = this.options;
        // Tiptap binds it, and leaves it out of this method's type.
        const { parent } = this as unknown as { parent: () => Plugin[] };
        return parent().map((plugin) => {
            switch (plugin.spec.key) {
                case ySyncPluginKey:
                    return noteSyncPlugin(document!.getXmlFragment(field), this.editor.schema);
                case yUndoPluginKey:
                    return withNoteSelection(plugin);
                default:
                    return plugin;
            }
        });
    },
});

export function createCollaborationExtension(ydoc: Y.Doc, fieldName: string = CONTENT_FIELD) {
    return NoteCollaboration.configure({
        document: ydoc,
        field: fieldName,
    });
}

import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { attachEmailFiles, isEmailFile } from '../commands/EmailCommand';

/**
 * Emails pasted into a note, or dropped on it where the page is given the
 * file: on a phone, or dragged from another page. A computer's drops from the
 * system never reach the page, and come by `attachDroppedEmails` instead.
 *
 * Only the emails among the files are taken. Anything else is left to the
 * other handlers, so a picture pasted beside an email still goes in as one.
 */
export const EmailFiles = Extension.create({
    name: 'emailFiles',

    addProseMirrorPlugins() {
        const editor = this.editor as Editor;
        return [
            new Plugin({
                key: new PluginKey('emailFiles'),
                props: {
                    handlePaste: (_view, event) => {
                        const emails = emailsIn(event.clipboardData);
                        if (emails.length === 0) return false;
                        event.preventDefault();
                        void attachEmailFiles(editor, emails);
                        return true;
                    },
                    handleDrop: (view, event) => {
                        const emails = emailsIn(event.dataTransfer);
                        if (emails.length === 0) return false;
                        event.preventDefault();
                        const at = view.posAtCoords({
                            left: event.clientX,
                            top: event.clientY,
                        })?.pos;
                        void attachEmailFiles(editor, emails, at);
                        return true;
                    },
                },
            }),
        ];
    },
});

function emailsIn(data: DataTransfer | null): File[] {
    return Array.from(data?.files ?? []).filter(isEmailFile);
}

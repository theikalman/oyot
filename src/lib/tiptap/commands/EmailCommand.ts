import { invoke } from '@tauri-apps/api/core';
import type { Editor } from '@tiptap/core';
import { exitSuggestion } from '@tiptap/suggestion';
import { commandRegistry, type SlashCommand, type CommandSelectProps } from '../CommandRegistry';
import { ATTACHMENT_SCHEME } from '../attachmentRef';
import { EMAIL_NODE_NAME } from '../nodes/EmailAttachmentNode';
import { toasts } from '$lib/services/toast';

/** What `pick_and_import_email` returns for an email it stored. */
export interface AttachedEmail {
    hash: string;
    subject: string | null;
    from: string | null;
    date: string | null;
}

const ENVELOPE_ICON =
    '<svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m2 7 8.165 5.715c.661.463.992.695 1.351.784a2 2 0 0 0 .968 0c.36-.09.69-.32 1.351-.784L22 7M6.8 20h10.4c1.68 0 2.52 0 3.162-.327a3 3 0 0 0 1.311-1.311C22 17.72 22 16.88 22 15.2V8.8c0-1.68 0-2.52-.327-3.162a3 3 0 0 0-1.311-1.311C19.72 4 18.88 4 17.2 4H6.8c-1.68 0-2.52 0-3.162.327a3 3 0 0 0-1.311 1.311C2 6.28 2 7.12 2 8.8v6.4c0 1.68 0 2.52.327 3.162a3 3 0 0 0 1.311 1.311C4.28 20 5.12 20 6.8 20"/></svg>';

export function registerEmailCommand(): void {
    const command: SlashCommand = {
        id: 'email',
        label: 'Attach Email',
        icon: ENVELOPE_ICON,
        onSelect: (props: CommandSelectProps) => {
            const editor = props.editor as Editor;
            exitSuggestion(editor.view);
            editor.chain().focus().deleteRange(props.range).run();
            void attachEmailFromFile(editor);
        },
    };
    commandRegistry.register(command);
}

export async function attachEmailFromFile(editor: Editor): Promise<void> {
    try {
        // Rust opens the dialog, reads the file, checks that it is an email
        // and stores it, so the picked path never crosses IPC. See
        // `pick_and_import_image` for why.
        const attached = await invoke<AttachedEmail | null>('pick_and_import_email');
        if (!attached) return; // cancelled
        editor.chain().focus().insertContent(emailNodeFor(attached)).run();
    } catch (error) {
        console.error('Failed to attach email:', error);
        toasts.error(typeof error === 'string' ? error : 'Failed to attach email');
    }
}

/** The node that holds an email in a note. */
export function emailNodeFor(email: AttachedEmail) {
    return {
        type: EMAIL_NODE_NAME,
        attrs: {
            src: `${ATTACHMENT_SCHEME}${email.hash}`,
            subject: email.subject,
            from: email.from,
            date: email.date,
        },
    };
}

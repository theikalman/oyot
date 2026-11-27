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
        insertEmails(editor, [attached]);
    } catch (error) {
        console.error('Failed to attach email:', error);
        toasts.error(typeof error === 'string' ? error : 'Failed to attach email');
    }
}

/** Whether a file the page was given is an email. */
export function isEmailFile(file: File): boolean {
    return file.type === 'message/rfc822' || /\.eml$/i.test(file.name);
}

/**
 * Attach emails the page holds as files: pasted, or dropped where the page
 * is given the file. Each goes to Rust as its bytes, which checks it as it
 * checks a picked one.
 */
export async function attachEmailFiles(editor: Editor, files: File[], at?: number): Promise<void> {
    const attached: AttachedEmail[] = [];
    for (const file of files) {
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            attached.push(await invoke<AttachedEmail>('save_email', bytes));
        } catch (error) {
            console.error('Failed to attach email:', error);
            toasts.error(
                `${file.name}: ${typeof error === 'string' ? error : 'could not attach it'}`,
            );
        }
    }
    insertEmails(editor, attached, at);
}

/** What Rust tells the page of emails dropped on the window. */
export interface EmailsDropped {
    token: string;
    count: number;
    x: number;
    y: number;
}

/**
 * Attach emails dropped on the window from the system, when they were
 * dropped on this editor while it can be written in. On a computer the page
 * never sees such a file: Rust holds its path until the page says where it
 * goes, by the token it was told.
 */
export async function attachDroppedEmails(editor: Editor, drop: EmailsDropped): Promise<void> {
    if (!editor.isEditable) return;
    const under = document.elementFromPoint(drop.x, drop.y);
    if (!under || !editor.view.dom.contains(under)) return;
    const at = editor.view.posAtCoords({ left: drop.x, top: drop.y })?.pos;
    try {
        const result = await invoke<{ emails: AttachedEmail[]; failed: string[] }>(
            'accept_dropped_emails',
            { token: drop.token },
        );
        insertEmails(editor, result.emails, at);
        for (const reason of result.failed) toasts.error(reason);
    } catch (error) {
        console.error('Failed to attach dropped emails:', error);
        toasts.error(typeof error === 'string' ? error : 'Failed to attach email');
    }
}

/** Put emails into a note, at `at` or where the caret is, one after another. */
export function insertEmails(editor: Editor, emails: AttachedEmail[], at?: number): void {
    if (emails.length === 0) return;
    const content = emails.flatMap((email, i) =>
        i === 0 ? [emailNodeFor(email)] : [{ type: 'text', text: ' ' }, emailNodeFor(email)],
    );
    const chain = editor.chain().focus();
    if (at === undefined) chain.insertContent(content).run();
    else chain.insertContentAt(at, content).run();
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

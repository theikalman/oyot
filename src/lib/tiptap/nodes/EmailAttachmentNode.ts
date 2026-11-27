import { Node, mergeAttributes } from '@tiptap/core';
import { textOf } from '../attrValues';
import { attachmentHash } from '../attachmentRef';

/**
 * An email held in a note: a chip on the line, like a linked note's.
 *
 * The note holds `oyot-attachment://<hash>` and the headers the chip shows,
 * read from the email when it was attached. The email itself is in the
 * attachment store, synced like an image, and read by Rust when it is opened
 * (docs/plans/email-attachments.md).
 */
export const EMAIL_NODE_NAME = 'emailAttachment';

/** Dispatched from a chip that was clicked, for the editor to open the email. */
export const EMAIL_VIEW_EVENT = 'oyot-email-view';

export interface EmailViewRequest {
    hash: string;
    subject: string | null;
}

/** What a chip says when the email has no subject. */
export const NO_SUBJECT = '(no subject)';

const ENVELOPE_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m2 7 8.165 5.715c.661.463.992.695 1.351.784a2 2 0 0 0 .968 0c.36-.09.69-.32 1.351-.784L22 7M6.8 20h10.4c1.68 0 2.52 0 3.162-.327a3 3 0 0 0 1.311-1.311C22 17.72 22 16.88 22 15.2V8.8c0-1.68 0-2.52-.327-3.162a3 3 0 0 0-1.311-1.311C19.72 4 18.88 4 17.2 4H6.8c-1.68 0-2.52 0-3.162.327a3 3 0 0 0-1.311 1.311C2 6.28 2 7.12 2 8.8v6.4c0 1.68 0 2.52.327 3.162a3 3 0 0 0 1.311 1.311C4.28 20 5.12 20 6.8 20"/></svg>';

/** The sender and the date, for the chip's tooltip. */
export function emailTooltip(from: string | null, date: string | null): string {
    const when = date ? new Date(date) : null;
    const shown = when && !Number.isNaN(when.getTime()) ? when.toLocaleString() : null;
    return [from, shown].filter(Boolean).join('\n');
}

function dataAttribute(name: string) {
    return {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute(`data-${name}`),
        renderHTML: (attributes: Record<string, unknown>) => {
            const value = textOf(attributes[name]);
            return value ? { [`data-${name}`]: value } : {};
        },
    };
}

export const EmailAttachmentNode = Node.create({
    name: EMAIL_NODE_NAME,

    group: 'inline',

    inline: true,

    atom: true,

    addAttributes() {
        return {
            src: dataAttribute('src'),
            subject: dataAttribute('subject'),
            from: dataAttribute('from'),
            date: dataAttribute('date'),
        };
    },

    parseHTML() {
        return [{ tag: 'span[data-type="email-attachment"]' }];
    },

    renderHTML({ node, HTMLAttributes }) {
        return [
            'span',
            mergeAttributes(HTMLAttributes, {
                'data-type': 'email-attachment',
                class: 'email-attachment',
            }),
            textOf(node.attrs.subject) || NO_SUBJECT,
        ];
    },

    renderText({ node }) {
        return textOf(node.attrs.subject) || NO_SUBJECT;
    },

    addNodeView() {
        return ({ node }) => {
            const hash = attachmentHash(node.attrs.src);
            const subject = textOf(node.attrs.subject);

            const dom = document.createElement('span');
            dom.setAttribute('data-type', 'email-attachment');
            dom.className = 'email-attachment';
            dom.title = emailTooltip(textOf(node.attrs.from), textOf(node.attrs.date));

            const icon = document.createElement('span');
            icon.className = 'email-attachment-icon';
            // A constant, never anything the note holds.
            icon.innerHTML = ENVELOPE_ICON;

            const title = document.createElement('span');
            title.className = 'email-attachment-title';
            title.textContent = subject || NO_SUBJECT;

            dom.append(icon, title);

            dom.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!hash) return;
                dom.dispatchEvent(
                    new CustomEvent<EmailViewRequest>(EMAIL_VIEW_EVENT, {
                        bubbles: true,
                        detail: { hash, subject },
                    }),
                );
            });

            return { dom };
        };
    },
});

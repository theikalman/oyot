import { describe, it, expect } from 'vitest';
import { contentSchema } from '$lib/editor/headlessIndex';
import { extractDocumentIndex } from '$lib/editor/documentIndex';
import { serializeDocument } from '$lib/export/markdown';
import { emailHashOf, readMarkdown } from '$lib/import/markdown';
import { renderNote } from '$lib/mcp/noteMarkdown';
import { planEdit } from '$lib/mcp/planEdit';
import { ctx, doc, p, t } from '$lib/mcp/testDocs';
import { emailNodeFor, isEmailFile } from './commands/EmailCommand';
import { EMAIL_NODE_NAME, emailTooltip } from './nodes/EmailAttachmentNode';

const HASH = 'e'.repeat(64);

const email = (subject: string | null = 'Quarterly report') =>
    emailNodeFor({
        hash: HASH,
        subject,
        from: 'Ana <ana@example.com>',
        date: '2026-11-03T09:12:00Z',
    });

const noFiles = { attachmentPath: () => null, notePath: () => null };

function emailsIn(markdown: string) {
    const found: Record<string, unknown>[] = [];
    readMarkdown(markdown, contentSchema()).doc.descendants((node) => {
        if (node.type.name === EMAIL_NODE_NAME) found.push(node.attrs);
    });
    return found;
}

describe('an email in a note', () => {
    it('is in use, and found by its subject and sender', () => {
        const index = extractDocumentIndex(doc(p(t('See '), email())));
        expect(index.attachmentHashes).toEqual([HASH]);
        expect(index.text).toBe('See Quarterly report Ana <ana@example.com>');
    });

    it('is exported as a link to its file, named by its subject', () => {
        const note = doc(p(t('See '), email()));
        expect(
            serializeDocument(note, {
                ...noFiles,
                attachmentPath: (hash) => `../attachments/${hash}.eml`,
            }),
        ).toBe(`See [Quarterly report](../attachments/${HASH}.eml)\n`);
        expect(serializeDocument(note, noFiles)).toBe(
            `See [Quarterly report](oyot-attachment://${HASH})\n`,
        );
    });

    it('without a subject says so', () => {
        expect(serializeDocument(doc(p(email(null))), noFiles)).toBe(
            `[(no subject)](oyot-attachment://${HASH})\n`,
        );
        expect(emailsIn(`[(no subject)](oyot-attachment://${HASH})`)[0].subject).toBeNull();
    });

    it('is read back as an email from either address', () => {
        for (const href of [`oyot-attachment://${HASH}`, `../attachments/${HASH}.eml`]) {
            expect(emailsIn(`See [Quarterly report](${href})`)).toEqual([
                {
                    src: `oyot-attachment://${HASH}`,
                    subject: 'Quarterly report',
                    from: null,
                    date: null,
                },
            ]);
        }
    });

    it('is not made of a link to anything else', () => {
        expect(emailHashOf('https://example.com/attachments/x.eml')).toBeNull();
        expect(emailHashOf(`../attachments/${HASH}.png`)).toBeNull();
        expect(emailHashOf(`oyot-attachment://${HASH.slice(1)}`)).toBeNull();
        expect(emailsIn('[a page](https://example.com)')).toEqual([]);
    });

    // An assistant's edit is a rewrite of the note's Markdown, which has only
    // the subject in it.
    it('keeps its sender and date through an edit by an assistant', () => {
        const note = doc(p(t('one')), p(t('See '), email()));
        const markdown = renderNote(note).markdown.replace('See', 'Read');
        const plan = planEdit(note, markdown, ctx);

        const found: Record<string, unknown>[] = [];
        plan.root.descendants((node) => {
            if (node.type.name === EMAIL_NODE_NAME) found.push(node.attrs);
        });
        expect(found).toEqual([email().attrs]);
        expect(plan.lossy).toEqual([]);
    });

    it("has its sender and date as the chip's tooltip", () => {
        const tooltip = emailTooltip('Ana <ana@example.com>', '2026-11-03T09:12:00Z');
        expect(tooltip.split('\n')).toHaveLength(2);
        expect(tooltip.startsWith('Ana <ana@example.com>\n')).toBe(true);
        expect(emailTooltip(null, 'not a date')).toBe('');
    });

    it('is told from other files by its name or its type', () => {
        expect(isEmailFile(new File([''], 'Report.EML'))).toBe(true);
        expect(isEmailFile(new File([''], 'saved', { type: 'message/rfc822' }))).toBe(true);
        expect(isEmailFile(new File([''], 'report.eml.txt'))).toBe(false);
        expect(isEmailFile(new File([''], 'photo.png', { type: 'image/png' }))).toBe(false);
    });
});

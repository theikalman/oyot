import { describe, it, expect } from 'vitest';
import { fileSize, headerLines, sentAt, type EmailView } from './view';

const view = (over: Partial<EmailView> = {}): EmailView => ({
    subject: 'Report',
    from: 'Ana <ana@example.com>',
    to: ['Bo <bo@example.com>', 'cy@example.com'],
    cc: [],
    date: '2026-11-03T09:12:00Z',
    html: null,
    text: 'Hello',
    parts: [],
    ...over,
});

describe('the email preview', () => {
    it('says a size as a file manager does', () => {
        expect(fileSize(0)).toBe('0 B');
        expect(fileSize(1023)).toBe('1023 B');
        expect(fileSize(1536)).toBe('1.5 KB');
        expect(fileSize(200 * 1024)).toBe('200 KB');
        expect(fileSize(27 * 1024 * 1024)).toBe('27 MB');
    });

    it('shows the headers an email has, in order', () => {
        expect(headerLines(view()).map((line) => line.label)).toEqual(['From', 'To', 'Date']);
        expect(headerLines(view()).find((line) => line.label === 'To')?.value).toBe(
            'Bo <bo@example.com>, cy@example.com',
        );
        expect(
            headerLines(view({ from: null, to: [], cc: ['di@example.com'], date: null })),
        ).toEqual([{ label: 'Cc', value: 'di@example.com' }]);
    });

    it('leaves out a date that is not one', () => {
        expect(sentAt('not a date')).toBeNull();
        expect(sentAt(null)).toBeNull();
        expect(sentAt('2026-11-03T09:12:00Z')).toContain('2026');
    });
});

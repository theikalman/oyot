/**
 * An email as the preview shows it: what `read_email` returns, and the
 * wording the page puts on it. Pure, so it is tested without Tauri.
 */

export interface EmailPart {
    /** Where it is among the email's attachments, to ask for it by. */
    index: number;
    name: string;
    mime: string;
    size: number;
}

export interface EmailView {
    subject: string | null;
    from: string | null;
    to: string[];
    cc: string[];
    /** RFC 3339. */
    date: string | null;
    /** The email's own HTML, hostile, shown only in a sandboxed frame. */
    html: string | null;
    text: string | null;
    parts: EmailPart[];
}

/** A size the way a file manager says one. */
export function fileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** When an email was sent, in the user's own format, or null for no date. */
export function sentAt(date: string | null): string | null {
    if (!date) return null;
    const when = new Date(date);
    if (Number.isNaN(when.getTime())) return null;
    return when.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' });
}

/** The header lines the preview shows, in order, leaving out empty ones. */
export function headerLines(view: EmailView): { label: string; value: string }[] {
    const lines = [
        { label: 'From', value: view.from ?? '' },
        { label: 'To', value: view.to.join(', ') },
        { label: 'Cc', value: view.cc.join(', ') },
        { label: 'Date', value: sentAt(view.date) ?? '' },
    ];
    return lines.filter((line) => line.value !== '');
}

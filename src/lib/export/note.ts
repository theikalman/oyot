/**
 * One exported file: what the app knows about a note, then the note.
 *
 * The metadata goes in YAML front matter, which is what every Markdown tool
 * that reads metadata at all reads, and which a tool that does not is willing
 * to show as a block at the top. Without it an export loses the created date,
 * the tags and the document id, and the id is the only thing that could ever
 * match an exported file back to the note it came from.
 */

export interface NoteMetadata {
    id: string;
    title: string;
    /** 'journal' or 'note', as the document row spells it. */
    docType: string;
    createdAt: number;
    updatedAt: number;
    /** Normalized tag names, without their hashes. */
    tags: string[];
}

/**
 * A YAML scalar that means what it says.
 *
 * Every value here is quoted rather than quoted-when-necessary. A title of
 * `true`, `null`, `2026-09-22` or `- item` is a different type in YAML than it
 * is in Oyot, and deciding which titles need quoting is a longer list of rules
 * than quoting all of them.
 */
function yamlString(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
}

/** An epoch milliseconds stamp as an ISO 8601 instant, or nothing if it is not one. */
function isoDate(ms: number): string | null {
    if (!Number.isFinite(ms)) return null;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
}

export function renderNote(meta: NoteMetadata, body: string): string {
    const lines = ['---', `id: ${yamlString(meta.id)}`, `title: ${yamlString(meta.title)}`];
    lines.push(`type: ${yamlString(meta.docType)}`);

    const created = isoDate(meta.createdAt);
    if (created) lines.push(`created: ${yamlString(created)}`);
    const updated = isoDate(meta.updatedAt);
    if (updated) lines.push(`updated: ${yamlString(updated)}`);

    if (meta.tags.length > 0) {
        lines.push(`tags: [${meta.tags.map(yamlString).join(', ')}]`);
    }
    lines.push('---', '');

    // The title again, as a heading. Front matter is metadata, and a reader
    // with a plain Markdown viewer should still see what the note is called.
    lines.push(`# ${meta.title || 'Untitled'}`, '');

    const trimmed = body.trim();
    // The blank line after the heading is what keeps the first block of the
    // note from being read as part of it.
    return trimmed ? `${lines.join('\n')}\n${trimmed}\n` : lines.join('\n');
}

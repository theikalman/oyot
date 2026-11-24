// What stands in the editor for content this build cannot show.
//
// Devices run different builds, so a note can hold a block, a chip or
// formatting that only a newer build knows, and a paired device is free to
// store anything at all. Such content is never put in the editor's document,
// which has no node for it. A placeholder is, and the content itself stays in
// the Y.Doc (see `$lib/editor/noteBinding`).
//
// Pure, and free of Tiptap and Yjs: the index, the export and the MCP renderer
// all read placeholders, and run where there is no editor.

import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

/** Stands for something among blocks. */
export const UNKNOWN_BLOCK = 'unknownBlock';
/** Stands for something in a line of writing. */
export const UNKNOWN_INLINE = 'unknownInline';
/** Formatting on words, carried as it is stored. */
export const UNKNOWN_MARK = 'unknownMark';

/** What a placeholder says it is, to whoever reads the note. */
export const UNKNOWN_LABEL = 'This version of Oyot cannot show this part. It is kept as it is.';

/** What content that cannot be shown holds, as far as an index is concerned. */
export interface UnknownFindings {
    linkTargets: string[];
    tags: string[];
    attachmentHashes: string[];
}

/** Whether a type by this name is one of the placeholders. */
export function isUnknownName(name: string): boolean {
    return name === UNKNOWN_BLOCK || name === UNKNOWN_INLINE;
}

/** Whether a node stands for content this build cannot show. */
export function isUnknown(node: ProseMirrorNode): boolean {
    return isUnknownName(node.type.name);
}

/** The words in what a placeholder stands for, a line to each block of them. */
export function unknownText(node: ProseMirrorNode): string {
    return typeof node.attrs.text === 'string' ? node.attrs.text : '';
}

/** The same words on one line. */
export function unknownLine(node: ProseMirrorNode): string {
    return unknownText(node).replace(/\s+/g, ' ').trim();
}

// Held as text, so that a placeholder's attributes are all of the one type.

export function writeFindings(found: UnknownFindings): string {
    const { linkTargets, tags, attachmentHashes } = found;
    if (linkTargets.length + tags.length + attachmentHashes.length === 0) return '';
    return JSON.stringify({ linkTargets, tags, attachmentHashes });
}

export function readFindings(node: ProseMirrorNode): UnknownFindings {
    const none: UnknownFindings = { linkTargets: [], tags: [], attachmentHashes: [] };
    if (typeof node.attrs.found !== 'string' || !node.attrs.found) return none;
    try {
        return { ...none, ...(JSON.parse(node.attrs.found) as Partial<UnknownFindings>) };
    } catch {
        return none;
    }
}

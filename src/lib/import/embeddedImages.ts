import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { ATTACHMENT_SCHEME } from '$lib/tiptap/attachmentRef';

/**
 * The pictures inside a file, made into attachments.
 *
 * An HTML file saved as a single one carries its pictures in its text, as
 * base64. Left there, each would be in the note's CRDT for good and be sent
 * whole with every state of it, which is what attachments exist to avoid
 * (ADR 0005). So each is stored as one pasted into the editor is.
 */

/** Store a picture, and say what it is known by. */
export type SaveImage = (base64: string, mimeType: string) => Promise<string>;

/**
 * A `src` that holds a picture an attachment can be, as a plain data URI, or
 * null. Tidied: a data URI can be broken over lines, and percent-encoded.
 */
export function embeddedRaster(src: string): string | null {
    if (!/^data:/i.test(src)) return null;
    // Found rather than matched, which stays cheap however long the rest is.
    const comma = src.indexOf(',');
    if (comma < 0) return null;
    const [type, ...parameters] = src.slice('data:'.length, comma).toLowerCase().split(';');
    const mime = type.trim() === 'image/jpg' ? 'image/jpeg' : type.trim();
    if (!/^image\/(png|jpeg|gif|webp)$/.test(mime)) return null;
    if (parameters.at(-1)?.trim() !== 'base64') return null;

    const data = src
        .slice(comma + 1)
        .replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\s+/g, '');
    return data ? `data:${mime};base64,${data}` : null;
}

/**
 * `doc` with every picture inside it stored, and how many could not be.
 *
 * One that cannot be stored, being too large or not the picture it says it
 * is, is replaced by its description. The same picture twice is stored once.
 */
export async function storeEmbedded(
    doc: ProseMirrorNode,
    save: SaveImage,
): Promise<{ doc: ProseMirrorNode; failed: number }> {
    const stored = new Map<string, string | null>();
    doc.descendants((node) => {
        const src = embeddedSrc(node);
        if (src) stored.set(src, null);
    });
    if (stored.size === 0) return { doc, failed: 0 };

    for (const src of stored.keys()) {
        const [header, data] = src.split(',');
        const mime = header.slice('data:'.length, header.indexOf(';'));
        try {
            stored.set(src, await save(data, mime));
        } catch (e) {
            console.warn('[import] could not store a picture:', e);
        }
    }

    let failed = 0;
    const replaced = (node: ProseMirrorNode): ProseMirrorNode => {
        const src = embeddedSrc(node);
        if (src) {
            const hash = stored.get(src);
            if (hash) {
                return node.type.create({
                    ...node.attrs,
                    src: `${ATTACHMENT_SCHEME}${hash}`,
                    alt: node.attrs.alt || `oyot:${hash}`,
                });
            }
            failed++;
            const { schema } = node.type;
            const alt = node.attrs.alt;
            return schema.nodes.paragraph.create(null, alt ? schema.text(alt) : null);
        }
        if (node.isLeaf) return node;
        const children: ProseMirrorNode[] = [];
        node.forEach((child) => children.push(replaced(child)));
        return node.copy(Fragment.fromArray(children));
    };
    return { doc: replaced(doc), failed };
}

function embeddedSrc(node: ProseMirrorNode): string | null {
    const src = node.type.name === 'image' ? node.attrs.src : null;
    return typeof src === 'string' && src.startsWith('data:') ? src : null;
}

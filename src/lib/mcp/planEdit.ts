import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { contentSchema } from '$lib/editor/headlessIndex';
import { parseNote, renderBlock, renderNote, type NoteContext } from './noteMarkdown';

/**
 * Turn an assistant's rewrite of a whole note into the smallest change to the
 * note (ADR 0037, decision 7).
 *
 * An assistant is given a note as Markdown and sends all of it back, changed.
 * Writing that back as a new document would replace every block in it, which
 * to a peer is "the whole note was rewritten": anything typed into it
 * meanwhile, anywhere, would be lost to the replacement, and whatever Markdown
 * cannot carry (an image's size, a table's column widths) would be lost from
 * every block, not only the ones that changed.
 *
 * So the two are compared block by block, each side rendered by the same
 * exporter, which makes spellings that mean the same thing (`*a*` and `_a_`,
 * a wrapped line and an unwrapped one) the same. A block that matches keeps
 * the node it was, untouched. What is left is a list of stretches to replace.
 *
 * Empty paragraphs, which a note uses as spacing and Markdown cannot say,
 * take no part in the comparison. The ones that stand next to a block that
 * stays, stay; the ones between two blocks that are replaced go with them.
 */

/** Replace the top-level blocks `[from, to)` of the note with `insert`. */
export interface EditHunk {
    from: number;
    to: number;
    insert: ProseMirrorNode[];
}

/** A block the edit would rewrite, and what rewriting it would lose. */
export interface LossyBlock {
    /** Its index among the note's top-level blocks. */
    index: number;
    /** It, as the assistant was shown it. */
    markdown: string;
    /** What it holds that its Markdown does not say, in words. */
    losses: string[];
}

export interface EditPlan {
    /** The note as it would be, every block that did not change the node it was. */
    root: ProseMirrorNode;
    /** The changes, in order, against the note's blocks as they are. Empty for no change. */
    hunks: EditHunk[];
    /** Blocks the edit replaces that would lose something by it. */
    lossy: LossyBlock[];
}

/**
 * Past this many blocks in the stretch between the edit's first and last
 * change, the stretch is replaced whole rather than compared: comparing costs
 * the product of the two lengths. Far past any note anyone has written.
 */
const MAX_COMPARED = 4_000_000;

export function planEdit(current: ProseMirrorNode, markdown: string, ctx: NoteContext): EditPlan {
    const rendered = renderNote(current);
    const parsed = parseNote(markdown, ctx, rendered.inlineImages);

    const oldBlocks = visible(rendered.blocks);
    const newNodes: ProseMirrorNode[] = [];
    const newBlocks: string[] = [];
    parsed.forEach((node) => {
        const md = renderBlock(node, rendered.inlineImages);
        if (md.trim().length === 0) return;
        newNodes.push(node);
        newBlocks.push(md);
    });

    const steps = align(
        oldBlocks.map((b) => b.markdown),
        newBlocks,
    );
    const hunks = toHunks(steps, oldBlocks, newNodes);
    keepOneBlock(current, hunks);

    const lossy: LossyBlock[] = [];
    for (const hunk of hunks) {
        if (hunk.insert.length === 0) continue;
        for (let i = hunk.from; i < hunk.to; i++) {
            const md = rendered.blocks[i];
            if (md.trim().length === 0) continue;
            const losses = lossesOf(current.child(i), md, ctx, rendered.inlineImages);
            if (losses.length > 0) lossy.push({ index: i, markdown: md, losses });
        }
    }

    return { root: applyHunks(current, hunks), hunks, lossy };
}

/** The blocks with something in them, and where each sits among all of them. */
function visible(blocks: string[]): { index: number; markdown: string }[] {
    const out: { index: number; markdown: string }[] = [];
    blocks.forEach((markdown, index) => {
        if (markdown.trim().length > 0) out.push({ index, markdown });
    });
    return out;
}

type Step = { op: 'keep'; old: number } | { op: 'drop'; old: number } | { op: 'add'; new: number };

/**
 * A shortest edit from `a` to `b`: the longest common subsequence, found on
 * what is left once the common start and end are taken off, which for an
 * edit is usually very little.
 */
function align(a: string[], b: string[]): Step[] {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }

    const steps: Step[] = [];
    for (let i = 0; i < start; i++) steps.push({ op: 'keep', old: i });
    steps.push(...alignMiddle(a, b, start, endA, endB));
    for (let i = endA; i < a.length; i++) steps.push({ op: 'keep', old: i });
    return steps;
}

function alignMiddle(a: string[], b: string[], start: number, endA: number, endB: number): Step[] {
    const n = endA - start;
    const m = endB - start;
    if (n * m > MAX_COMPARED) {
        return [
            ...Array.from({ length: n }, (_, i): Step => ({ op: 'drop', old: start + i })),
            ...Array.from({ length: m }, (_, j): Step => ({ op: 'add', new: start + j })),
        ];
    }

    // lengths[i * (m + 1) + j]: the longest common subsequence of a's middle
    // from i and b's middle from j.
    const width = m + 1;
    const lengths = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lengths[i * width + j] =
                a[start + i] === b[start + j]
                    ? lengths[(i + 1) * width + j + 1] + 1
                    : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
        }
    }

    const steps: Step[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[start + i] === b[start + j]) {
            steps.push({ op: 'keep', old: start + i });
            i++;
            j++;
        } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
            steps.push({ op: 'drop', old: start + i });
            i++;
        } else {
            steps.push({ op: 'add', new: start + j });
            j++;
        }
    }
    for (; i < n; i++) steps.push({ op: 'drop', old: start + i });
    for (; j < m; j++) steps.push({ op: 'add', new: start + j });
    return steps;
}

/**
 * Each run of steps between two kept blocks, as a change to the note's own
 * blocks. A run that drops blocks covers them and everything between them; a
 * run that only adds goes in straight after the block kept before it.
 */
function toHunks(
    steps: Step[],
    oldBlocks: { index: number }[],
    newNodes: ProseMirrorNode[],
): EditHunk[] {
    const hunks: EditHunk[] = [];
    let afterKept = 0;
    let dropped: number[] = [];
    let added: ProseMirrorNode[] = [];

    const flush = () => {
        if (dropped.length === 0 && added.length === 0) return;
        const from = dropped.length > 0 ? dropped[0] : afterKept;
        const to = dropped.length > 0 ? dropped[dropped.length - 1] + 1 : afterKept;
        hunks.push({ from, to, insert: added });
        dropped = [];
        added = [];
    };

    for (const step of steps) {
        if (step.op === 'keep') {
            flush();
            afterKept = oldBlocks[step.old].index + 1;
        } else if (step.op === 'drop') {
            dropped.push(oldBlocks[step.old].index);
        } else {
            added.push(newNodes[step.new]);
        }
    }
    flush();
    return hunks;
}

/**
 * A note always has a block, which is where the editor puts the caret. An
 * edit that would leave none gets an empty paragraph, put in its last hunk so
 * that the content gets it and not only the plan.
 */
function keepOneBlock(current: ProseMirrorNode, hunks: EditHunk[]): void {
    const left = hunks.reduce(
        (count, hunk) => count - (hunk.to - hunk.from) + hunk.insert.length,
        current.childCount,
    );
    if (left > 0 || hunks.length === 0) return;
    hunks[hunks.length - 1].insert.push(contentSchema().nodes.paragraph.create());
}

function applyHunks(current: ProseMirrorNode, hunks: EditHunk[]): ProseMirrorNode {
    const children: ProseMirrorNode[] = [];
    current.forEach((child) => children.push(child));
    for (const hunk of [...hunks].reverse()) {
        children.splice(hunk.from, hunk.to - hunk.from, ...hunk.insert);
    }
    const schema = contentSchema();
    const root = schema.topNodeType.create(current.attrs, Fragment.from(children));
    root.check();
    return root;
}

/**
 * What a block holds that its Markdown does not say. Nothing when the block
 * read back from its own Markdown is the block itself.
 */
function lossesOf(
    node: ProseMirrorNode,
    markdown: string,
    ctx: NoteContext,
    inlineImages: ReadonlyMap<string, string>,
): string[] {
    const back = parseNote(markdown, ctx, inlineImages);
    if (back.childCount === 1 && back.firstChild!.eq(node)) return [];

    const losses = new Set<string>();
    node.descendants((child, _pos, parent) => {
        const name = child.type.name;
        if (name === 'image' && (child.attrs.width || child.attrs.height)) {
            losses.add("an image's size");
        }
        if ((name === 'tableCell' || name === 'tableHeader') && child.attrs.colwidth) {
            losses.add("a table's column widths");
        }
        if ((name === 'tableCell' || name === 'tableHeader') && child.childCount > 1) {
            losses.add('more than one paragraph in a table cell');
        }
        if (name === 'tableRow' && parent?.firstChild === child) {
            let header = true;
            child.forEach((cell) => {
                if (cell.type.name !== 'tableHeader') header = false;
            });
            if (!header) losses.add('a table without a header row');
        }
        if (name === 'hardBreak' && parent?.type.name === 'heading') {
            losses.add('a line break in a heading');
        }
        if (name === 'tag' && child.marks.some((mark) => mark.type.name === 'underline')) {
            losses.add('underline on a tag');
        }
        return true;
    });
    if (node.type.name === 'image' && (node.attrs.width || node.attrs.height)) {
        losses.add("an image's size");
    }
    if (losses.size === 0) losses.add('formatting that Markdown cannot write');
    return [...losses];
}

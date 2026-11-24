import {
    Mark,
    type Attrs,
    type Node as ProseMirrorNode,
    type NodeType,
    type Schema,
} from '@tiptap/pm/model';

/**
 * What the Markdown reader and the HTML reader both do once they know what a
 * file says: fit it into the shapes the editor's schema allows.
 */

/** At least one block, where the schema requires one. */
export function nonEmpty(schema: Schema, blocks: ProseMirrorNode[]): ProseMirrorNode[] {
    return blocks.length > 0 ? blocks : [schema.nodes.paragraph.create()];
}

/**
 * A paragraph or a heading made of `pieces`, split wherever an image stands
 * in it.
 *
 * A file puts an image in a line of text, and the editor's image is a block
 * of its own, so a line with an image in it becomes the words before it, the
 * image, and the words after.
 */
export function textblocks(
    type: NodeType,
    attrs: Attrs | null,
    pieces: ProseMirrorNode[],
): ProseMirrorNode[] {
    if (!pieces.some((piece) => piece.isBlock)) return [type.create(attrs, pieces)];

    const out: ProseMirrorNode[] = [];
    let run: ProseMirrorNode[] = [];
    const endRun = () => {
        const words = trimmed(run);
        if (words.length > 0) out.push(type.create(attrs, words));
        run = [];
    };
    for (const piece of pieces) {
        if (!piece.isBlock) {
            run.push(piece);
            continue;
        }
        endRun();
        out.push(piece);
    }
    endRun();
    return out;
}

/** A run of inline nodes without the spaces and breaks at either end. */
export function trimmed(run: ProseMirrorNode[]): ProseMirrorNode[] {
    const nodes = [...run];
    // Trims the node at `index`, and says whether it went entirely, in
    // which case the next one in has to be looked at too.
    const trimAway = (index: number, side: 'start' | 'end'): boolean => {
        const node = nodes[index];
        if (node.type.name === 'hardBreak') {
            nodes.splice(index, 1);
            return true;
        }
        if (!node.isText) return false;
        const text = side === 'start' ? node.text!.trimStart() : node.text!.trimEnd();
        if (!text) {
            nodes.splice(index, 1);
            return true;
        }
        nodes[index] = node.type.schema.text(text, node.marks);
        return false;
    };
    while (nodes.length > 0 && trimAway(0, 'start'));
    while (nodes.length > 0 && trimAway(nodes.length - 1, 'end'));
    return nodes;
}

/** An item of a list in a file. */
export interface ListItem {
    /** Whether it is ticked, or null for one that is not a task. */
    checked: boolean | null;
    blocks: ProseMirrorNode[];
}

/**
 * A list, or several.
 *
 * A file's list can mix task items with plain ones, and the editor's cannot:
 * a task list holds only tasks. So a mixed list becomes a run of lists, one
 * per stretch of items of the same kind, in the same order. An ordered list
 * split that way keeps counting where it left off.
 *
 * `first` is the number an ordered list starts at, and null for bullets.
 */
export function lists(schema: Schema, items: ListItem[], first: number | null): ProseMirrorNode[] {
    const { nodes } = schema;
    const out: ProseMirrorNode[] = [];
    let number = first ?? 1;
    let start = number;
    let task = false;
    let run: ProseMirrorNode[] = [];
    const endRun = () => {
        if (run.length === 0) return;
        if (task) out.push(nodes.taskList.create(null, run));
        else if (first !== null) out.push(nodes.orderedList.create({ start }, run));
        else out.push(nodes.bulletList.create(null, run));
        run = [];
    };

    for (const { checked, blocks } of items) {
        if (run.length > 0 && (checked !== null) !== task) endRun();
        if (run.length === 0) {
            task = checked !== null;
            start = number;
        }
        const content = itemContent(schema, blocks);
        run.push(
            checked !== null
                ? nodes.taskItem.create({ checked }, content)
                : nodes.listItem.create(null, content),
        );
        number++;
    }
    endRun();
    return out;
}

/**
 * What a list item can hold: a paragraph first, then any blocks. An item
 * with nothing in it, or one that opens with a heading, a code block or an
 * image, gets an empty paragraph in front, which is where the editor puts
 * the caret in an item of its own.
 */
function itemContent(schema: Schema, blocks: ProseMirrorNode[]): ProseMirrorNode[] {
    const { paragraph } = schema.nodes;
    return blocks[0]?.type === paragraph ? blocks : [paragraph.create(), ...blocks];
}

/** The marks in force, as a set the schema accepts. */
export function markSet(active: readonly Mark[]): readonly Mark[] {
    let set: readonly Mark[] = Mark.none;
    for (const mark of active) set = mark.addToSet(set);
    return set;
}

/**
 * The marks for inline code.
 *
 * The schema's code mark excludes every other, so adding it drops the rest.
 * A link is the exception: its address is information and code's typeface is
 * not, so inside a link it is the code mark that goes.
 */
export function codeMarks(active: readonly Mark[], schema: Schema): readonly Mark[] {
    if (active.some((mark) => mark.type.name === 'link')) return markSet(active);
    return markSet([...active, schema.marks.code.create()]);
}

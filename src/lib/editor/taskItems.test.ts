import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { createContentExtensions } from './extensions';
import { extractDocumentIndex } from './documentIndex';
import { locateTaskItem, toggleTaskAt } from './taskItems';

// The editor's real schema, because this resolves positions in documents the
// editor produced.
const schema = getSchema(createContentExtensions());

const para = (text: string) => ({
    type: 'paragraph',
    content: text ? [{ type: 'text', text }] : [],
});
const task = (text: string, checked = false, children: unknown[] = []) => ({
    type: 'taskItem',
    attrs: { checked },
    content: [para(text), ...children],
});
const list = (...items: unknown[]) => ({ type: 'taskList', content: items });
const doc = (...content: unknown[]) => schema.nodeFromJSON({ type: 'doc', content });

const flat = doc(para('intro'), list(task('buy milk'), task('call the bank'), task('pack')));
const nested = doc(list(task('plan the trip', false, [list(task('pick dates'))]), task('pack')));

describe('locateTaskItem', () => {
    it('finds the item an ordinal names', () => {
        const target = locateTaskItem(flat, 1);
        expect(target).not.toBeNull();
        expect(flat.nodeAt(target!.pos)?.textContent).toBe('call the bank');
    });

    it('finds the first item', () => {
        const target = locateTaskItem(flat, 0);
        expect(flat.nodeAt(target!.pos)?.textContent).toBe('buy milk');
    });

    // The whole point of the pairing: whatever the extractor numbered, this
    // has to find. A divergence would put the cursor on the wrong line and
    // look like nothing was wrong.
    it('agrees with the extractor about every item, nesting included', () => {
        for (const source of [flat, nested]) {
            const todos = extractDocumentIndex(source).todos;
            expect(todos.length).toBeGreaterThan(0);
            for (const todo of todos) {
                const target = locateTaskItem(source, todo.ordinal);
                expect(target, `ordinal ${todo.ordinal}`).not.toBeNull();
                const node = source.nodeAt(target!.pos);
                expect(node?.type.name).toBe('taskItem');
                expect(node?.firstChild?.textContent).toBe(todo.text);
            }
        }
    });

    it('has nothing to point at past the end of the list', () => {
        expect(locateTaskItem(flat, 3)).toBeNull();
        expect(locateTaskItem(doc(para('no tasks here')), 0)).toBeNull();
    });

    it('refuses an ordinal that is not one', () => {
        expect(locateTaskItem(flat, -1)).toBeNull();
        expect(locateTaskItem(flat, 1.5)).toBeNull();
    });

    // The cursor has to be somewhere a cursor can go, or dispatching the
    // selection throws and the note opens on an error instead of a line.
    it('gives a position a text selection accepts', () => {
        for (const source of [flat, nested]) {
            const todos = extractDocumentIndex(source).todos;
            for (const todo of todos) {
                const target = locateTaskItem(source, todo.ordinal)!;
                const selection = TextSelection.create(source, target.from, target.to);
                expect(selection.empty).toBe(true);
                expect(selection.$from.parent.type.name).toBe('paragraph');
            }
        }
    });

    it('puts the cursor after the words, not before them', () => {
        const target = locateTaskItem(flat, 0)!;
        const selection = TextSelection.create(flat, target.from, target.to);
        expect(selection.$from.parentOffset).toBe('buy milk'.length);
    });

    // An item with nothing in it yet still has a place to put the cursor,
    // which is exactly where someone clicking it wants to end up.
    it('can put the cursor in an empty item', () => {
        const empty = doc(list(task('')));
        const target = locateTaskItem(empty, 0)!;
        const selection = TextSelection.create(empty, target.from, target.to);
        expect(selection.$from.parent.textContent).toBe('');
    });
});

describe('toggleTaskAt', () => {
    const stateOf = (node: ReturnType<typeof doc>) => EditorState.create({ schema, doc: node });
    // Just inside the item, which is where a click on its box resolves to.
    const insideItem = (node: ReturnType<typeof doc>, ordinal: number) =>
        locateTaskItem(node, ordinal)!.pos + 1;
    const checkedOf = (node: ReturnType<typeof doc>) => {
        const states: boolean[] = [];
        node.descendants((child) => {
            if (child.type.name === 'taskItem') states.push(child.attrs.checked);
        });
        return states;
    };

    it('ticks the item the position is in, and only that one', () => {
        const state = stateOf(flat);

        const tr = toggleTaskAt(state, insideItem(flat, 1));

        expect(checkedOf(tr!.doc)).toEqual([false, true, false]);
    });

    it('unticks an item that was ticked', () => {
        const ticked = doc(list(task('buy milk', true)));

        const tr = toggleTaskAt(stateOf(ticked), insideItem(ticked, 0));

        expect(checkedOf(tr!.doc)).toEqual([false]);
    });

    // A sub-task sits inside its parent, so both contain the position. The
    // box clicked was the sub-task's.
    it('ticks a sub-task rather than the task around it', () => {
        const tr = toggleTaskAt(stateOf(nested), insideItem(nested, 1));

        expect(checkedOf(tr!.doc)).toEqual([false, true, false]);
    });

    it('works from anywhere in the item, its text included', () => {
        const state = stateOf(flat);
        const inText = insideItem(flat, 2) + 2;

        const tr = toggleTaskAt(state, inText);

        expect(checkedOf(tr!.doc)).toEqual([false, false, true]);
    });

    it('does nothing outside every task item', () => {
        expect(toggleTaskAt(stateOf(flat), 2)).toBeNull();
    });

    it('changes nothing but the tick', () => {
        const tr = toggleTaskAt(stateOf(flat), insideItem(flat, 0))!;

        expect(tr.doc.textContent).toBe(flat.textContent);
        expect(tr.doc.childCount).toBe(flat.childCount);
    });
});

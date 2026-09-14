import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { createContentExtensions } from './extensions';
import { extractDocumentIndex } from './documentIndex';
import { locateTaskItem } from './taskItems';

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

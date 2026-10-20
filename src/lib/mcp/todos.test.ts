import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { CONTENT_FIELD } from '$lib/editor/contentField';
import { extractDocumentIndex } from '$lib/editor/documentIndex';
import { rootFromYDoc } from '$lib/editor/headlessIndex';
import { taskElementAt, toggleTodoInDoc } from './todos';
import { doc, p, t, task, tasks, ydocOf } from './testDocs';

// The shapes taskItems.test.ts pins locateTaskItem to, and one nested deeper,
// with a task between two lists and one after a quote.
const flat = doc(p(t('intro')), tasks(task('buy milk'), task('call the bank'), task('pack')));
const nested = doc(tasks(task('plan the trip', false, [tasks(task('pick dates'))]), task('pack')));
const deep = doc(
    tasks(
        task('a', false, [tasks(task('a.1', true, [tasks(task('a.1.i'))]), task('a.2'))]),
        task('b'),
    ),
    { type: 'blockquote', content: [p(t('aside'))] },
    tasks(task('c', true)),
);

/** What a task element says, read off its first paragraph. */
function elementText(element: Y.XmlElement): string {
    const first = element.get(0) as Y.XmlElement;
    return first
        .toArray()
        .map((child) => (child instanceof Y.XmlText ? child.toString() : ''))
        .join('');
}

describe('taskElementAt', () => {
    it('finds the task the index numbered, at every ordinal and depth', () => {
        for (const source of [flat, nested, deep]) {
            const fragment = ydocOf(source).getXmlFragment(CONTENT_FIELD);
            const todos = extractDocumentIndex(source).todos;
            expect(todos.length).toBeGreaterThan(0);
            for (const todo of todos) {
                const element = taskElementAt(fragment, todo.ordinal);
                expect(element, `ordinal ${todo.ordinal}`).not.toBeNull();
                expect(elementText(element!)).toBe(todo.text);
            }
            expect(taskElementAt(fragment, todos.length)).toBeNull();
        }
    });

    it('finds nothing at an ordinal that is not one', () => {
        const fragment = ydocOf(flat).getXmlFragment(CONTENT_FIELD);
        for (const ordinal of [-1, 0.5, Number.NaN]) {
            expect(taskElementAt(fragment, ordinal)).toBeNull();
        }
    });
});

describe('toggleTodoInDoc', () => {
    const checkedOf = (ydoc: Y.Doc) =>
        extractDocumentIndex(rootFromYDoc(ydoc)).todos.map((todo) => todo.checked);

    it('ticks a task, and unticks it', () => {
        const ydoc = ydocOf(deep);
        expect(toggleTodoInDoc(ydoc, 2, 'a.1.i', true)).toBe('changed');
        expect(checkedOf(ydoc)).toEqual([false, true, true, false, false, true]);
        expect(toggleTodoInDoc(ydoc, 1, 'a.1', false)).toBe('changed');
        expect(checkedOf(ydoc)).toEqual([false, false, true, false, false, true]);
    });

    it('changes nothing for a task already as asked, so a retry cannot undo it', () => {
        const ydoc = ydocOf(deep);
        const before = Y.encodeStateAsUpdate(ydoc);
        expect(toggleTodoInDoc(ydoc, 5, 'c', true)).toBe('unchanged');
        expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
    });

    it('writes nothing when the ordinal no longer names that task', () => {
        const ydoc = ydocOf(flat);
        const before = Y.encodeStateAsUpdate(ydoc);
        expect(toggleTodoInDoc(ydoc, 0, 'call the bank', true)).toBe('moved');
        expect(toggleTodoInDoc(ydoc, 7, 'pack', true)).toBe('moved');
        expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
    });

    it('matches the text as the index writes it', () => {
        const ydoc = ydocOf(flat);
        expect(toggleTodoInDoc(ydoc, 1, '  call   the bank ', true)).toBe('changed');
    });

    it('keeps a tick and an edit to the same task made at once on two devices', () => {
        const a = ydocOf(flat);
        const b = new Y.Doc();
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

        expect(toggleTodoInDoc(a, 1, 'call the bank', true)).toBe('changed');
        const item = taskElementAt(b.getXmlFragment(CONTENT_FIELD), 1)!;
        ((item.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(13, ' today');

        Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
        for (const ydoc of [a, b]) {
            const todo = extractDocumentIndex(rootFromYDoc(ydoc)).todos[1];
            expect(todo).toMatchObject({ text: 'call the bank today', checked: true });
        }
    });
});

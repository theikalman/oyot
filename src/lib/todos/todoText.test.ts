import { describe, it, expect } from 'vitest';
import { todoSegments, type TodoSegment } from './todoText';

const text = (value: string): TodoSegment => ({ kind: 'text', text: value });
const tag = (name: string): TodoSegment => ({ kind: 'tag', name });

/** The segments put back together, the way the page reads them aloud. */
function spoken(segments: TodoSegment[]): string {
    return segments.map((s) => (s.kind === 'tag' ? `#${s.name}` : s.text)).join('');
}

describe('todoSegments', () => {
    it('leaves a todo with no hashes as it is', () => {
        expect(todoSegments('buy milk', ['urgent'])).toEqual([text('buy milk')]);
    });

    it('finds a tag the document carries', () => {
        expect(todoSegments('call mum #urgent', ['urgent'])).toEqual([
            text('call mum '),
            tag('urgent'),
        ]);
    });

    it('finds tags at the start, in the middle and side by side', () => {
        expect(todoSegments('#work plan #urgent#home', ['home', 'urgent', 'work'])).toEqual([
            tag('work'),
            text(' plan '),
            tag('urgent'),
            tag('home'),
        ]);
    });

    // A hash on its own is not a tag (ADR 0019): only a chip is, and every
    // chip in a todo is one of its document's tags.
    it("leaves a hash that spells none of the document's tags as words", () => {
        expect(todoSegments('fix issue #42 and #Urgent', ['urgent'])).toEqual([
            text('fix issue #42 and #Urgent'),
        ]);
    });

    it('draws nothing as a chip for a document with no tags', () => {
        expect(todoSegments('call mum #urgent', [])).toEqual([text('call mum #urgent')]);
    });

    it('reads the longest tag the text spells', () => {
        expect(todoSegments('#project x kickoff', ['project', 'project x'])).toEqual([
            tag('project x'),
            text(' kickoff'),
        ]);
    });

    it('does not cut a typed word short to make a chip of it', () => {
        expect(todoSegments('run the #workshop, #work-life, #work𝒳', ['work'])).toEqual([
            text('run the #workshop, #work-life, #work𝒳'),
        ]);
    });

    it('ends a tag at punctuation', () => {
        expect(todoSegments('ask #mum, #dad’s turn', ['dad', 'mum'])).toEqual([
            text('ask '),
            tag('mum'),
            text(', '),
            tag('dad'),
            text('’s turn'),
        ]);
    });

    it('has nothing to draw for no text', () => {
        expect(todoSegments('', ['urgent'])).toEqual([]);
    });

    // The chips change how a todo looks, never what it says.
    it('keeps every character of the text', () => {
        const tags = ['c#', 'project x', 'urgent', 'work'];
        for (const todo of [
            'learn #c# today',
            '#project x#urgent',
            'a # b ## c #',
            '#workshop and #work.',
            'emoji #urgent🎉 #work𝒳',
        ]) {
            expect(spoken(todoSegments(todo, tags))).toBe(todo);
        }
    });
});

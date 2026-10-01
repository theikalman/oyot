import { describe, it, expect } from 'vitest';
import { documentTypeFor, isScope, isTextScope, scopeInfo, SCOPES } from './scopes';

describe('the choices of what to search', () => {
    it('start with everything, then follow the Index', () => {
        expect(SCOPES.map((s) => s.label)).toEqual(['All', 'Notes', 'Journals', 'Todos', 'Tags']);
    });

    it('are each offered once', () => {
        const ids = SCOPES.map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('each say what they find and what to call a result', () => {
        for (const scope of SCOPES) {
            expect(scope.placeholder, scope.id).not.toBe('');
            expect(scope.hint, scope.id).not.toBe('');
            expect(scope.noun, scope.id).not.toBe('');
        }
    });

    it('are found by their id', () => {
        expect(scopeInfo('todos').label).toBe('Todos');
    });
});

describe('isScope', () => {
    it('knows every choice', () => {
        for (const scope of SCOPES) expect(isScope(scope.id)).toBe(true);
    });

    // What a search kept in the history says is read back from storage.
    it('refuses anything else', () => {
        for (const value of ['', 'everything', 'note', null, undefined, 3]) {
            expect(isScope(value)).toBe(false);
        }
    });
});

describe('the full-text choices', () => {
    it('are everything, notes and journals', () => {
        expect(SCOPES.filter((s) => isTextScope(s.id)).map((s) => s.id)).toEqual([
            'all',
            'notes',
            'journals',
        ]);
    });

    it('narrow the search to the kind of document they name', () => {
        expect(documentTypeFor('all')).toBeNull();
        expect(documentTypeFor('notes')).toBe('note');
        expect(documentTypeFor('journals')).toBe('journal');
    });
});

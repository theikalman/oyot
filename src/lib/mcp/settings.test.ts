import { describe, it, expect } from 'vitest';
import { launchLine } from './settings';

describe('launchLine', () => {
    it('quotes a path with a space in it, and nothing else', () => {
        expect(launchLine({ access: 'off', command: '/opt/oyot/oyot', args: ['--mcp'] })).toBe(
            '/opt/oyot/oyot --mcp',
        );
        expect(
            launchLine({
                access: 'off',
                command: 'C:\\Program Files\\Oyot\\oyot.exe',
                args: ['--mcp'],
            }),
        ).toBe('"C:\\\\Program Files\\\\Oyot\\\\oyot.exe" --mcp');
    });
});

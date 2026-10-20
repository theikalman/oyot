import { describe, it, expect } from 'vitest';
import { claudeCodeCommand, claudeDesktopConfig, connectedLine, launchLine } from './settings';

describe('launchLine', () => {
    it('quotes a path with a space in it, and nothing else', () => {
        expect(
            launchLine({ access: 'off', command: '/opt/oyot/oyot', args: ['--mcp'], clients: 0 }),
        ).toBe('/opt/oyot/oyot --mcp');
        expect(
            launchLine({
                access: 'off',
                command: 'C:\\Program Files\\Oyot\\oyot.exe',
                args: ['--mcp'],
                clients: 0,
            }),
        ).toBe('"C:\\\\Program Files\\\\Oyot\\\\oyot.exe" --mcp');
    });
});

const mac = {
    access: 'read_only' as const,
    command: '/Applications/Oyot.app/Contents/MacOS/oyot',
    args: ['--mcp'],
    clients: 0,
};

describe('setting up an assistant', () => {
    it('gives Claude Desktop a config naming this binary', () => {
        expect(JSON.parse(claudeDesktopConfig(mac))).toEqual({
            mcpServers: { oyot: { command: mac.command, args: ['--mcp'] } },
        });
    });

    it('gives Claude Code a command adding it for this user', () => {
        expect(claudeCodeCommand(mac)).toBe(
            'claude mcp add --scope user oyot -- /Applications/Oyot.app/Contents/MacOS/oyot --mcp',
        );
    });

    it('says how many are connected', () => {
        expect([0, 1, 2].map(connectedLine)).toEqual([
            'No assistant is connected',
            '1 assistant is connected',
            '2 assistants are connected',
        ]);
    });
});

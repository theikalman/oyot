// Letting AI assistants reach Oyot over MCP (ADR 0037).
//
// Rust holds the setting and serves the clients; the page only reads it and
// changes it, and shows what a client has to be told to launch.

import { invoke } from '@tauri-apps/api/core';

export type McpAccess = 'off' | 'read_only' | 'read_write';

export interface McpSettings {
    access: McpAccess;
    /** What a client launches: this app's binary, with `args`. */
    command: string;
    args: string[];
    /** Assistants connected now. */
    clients: number;
}

export function getMcpSettings(): Promise<McpSettings> {
    return invoke<McpSettings>('get_mcp_settings');
}

export function setMcpAccess(access: McpAccess): Promise<void> {
    return invoke<void>('set_mcp_access', { access });
}

/** The command a client is told to launch, quoted for a shell if it needs to be. */
export function launchLine(settings: McpSettings): string {
    const quote = (part: string) => (/[\s"'\\]/.test(part) ? JSON.stringify(part) : part);
    return [settings.command, ...settings.args].map(quote).join(' ');
}

/**
 * What goes in Claude Desktop's `claude_desktop_config.json`, which it opens
 * from Settings, Developer, Edit Config. Merged by hand into whatever servers
 * are there already, so it is the whole file only when there are none.
 */
export function claudeDesktopConfig(settings: McpSettings): string {
    return JSON.stringify(
        { mcpServers: { oyot: { command: settings.command, args: settings.args } } },
        null,
        2,
    );
}

/** The command that adds Oyot to Claude Code, for every project of this user. */
export function claudeCodeCommand(settings: McpSettings): string {
    return `claude mcp add --scope user oyot -- ${launchLine(settings)}`;
}

/** How many assistants are connected, in words. */
export function connectedLine(clients: number): string {
    if (clients === 0) return 'No assistant is connected';
    return clients === 1 ? '1 assistant is connected' : `${clients} assistants are connected`;
}

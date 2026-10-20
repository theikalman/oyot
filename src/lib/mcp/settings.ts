// Letting AI assistants reach Oyot over MCP (ADR 0037).
//
// Rust holds the setting and serves the clients; the page only reads it and
// changes it, and shows what a client has to be told to launch.

import { invoke } from '@tauri-apps/api/core';

export type McpAccess = 'off' | 'read_only';

export interface McpSettings {
    access: McpAccess;
    /** What a client launches: this app's binary, with `args`. */
    command: string;
    args: string[];
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

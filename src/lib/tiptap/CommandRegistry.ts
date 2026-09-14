import type { Editor } from '@tiptap/core';

export interface CommandSuggestion {
    id: string;
    title: string;
    icon: string;
    command: SlashCommand;
}

export interface SlashCommand {
    id: string;
    label: string;
    icon: string;
    onSelect: (props: CommandSelectProps) => void;
}

export interface CommandSelectProps {
    editor: Editor;
    range: { from: number; to: number };
    props?: Record<string, unknown>;
}

class CommandRegistry {
    private commands = new Map<string, SlashCommand>();

    register(command: SlashCommand): void {
        this.commands.set(command.id, command);
    }

    getCommand(id: string): SlashCommand | undefined {
        return this.commands.get(id);
    }

    getAllCommands(): SlashCommand[] {
        return Array.from(this.commands.values());
    }

    filterCommands(query: string): CommandSuggestion[] {
        const normalizedQuery = query.toLowerCase();
        return this.getAllCommands()
            .filter(
                (cmd) =>
                    cmd.id.toLowerCase().includes(normalizedQuery) ||
                    cmd.label.toLowerCase().includes(normalizedQuery),
            )
            .map((cmd) => ({
                id: cmd.id,
                title: cmd.label,
                icon: cmd.icon,
                command: cmd,
            }));
    }
}

export const commandRegistry = new CommandRegistry();

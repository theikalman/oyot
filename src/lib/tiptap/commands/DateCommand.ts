import type { Editor, Range } from '@tiptap/core';
import { commandRegistry, type SlashCommand, type CommandSelectProps } from '../CommandRegistry';

export function registerDateCommand(editor: Editor): void {
    const command: SlashCommand = {
        id: 'date',
        label: 'Insert Date',
        icon: '<svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10H3m13-8v4M8 2v4m2.5 8 1.5-1v5m-1.25 0h2.5M7.8 22h8.4c1.68 0 2.52 0 3.162-.327a3 3 0 0 0 1.311-1.311C21 19.72 21 18.88 21 17.2V8.8c0-1.68 0-2.52-.327-3.162a3 3 0 0 0-1.311-1.311C18.72 4 17.88 4 16.2 4H7.8c-1.68 0-2.52 0-3.162.327a3 3 0 0 0-1.311 1.311C3 6.28 3 7.12 3 8.8v8.4c0 1.68 0 2.52.327 3.162a3 3 0 0 0 1.311 1.311C5.28 22 6.12 22 7.8 22"/></svg>',
        onTrigger: () => {},
        onSelect: (props: CommandSelectProps) => {
            const editor = props.editor as Editor;
            const range = props.range;

            const now = new Date();
            const formattedDate = now.toLocaleDateString('en-US', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });

            editor.chain()
                .focus()
                .deleteRange(range)
                .insertContent(formattedDate)
                .run();
        }
    };

    commandRegistry.register(command);
}
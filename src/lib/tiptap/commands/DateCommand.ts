import type { Editor, Range } from '@tiptap/core';
import { commandRegistry, type SlashCommand, type CommandSelectProps } from '../CommandRegistry';

export function registerDateCommand(editor: Editor): void {
    const command: SlashCommand = {
        id: 'date',
        label: 'Insert Date',
        icon: '📅',
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
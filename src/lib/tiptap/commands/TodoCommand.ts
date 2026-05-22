import type { Editor } from '@tiptap/core';
import { commandRegistry, type SlashCommand, type CommandSelectProps } from '../CommandRegistry';

export function registerTodoCommand(editor: Editor): void {
    const command: SlashCommand = {
        id: 'todo',
        label: 'Insert Todo',
        icon: '<svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m7.5 12 3 3 6-6M7.8 21h8.4c1.68 0 2.52 0 3.162-.327a3 3 0 0 0 1.311-1.311C21 18.72 21 17.88 21 16.2V7.8c0-1.68 0-2.52-.327-3.162a3 3 0 0 0-1.311-1.311C18.72 3 17.88 3 16.2 3H7.8c-1.68 0-2.52 0-3.162.327a3 3 0 0 0-1.311 1.311C3 5.28 3 6.12 3 7.8v8.4c0 1.68 0 2.52.327 3.162a3 3 0 0 0 1.311 1.311C5.28 21 6.12 21 7.8 21"/></svg>',
        onTrigger: () => {},
        onSelect: (props: CommandSelectProps) => {
            const ed = props.editor as Editor;
            const range = props.range;

            ed.chain()
                .focus()
                .deleteRange(range)
                .insertContent({
                    type: 'taskItem',
                    attrs: {
                        checked: false
                    },
                    content: [
                        {
                            type: 'paragraph',
                            content: []
                        }
                    ]
                })
                .run();
        }
    };

    commandRegistry.register(command);
}
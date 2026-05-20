import type { Editor } from '@tiptap/core';
import { commandRegistry, type SlashCommand, type CommandSelectProps } from '../CommandRegistry';

export function registerTodoCommand(editor: Editor): void {
    const command: SlashCommand = {
        id: 'todo',
        label: 'Insert Todo',
        icon: '☑️',
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
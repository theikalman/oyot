import { Extension } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { insertImageFromBlob } from '../commands/ImageCommand';

const ImageExtensionPluginKey = new PluginKey('imageExtension');

export const ImageExtension = Extension.create({
    name: 'imageExtension',

    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: ImageExtensionPluginKey,
                props: {
                    handlePaste: (_view, event) => {
                        const items = event.clipboardData?.items;
                        if (!items) return false;

                        for (const item of Array.from(items)) {
                            if (item.type.startsWith('image/')) {
                                event.preventDefault();
                                const blob = item.getAsFile();
                                if (blob) {
                                    insertImageFromBlob(this.editor as Editor, blob);
                                }
                                return true;
                            }
                        }
                        return false;
                    },

                    handleDrop: (_view, event) => {
                        const files = event.dataTransfer?.files;
                        if (!files) return false;

                        for (const file of Array.from(files)) {
                            if (file.type.startsWith('image/')) {
                                event.preventDefault();
                                insertImageFromBlob(this.editor as Editor, file);
                                return true;
                            }
                        }
                        return false;
                    }
                }
            })
        ];
    }
});
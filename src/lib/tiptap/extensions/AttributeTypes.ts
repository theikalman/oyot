import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { fitSlice, tolerateAttributes } from '../attributeTypes';

/**
 * Fits what a note's nodes hold to the types their attributes have, so a bad
 * value pasted or synced cannot leave a note that does not open. See
 * `attributeTypes.ts`.
 *
 * The schema is a live editor's own, so it is done before the editor reads
 * anything against it. `contentSchema`, which has no editor, does it itself.
 */
export const AttributeTypes = Extension.create({
    name: 'attributeTypes',

    onBeforeCreate() {
        tolerateAttributes(this.editor.schema);
    },

    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: new PluginKey('attributeTypes'),
                // A drop comes through here as well.
                props: { transformPasted: (slice) => fitSlice(slice) },
            }),
        ];
    },
});

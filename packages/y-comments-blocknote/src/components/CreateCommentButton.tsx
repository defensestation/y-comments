import { useComponentsContext } from "@blocknote/react";
import { useCallback, useEffect, useState } from "react";
import { useComments } from "../context.js";
import { CommentIcon } from "./icons.js";

/**
 * Formatting-toolbar item (same export name as v1): opens the floating
 * composer for the current selection. Disabled when the selection is empty
 * or the store's auth denies thread creation.
 *
 * Render inside BlockNote's FormattingToolbar (it uses the components
 * context) and inside a CommentsProvider.
 */
export function CreateCommentButton() {
  const Components = useComponentsContext();
  const { editor, store, openComposer } = useComments();
  const [hasSelection, setHasSelection] = useState(false);

  useEffect(() => {
    const update = () => {
      try {
        setHasSelection(editor.getSelectedText().trim().length > 0);
      } catch {
        setHasSelection(false);
      }
    };
    update();
    return editor.onSelectionChange(update);
  }, [editor]);

  const onClick = useCallback(() => {
    openComposer();
    // close the formatting toolbar so the composer (which auto-focuses its
    // textarea) is the only thing in front of the selection
    try {
      const toolbar = editor.getExtension("formattingToolbar") as
        | { store?: { setState: (open: boolean) => void } }
        | undefined;
      toolbar?.store?.setState(false);
    } catch {
      // no formatting toolbar extension — nothing to close
    }
  }, [openComposer, editor]);

  if (!Components) {
    return null;
  }

  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      label="Add comment"
      mainTooltip="Add comment"
      icon={<CommentIcon />}
      isDisabled={!hasSelection || !store.auth.canCreateThread()}
      onClick={onClick}
    />
  );
}

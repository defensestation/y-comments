import { anchorFromRange } from "@defensestation/y-comments-prosemirror";
import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
} from "@floating-ui/react";
import type { EditorView } from "prosemirror-view";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useComments } from "../context.js";
import { OFFSCREEN_RECT } from "./floating-utils.js";

/**
 * Floating comment composer, positioned at the selection captured when
 * `openComposer()` was called (normally by CreateCommentButton).
 *
 * On submit: build a relative-position anchor from the selection, create the
 * thread in the store, select it. The document is never touched.
 */
export function FloatingComposer() {
  const { editor, store, docId, composer, closeComposer, selectThread } = useComments();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const { refs, floatingStyles, isPositioned } = useFloating({
    open: composer !== null,
    placement: "bottom",
    strategy: "fixed",
    middleware: [offset(8), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  // Anchor the popover to the selection's bounding box, recomputed live so
  // scrolling or reflow doesn't strand it (coordsAtPos is viewport-relative).
  useEffect(() => {
    if (composer === null) {
      return;
    }
    let view: EditorView;
    try {
      view = editor.prosemirrorView;
    } catch {
      return;
    }
    refs.setPositionReference({
      getBoundingClientRect: () => {
        try {
          const max = view.state.doc.content.size;
          const a = view.coordsAtPos(Math.min(composer.from, max));
          const b = view.coordsAtPos(Math.min(composer.to, max));
          const left = Math.min(a.left, b.left);
          const right = Math.max(a.right, b.right);
          const top = Math.min(a.top, b.top);
          const bottom = Math.max(a.bottom, b.bottom);
          return { x: left, y: top, left, right, top, bottom, width: right - left, height: bottom - top };
        } catch {
          return OFFSCREEN_RECT;
        }
      },
      contextElement: view.dom,
    });
  }, [composer, editor, refs]);

  useEffect(() => {
    setText("");
    setError(null);
  }, [composer]);

  // The popover mounts with visibility:hidden until floating-ui positions
  // it, and hidden elements refuse focus — so autoFocus never fires. Focus
  // once positioned; the rAF also lets BlockNote's post-click editor
  // refocus settle first.
  useEffect(() => {
    if (composer === null || !isPositioned) {
      return;
    }
    const raf = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [composer, isPositioned]);

  // Dismiss on outside pointer-down or Escape.
  useEffect(() => {
    if (composer === null) {
      return;
    }
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        closeComposer();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeComposer();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [composer, closeComposer]);

  const submit = useCallback(() => {
    if (composer === null) {
      return;
    }
    const body = text.trim();
    if (body.length === 0) {
      return;
    }
    let anchor;
    try {
      const view = editor.prosemirrorView;
      anchor = anchorFromRange(view.state, composer.from, composer.to);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setBusy(true);
    store
      .createThread({ docId, anchor, body: { text: body } })
      .then((thread) => {
        setBusy(false);
        closeComposer();
        selectThread(thread.id);
      })
      .catch((err) => {
        setBusy(false);
        setError(
          err instanceof Error
            ? `Couldn't create the comment: ${err.message}`
            : "Couldn't create the comment — check the connection and try again."
        );
      });
  }, [composer, text, editor, store, docId, closeComposer, selectThread]);

  const onSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      submit();
    },
    [submit]
  );

  // Enter posts the comment, Shift+Enter inserts a newline.
  const onTextareaKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        submit();
      }
    },
    [submit]
  );

  if (composer === null) {
    return null;
  }

  return (
    <div
      ref={(node) => {
        containerRef.current = node;
        refs.setFloating(node);
      }}
      style={{ ...floatingStyles, visibility: isPositioned ? undefined : "hidden" }}
      className="y-comments-floating y-comments-floating-composer"
      data-y-comments-composer
    >
      <form className="y-comments-composer" onSubmit={onSubmit}>
        <textarea
          ref={textareaRef}
          className="y-comments-input"
          placeholder="Add a comment…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onTextareaKeyDown}
          rows={2}
        />
        {error && (
          <div className="y-comments-error" role="alert">
            {error}
          </div>
        )}
        <div className="y-comments-composer-actions">
          <button type="button" className="y-comments-button" onClick={closeComposer}>
            Cancel
          </button>
          <button
            type="submit"
            className="y-comments-button y-comments-button-primary"
            disabled={text.trim().length === 0 || busy}
          >
            {busy ? "Saving…" : "Comment"}
          </button>
        </div>
      </form>
    </div>
  );
}

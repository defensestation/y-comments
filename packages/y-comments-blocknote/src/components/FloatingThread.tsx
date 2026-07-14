import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
} from "@floating-ui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useComments } from "../context.js";
import { OFFSCREEN_RECT } from "./floating-utils.js";
import { ThreadBody } from "./ThreadBody.js";

/**
 * Popover showing the full selected thread, anchored to its highlight span
 * in the editor. Renders only while a thread with a live highlight is
 * selected (sidebar-only threads — orphaned/container — expand in the
 * sidebar instead).
 *
 * The reference is virtual and re-queries the decoration span on every
 * position read: ProseMirror replaces the spans whenever decorations
 * rebuild, so holding a DOM node would leave the popover anchored to a
 * detached element whose rect is 0,0 — the "popover in the corner" bug.
 */
export function FloatingThread() {
  const { editor, threads, resolutions, selectedThreadId, selectThread } = useComments();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [spanExists, setSpanExists] = useState(false);

  const thread = useMemo(
    () => threads.find((t) => t.id === selectedThreadId) ?? null,
    [threads, selectedThreadId]
  );
  const resolution = thread ? resolutions.get(thread.id) : undefined;
  const hasHighlight =
    thread !== null &&
    !thread.resolved &&
    (resolution?.kind === "exact" || resolution?.kind === "reanchored");

  const { refs, floatingStyles, isPositioned } = useFloating({
    open: hasHighlight && spanExists,
    placement: "bottom-start",
    strategy: "fixed",
    middleware: [offset(6), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  // Virtual reference resolving the *current* span on every read; re-check
  // span existence whenever threads/resolutions change (decorations rebuild
  // replaces the spans).
  useEffect(() => {
    if (!hasHighlight || thread === null) {
      setSpanExists(false);
      return;
    }
    let viewDom: HTMLElement;
    try {
      viewDom = editor.prosemirrorView.dom;
    } catch {
      setSpanExists(false);
      return;
    }
    const selector = `[data-thread-id="${CSS.escape(thread.id)}"]`;
    setSpanExists(viewDom.querySelector(selector) !== null);
    refs.setPositionReference({
      getBoundingClientRect: () => {
        const span = viewDom.querySelector(selector);
        return span ? span.getBoundingClientRect() : OFFSCREEN_RECT;
      },
      contextElement: viewDom,
    });
  }, [hasHighlight, thread, resolutions, editor, refs]);

  // Dismiss on outside pointer-down (clicks on the highlight or inside the
  // popover keep it open) or Escape.
  useEffect(() => {
    if (!hasHighlight) {
      return;
    }
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) {
        return;
      }
      if (target instanceof Element && target.closest("[data-thread-id]")) {
        return; // highlight clicks are handled by the plugin
      }
      selectThread(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        selectThread(null);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [hasHighlight, selectThread]);

  if (!hasHighlight || thread === null || !spanExists) {
    return null;
  }

  return (
    <div
      ref={(node) => {
        containerRef.current = node;
        refs.setFloating(node);
      }}
      style={{ ...floatingStyles, visibility: isPositioned ? undefined : "hidden" }}
      className="y-comments-floating y-comments-floating-thread"
      data-y-comments-floating-thread
    >
      <ThreadBody thread={thread} />
    </div>
  );
}

import type { Thread } from "@defensestation/y-comments-core";
import { useMemo, useState } from "react";
import { useComments } from "../context.js";
import { ThreadBody } from "./ThreadBody.js";

export type ThreadsFilter = "open" | "resolved" | "all";

export interface ThreadsSidebarProps {
  /** Initial filter. The user can change it via the built-in control. */
  defaultFilter?: ThreadsFilter;
  className?: string;
}

const FILTERS: { value: ThreadsFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "all", label: "All" },
];

/**
 * All threads for the document, ordered by their resolved position in the
 * doc. Threads whose anchor no longer resolves to text (container/orphaned)
 * or that the store marked `outdated` are grouped last under "Outdated",
 * showing their stored quote — the GitHub outdated-review-comment pattern.
 */
export function ThreadsSidebar({ defaultFilter = "open", className }: ThreadsSidebarProps) {
  const { editor, threads, resolutions, selectedThreadId, selectThread } = useComments();
  const [filter, setFilter] = useState<ThreadsFilter>(defaultFilter);

  const { positioned, outdated } = useMemo(() => {
    const visible = threads.filter((t) =>
      filter === "all" ? true : filter === "resolved" ? t.resolved : !t.resolved
    );
    const positioned: { thread: Thread; at: number }[] = [];
    const outdated: Thread[] = [];
    for (const thread of visible) {
      const resolution = resolutions.get(thread.id);
      if (
        !thread.outdated &&
        (resolution?.kind === "exact" || resolution?.kind === "reanchored")
      ) {
        positioned.push({ thread, at: resolution.from.index });
      } else {
        outdated.push(thread);
      }
    }
    positioned.sort((a, b) => a.at - b.at);
    outdated.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { positioned, outdated };
  }, [threads, resolutions, filter]);

  const focusThread = (thread: Thread, scroll: boolean) => {
    selectThread(thread.id);
    if (!scroll) {
      return;
    }
    try {
      const span = editor.prosemirrorView.dom.querySelector(
        `[data-thread-id="${CSS.escape(thread.id)}"]`
      );
      if (span) {
        span.scrollIntoView({ behavior: "smooth", block: "center" });
        span.classList.add("y-comments-flash");
        setTimeout(() => span.classList.remove("y-comments-flash"), 1200);
      }
    } catch {
      // editor unmounted
    }
  };

  // Cards contain their own controls (reply box, resolve/delete buttons);
  // interacting with those must not re-select the thread or yank the editor
  // scroll position.
  const isInteractive = (target: EventTarget | null) =>
    target instanceof Element &&
    target.closest("button, textarea, input, a, [contenteditable]") !== null;

  const renderCard = (thread: Thread, scrollOnClick: boolean) => (
    <div
      key={thread.id}
      role="button"
      tabIndex={0}
      className={`y-comments-card${thread.id === selectedThreadId ? " y-comments-card-selected" : ""}`}
      data-thread-card={thread.id}
      onClick={(e) => {
        if (!isInteractive(e.target)) {
          focusThread(thread, scrollOnClick);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) {
          focusThread(thread, scrollOnClick);
        }
      }}
    >
      <ThreadBody thread={thread} showQuote />
    </div>
  );

  return (
    <aside className={`y-comments-sidebar${className ? ` ${className}` : ""}`}>
      <div className="y-comments-sidebar-header">
        <span className="y-comments-sidebar-title">Comments</span>
        <span className="y-comments-filter" role="tablist">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              role="tab"
              aria-selected={filter === f.value}
              className={`y-comments-filter-button${
                filter === f.value ? " y-comments-filter-button-active" : ""
              }`}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </span>
      </div>

      {positioned.length === 0 && outdated.length === 0 && (
        <div className="y-comments-empty">No comments</div>
      )}

      {positioned.map(({ thread }) => renderCard(thread, true))}

      {outdated.length > 0 && (
        <>
          <div className="y-comments-group-label">Outdated</div>
          {/* No scroll target — the commented text no longer exists. */}
          {outdated.map((thread) => renderCard(thread, false))}
        </>
      )}
    </aside>
  );
}

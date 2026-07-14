import {
  resolveThread,
  type Anchor,
  type Resolution,
  type Thread,
} from "@defensestation/y-comments-core";
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { anchorFromRange, BLOCK_SEPARATOR, LEAF_TEXT } from "./anchors.js";
import { createDocAdapter } from "./doc-adapter.js";

export const DEFAULT_HIGHLIGHT_CLASS = "y-comments-highlight";
export const DEFAULT_ACTIVE_CLASS = "y-comments-active";
export const DEFAULT_PENDING_CLASS = "y-comments-pending";
export const DEFAULT_DEBOUNCE_MS = 150;

export interface PendingRange {
  from: number;
  to: number;
}

export interface YCommentsState {
  threads: Thread[];
  /** Bumped on every setThreads, so the view can detect thread changes. */
  threadsVersion: number;
  resolutions: Map<string, Resolution>;
  selectedThreadId: string | null;
  /** Range currently being commented on (composer open) — highlighted so
   *  the author can still see what they selected while typing. */
  pendingRange: PendingRange | null;
  decorations: DecorationSet;
}

type YCommentsMeta =
  | { type: "setThreads"; threads: Thread[] }
  | { type: "setResolutions"; resolutions: Map<string, Resolution> }
  | { type: "selectThread"; threadId: string | null }
  | { type: "setPendingRange"; range: PendingRange | null };

export const yCommentsPluginKey = new PluginKey<YCommentsState>("yComments");

export interface YCommentsPluginOptions {
  /** Trailing debounce for full re-resolution after doc changes. Default 150 ms. */
  debounceMs?: number;
  /** Fired when a highlight is clicked (threadId) or the selection is cleared (null). */
  onThreadSelect?: (threadId: string | null) => void;
  /** Fired after every re-resolution pass with the fresh resolutions. */
  onResolutionsChange?: (resolutions: Map<string, Resolution>) => void;
  /**
   * After a `reanchored` resolution whose text still equals the stored
   * quote exactly, persist a fresh anchor via `store.updateAnchor`.
   * Off by default: it writes to the thread store on read, which surprises
   * audit logs and requires update permission on every reader.
   */
  selfHeal?: boolean;
  /** Store used for self-healing. Only `updateAnchor` is consulted. */
  store?: { updateAnchor?: (input: { threadId: string; anchor: Anchor }) => Promise<void> };
  highlightClass?: string;
  activeClass?: string;
  pendingClass?: string;
}

function buildDecorations(
  doc: PMNode,
  threads: Thread[],
  resolutions: Map<string, Resolution>,
  selectedThreadId: string | null,
  pendingRange: PendingRange | null,
  highlightClass: string,
  activeClass: string,
  pendingClass: string
): DecorationSet {
  const decorations: Decoration[] = [];
  if (pendingRange && pendingRange.from < pendingRange.to) {
    decorations.push(
      Decoration.inline(
        Math.max(0, pendingRange.from),
        Math.min(doc.content.size, pendingRange.to),
        { class: pendingClass }
      )
    );
  }
  for (const thread of threads) {
    // Resolved threads get no persistent highlight (parity with BlockNote);
    // container/orphaned threads render in the sidebar only.
    if (thread.resolved) {
      continue;
    }
    const resolution = resolutions.get(thread.id);
    if (!resolution || (resolution.kind !== "exact" && resolution.kind !== "reanchored")) {
      continue;
    }
    const from = Math.max(0, resolution.from.index);
    const to = Math.min(doc.content.size, resolution.to.index);
    if (from >= to) {
      continue;
    }
    const active = thread.id === selectedThreadId;
    decorations.push(
      Decoration.inline(from, to, {
        class: active ? `${highlightClass} ${activeClass}` : highlightClass,
        "data-thread-id": thread.id,
      })
    );
  }
  return DecorationSet.create(doc, decorations);
}

function resolutionsEqual(a: Map<string, Resolution>, b: Map<string, Resolution>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [id, ra] of a) {
    const rb = b.get(id);
    if (!rb || ra.kind !== rb.kind) {
      return false;
    }
    if (
      (ra.kind === "exact" || ra.kind === "reanchored") &&
      (rb.kind === "exact" || rb.kind === "reanchored") &&
      (ra.from.index !== rb.from.index || ra.to.index !== rb.to.index)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * View-only comment highlights: threads live in an external store, anchors
 * resolve through Yjs relative positions, and highlights render as inline
 * decorations. Nothing here ever writes to the document or the Y.Doc.
 *
 * Decorations are mapped through `tr.mapping` on every transaction (so they
 * track keystrokes instantly) and fully re-resolved on a trailing debounce
 * (so they stay correct after structural edits).
 */
export function yCommentsPlugin(options: YCommentsPluginOptions = {}): Plugin<YCommentsState> {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const highlightClass = options.highlightClass ?? DEFAULT_HIGHLIGHT_CLASS;
  const activeClass = options.activeClass ?? DEFAULT_ACTIVE_CLASS;
  const pendingClass = options.pendingClass ?? DEFAULT_PENDING_CLASS;

  const rebuild = (state: YCommentsState, doc: PMNode): DecorationSet =>
    buildDecorations(
      doc,
      state.threads,
      state.resolutions,
      state.selectedThreadId,
      state.pendingRange,
      highlightClass,
      activeClass,
      pendingClass
    );

  return new Plugin<YCommentsState>({
    key: yCommentsPluginKey,

    state: {
      init(): YCommentsState {
        return {
          threads: [],
          threadsVersion: 0,
          resolutions: new Map(),
          selectedThreadId: null,
          pendingRange: null,
          decorations: DecorationSet.empty,
        };
      },
      apply(tr, prev, _oldState, newState): YCommentsState {
        let next = prev;
        if (tr.docChanged) {
          // Map resolutions alongside the decorations: a meta rebuild (e.g.
          // a thread-store poll landing inside the debounce window) must
          // never rebuild from pre-edit positions.
          const mappedResolutions = new Map<string, Resolution>();
          for (const [id, res] of next.resolutions) {
            if (res.kind === "exact" || res.kind === "reanchored") {
              mappedResolutions.set(id, {
                ...res,
                from: { ...res.from, index: tr.mapping.map(res.from.index, 1) },
                to: { ...res.to, index: tr.mapping.map(res.to.index, -1) },
              });
            } else {
              mappedResolutions.set(id, res);
            }
          }
          next = {
            ...next,
            resolutions: mappedResolutions,
            pendingRange: next.pendingRange
              ? {
                  from: tr.mapping.map(next.pendingRange.from, 1),
                  to: tr.mapping.map(next.pendingRange.to, -1),
                }
              : null,
            decorations: next.decorations.map(tr.mapping, tr.doc),
          };
        }
        const meta = tr.getMeta(yCommentsPluginKey) as YCommentsMeta | undefined;
        if (meta) {
          switch (meta.type) {
            case "setThreads":
              next = { ...next, threads: meta.threads, threadsVersion: next.threadsVersion + 1 };
              break;
            case "setResolutions":
              next = { ...next, resolutions: meta.resolutions };
              break;
            case "selectThread":
              next = { ...next, selectedThreadId: meta.threadId };
              break;
            case "setPendingRange":
              next = { ...next, pendingRange: meta.range };
              break;
          }
          next = { ...next, decorations: rebuild(next, newState.doc) };
        }
        return next;
      },
    },

    view(editorView: EditorView) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let destroyed = false;

      const recompute = () => {
        if (destroyed) {
          return;
        }
        const state = editorView.state;
        const pluginState = yCommentsPluginKey.getState(state);
        if (!pluginState) {
          return;
        }
        let adapter;
        try {
          adapter = createDocAdapter(state);
        } catch {
          // Editor not (yet) collaborative — nothing to resolve against.
          return;
        }
        const resolutions = new Map<string, Resolution>();
        for (const thread of pluginState.threads) {
          resolutions.set(thread.id, resolveThread(thread, adapter));
        }
        // Skip the dispatch AND the host callback when nothing changed —
        // otherwise every debounce tick re-renders the host UI for free.
        if (!resolutionsEqual(pluginState.resolutions, resolutions)) {
          editorView.dispatch(
            state.tr.setMeta(yCommentsPluginKey, { type: "setResolutions", resolutions })
          );
          options.onResolutionsChange?.(resolutions);
        }

        if (options.selfHeal && options.store?.updateAnchor) {
          for (const thread of pluginState.threads) {
            const resolution = resolutions.get(thread.id);
            if (resolution?.kind !== "reanchored") {
              continue;
            }
            const text = state.doc.textBetween(
              resolution.from.index,
              resolution.to.index,
              BLOCK_SEPARATOR,
              LEAF_TEXT
            );
            // Only heal when the re-resolved text equals the quote exactly.
            if (text !== thread.anchor.quotedText) {
              continue;
            }
            try {
              const anchor = anchorFromRange(state, resolution.from.index, resolution.to.index);
              void options.store.updateAnchor({ threadId: thread.id, anchor }).catch(() => {
                /* healing is best-effort */
              });
            } catch {
              /* healing is best-effort */
            }
          }
        }
      };

      const schedule = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        timer = setTimeout(recompute, debounceMs);
      };

      schedule();

      return {
        update(view: EditorView, prevState: EditorState) {
          const prev = yCommentsPluginKey.getState(prevState);
          const current = yCommentsPluginKey.getState(view.state);
          if (
            view.state.doc !== prevState.doc ||
            (prev && current && prev.threadsVersion !== current.threadsVersion)
          ) {
            schedule();
          }
        },
        destroy() {
          destroyed = true;
          if (timer !== undefined) {
            clearTimeout(timer);
          }
        },
      };
    },

    props: {
      decorations(state) {
        return yCommentsPluginKey.getState(state)?.decorations ?? null;
      },
      handleClick(view, _pos, event) {
        const target = event.target as HTMLElement | null;
        const span = target?.closest?.("[data-thread-id]");
        const threadId = span?.getAttribute("data-thread-id") ?? null;
        const current = yCommentsPluginKey.getState(view.state)?.selectedThreadId ?? null;
        if (threadId !== current) {
          selectThread(view, threadId);
          options.onThreadSelect?.(threadId);
        }
        return false;
      },
    },
  });
}

/** Feed a fresh thread list into the plugin (dispatches a meta transaction). */
export function setThreads(view: EditorView, threads: Thread[]): void {
  view.dispatch(view.state.tr.setMeta(yCommentsPluginKey, { type: "setThreads", threads }));
}

/** Select (highlight as active) a thread, or pass null to deselect. */
export function selectThread(view: EditorView, threadId: string | null): void {
  view.dispatch(view.state.tr.setMeta(yCommentsPluginKey, { type: "selectThread", threadId }));
}

/**
 * Highlight the range currently being commented on (composer open), or
 * pass null to clear. Keeps the author's selection visible while focus is
 * in the composer.
 */
export function setPendingRange(view: EditorView, range: PendingRange | null): void {
  view.dispatch(view.state.tr.setMeta(yCommentsPluginKey, { type: "setPendingRange", range }));
}

/** Latest resolutions, keyed by thread id. Sidebars use this for ordering. */
export function getResolutions(state: EditorState): Map<string, Resolution> {
  return yCommentsPluginKey.getState(state)?.resolutions ?? new Map();
}

export function getSelectedThreadId(state: EditorState): string | null {
  return yCommentsPluginKey.getState(state)?.selectedThreadId ?? null;
}

export function getThreads(state: EditorState): Thread[] {
  return yCommentsPluginKey.getState(state)?.threads ?? [];
}

import type {
  Resolution,
  ResolveUsersFn,
  Thread,
  ThreadStore,
  User,
} from "@defensestation/y-comments-core";
import {
  selectThread as pmSelectThread,
  setPendingRange as pmSetPendingRange,
  setThreads as pmSetThreads,
  yCommentsPlugin,
  yCommentsPluginKey,
} from "@defensestation/y-comments-prosemirror";
import type { BlockNoteEditor } from "@blocknote/core";
import type { EditorView } from "prosemirror-view";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

// The provider works with any BlockNote schema; the editor generics don't
// affect anything comments touch.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyBlockNoteEditor = BlockNoteEditor<any, any, any>;

export interface CommentsContextValue {
  editor: AnyBlockNoteEditor;
  store: ThreadStore;
  docId: string;
  threads: Thread[];
  resolutions: Map<string, Resolution>;
  selectedThreadId: string | null;
  selectThread: (threadId: string | null) => void;
  /** Selection captured when the composer was opened; null = closed. */
  composer: { from: number; to: number } | null;
  openComposer: () => void;
  closeComposer: () => void;
  users: Map<string, User>;
  /** Ask the provider to resolve (and cache) these user ids. */
  requestUsers: (userIds: string[]) => void;
}

const CommentsContext = createContext<CommentsContextValue | null>(null);

export function useComments(): CommentsContextValue {
  const ctx = useContext(CommentsContext);
  if (!ctx) {
    throw new Error("y-comments: this component must be rendered inside <CommentsProvider>.");
  }
  return ctx;
}

export interface CommentsProviderProps {
  editor: AnyBlockNoteEditor;
  store: ThreadStore;
  /** Document id used against the thread store. */
  docId: string;
  /** Lookup for avatars/names, same contract as BlockNote's resolveUsers. */
  resolveUsers: ResolveUsersFn;
  /**
   * Persist fresh anchors after successful re-anchoring. Off by default —
   * it writes to the store on read. See the README before enabling.
   */
  selfHeal?: boolean;
  children: ReactNode;
}

/**
 * Owns the comment machinery for one editor + document:
 * installs the decorations plugin into BlockNote's ProseMirror view,
 * subscribes to the thread store, and exposes everything to the UI
 * components via context.
 *
 * Nothing under this provider ever writes to the Y.Doc.
 */
export function CommentsProvider(props: CommentsProviderProps) {
  const { editor, store, docId, resolveUsers, selfHeal } = props;

  const [threads, setThreadsState] = useState<Thread[]>([]);
  const [resolutions, setResolutions] = useState<Map<string, Resolution>>(new Map());
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [composer, setComposer] = useState<{ from: number; to: number } | null>(null);
  const [users, setUsers] = useState<Map<string, User>>(new Map());

  const threadsRef = useRef<Thread[]>([]);
  const pendingUserIds = useRef<Set<string>>(new Set());

  const withView = useCallback(
    (fn: (view: EditorView) => void) => {
      try {
        fn(editor.prosemirrorView);
      } catch {
        // editor not mounted yet — callers re-run once it is
      }
    },
    [editor]
  );

  // Install the ProseMirror plugin (unless the host already registered it
  // as a BlockNote extension) and subscribe to the thread store.
  useEffect(() => {
    let disposed = false;
    let installedByUs = false;
    let unsubscribe: (() => void) | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const start = () => {
      if (disposed) {
        return;
      }
      let view: EditorView;
      try {
        view = editor.prosemirrorView;
      } catch {
        retryTimer = setTimeout(start, 50); // BlockNoteView not mounted yet
        return;
      }

      if (yCommentsPluginKey.getState(view.state) === undefined) {
        editor._tiptapEditor.registerPlugin(
          yCommentsPlugin({
            selfHeal,
            store,
            onThreadSelect: (threadId) => setSelectedThreadId(threadId),
            onResolutionsChange: (r) => setResolutions(new Map(r)),
          })
        );
        installedByUs = true;
      }
      pmSetThreads(view, threadsRef.current);

      // Polling stores re-emit unchanged lists; dropping those early keeps
      // both React and the plugin from re-rendering every poll tick.
      const serializeThreads = (threads: Thread[]) =>
        JSON.stringify(threads, (_key, value: unknown) =>
          value instanceof Uint8Array ? Array.from(value) : value
        );
      let lastSerialized = serializeThreads(threadsRef.current);

      unsubscribe = store.subscribe(docId, (nextThreads) => {
        if (disposed) {
          return;
        }
        const serialized = serializeThreads(nextThreads);
        if (serialized === lastSerialized) {
          return;
        }
        lastSerialized = serialized;
        threadsRef.current = nextThreads;
        setThreadsState(nextThreads);
        withView((v) => pmSetThreads(v, nextThreads));
      });
    };

    start();

    return () => {
      disposed = true;
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
      }
      unsubscribe?.();
      if (installedByUs) {
        try {
          editor._tiptapEditor.unregisterPlugin(yCommentsPluginKey);
        } catch {
          // view already destroyed
        }
      }
    };
  }, [editor, store, docId, selfHeal, withView]);

  const selectThread = useCallback(
    (threadId: string | null) => {
      setSelectedThreadId(threadId);
      withView((view) => pmSelectThread(view, threadId));
    },
    [withView]
  );

  const openComposer = useCallback(() => {
    try {
      const { from, to } = editor.prosemirrorState.selection;
      if (from === to) {
        return;
      }
      setComposer({ from, to });
      // keep the selection visible while focus moves into the composer
      withView((view) => pmSetPendingRange(view, { from, to }));
    } catch {
      // not mounted
    }
  }, [editor, withView]);

  const closeComposer = useCallback(() => {
    setComposer(null);
    withView((view) => pmSetPendingRange(view, null));
  }, [withView]);

  const requestUsers = useCallback(
    (userIds: string[]) => {
      const missing = userIds.filter(
        (id) => !pendingUserIds.current.has(id)
      );
      if (missing.length === 0) {
        return;
      }
      for (const id of missing) {
        pendingUserIds.current.add(id);
      }
      resolveUsers(missing).then(
        (resolved) => {
          setUsers((prev) => {
            const next = new Map(prev);
            for (const user of resolved) {
              next.set(user.id, user);
            }
            return next;
          });
        },
        () => {
          for (const id of missing) {
            pendingUserIds.current.delete(id); // allow retry
          }
        }
      );
    },
    [resolveUsers]
  );

  const value = useMemo<CommentsContextValue>(
    () => ({
      editor,
      store,
      docId,
      threads,
      resolutions,
      selectedThreadId,
      selectThread,
      composer,
      openComposer,
      closeComposer,
      users,
      requestUsers,
    }),
    [
      editor,
      store,
      docId,
      threads,
      resolutions,
      selectedThreadId,
      selectThread,
      composer,
      openComposer,
      closeComposer,
      users,
      requestUsers,
    ]
  );

  return <CommentsContext.Provider value={value}>{props.children}</CommentsContext.Provider>;
}

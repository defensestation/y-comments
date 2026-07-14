export {
  CommentsProvider,
  useComments,
  type CommentsProviderProps,
  type CommentsContextValue,
  type AnyBlockNoteEditor,
} from "./context.js";
export { CreateCommentButton } from "./components/CreateCommentButton.js";
export { FloatingComposer } from "./components/FloatingComposer.js";
export { FloatingThread } from "./components/FloatingThread.js";
export { ThreadsSidebar, type ThreadsSidebarProps, type ThreadsFilter } from "./components/ThreadsSidebar.js";
export { ThreadBody, type ThreadBodyProps } from "./components/ThreadBody.js";

// Re-exports so hosts only need this package for common flows.
export {
  DefaultThreadStoreAuth,
  AllowAllThreadStoreAuth,
  InMemoryThreadStore,
  RestThreadStore,
  PushThreadStore,
  OptimisticThreadStore,
  type PushTransport,
  type Anchor,
  type Comment,
  type CommentBody,
  type Resolution,
  type Thread,
  type ThreadStore,
  type ThreadStoreAuth,
  type User,
  type ResolveUsersFn,
} from "@defensestation/y-comments-core";
export {
  anchorFromSelection,
  anchorFromRange,
  yCommentsPlugin,
  yCommentsPluginKey,
} from "@defensestation/y-comments-prosemirror";

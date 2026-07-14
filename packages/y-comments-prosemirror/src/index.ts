export {
  anchorFromSelection,
  anchorFromRange,
  MAX_QUOTE_LENGTH,
  DEFAULT_CONTEXT_LENGTH,
  BLOCK_SEPARATOR,
  LEAF_TEXT,
  type AnchorFromSelectionOptions,
} from "./anchors.js";
export { createDocAdapter } from "./doc-adapter.js";
export { getYSyncState, type YSyncState } from "./ysync.js";
export {
  yCommentsPlugin,
  yCommentsPluginKey,
  setThreads,
  selectThread,
  setPendingRange,
  getResolutions,
  getSelectedThreadId,
  getThreads,
  DEFAULT_HIGHLIGHT_CLASS,
  DEFAULT_ACTIVE_CLASS,
  DEFAULT_PENDING_CLASS,
  DEFAULT_DEBOUNCE_MS,
  type YCommentsState,
  type YCommentsPluginOptions,
  type PendingRange,
} from "./plugin.js";

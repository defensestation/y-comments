import type { Comment, Thread } from "@defensestation/y-comments-core";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useComments } from "../context.js";
import { relativeTime } from "../time.js";
import { CheckIcon, EditIcon, EmojiIcon, ReopenIcon, TrashIcon } from "./icons.js";

const REACTION_PALETTE = ["👍", "❤️", "✅", "👀", "😄", "🎉"];

/**
 * Run a store action with visual failure feedback: on rejection an error
 * line appears where the action happened, and the triggering state (draft
 * text, edit mode) is preserved so the user can retry.
 */
function useStoreAction() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    (label: string, action: () => Promise<unknown>, onSuccess?: () => void) => {
      setBusy(true);
      action().then(
        () => {
          setBusy(false);
          setError(null);
          onSuccess?.();
        },
        () => {
          setBusy(false);
          setError(`${label} failed — check the connection and try again.`);
        }
      );
    },
    []
  );
  return { error, busy, run };
}

/** Enter submits, Shift+Enter inserts a newline (IME composition ignored). */
function submitOnEnter(e: KeyboardEvent<HTMLTextAreaElement>, submit: () => void) {
  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
    e.preventDefault();
    submit();
  }
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) {
    return null;
  }
  return (
    <div className="y-comments-error" role="alert">
      {error}
    </div>
  );
}

function Avatar({ userId }: { userId: string }) {
  const { users } = useComments();
  const user = users.get(userId);
  if (user?.avatarUrl) {
    return <img className="y-comments-avatar" src={user.avatarUrl} alt={user.username} />;
  }
  const name = user?.username ?? userId;
  return (
    <span className="y-comments-avatar y-comments-avatar-fallback" title={name}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function Username({ userId }: { userId: string }) {
  const { users } = useComments();
  return <span className="y-comments-username">{users.get(userId)?.username ?? userId}</span>;
}

function Reactions({ thread, comment }: { thread: Thread; comment: Comment }) {
  const { store } = useComments();
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerWrapRef = useRef<HTMLSpanElement | null>(null);
  const { error, run } = useStoreAction();

  // Dismiss the palette on outside pointer-down, like any popover.
  useEffect(() => {
    if (!pickerOpen) {
      return;
    }
    const onPointerDown = (e: MouseEvent) => {
      if (pickerWrapRef.current && !pickerWrapRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [pickerOpen]);

  const toggle = (emoji: string, mine: boolean) => {
    const input = { threadId: thread.id, commentId: comment.id, emoji };
    run("Reaction", () => (mine ? store.deleteReaction(input) : store.addReaction(input)));
    setPickerOpen(false);
  };

  const canReact = store.auth.canAddReaction(comment);

  return (
    <div className="y-comments-reactions">
      {comment.reactions.map((reaction) => {
        const mine = store.auth.canDeleteReaction(comment, reaction.emoji);
        return (
          <button
            key={reaction.emoji}
            type="button"
            className={`y-comments-reaction${mine ? " y-comments-reaction-mine" : ""}`}
            title={reaction.userIds.join(", ")}
            onClick={() => (mine || canReact ? toggle(reaction.emoji, mine) : undefined)}
          >
            {reaction.emoji} {reaction.userIds.length}
          </button>
        );
      })}
      {canReact && (
        <span className="y-comments-reaction-picker-wrap" ref={pickerWrapRef}>
          <button
            type="button"
            className="y-comments-icon-button"
            aria-label="Add reaction"
            onClick={() => setPickerOpen((open) => !open)}
          >
            <EmojiIcon />
          </button>
          {pickerOpen && (
            <span className="y-comments-reaction-picker" role="menu">
              {REACTION_PALETTE.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="y-comments-reaction"
                  onClick={() =>
                    toggle(
                      emoji,
                      comment.reactions.some(
                        (r) => r.emoji === emoji && store.auth.canDeleteReaction(comment, emoji)
                      )
                    )
                  }
                >
                  {emoji}
                </button>
              ))}
            </span>
          )}
        </span>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

function CommentView({ thread, comment }: { thread: Thread; comment: Comment }) {
  const { store, requestUsers } = useComments();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body.text);
  const { error, busy, run } = useStoreAction();

  useEffect(() => requestUsers([comment.userId]), [comment.userId, requestUsers]);

  const submitEdit = () => {
    const text = draft.trim();
    if (text.length === 0) {
      return;
    }
    // stay in edit mode (draft intact) unless the save succeeds
    run(
      "Saving the edit",
      () => store.updateComment({ threadId: thread.id, commentId: comment.id, body: { text } }),
      () => setEditing(false)
    );
  };

  const onEditKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      // cancel just the edit — don't let the floating thread's document
      // Escape handler close the whole popover
      e.stopPropagation();
      setEditing(false);
      return;
    }
    submitOnEnter(e, submitEdit);
  };

  return (
    <div className="y-comments-comment" data-comment-id={comment.id}>
      <div className="y-comments-comment-header">
        <Avatar userId={comment.userId} />
        <Username userId={comment.userId} />
        <span className="y-comments-timestamp" title={comment.createdAt}>
          {relativeTime(comment.createdAt)}
          {comment.updatedAt ? " (edited)" : ""}
        </span>
        <span className="y-comments-comment-actions">
          {store.auth.canUpdateComment(comment) && (
            <button
              type="button"
              className="y-comments-icon-button"
              aria-label="Edit comment"
              onClick={() => {
                setDraft(comment.body.text);
                setEditing((v) => !v);
              }}
            >
              <EditIcon />
            </button>
          )}
          {store.auth.canDeleteComment(comment) && (
            <button
              type="button"
              className="y-comments-icon-button"
              aria-label="Delete comment"
              onClick={() =>
                run("Deleting the comment", () =>
                  store.deleteComment({ threadId: thread.id, commentId: comment.id })
                )
              }
            >
              <TrashIcon />
            </button>
          )}
        </span>
      </div>
      {editing ? (
        <form
          className="y-comments-composer"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            submitEdit();
          }}
        >
          <textarea
            className="y-comments-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onEditKeyDown}
            rows={2}
            autoFocus
          />
          <ErrorLine error={error} />
          <div className="y-comments-composer-actions">
            <button type="button" className="y-comments-button" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              type="submit"
              className="y-comments-button y-comments-button-primary"
              disabled={busy}
            >
              Save
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="y-comments-comment-body">{comment.body.text}</div>
          <ErrorLine error={error} />
        </>
      )}
      <Reactions thread={thread} comment={comment} />
    </div>
  );
}

export interface ThreadBodyProps {
  thread: Thread;
  /** Render the quoted text above the comments (used by the sidebar). */
  showQuote?: boolean;
}

/** Full thread: header actions, comments, reply composer. */
export function ThreadBody({ thread, showQuote }: ThreadBodyProps) {
  const { store, requestUsers } = useComments();
  const [reply, setReply] = useState("");
  const headerAction = useStoreAction();
  const replyAction = useStoreAction();

  const commentsRef = useRef<HTMLDivElement | null>(null);
  // Follow the newest comment unless the user scrolled up to read history;
  // scrolling back near the bottom re-pins.
  const pinnedToBottom = useRef(true);
  // Smooth scrolling emits scroll events from positions the user never
  // chose; don't let those unpin (only a wheel/touch takeover does).
  const autoScrolling = useRef(false);
  const commentCount = useRef(thread.comments.length);

  const scrollToLatest = useCallback((behavior: ScrollBehavior) => {
    const el = commentsRef.current;
    if (!el) {
      return;
    }
    if (typeof el.scrollTo === "function") {
      autoScrolling.current = behavior === "smooth";
      el.scrollTo({ top: el.scrollHeight, behavior });
    } else {
      el.scrollTop = el.scrollHeight; // jsdom
    }
  }, []);

  // Open showing the latest comment.
  useEffect(() => {
    scrollToLatest("auto");
  }, [scrollToLatest]);

  useEffect(() => {
    const grew = thread.comments.length > commentCount.current;
    commentCount.current = thread.comments.length;
    if (grew && pinnedToBottom.current) {
      scrollToLatest("smooth");
    }
  }, [thread.comments.length, scrollToLatest]);

  const onCommentsScroll = () => {
    const el = commentsRef.current;
    if (!el) {
      return;
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (autoScrolling.current) {
      if (nearBottom) {
        autoScrolling.current = false; // arrived
        pinnedToBottom.current = true;
      }
      return;
    }
    pinnedToBottom.current = nearBottom;
  };

  // A wheel or touch means the user took over, even mid-animation.
  const onUserScrollIntent = () => {
    autoScrolling.current = false;
  };

  const userIds = useMemo(
    () => Array.from(new Set(thread.comments.map((c) => c.userId))),
    [thread.comments]
  );
  useEffect(() => requestUsers(userIds), [userIds, requestUsers]);

  const submitReply = () => {
    const text = reply.trim();
    if (text.length === 0) {
      return;
    }
    // the draft is only cleared once the reply actually saved
    replyAction.run(
      "Sending the reply",
      () => store.addComment({ threadId: thread.id, body: { text } }),
      () => {
        setReply("");
        // your own reply always comes into view, even if you were scrolled up
        pinnedToBottom.current = true;
      }
    );
  };

  return (
    <div className="y-comments-thread" data-thread-body={thread.id}>
      <div className="y-comments-thread-header">
        {thread.outdated && <span className="y-comments-badge">Outdated</span>}
        {thread.resolved && <span className="y-comments-badge y-comments-badge-resolved">Resolved</span>}
        <span className="y-comments-thread-header-spacer" />
        {!thread.resolved && store.auth.canResolveThread(thread) && (
          <button
            type="button"
            className="y-comments-icon-button"
            aria-label="Resolve thread"
            title="Resolve"
            onClick={() =>
              headerAction.run("Resolving", () => store.resolveThread({ threadId: thread.id }))
            }
          >
            <CheckIcon />
          </button>
        )}
        {thread.resolved && store.auth.canUnresolveThread(thread) && (
          <button
            type="button"
            className="y-comments-icon-button"
            aria-label="Reopen thread"
            title="Reopen"
            onClick={() =>
              headerAction.run("Reopening", () => store.unresolveThread({ threadId: thread.id }))
            }
          >
            <ReopenIcon />
          </button>
        )}
        {store.auth.canDeleteThread(thread) && (
          <button
            type="button"
            className="y-comments-icon-button"
            aria-label="Delete thread"
            title="Delete thread"
            onClick={() =>
              headerAction.run("Deleting the thread", () =>
                store.deleteThread({ threadId: thread.id })
              )
            }
          >
            <TrashIcon />
          </button>
        )}
      </div>
      <ErrorLine error={headerAction.error} />
      {showQuote && thread.anchor.quotedText && (
        <blockquote className="y-comments-quote">{thread.anchor.quotedText}</blockquote>
      )}
      <div
        className="y-comments-comments"
        ref={commentsRef}
        onScroll={onCommentsScroll}
        onWheel={onUserScrollIntent}
        onTouchMove={onUserScrollIntent}
      >
        {thread.comments.map((comment) => (
          <CommentView key={comment.id} thread={thread} comment={comment} />
        ))}
      </div>
      {store.auth.canAddComment(thread) && (
        <form
          className="y-comments-composer"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            submitReply();
          }}
        >
          <textarea
            className="y-comments-input"
            placeholder="Reply…"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => submitOnEnter(e, submitReply)}
            rows={1}
          />
          <ErrorLine error={replyAction.error} />
          <div className="y-comments-composer-actions">
            <button
              type="submit"
              className="y-comments-button y-comments-button-primary"
              disabled={reply.trim().length === 0 || replyAction.busy}
            >
              Reply
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

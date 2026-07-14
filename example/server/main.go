// Reference implementation of the y-comments REST contract, backed by
// SQLite. Meant for local development against the example app; a real
// deployment adds real authentication and per-document ACLs.
//
//	go run . -addr :8787 -db comments.db
//
// Identity is taken from the X-User-Id header (default "anonymous") — a
// stand-in for whatever session auth your platform uses. Authorization
// enforced here mirrors DefaultThreadStoreAuth: authors may edit/delete
// their own comments and resolve/delete their own threads.
package main

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"crypto/rand"

	_ "modernc.org/sqlite"
)

// ---- wire types (§ REST contract; relFrom/relTo are base64) ----

type Anchor struct {
	RelFrom     string `json:"relFrom"`
	RelTo       string `json:"relTo"`
	ContainerID string `json:"containerId,omitempty"`
	QuotedText  string `json:"quotedText"`
	Prefix      string `json:"prefix"`
	Suffix      string `json:"suffix"`
}

type CommentBody struct {
	Text string          `json:"text"`
	JSON json.RawMessage `json:"json,omitempty"`
}

type Reaction struct {
	Emoji   string   `json:"emoji"`
	UserIDs []string `json:"userIds"`
}

type Comment struct {
	ID        string      `json:"id"`
	UserID    string      `json:"userId"`
	Body      CommentBody `json:"body"`
	CreatedAt string      `json:"createdAt"`
	UpdatedAt string      `json:"updatedAt,omitempty"`
	Reactions []Reaction  `json:"reactions"`
}

type Thread struct {
	ID         string    `json:"id"`
	DocID      string    `json:"docId"`
	Anchor     Anchor    `json:"anchor"`
	Comments   []Comment `json:"comments"`
	Resolved   bool      `json:"resolved"`
	ResolvedBy string    `json:"resolvedBy,omitempty"`
	ResolvedAt string    `json:"resolvedAt,omitempty"`
	Outdated   bool      `json:"outdated,omitempty"`
	CreatedAt  string    `json:"createdAt"`
}

// A forged anchor can only misplace a highlight, never modify content —
// but bound it anyway.
const maxAnchorBlobBytes = 4096

const schema = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  anchor TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_by TEXT,
  resolved_at TEXT,
  outdated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS threads_doc ON threads(doc_id);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  body_text TEXT NOT NULL,
  body_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_thread ON comments(thread_id, seq);
CREATE TABLE IF NOT EXISTS reactions (
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (comment_id, emoji, user_id)
);
`

type server struct {
	db  *sql.DB
	hub *hub
}

// hub fans out "something changed in this doc" pings to SSE subscribers, so
// clients refetch on demand instead of polling GET /threads.
type hub struct {
	mu   sync.Mutex
	subs map[string]map[chan struct{}]struct{}
}

func newHub() *hub {
	return &hub{subs: map[string]map[chan struct{}]struct{}{}}
}

func (h *hub) subscribe(docID string) (ch chan struct{}, cancel func()) {
	ch = make(chan struct{}, 1)
	h.mu.Lock()
	if h.subs[docID] == nil {
		h.subs[docID] = map[chan struct{}]struct{}{}
	}
	h.subs[docID][ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		delete(h.subs[docID], ch)
		h.mu.Unlock()
	}
}

func (h *hub) notify(docID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs[docID] {
		select {
		case ch <- struct{}{}:
		default: // subscriber already has a pending ping
		}
	}
}

func main() {
	addr := flag.String("addr", ":8787", "listen address")
	dbPath := flag.String("db", "comments.db", "sqlite database path")
	flag.Parse()

	db, err := sql.Open("sqlite", *dbPath+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)")
	if err != nil {
		log.Fatal(err)
	}
	if _, err := db.Exec(schema); err != nil {
		log.Fatal(err)
	}
	s := &server{db: db, hub: newHub()}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /docs/{docId}/threads", s.listThreads)
	mux.HandleFunc("GET /docs/{docId}/events", s.events)
	mux.HandleFunc("POST /docs/{docId}/threads", s.createThread)
	mux.HandleFunc("POST /threads/{id}/comments", s.addComment)
	mux.HandleFunc("PATCH /threads/{id}/comments/{cid}", s.updateComment)
	mux.HandleFunc("DELETE /threads/{id}/comments/{cid}", s.deleteComment)
	mux.HandleFunc("DELETE /threads/{id}", s.deleteThread)
	mux.HandleFunc("POST /threads/{id}/resolve", s.setResolved(true))
	mux.HandleFunc("POST /threads/{id}/unresolve", s.setResolved(false))
	mux.HandleFunc("POST /threads/{id}/comments/{cid}/reactions", s.addReaction)
	mux.HandleFunc("DELETE /threads/{id}/comments/{cid}/reactions/{emoji}", s.deleteReaction)
	mux.HandleFunc("PATCH /threads/{id}/anchor", s.updateAnchor)

	log.Printf("y-comments server listening on %s (db %s)", *addr, *dbPath)
	log.Fatal(http.ListenAndServe(*addr, cors(mux)))
}

// ---- middleware / helpers ----

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-User-Id")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func userID(r *http.Request) string {
	if id := r.Header.Get("X-User-Id"); id != "" {
		return id
	}
	return "anonymous"
}

func now() string {
	return time.Now().UTC().Format(time.RFC3339)
}

func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func validateAnchor(a Anchor) error {
	for _, blob := range []string{a.RelFrom, a.RelTo} {
		raw, err := base64.StdEncoding.DecodeString(blob)
		if err != nil {
			return errors.New("anchor positions must be base64")
		}
		if len(raw) == 0 || len(raw) > maxAnchorBlobBytes {
			return fmt.Errorf("anchor position blob must be 1-%d bytes", maxAnchorBlobBytes)
		}
	}
	if a.QuotedText == "" {
		return errors.New("anchor.quotedText is required")
	}
	return nil
}

// ---- queries ----

func (s *server) loadThreads(docID, threadID string) ([]Thread, error) {
	query := `SELECT id, doc_id, anchor, resolved, resolved_by, resolved_at, outdated, created_at FROM threads`
	var args []any
	if threadID != "" {
		query += ` WHERE id = ?`
		args = append(args, threadID)
	} else {
		query += ` WHERE doc_id = ? ORDER BY created_at`
		args = append(args, docID)
	}
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var threads []Thread
	for rows.Next() {
		var t Thread
		var anchorJSON string
		var resolvedBy, resolvedAt sql.NullString
		var resolved, outdated int
		if err := rows.Scan(&t.ID, &t.DocID, &anchorJSON, &resolved, &resolvedBy, &resolvedAt, &outdated, &t.CreatedAt); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(anchorJSON), &t.Anchor); err != nil {
			return nil, err
		}
		t.Resolved = resolved != 0
		t.Outdated = outdated != 0
		t.ResolvedBy = resolvedBy.String
		t.ResolvedAt = resolvedAt.String
		t.Comments = []Comment{}
		threads = append(threads, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for i := range threads {
		comments, err := s.loadComments(threads[i].ID)
		if err != nil {
			return nil, err
		}
		threads[i].Comments = comments
	}
	return threads, nil
}

func (s *server) loadComments(threadID string) ([]Comment, error) {
	rows, err := s.db.Query(
		`SELECT id, user_id, body_text, body_json, created_at, updated_at FROM comments WHERE thread_id = ? ORDER BY seq`,
		threadID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	comments := []Comment{}
	for rows.Next() {
		var c Comment
		var bodyJSON, updatedAt sql.NullString
		if err := rows.Scan(&c.ID, &c.UserID, &c.Body.Text, &bodyJSON, &c.CreatedAt, &updatedAt); err != nil {
			return nil, err
		}
		if bodyJSON.Valid && bodyJSON.String != "" {
			c.Body.JSON = json.RawMessage(bodyJSON.String)
		}
		c.UpdatedAt = updatedAt.String
		c.Reactions = []Reaction{}
		comments = append(comments, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for i := range comments {
		rrows, err := s.db.Query(
			`SELECT emoji, user_id FROM reactions WHERE comment_id = ? ORDER BY rowid`,
			comments[i].ID,
		)
		if err != nil {
			return nil, err
		}
		byEmoji := map[string]int{}
		for rrows.Next() {
			var emoji, uid string
			if err := rrows.Scan(&emoji, &uid); err != nil {
				rrows.Close()
				return nil, err
			}
			idx, ok := byEmoji[emoji]
			if !ok {
				comments[i].Reactions = append(comments[i].Reactions, Reaction{Emoji: emoji})
				idx = len(comments[i].Reactions) - 1
				byEmoji[emoji] = idx
			}
			comments[i].Reactions[idx].UserIDs = append(comments[i].Reactions[idx].UserIDs, uid)
		}
		rrows.Close()
		if err := rrows.Err(); err != nil {
			return nil, err
		}
	}
	return comments, nil
}

func (s *server) threadByID(w http.ResponseWriter, id string) (Thread, bool) {
	threads, err := s.loadThreads("", id)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return Thread{}, false
	}
	if len(threads) == 0 {
		httpError(w, http.StatusNotFound, "thread not found")
		return Thread{}, false
	}
	return threads[0], true
}

// ---- handlers ----

// events streams "data: changed" whenever the doc's threads change; the
// client refetches once per event instead of polling.
func (s *server) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		httpError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	docID := r.PathValue("docId")
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	ch, cancel := s.hub.subscribe(docID)
	defer cancel()
	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ch:
			fmt.Fprint(w, "data: changed\n\n")
			flusher.Flush()
		case <-heartbeat.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

func (s *server) docIDOf(threadID string) string {
	var docID string
	_ = s.db.QueryRow(`SELECT doc_id FROM threads WHERE id = ?`, threadID).Scan(&docID)
	return docID
}

func (s *server) listThreads(w http.ResponseWriter, r *http.Request) {
	threads, err := s.loadThreads(r.PathValue("docId"), "")
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if threads == nil {
		threads = []Thread{}
	}
	writeJSON(w, http.StatusOK, threads)
}

func (s *server) createThread(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Anchor Anchor      `json:"anchor"`
		Body   CommentBody `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		httpError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if err := validateAnchor(in.Anchor); err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	if in.Body.Text == "" {
		httpError(w, http.StatusBadRequest, "body.text is required")
		return
	}

	anchorJSON, _ := json.Marshal(in.Anchor)
	threadID, commentID, ts := newID(), newID(), now()
	tx, err := s.db.Begin()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer tx.Rollback()
	if _, err := tx.Exec(
		`INSERT INTO threads (id, doc_id, anchor, created_at) VALUES (?, ?, ?, ?)`,
		threadID, r.PathValue("docId"), string(anchorJSON), ts,
	); err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	var bodyJSON any
	if in.Body.JSON != nil {
		bodyJSON = string(in.Body.JSON)
	}
	if _, err := tx.Exec(
		`INSERT INTO comments (id, thread_id, user_id, body_text, body_json, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, 0)`,
		commentID, threadID, userID(r), in.Body.Text, bodyJSON, ts,
	); err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := tx.Commit(); err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}

	s.hub.notify(r.PathValue("docId"))
	thread, ok := s.threadByID(w, threadID)
	if !ok {
		return
	}
	writeJSON(w, http.StatusCreated, thread)
}

func (s *server) addComment(w http.ResponseWriter, r *http.Request) {
	threadID := r.PathValue("id")
	if _, ok := s.threadByID(w, threadID); !ok {
		return
	}
	var in struct {
		Body CommentBody `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.Body.Text == "" {
		httpError(w, http.StatusBadRequest, "body.text is required")
		return
	}
	commentID, ts := newID(), now()
	var bodyJSON any
	if in.Body.JSON != nil {
		bodyJSON = string(in.Body.JSON)
	}
	if _, err := s.db.Exec(
		`INSERT INTO comments (id, thread_id, user_id, body_text, body_json, created_at, seq)
		 VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM comments WHERE thread_id = ?))`,
		commentID, threadID, userID(r), in.Body.Text, bodyJSON, ts, threadID,
	); err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.hub.notify(s.docIDOf(threadID))
	comments, err := s.loadComments(threadID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	for _, c := range comments {
		if c.ID == commentID {
			writeJSON(w, http.StatusCreated, c)
			return
		}
	}
	httpError(w, http.StatusInternalServerError, "comment vanished")
}

func (s *server) commentAuthor(threadID, commentID string) (string, error) {
	var author string
	err := s.db.QueryRow(
		`SELECT user_id FROM comments WHERE id = ? AND thread_id = ?`, commentID, threadID,
	).Scan(&author)
	return author, err
}

func (s *server) updateComment(w http.ResponseWriter, r *http.Request) {
	threadID, commentID := r.PathValue("id"), r.PathValue("cid")
	author, err := s.commentAuthor(threadID, commentID)
	if errors.Is(err, sql.ErrNoRows) {
		httpError(w, http.StatusNotFound, "comment not found")
		return
	} else if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if author != userID(r) {
		httpError(w, http.StatusForbidden, "only the author may edit a comment")
		return
	}
	var in struct {
		Body CommentBody `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.Body.Text == "" {
		httpError(w, http.StatusBadRequest, "body.text is required")
		return
	}
	var bodyJSON any
	if in.Body.JSON != nil {
		bodyJSON = string(in.Body.JSON)
	}
	if _, err := s.db.Exec(
		`UPDATE comments SET body_text = ?, body_json = ?, updated_at = ? WHERE id = ?`,
		in.Body.Text, bodyJSON, now(), commentID,
	); err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.hub.notify(s.docIDOf(threadID))
	comments, err := s.loadComments(threadID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	for _, c := range comments {
		if c.ID == commentID {
			writeJSON(w, http.StatusOK, c)
			return
		}
	}
	httpError(w, http.StatusInternalServerError, "comment vanished")
}

func (s *server) deleteComment(w http.ResponseWriter, r *http.Request) {
	threadID, commentID := r.PathValue("id"), r.PathValue("cid")
	author, err := s.commentAuthor(threadID, commentID)
	if errors.Is(err, sql.ErrNoRows) {
		httpError(w, http.StatusNotFound, "comment not found")
		return
	} else if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if author != userID(r) {
		httpError(w, http.StatusForbidden, "only the author may delete a comment")
		return
	}
	docID := s.docIDOf(threadID)
	if _, err := s.db.Exec(`DELETE FROM comments WHERE id = ?`, commentID); err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// deleting the last comment deletes the thread
	var remaining int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM comments WHERE thread_id = ?`, threadID).Scan(&remaining); err == nil && remaining == 0 {
		_, _ = s.db.Exec(`DELETE FROM threads WHERE id = ?`, threadID)
	}
	s.hub.notify(docID)
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) rootAuthor(threadID string) (string, error) {
	var author string
	err := s.db.QueryRow(
		`SELECT user_id FROM comments WHERE thread_id = ? ORDER BY seq LIMIT 1`, threadID,
	).Scan(&author)
	return author, err
}

func (s *server) deleteThread(w http.ResponseWriter, r *http.Request) {
	threadID := r.PathValue("id")
	if _, ok := s.threadByID(w, threadID); !ok {
		return
	}
	author, err := s.rootAuthor(threadID)
	if err == nil && author != userID(r) {
		httpError(w, http.StatusForbidden, "only the thread author may delete it")
		return
	}
	docID := s.docIDOf(threadID)
	if _, err := s.db.Exec(`DELETE FROM threads WHERE id = ?`, threadID); err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.hub.notify(docID)
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) setResolved(resolved bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		threadID := r.PathValue("id")
		if _, ok := s.threadByID(w, threadID); !ok {
			return
		}
		if resolved {
			_, err := s.db.Exec(
				`UPDATE threads SET resolved = 1, resolved_by = ?, resolved_at = ? WHERE id = ?`,
				userID(r), now(), threadID,
			)
			if err != nil {
				httpError(w, http.StatusInternalServerError, err.Error())
				return
			}
		} else {
			_, err := s.db.Exec(
				`UPDATE threads SET resolved = 0, resolved_by = NULL, resolved_at = NULL WHERE id = ?`,
				threadID,
			)
			if err != nil {
				httpError(w, http.StatusInternalServerError, err.Error())
				return
			}
		}
		s.hub.notify(s.docIDOf(threadID))
		w.WriteHeader(http.StatusNoContent)
	}
}

func (s *server) addReaction(w http.ResponseWriter, r *http.Request) {
	commentID := r.PathValue("cid")
	var in struct {
		Emoji string `json:"emoji"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.Emoji == "" {
		httpError(w, http.StatusBadRequest, "emoji is required")
		return
	}
	if _, err := s.db.Exec(
		`INSERT OR IGNORE INTO reactions (comment_id, emoji, user_id) VALUES (?, ?, ?)`,
		commentID, in.Emoji, userID(r),
	); err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.hub.notify(s.docIDOf(r.PathValue("id")))
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) deleteReaction(w http.ResponseWriter, r *http.Request) {
	if _, err := s.db.Exec(
		`DELETE FROM reactions WHERE comment_id = ? AND emoji = ? AND user_id = ?`,
		r.PathValue("cid"), r.PathValue("emoji"), userID(r),
	); err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.hub.notify(s.docIDOf(r.PathValue("id")))
	w.WriteHeader(http.StatusNoContent)
}

// Self-heal support: replace a thread's anchor (optional part of the contract).
func (s *server) updateAnchor(w http.ResponseWriter, r *http.Request) {
	threadID := r.PathValue("id")
	if _, ok := s.threadByID(w, threadID); !ok {
		return
	}
	var in struct {
		Anchor Anchor `json:"anchor"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		httpError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if err := validateAnchor(in.Anchor); err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	anchorJSON, _ := json.Marshal(in.Anchor)
	if _, err := s.db.Exec(`UPDATE threads SET anchor = ? WHERE id = ?`, string(anchorJSON), threadID); err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.hub.notify(s.docIDOf(threadID))
	w.WriteHeader(http.StatusNoContent)
}

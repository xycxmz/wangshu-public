package mcp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"

	"github.com/xycxmz/company-platform-v1/server/internal/auth"
	"github.com/xycxmz/company-platform-v1/server/internal/auth/acauth"
	"github.com/xycxmz/company-platform-v1/server/internal/store"
)

type upstreamCall struct {
	method string
	auth   string
	body   string
}

// mockMCP stands in for a real MCP server: every request is answered with the
// configured status and body, and what arrived (method, Authorization,
// body) is recorded for assertions. A positive delay simulates a slow
// upstream for the timeout test.
type mockMCP struct {
	mu     sync.Mutex
	server *httptest.Server
	calls  []upstreamCall
	status int
	body   string
	delay  time.Duration
}

const mcpReply = `{"jsonrpc":"2.0","id":1,"result":{"pong":true}}`

func newMockMCP(t *testing.T) *mockMCP {
	t.Helper()
	m := &mockMCP{status: http.StatusOK, body: mcpReply}
	m.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if m.delay > 0 {
			time.Sleep(m.delay)
		}
		raw, _ := io.ReadAll(r.Body)
		m.mu.Lock()
		defer m.mu.Unlock()
		m.calls = append(m.calls, upstreamCall{
			method: r.Method,
			auth:   r.Header.Get("Authorization"),
			body:   string(raw),
		})
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(m.status)
		_, _ = w.Write([]byte(m.body))
	}))
	t.Cleanup(m.server.Close)
	return m
}

func (m *mockMCP) recorded() []upstreamCall {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]upstreamCall(nil), m.calls...)
}

// fakeAuth stands in for auth.Middleware: it derives the user from a header
// so one engine can act as several users. Token verification itself is the
// api package's contract, not this package's. X-Test-Role feeds the role
// claim (default admin: the pre-existing tests act as the pool manager).
func fakeAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		role := c.GetHeader("X-Test-Role")
		if role == "" {
			role = "admin"
		}
		c.Set(auth.ClaimsKey, &acauth.Claims{
			Role:             role,
			RegisteredClaims: jwt.RegisteredClaims{Subject: c.GetHeader("X-Test-User")},
		})
		c.Next()
	}
}

func newEnv(t *testing.T) (*gin.Engine, *store.Store) {
	t.Helper()
	// Unique shared-cache in-memory DB: one per test, no disk artifacts.
	dsn := fmt.Sprintf("file:mcp-test-%d?mode=memory&cache=shared", time.Now().UnixNano())
	st, err := store.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.AutoMigrate(); err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	Register(r.Group("/api/v1", fakeAuth()).Group("/mcp"), st, auth.RequireRoles("admin", "owner"))
	return r, st
}

// doRole issues a request with an explicit X-Test-Role (fakeAuth maps it to
// the claims role): the admin-gate tests need non-default roles.
func doRole(r *gin.Engine, method, path, user, role string, body any) *httptest.ResponseRecorder {
	var rd io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			panic(err)
		}
		rd = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, rd)
	req.Header.Set("X-Test-User", user)
	req.Header.Set("X-Test-Role", role)
	if rd != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func doReq(r *gin.Engine, method, path, user, authHeader string, body any) *httptest.ResponseRecorder {
	var rd io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			panic(err)
		}
		rd = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, rd)
	req.Header.Set("X-Test-User", user)
	if authHeader != "" {
		req.Header.Set("Authorization", authHeader)
	}
	if rd != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func registerUpstream(t *testing.T, r *gin.Engine, name, baseURL, token string, enabled any) *httptest.ResponseRecorder {
	t.Helper()
	body := map[string]any{"name": name, "base_url": baseURL}
	if token != "" {
		body["auth_token"] = token
	}
	if enabled != nil {
		body["enabled"] = enabled
	}
	w := doReq(r, http.MethodPost, "/api/v1/mcp/upstreams", "admin", "", body)
	if w.Code != http.StatusCreated {
		t.Fatalf("register %s = %d %s", name, w.Code, w.Body.String())
	}
	return w
}

func registerUpstreamWithTools(t *testing.T, r *gin.Engine, name, baseURL string, tools []string) *httptest.ResponseRecorder {
	t.Helper()
	body := map[string]any{"name": name, "base_url": baseURL, "allowed_tools": tools}
	w := doReq(r, http.MethodPost, "/api/v1/mcp/upstreams", "admin", "", body)
	if w.Code != http.StatusCreated {
		t.Fatalf("register %s = %d %s", name, w.Code, w.Body.String())
	}
	return w
}

func decode(t *testing.T, w *httptest.ResponseRecorder, into any) {
	t.Helper()
	if err := json.Unmarshal(w.Body.Bytes(), into); err != nil {
		t.Fatalf("decode %s: %v", w.Body.String(), err)
	}
}

func auditRows(t *testing.T, r *gin.Engine, user string, limit string) []auditView {
	t.Helper()
	path := "/api/v1/mcp/audit"
	if limit != "" {
		path += "?limit=" + limit
	}
	w := doReq(r, http.MethodGet, path, user, "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("audit list = %d %s", w.Code, w.Body.String())
	}
	var body struct {
		Audit []auditView `json:"audit"`
	}
	decode(t, w, &body)
	return body.Audit
}

func TestProxyRelaysBodyStatusAndInjectsUpstreamToken(t *testing.T) {
	mock := newMockMCP(t)
	r, st := newEnv(t)
	registerUpstream(t, r, "echo", mock.server.URL, "up-secret", nil)

	rpc := map[string]any{"jsonrpc": "2.0", "id": 1, "method": "ping", "params": map[string]int{"n": 1}}
	sent, err := json.Marshal(rpc)
	if err != nil {
		t.Fatal(err)
	}
	w := doReq(r, http.MethodPost, "/api/v1/mcp/echo/proxy", "u1", "Bearer hub-token", rpc)
	if w.Code != http.StatusOK {
		t.Fatalf("proxy = %d %s", w.Code, w.Body.String())
	}
	if w.Body.String() != mcpReply {
		t.Fatalf("response body not relayed verbatim: %s", w.Body.String())
	}
	if got := w.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("content-type = %q", got)
	}

	calls := mock.recorded()
	if len(calls) != 1 {
		t.Fatalf("upstream calls = %d, want 1", len(calls))
	}
	if calls[0].method != http.MethodPost || calls[0].body != string(sent) {
		t.Fatalf("upstream saw %+v, want POST with body %s", calls[0], sent)
	}
	// The hub token must be replaced by the upstream token, never forwarded.
	if calls[0].auth != "Bearer up-secret" {
		t.Fatalf("upstream Authorization = %q, want upstream token injected", calls[0].auth)
	}

	rows, err := st.ListMcpAudit("u1", 10)
	if err != nil || len(rows) != 1 {
		t.Fatalf("audit rows = %+v err = %v", rows, err)
	}
	a := rows[0]
	if a.UserID != "u1" || a.Upstream != "echo" || a.Method != http.MethodPost ||
		a.Path != "/api/v1/mcp/echo/proxy" || a.StatusCode != http.StatusOK || a.DurationMs < 0 {
		t.Fatalf("audit row = %+v", a)
	}

	// GET proxies too and lands in the same audit trail, newest first.
	if w = doReq(r, http.MethodGet, "/api/v1/mcp/echo/proxy", "u1", "Bearer hub-token", nil); w.Code != http.StatusOK {
		t.Fatalf("GET proxy = %d %s", w.Code, w.Body.String())
	}
	if calls = mock.recorded(); len(calls) != 2 || calls[1].method != http.MethodGet {
		t.Fatalf("upstream calls = %+v", calls)
	}
	views := auditRows(t, r, "u1", "")
	if len(views) != 2 || views[0].Method != http.MethodGet || views[1].Method != http.MethodPost {
		t.Fatalf("audit views = %+v", views)
	}
}

// 2026-11-10 audit tightening: without a configured upstream token no
// Authorization reaches the upstream at all — the caller's hub JWT must
// never leave the server, even when the caller presents one.
func TestProxySendsNoAuthorizationWithoutUpstreamToken(t *testing.T) {
	mock := newMockMCP(t)
	r, _ := newEnv(t)
	registerUpstream(t, r, "passthru", mock.server.URL, "", nil)

	doReq(r, http.MethodPost, "/api/v1/mcp/passthru/proxy", "u1", "Bearer caller-jwt",
		map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
	calls := mock.recorded()
	if len(calls) != 1 {
		t.Fatalf("calls = %d", len(calls))
	}
	if calls[0].auth != "" {
		t.Fatalf("Authorization = %q, want none relayed", calls[0].auth)
	}

	// Neither side has a credential: still no Authorization header.
	doReq(r, http.MethodPost, "/api/v1/mcp/passthru/proxy", "u1", "",
		map[string]any{"jsonrpc": "2.0", "id": 3, "method": "tools/list"})
	if calls = mock.recorded(); len(calls) != 2 || calls[1].auth != "" {
		t.Fatalf("no-credential call = %+v, want empty Authorization", calls[1])
	}
}

func TestProxyUnknownUpstreamNotFound(t *testing.T) {
	mock := newMockMCP(t)
	r, _ := newEnv(t)

	w := doReq(r, http.MethodPost, "/api/v1/mcp/ghost/proxy", "u1", "",
		map[string]any{"jsonrpc": "2.0", "id": 1, "method": "ping"})
	if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "UPSTREAM_NOT_FOUND") {
		t.Fatalf("unknown upstream = %d %s", w.Code, w.Body.String())
	}
	if calls := mock.recorded(); len(calls) != 0 {
		t.Fatalf("unknown name must not reach any upstream: %+v", calls)
	}
	if rows := auditRows(t, r, "u1", ""); len(rows) != 0 {
		t.Fatalf("unresolved calls must not audit: %+v", rows)
	}
}

// A false Enabled surviving registration is the *bool fix's observable
// contract: with a plain bool the GORM default:true pitfall flips it back on
// and the proxy would relay instead of answering 409.
func TestProxyDisabledUpstreamConflict(t *testing.T) {
	mock := newMockMCP(t)
	r, _ := newEnv(t)
	registerUpstream(t, r, "off", mock.server.URL, "up-secret", false)

	w := doReq(r, http.MethodPost, "/api/v1/mcp/off/proxy", "u1", "",
		map[string]any{"jsonrpc": "2.0", "id": 1, "method": "ping"})
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "UPSTREAM_DISABLED") {
		t.Fatalf("disabled upstream = %d %s", w.Code, w.Body.String())
	}
	if calls := mock.recorded(); len(calls) != 0 {
		t.Fatalf("disabled upstream must not be called: %+v", calls)
	}

	w = doReq(r, http.MethodGet, "/api/v1/mcp/upstreams", "u1", "", nil)
	var list struct {
		Upstreams []upstreamView `json:"upstreams"`
	}
	decode(t, w, &list)
	if len(list.Upstreams) != 1 || list.Upstreams[0].Enabled || !list.Upstreams[0].HasToken {
		t.Fatalf("upstream views = %+v, want enabled=false has_token=true", list.Upstreams)
	}
}

func TestProxyRelaysNon2xxVerbatim(t *testing.T) {
	mock := newMockMCP(t)
	mock.status = http.StatusBadRequest
	mock.body = `{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"invalid request"}}`
	r, _ := newEnv(t)
	registerUpstream(t, r, "echo", mock.server.URL, "up-secret", nil)

	w := doReq(r, http.MethodPost, "/api/v1/mcp/echo/proxy", "u1", "",
		map[string]any{"jsonrpc": "2.0", "id": 1, "method": "ping"})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("non-2xx status not relayed: %d", w.Code)
	}
	if w.Body.String() != mock.body {
		t.Fatalf("error body not relayed verbatim: %s", w.Body.String())
	}
	rows := auditRows(t, r, "u1", "")
	if len(rows) != 1 || rows[0].StatusCode != http.StatusBadRequest {
		t.Fatalf("audit = %+v, want the 400 recorded", rows)
	}
}

func TestUpstreamListHidesToken(t *testing.T) {
	mock := newMockMCP(t)
	r, _ := newEnv(t)
	registerUpstream(t, r, "secret", mock.server.URL, "sk-mcp-very-secret", nil)
	registerUpstream(t, r, "bare", mock.server.URL, "", nil)

	w := doReq(r, http.MethodGet, "/api/v1/mcp/upstreams", "u1", "", nil)
	if strings.Contains(w.Body.String(), "sk-mcp-very-secret") {
		t.Fatalf("token leaked in list response: %s", w.Body.String())
	}
	var list struct {
		Upstreams []upstreamView `json:"upstreams"`
	}
	decode(t, w, &list)
	if len(list.Upstreams) != 2 {
		t.Fatalf("upstreams = %+v", list.Upstreams)
	}
	byName := map[string]upstreamView{}
	for _, u := range list.Upstreams {
		byName[u.Name] = u
	}
	if !byName["secret"].HasToken || byName["bare"].HasToken {
		t.Fatalf("has_token = %+v", byName)
	}

	w = doReq(r, http.MethodPost, "/api/v1/mcp/upstreams", "u1", "",
		map[string]any{"name": "secret2", "base_url": mock.server.URL, "auth_token": "sk-mcp-very-secret"})
	if strings.Contains(w.Body.String(), "sk-mcp-very-secret") {
		t.Fatalf("token leaked in create response: %s", w.Body.String())
	}
}

func TestAuditIsolationAndLimit(t *testing.T) {
	mock := newMockMCP(t)
	r, st := newEnv(t)
	registerUpstream(t, r, "echo", mock.server.URL, "up-secret", nil)

	for _, user := range []string{"alice", "alice", "bob"} {
		w := doReq(r, http.MethodPost, "/api/v1/mcp/echo/proxy", user, "",
			map[string]any{"jsonrpc": "2.0", "id": 1, "method": "ping"})
		if w.Code != http.StatusOK {
			t.Fatalf("proxy for %s = %d %s", user, w.Code, w.Body.String())
		}
	}

	if rows := auditRows(t, r, "alice", ""); len(rows) != 2 {
		t.Fatalf("alice sees %d rows, want her 2", len(rows))
	}
	if rows := auditRows(t, r, "bob", ""); len(rows) != 1 {
		t.Fatalf("bob sees %d rows, want his 1", len(rows))
	}
	if rows := auditRows(t, r, "alice", "1"); len(rows) != 1 {
		t.Fatalf("limit=1 returned %d rows", len(rows))
	}
	for _, user := range []string{"alice", "bob", "carol"} {
		rows, err := st.ListMcpAudit(user, 10)
		if err != nil {
			t.Fatal(err)
		}
		want := map[string]int{"alice": 2, "bob": 1, "carol": 0}[user]
		if len(rows) != want {
			t.Fatalf("store rows for %s = %d, want %d", user, len(rows), want)
		}
	}
}

// The audit limit clamps at 500 instead of erroring: a caller asking for
// more gets the cap, never a 400 and never an unbounded scan.
func TestAuditLimitClampedTo500(t *testing.T) {
	r, st := newEnv(t)
	for i := 0; i < 501; i++ {
		if err := st.CreateMcpAudit(&store.McpAudit{
			UserID: "u1", Upstream: "bulk", Method: http.MethodPost,
			Path: "/api/v1/mcp/bulk/proxy", StatusCode: http.StatusOK,
		}); err != nil {
			t.Fatal(err)
		}
	}
	rows := auditRows(t, r, "u1", "1000")
	if len(rows) != 500 {
		t.Fatalf("limit=1000 returned %d rows, want the 500 cap", len(rows))
	}
	if rows = auditRows(t, r, "u1", "1"); len(rows) != 1 {
		t.Fatalf("small limits unaffected: %d rows", len(rows))
	}
}

func TestUpstreamValidationAndDelete(t *testing.T) {
	mock := newMockMCP(t)
	r, _ := newEnv(t)

	if w := doReq(r, http.MethodPost, "/api/v1/mcp/upstreams", "u1", "",
		map[string]any{"name": "no-url"}); w.Code != http.StatusBadRequest {
		t.Fatalf("missing base_url = %d %s", w.Code, w.Body.String())
	}
	registerUpstream(t, r, "echo", mock.server.URL, "", nil)
	if w := doReq(r, http.MethodPost, "/api/v1/mcp/upstreams", "u1", "",
		map[string]any{"name": "echo", "base_url": mock.server.URL}); w.Code != http.StatusConflict {
		t.Fatalf("duplicate name = %d %s", w.Code, w.Body.String())
	}

	if w := doReq(r, http.MethodDelete, "/api/v1/mcp/upstreams/echo", "u1", "", nil); w.Code != http.StatusOK {
		t.Fatalf("delete = %d %s", w.Code, w.Body.String())
	}
	if w := doReq(r, http.MethodPost, "/api/v1/mcp/echo/proxy", "u1", "",
		map[string]any{"jsonrpc": "2.0", "id": 1, "method": "ping"}); w.Code != http.StatusNotFound {
		t.Fatalf("proxy after delete = %d %s", w.Code, w.Body.String())
	}
	if w := doReq(r, http.MethodDelete, "/api/v1/mcp/upstreams/echo", "u1", "", nil); w.Code != http.StatusOK {
		t.Fatalf("delete of absent name must be idempotent: %d %s", w.Code, w.Body.String())
	}
	w := doReq(r, http.MethodGet, "/api/v1/mcp/upstreams", "u1", "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list = %d", w.Code)
	}
	var list struct {
		Upstreams []upstreamView `json:"upstreams"`
	}
	decode(t, w, &list)
	if len(list.Upstreams) != 0 {
		t.Fatalf("after delete: %+v", list.Upstreams)
	}

	if w := doReq(r, http.MethodGet, "/api/v1/mcp/audit?limit=0", "u1", "", nil); w.Code != http.StatusBadRequest {
		t.Fatalf("limit=0 = %d %s", w.Code, w.Body.String())
	}
}

func TestProxyTimeoutReturnsBadGatewayAndAudits(t *testing.T) {
	oldTimeout := upstreamTimeout
	upstreamTimeout = 150 * time.Millisecond
	t.Cleanup(func() { upstreamTimeout = oldTimeout })

	mock := newMockMCP(t)
	mock.delay = 500 * time.Millisecond
	r, _ := newEnv(t) // Register bakes the shortened timeout into the client
	registerUpstream(t, r, "slow", mock.server.URL, "", nil)

	w := doReq(r, http.MethodPost, "/api/v1/mcp/slow/proxy", "u1", "",
		map[string]any{"jsonrpc": "2.0", "id": 1, "method": "ping"})
	if w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), "BAD_GATEWAY") {
		t.Fatalf("timeout = %d %s", w.Code, w.Body.String())
	}
	rows := auditRows(t, r, "u1", "")
	if len(rows) != 1 || rows[0].StatusCode != http.StatusBadGateway {
		t.Fatalf("audit = %+v, want the 502 recorded", rows)
	}
}

// toolsListReply is the mock's canned tools/list answer for the filter
// tests: two keepers and two blockers, with a nested inputSchema so a kept
// tool can be checked for full-object survival.
const toolsListReply = `{"jsonrpc":"2.0","id":7,"result":{"tools":[` +
	`{"name":"keep_a","description":"keeper a","inputSchema":{"type":"object","properties":{"q":{"type":"string"}}}},` +
	`{"name":"drop_b","description":"blocker b","inputSchema":{"type":"object"}},` +
	`{"name":"keep_c","description":"keeper c"},` +
	`{"name":"drop_d","description":"blocker d"}],"nextCursor":null}}`

func TestProxyAllowedToolCallRelays(t *testing.T) {
	mock := newMockMCP(t)
	r, _ := newEnv(t)
	registerUpstreamWithTools(t, r, "gated", mock.server.URL, []string{"keep_a"})

	w := doReq(r, http.MethodPost, "/api/v1/mcp/gated/proxy", "u1", "",
		map[string]any{"jsonrpc": "2.0", "id": 5, "method": "tools/call",
			"params": map[string]any{"name": "keep_a", "arguments": map[string]string{"q": "hi"}}})
	if w.Code != http.StatusOK || w.Body.String() != mcpReply {
		t.Fatalf("allowed tools/call = %d %s", w.Code, w.Body.String())
	}
	if calls := mock.recorded(); len(calls) != 1 {
		t.Fatalf("allowed tools/call must reach the upstream: %+v", calls)
	}
}

func TestProxyDisallowedToolCallDeniedBeforeUpstream(t *testing.T) {
	mock := newMockMCP(t)
	r, _ := newEnv(t)
	registerUpstreamWithTools(t, r, "gated", mock.server.URL, []string{"keep_a"})

	w := doReq(r, http.MethodPost, "/api/v1/mcp/gated/proxy", "u1", "",
		map[string]any{"jsonrpc": "2.0", "id": "req-7", "method": "tools/call",
			"params": map[string]any{"name": "drop_b"}})
	if w.Code != http.StatusOK {
		t.Fatalf("a denial rides HTTP 200 per JSON-RPC semantics, got %d %s", w.Code, w.Body.String())
	}
	var resp struct {
		JSONRPC string `json:"jsonrpc"`
		ID      string `json:"id"`
		Error   struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	decode(t, w, &resp)
	if resp.JSONRPC != "2.0" || resp.ID != "req-7" ||
		resp.Error.Code != -32603 || resp.Error.Message != "tool not allowed: drop_b" {
		t.Fatalf("denial = %+v", resp)
	}
	if calls := mock.recorded(); len(calls) != 0 {
		t.Fatalf("denied call must never reach the upstream: %+v", calls)
	}
	rows := auditRows(t, r, "u1", "")
	if len(rows) != 1 || rows[0].Upstream != "gated" || rows[0].Method != "tools/call:drop_b" ||
		rows[0].Path != "gated" || rows[0].StatusCode != http.StatusOK {
		t.Fatalf("denial audit = %+v, want method tools/call:drop_b path gated", rows)
	}
}

func TestProxyToolsListFilteredToAllowlist(t *testing.T) {
	mock := newMockMCP(t)
	mock.body = toolsListReply
	r, _ := newEnv(t)
	registerUpstreamWithTools(t, r, "gated", mock.server.URL, []string{"keep_a", "keep_c"})

	w := doReq(r, http.MethodPost, "/api/v1/mcp/gated/proxy", "u1", "",
		map[string]any{"jsonrpc": "2.0", "id": 7, "method": "tools/list"})
	if w.Code != http.StatusOK {
		t.Fatalf("tools/list = %d %s", w.Code, w.Body.String())
	}
	var resp struct {
		Result struct {
			Tools []struct {
				Name        string          `json:"name"`
				Description string          `json:"description"`
				Schema      json.RawMessage `json:"inputSchema"`
			} `json:"tools"`
		} `json:"result"`
	}
	decode(t, w, &resp)
	tools := resp.Result.Tools
	if len(tools) != 2 || tools[0].Name != "keep_a" || tools[1].Name != "keep_c" {
		t.Fatalf("filtered tools = %+v, want keep_a then keep_c", tools)
	}
	if tools[0].Description != "keeper a" || len(tools[0].Schema) == 0 {
		t.Fatalf("kept tool lost fields: %+v", tools[0])
	}
	if calls := mock.recorded(); len(calls) != 1 {
		t.Fatalf("tools/list must reach the upstream: %+v", calls)
	}
}

func TestProxyToolsListUnfilteredWithoutAllowlist(t *testing.T) {
	mock := newMockMCP(t)
	mock.body = toolsListReply
	r, _ := newEnv(t)
	registerUpstream(t, r, "open", mock.server.URL, "", nil)

	w := doReq(r, http.MethodPost, "/api/v1/mcp/open/proxy", "u1", "",
		map[string]any{"jsonrpc": "2.0", "id": 7, "method": "tools/list"})
	if w.Code != http.StatusOK || w.Body.String() != toolsListReply {
		t.Fatalf("tools/list without allowlist = %d %s", w.Code, w.Body.String())
	}
}

func TestProxyToolsListNonJSONResponseRelaysVerbatim(t *testing.T) {
	mock := newMockMCP(t)
	mock.body = "<html>mcp is down"
	r, _ := newEnv(t)
	registerUpstreamWithTools(t, r, "gated", mock.server.URL, []string{"keep_a"})

	w := doReq(r, http.MethodPost, "/api/v1/mcp/gated/proxy", "u1", "",
		map[string]any{"jsonrpc": "2.0", "id": 7, "method": "tools/list"})
	if w.Code != http.StatusOK || w.Body.String() != mock.body {
		t.Fatalf("non-JSON tools/list must relay verbatim: %d %s", w.Code, w.Body.String())
	}
}

func TestUpstreamAllowedToolsRoundTrip(t *testing.T) {
	mock := newMockMCP(t)
	r, _ := newEnv(t)

	w := registerUpstreamWithTools(t, r, "gated", mock.server.URL, []string{"keep_a", "keep_c"})
	var created struct {
		Upstream upstreamView `json:"upstream"`
	}
	decode(t, w, &created)
	if got := created.Upstream.AllowedTools; len(got) != 2 || got[0] != "keep_a" || got[1] != "keep_c" {
		t.Fatalf("create view allowed_tools = %+v", got)
	}

	registerUpstream(t, r, "open", mock.server.URL, "", nil)
	w = doReq(r, http.MethodGet, "/api/v1/mcp/upstreams", "u1", "", nil)
	var list struct {
		Upstreams []upstreamView `json:"upstreams"`
	}
	decode(t, w, &list)
	byName := map[string]upstreamView{}
	for _, u := range list.Upstreams {
		byName[u.Name] = u
	}
	if got := byName["gated"].AllowedTools; len(got) != 2 || got[0] != "keep_a" || got[1] != "keep_c" {
		t.Fatalf("list view allowed_tools = %+v", got)
	}
	if got := byName["open"].AllowedTools; len(got) != 0 {
		t.Fatalf("no allowlist must read back empty, got %+v", got)
	}
}

// B1（roadmap-r4）：upstream 注册表写面仅 admin/owner 可入（RequireRoles 门），
// user 角色 403 FORBIDDEN；读面与代理不设角色门。
func TestUpstreamRegistryAdminGate(t *testing.T) {
	r, _ := newEnv(t)
	body := map[string]any{"name": "gated", "base_url": "http://127.0.0.1:1"}

	w := doRole(r, http.MethodPost, "/api/v1/mcp/upstreams", "u1", "user", body)
	if w.Code != http.StatusForbidden {
		t.Fatalf("user create = %d %s, want 403", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "FORBIDDEN") {
		t.Fatalf("403 body must follow error envelope: %s", w.Body.String())
	}
	w = doRole(r, http.MethodDelete, "/api/v1/mcp/upstreams/gated", "u1", "user", nil)
	if w.Code != http.StatusForbidden {
		t.Fatalf("user delete = %d %s, want 403", w.Code, w.Body.String())
	}

	// 读面对所有持牌用户开放
	w = doRole(r, http.MethodGet, "/api/v1/mcp/upstreams", "u1", "user", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("user list = %d %s, want 200", w.Code, w.Body.String())
	}

	// owner 在默认角色集内，可通过写面
	w = doRole(r, http.MethodPost, "/api/v1/mcp/upstreams", "boss", "owner", body)
	if w.Code != http.StatusCreated {
		t.Fatalf("owner create = %d %s, want 201", w.Code, w.Body.String())
	}
}

// C3（depth-batch-r9c）API 面启停：PATCH /upstreams/:name 翻转 enabled，
// 生效与否以代理 409/200 为准；未知名字 404，缺 enabled 400，user 角色 403。
func TestUpstreamTogglePatch(t *testing.T) {
	mock := newMockMCP(t)
	r, _ := newEnv(t)
	registerUpstream(t, r, "toggle", mock.server.URL, "", nil)
	ping := map[string]any{"jsonrpc": "2.0", "id": 1, "method": "ping"}

	if w := doReq(r, http.MethodPatch, "/api/v1/mcp/upstreams/toggle", "u1", "",
		map[string]any{"enabled": false}); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"ok"`) {
		t.Fatalf("disable = %d %s", w.Code, w.Body.String())
	}
	if w := doReq(r, http.MethodPost, "/api/v1/mcp/toggle/proxy", "u1", "", ping); w.Code != http.StatusConflict {
		t.Fatalf("proxy after disable = %d, want 409", w.Code)
	}

	// 重复置 true（值未变）仍 200，不是 404
	if w := doReq(r, http.MethodPatch, "/api/v1/mcp/upstreams/toggle", "u1", "",
		map[string]any{"enabled": true}); w.Code != http.StatusOK {
		t.Fatalf("re-enable = %d %s", w.Code, w.Body.String())
	}
	if w := doReq(r, http.MethodPatch, "/api/v1/mcp/upstreams/toggle", "u1", "",
		map[string]any{"enabled": true}); w.Code != http.StatusOK {
		t.Fatalf("idempotent re-set = %d, want 200", w.Code)
	}
	if w := doReq(r, http.MethodPost, "/api/v1/mcp/toggle/proxy", "u1", "", ping); w.Code != http.StatusOK {
		t.Fatalf("proxy after re-enable = %d, want 200", w.Code)
	}

	if w := doReq(r, http.MethodPatch, "/api/v1/mcp/upstreams/ghost", "u1", "",
		map[string]any{"enabled": false}); w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "UPSTREAM_NOT_FOUND") {
		t.Fatalf("unknown name = %d %s, want 404 envelope", w.Code, w.Body.String())
	}

	if w := doReq(r, http.MethodPatch, "/api/v1/mcp/upstreams/toggle", "u1", "", map[string]any{}); w.Code != http.StatusBadRequest {
		t.Fatalf("missing enabled = %d %s, want 400", w.Code, w.Body.String())
	}
	if w := doReq(r, http.MethodPatch, "/api/v1/mcp/upstreams/toggle", "u1", "", "not json"); w.Code != http.StatusBadRequest {
		t.Fatalf("bad json = %d %s, want 400", w.Code, w.Body.String())
	}

	w := doRole(r, http.MethodPatch, "/api/v1/mcp/upstreams/toggle", "u1", "user", map[string]any{"enabled": false})
	if w.Code != http.StatusForbidden {
		t.Fatalf("user toggle = %d %s, want 403", w.Code, w.Body.String())
	}
}

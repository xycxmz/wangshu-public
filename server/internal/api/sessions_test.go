package api

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"

	"github.com/xycxmz/company-platform-v1/server/internal/auth/acauth"
	"github.com/xycxmz/company-platform-v1/server/internal/config"
	"github.com/xycxmz/company-platform-v1/server/internal/store"
)

const (
	testAppID = "api-test"
	testKID   = "k1"
)

func newTestServer(t *testing.T) (*gin.Engine, *store.Store, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	jwks, err := json.Marshal(map[string]any{
		"keys": []map[string]string{{
			"kty": "OKP", "crv": "Ed25519", "kid": testKID,
			"x": base64.RawURLEncoding.EncodeToString(pub),
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(filepath.Join(t.TempDir(), "hub.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.AutoMigrate(); err != nil {
		t.Fatal(err)
	}
	verifier := acauth.New("http://127.0.0.1:1/never-fetched", testAppID, string(jwks))
	r := gin.New()
	// AdminRoles 与生产默认一致（HUB_ADMIN_ROLES 未设 ⇒ admin,owner）：空集=全拒，
	// 会把 403 断言测成假阳性。
	Register(r, &config.Config{AdminRoles: []string{"admin", "owner"}}, st, verifier)
	return r, st, priv
}

func signToken(t *testing.T, priv ed25519.PrivateKey, sub string) string {
	t.Helper()
	return signRoleToken(t, priv, sub, "")
}

// signRoleToken mints a token carrying a role claim (empty ⇒ no role) for the
// management-plane gate tests (B1, roadmap-r4).
func signRoleToken(t *testing.T, priv ed25519.PrivateKey, sub, role string) string {
	t.Helper()
	claims := &acauth.Claims{
		Role: role,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   sub,
			Audience:  jwt.ClaimStrings{testAppID},
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	tok.Header["kid"] = testKID
	s, err := tok.SignedString(priv)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func do(r *gin.Engine, method, path, token string, body any) *httptest.ResponseRecorder {
	var rd io.Reader
	switch b := body.(type) {
	case nil:
	case string:
		rd = strings.NewReader(b)
	default:
		raw, err := json.Marshal(b)
		if err != nil {
			panic(err)
		}
		rd = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, rd)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if rd != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func decode(t *testing.T, w *httptest.ResponseRecorder, into any) {
	t.Helper()
	if err := json.Unmarshal(w.Body.Bytes(), into); err != nil {
		t.Fatalf("decode %s: %v", w.Body.String(), err)
	}
}

func createdSessionID(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Session sessionView `json:"session"`
	}
	decode(t, w, &body)
	if body.Session.ID == "" {
		t.Fatalf("no session id in %s", w.Body.String())
	}
	return body.Session.ID
}

func TestSessionsCRUD(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r, st, priv := newTestServer(t)
	tok := signToken(t, priv, "u-crud")

	w := do(r, http.MethodPost, "/api/v1/sessions", tok, map[string]any{"title": "Chat one", "model_name": "glm-flash"})
	if w.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", w.Code, w.Body.String())
	}
	var created struct {
		Session sessionView `json:"session"`
	}
	decode(t, w, &created)
	id := created.Session.ID
	if created.Session.Title != "Chat one" || created.Session.ModelName != "glm-flash" {
		t.Fatalf("create echo = %+v", created.Session)
	}

	w = do(r, http.MethodPatch, "/api/v1/sessions/"+id, tok, map[string]any{"title": "Renamed", "model_name": "byok:sk-mine/glm"})
	if w.Code != http.StatusOK {
		t.Fatalf("patch status = %d, body = %s", w.Code, w.Body.String())
	}
	var patched struct {
		Session sessionView `json:"session"`
	}
	decode(t, w, &patched)
	if patched.Session.Title != "Renamed" || patched.Session.ModelName != "byok:sk-mine/glm" {
		t.Fatalf("patch echo = %+v", patched.Session)
	}
	if !patched.Session.UpdatedAt.After(created.Session.UpdatedAt.Add(-time.Millisecond)) {
		t.Fatalf("updated_at not bumped: %s", patched.Session.UpdatedAt)
	}

	w = do(r, http.MethodGet, "/api/v1/sessions", tok, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list status = %d", w.Code)
	}
	var list struct {
		Sessions []sessionView `json:"sessions"`
	}
	decode(t, w, &list)
	if len(list.Sessions) != 1 || list.Sessions[0].ID != id {
		t.Fatalf("list = %+v", list.Sessions)
	}

	w = do(r, http.MethodGet, "/api/v1/sessions/"+id+"/messages", tok, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("empty messages status = %d, body = %s", w.Code, w.Body.String())
	}
	var empty struct {
		Messages []messageView `json:"messages"`
	}
	decode(t, w, &empty)
	if len(empty.Messages) != 0 {
		t.Fatalf("fresh session has messages: %+v", empty.Messages)
	}

	w = do(r, http.MethodDelete, "/api/v1/sessions/"+id, tok, nil)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"ok"`) {
		t.Fatalf("delete = %d %s", w.Code, w.Body.String())
	}
	if w = do(r, http.MethodPatch, "/api/v1/sessions/"+id, tok, map[string]any{"title": "x"}); w.Code != http.StatusNotFound {
		t.Fatalf("patch after delete = %d, want 404", w.Code)
	}
	if w = do(r, http.MethodGet, "/api/v1/sessions/"+id+"/messages", tok, nil); w.Code != http.StatusNotFound {
		t.Fatalf("messages after delete = %d, want 404", w.Code)
	}
	w = do(r, http.MethodGet, "/api/v1/sessions", tok, nil)
	decode(t, w, &list)
	if len(list.Sessions) != 0 {
		t.Fatalf("list after delete = %+v", list.Sessions)
	}
	_ = st
}

func TestSessionsOwnershipIsolation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r, _, priv := newTestServer(t)
	tokA := signToken(t, priv, "user-a")
	tokB := signToken(t, priv, "user-b")

	w := do(r, http.MethodPost, "/api/v1/sessions", tokA, map[string]any{"title": "A only"})
	if w.Code != http.StatusCreated {
		t.Fatalf("create status = %d", w.Code)
	}
	id := createdSessionID(t, w)

	if w = do(r, http.MethodPatch, "/api/v1/sessions/"+id, tokB, map[string]any{"title": "hijack"}); w.Code != http.StatusNotFound {
		t.Fatalf("B patch = %d, want 404", w.Code)
	}
	if w = do(r, http.MethodDelete, "/api/v1/sessions/"+id, tokB, nil); w.Code != http.StatusNotFound {
		t.Fatalf("B delete = %d, want 404", w.Code)
	}
	if w = do(r, http.MethodGet, "/api/v1/sessions/"+id+"/messages", tokB, nil); w.Code != http.StatusNotFound {
		t.Fatalf("B messages = %d, want 404", w.Code)
	}
	w = do(r, http.MethodGet, "/api/v1/sessions", tokB, nil)
	var list struct {
		Sessions []sessionView `json:"sessions"`
	}
	decode(t, w, &list)
	if len(list.Sessions) != 0 {
		t.Fatalf("B must not see A's sessions: %+v", list.Sessions)
	}

	if w = do(r, http.MethodGet, "/api/v1/sessions/"+id+"/messages", tokA, nil); w.Code != http.StatusOK {
		t.Fatalf("A messages after B probes = %d", w.Code)
	}
}

func TestSessionDeleteCascadesMessages(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r, st, priv := newTestServer(t)
	tok := signToken(t, priv, "u-cascade")

	w := do(r, http.MethodPost, "/api/v1/sessions", tok, map[string]any{"title": "with history"})
	id := createdSessionID(t, w)
	for i := 0; i < 3; i++ {
		if err := st.CreateMessage(&store.Message{SessionID: id, Role: "user", Content: "m", ModelName: "glm-flash"}); err != nil {
			t.Fatal(err)
		}
	}
	msgs, err := st.ListMessages(id)
	if err != nil || len(msgs) != 3 {
		t.Fatalf("setup messages = %+v err = %v", msgs, err)
	}

	if w = do(r, http.MethodDelete, "/api/v1/sessions/"+id, tok, nil); w.Code != http.StatusOK {
		t.Fatalf("delete = %d %s", w.Code, w.Body.String())
	}
	msgs, err = st.ListMessages(id)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 0 {
		t.Fatalf("cascade left %d messages", len(msgs))
	}
}

func TestSessionMessagesOrderingAndFields(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r, st, priv := newTestServer(t)
	tok := signToken(t, priv, "u-msg")

	w := do(r, http.MethodPost, "/api/v1/sessions", tok, map[string]any{"title": "order", "model_name": "glm-flash"})
	id := createdSessionID(t, w)
	fixture := []store.Message{
		{SessionID: id, Role: "user", Content: "first", ModelName: "glm-flash"},
		{SessionID: id, Role: "assistant", Content: "second", ModelName: "glm-flash", TokensIn: 3, TokensOut: 4, CostCents: 2},
		{SessionID: id, Role: "user", Content: "third", ModelName: "glm-flash"},
	}
	for i := range fixture {
		if err := st.CreateMessage(&fixture[i]); err != nil {
			t.Fatal(err)
		}
	}

	w = do(r, http.MethodGet, "/api/v1/sessions/"+id+"/messages", tok, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var body struct {
		Messages []messageView `json:"messages"`
	}
	decode(t, w, &body)
	if len(body.Messages) != 3 {
		t.Fatalf("messages = %+v", body.Messages)
	}
	for i, want := range []string{"first", "second", "third"} {
		if body.Messages[i].Content != want {
			t.Fatalf("order broken: %+v", body.Messages)
		}
	}
	assistant := body.Messages[1]
	if assistant.Role != "assistant" || assistant.ModelName != "glm-flash" ||
		assistant.TokensIn != 3 || assistant.TokensOut != 4 || assistant.CostCents != 2 || assistant.ID == 0 {
		t.Fatalf("assistant fields = %+v", assistant)
	}
}

// R9-A A1 读侧兼容：分段形态 content 回 JSON 数组；旧纯文本（含恰好像
// JSON 的文本但元素形状不符）一律回字符串。
func TestMessagesContentPartsReadCompat(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r, st, priv := newTestServer(t)
	tok := signToken(t, priv, "u-parts")

	w := do(r, http.MethodPost, "/api/v1/sessions", tok, map[string]any{"title": "vision", "model_name": "glm-flash"})
	id := createdSessionID(t, w)
	fixture := []store.Message{
		{SessionID: id, Role: "user", Content: `[{"type":"text","text":"看图"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AA"}}]`, ModelName: "glm-flash"},
		{SessionID: id, Role: "assistant", Content: "图中是一个任务报告封面", ModelName: "glm-flash"},
		{SessionID: id, Role: "user", Content: `[{"type":"text","text":1}]`, ModelName: "glm-flash"},
	}
	for i := range fixture {
		if err := st.CreateMessage(&fixture[i]); err != nil {
			t.Fatal(err)
		}
	}

	w = do(r, http.MethodGet, "/api/v1/sessions/"+id+"/messages", tok, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var body struct {
		Messages []struct {
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	decode(t, w, &body)
	if len(body.Messages) != 3 {
		t.Fatalf("messages = %s", w.Body.String())
	}
	var parts []store.ContentPart
	if err := json.Unmarshal(body.Messages[0].Content, &parts); err != nil || len(parts) != 2 ||
		parts[0].Text != "看图" || parts[1].ImageURL == nil || parts[1].ImageURL.URL != "data:image/png;base64,AA" {
		t.Fatalf("parts row = %s", body.Messages[0].Content)
	}
	var text string
	if err := json.Unmarshal(body.Messages[1].Content, &text); err != nil || text != "图中是一个任务报告封面" {
		t.Fatalf("plain row = %s", body.Messages[1].Content)
	}
	// 元素形状不符的数组按旧文本原样回
	if err := json.Unmarshal(body.Messages[2].Content, &text); err != nil || text != fixture[2].Content {
		t.Fatalf("malformed row = %s, want verbatim %q", body.Messages[2].Content, fixture[2].Content)
	}
}

func TestUsageSummaryOnlyCurrentUser(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r, st, priv := newTestServer(t)
	tokA := signToken(t, priv, "user-a")
	tokB := signToken(t, priv, "user-b")

	today := time.Now().Format("2006-01-02")
	older := time.Now().AddDate(0, 0, -40).Format("2006-01-02")
	for _, u := range []store.UsageDaily{
		{Date: today, UserID: "user-a", ModelName: "glm-flash", TokensIn: 10, TokensOut: 20, CostCents: 5, Requests: 2},
		{Date: today, UserID: "user-b", ModelName: "glm-flash", TokensIn: 99, TokensOut: 99, CostCents: 99, Requests: 9},
		{Date: older, UserID: "user-a", ModelName: "glm-flash", TokensIn: 1, TokensOut: 1, CostCents: 1, Requests: 1},
	} {
		if err := st.AddUsage(&u); err != nil {
			t.Fatal(err)
		}
	}

	w := do(r, http.MethodGet, "/api/v1/usage", tokA, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var body struct {
		Usage []usageView `json:"usage"`
	}
	decode(t, w, &body)
	if len(body.Usage) != 1 {
		t.Fatalf("30-day window must hide B and the old row: %+v", body.Usage)
	}
	row := body.Usage[0]
	if row.Date != today || row.ModelName != "glm-flash" ||
		row.TokensIn != 10 || row.TokensOut != 20 || row.CostCents != 5 || row.Requests != 2 {
		t.Fatalf("A's row = %+v", row)
	}

	w = do(r, http.MethodGet, "/api/v1/usage?days=60", tokA, nil)
	decode(t, w, &body)
	if len(body.Usage) != 2 {
		t.Fatalf("60-day window = %+v", body.Usage)
	}

	w = do(r, http.MethodGet, "/api/v1/usage", tokB, nil)
	decode(t, w, &body)
	if len(body.Usage) != 1 || body.Usage[0].TokensIn != 99 || body.Usage[0].Requests != 9 {
		t.Fatalf("B's rows = %+v", body.Usage)
	}

	if w = do(r, http.MethodGet, "/api/v1/usage?days=0", tokA, nil); w.Code != http.StatusBadRequest {
		t.Fatalf("days=0 = %d, want 400", w.Code)
	}
}

func TestMessageAppendMetaWhitelist(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r, _, priv := newTestServer(t)
	tok := signToken(t, priv, "u-meta")

	w := do(r, http.MethodPost, "/api/v1/sessions", tok, map[string]any{"title": "meta", "model_name": "glm-flash"})
	id := createdSessionID(t, w)

	// 合法 meta：单键 task_id，h 前缀或纯数字。
	w = do(r, http.MethodPost, "/api/v1/sessions/"+id+"/messages", tok,
		map[string]any{"role": "assistant", "content": "任务卡 · 失败重试", "meta": map[string]any{"task_id": "h42"}})
	if w.Code != http.StatusCreated {
		t.Fatalf("valid meta = %d, body = %s", w.Code, w.Body.String())
	}

	// 无 meta：合法且响应省略该字段。
	w = do(r, http.MethodPost, "/api/v1/sessions/"+id+"/messages", tok,
		map[string]any{"role": "user", "content": "普通消息"})
	if w.Code != http.StatusCreated {
		t.Fatalf("no meta = %d", w.Code)
	}

	// 白名单外：多键 / 非法 task_id / 非对象，一律 400。
	for name, meta := range map[string]any{
		"extra key":  map[string]any{"task_id": "h1", "foo": "bar"},
		"bad id":     map[string]any{"task_id": "../etc"},
		"not object": "h1",
	} {
		w = do(r, http.MethodPost, "/api/v1/sessions/"+id+"/messages", tok,
			map[string]any{"role": "assistant", "content": "x", "meta": meta})
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s = %d, want 400", name, w.Code)
		}
	}

	// role 白名单与空 content。
	if w = do(r, http.MethodPost, "/api/v1/sessions/"+id+"/messages", tok,
		map[string]any{"role": "system", "content": "x"}); w.Code != http.StatusBadRequest {
		t.Fatalf("role=system = %d, want 400", w.Code)
	}
	if w = do(r, http.MethodPost, "/api/v1/sessions/"+id+"/messages", tok,
		map[string]any{"role": "user", "content": "  "}); w.Code != http.StatusBadRequest {
		t.Fatalf("blank content = %d, want 400", w.Code)
	}

	// 回读：meta 只出现在携带行，形状还原为对象。
	w = do(r, http.MethodGet, "/api/v1/sessions/"+id+"/messages", tok, nil)
	var body struct {
		Messages []messageView `json:"messages"`
	}
	decode(t, w, &body)
	if len(body.Messages) != 2 {
		t.Fatalf("messages = %+v", body.Messages)
	}
	if string(body.Messages[0].Meta) != `{"task_id":"h42"}` {
		t.Fatalf("meta roundtrip = %q", string(body.Messages[0].Meta))
	}
	if len(body.Messages[1].Meta) != 0 {
		t.Fatalf("no-meta row must omit meta: %+v", body.Messages[1])
	}
}

// C2 会话搜索端点：camelCase 契约、命中标题/消息、通配转义、q 校验。
func TestSessionSearchEndpoint(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r, st, priv := newTestServer(t)
	tokA := signToken(t, priv, "user-a")
	tokB := signToken(t, priv, "user-b")

	w := do(r, http.MethodPost, "/api/v1/sessions", tokA, map[string]any{"title": "Quarterly Report", "model_name": "glm-flash"})
	s1 := createdSessionID(t, w)
	if err := st.CreateMessage(&store.Message{SessionID: s1, Role: "user", Content: "2026 Q3 数字回顾", ModelName: "glm-flash"}); err != nil {
		t.Fatal(err)
	}
	w = do(r, http.MethodPost, "/api/v1/sessions", tokA, map[string]any{"title": "随手记", "model_name": "glm-flash"})
	s2 := createdSessionID(t, w)
	long := strings.Repeat("前", 60) + "Report" + strings.Repeat("后", 60)
	if err := st.CreateMessage(&store.Message{SessionID: s2, Role: "user", Content: long, ModelName: "glm-flash"}); err != nil {
		t.Fatal(err)
	}
	// B 的同名会话不得进入 A 的结果
	w = do(r, http.MethodPost, "/api/v1/sessions", tokB, map[string]any{"title": "B 的 Report"})
	createdSessionID(t, w)

	type result struct {
		SessionID string    `json:"sessionId"`
		Title     string    `json:"title"`
		Snippet   string    `json:"snippet"`
		CreatedAt time.Time `json:"createdAt"`
	}
	search := func(q string) (int, []result) {
		w := do(r, http.MethodGet, "/api/v1/sessions/search?q="+url.QueryEscape(q), tokA, nil)
		var body struct {
			Results []result `json:"results"`
		}
		if w.Code == http.StatusOK {
			decode(t, w, &body)
		}
		return w.Code, body.Results
	}

	code, results := search("Report")
	if code != http.StatusOK {
		t.Fatalf("search = %d %s", code, w.Body.String())
	}
	if len(results) != 2 {
		t.Fatalf("results = %+v, want s2 and s1 (B isolated)", results)
	}
	// s2 的消息写入更晚，updated_at 倒序在前
	if results[0].SessionID != s2 || results[1].SessionID != s1 {
		t.Fatalf("order = [%s %s], want updated_at DESC", results[0].SessionID, results[1].SessionID)
	}
	if want := strings.Repeat("前", 40) + "Report" + strings.Repeat("后", 40); results[0].Snippet != want {
		t.Fatalf("message snippet = %q, want %q", results[0].Snippet, want)
	}
	if results[1].Snippet != "" {
		t.Fatalf("title hit must carry empty snippet, got %q", results[1].Snippet)
	}
	if results[1].CreatedAt.IsZero() {
		t.Fatal("createdAt missing from the wire shape")
	}

	// 中文关键词经 URL 编码往返
	if _, results = search("数字回顾"); len(results) != 1 || results[0].SessionID != s1 {
		t.Fatalf("chinese q = %+v", results)
	}

	// 空 q 与纯空白：200 + 空结果
	for _, q := range []string{"", "   "} {
		if code, results = search(q); code != http.StatusOK || len(results) != 0 {
			t.Fatalf("blank q %q = %d %+v", q, code, results)
		}
	}

	// 通配注入：q="%" 不全匹配
	if code, results = search("%"); code != http.StatusOK || len(results) != 0 {
		t.Fatalf("q=%% = %d %+v, want no match-all", code, results)
	}

	// q 长度：按字符计，101 个中文字符（303 字节）超限 400
	if code, _ = search(strings.Repeat("词", 101)); code != http.StatusBadRequest {
		t.Fatalf("101-rune q = %d, want 400", code)
	}
	if code, _ = search(strings.Repeat("词", 100)); code != http.StatusOK {
		t.Fatalf("100-rune q = %d, want 200", code)
	}

	// B 视角：自己的 Report 命中，看不到 A 的
	w = do(r, http.MethodGet, "/api/v1/sessions/search?q=Report", tokB, nil)
	var bodyB struct {
		Results []result `json:"results"`
	}
	decode(t, w, &bodyB)
	if len(bodyB.Results) != 1 || bodyB.Results[0].Title != "B 的 Report" {
		t.Fatalf("B results = %+v", bodyB.Results)
	}
}

func TestSessionMessagesPagination(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r, st, priv := newTestServer(t)
	tok := signToken(t, priv, "u-page")

	w := do(r, http.MethodPost, "/api/v1/sessions", tok, map[string]any{"title": "page", "model_name": "glm-flash"})
	id := createdSessionID(t, w)
	for i := 0; i < 55; i++ {
		if err := st.CreateMessage(&store.Message{SessionID: id, Role: "user", Content: fmt.Sprintf("m%02d", i), ModelName: "glm-flash"}); err != nil {
			t.Fatal(err)
		}
	}
	get := func(path string) ([]string, bool) {
		w := do(r, http.MethodGet, path, tok, nil)
		if w.Code != http.StatusOK {
			t.Fatalf("%s = %d", path, w.Code)
		}
		var body struct {
			Messages []messageView `json:"messages"`
			HasMore  bool          `json:"has_more"`
		}
		decode(t, w, &body)
		out := make([]string, 0, len(body.Messages))
		for _, m := range body.Messages {
			out = append(out, m.Content.(string))
		}
		return out, body.HasMore
	}

	// 默认：最新 50 条正序，has_more=true
	first, more := get("/api/v1/sessions/" + id + "/messages")
	if len(first) != 50 || !more || first[0] != "m05" || first[49] != "m54" {
		t.Fatalf("first page head/tail = %v…%v more=%v", first[0], first[49], more)
	}

	// 游标向前翻：以首页最旧 id 取更早 5 条，has_more=false
	_, _ = get("/api/v1/sessions/" + id + "/messages") // 重取拿 id
	w2 := do(r, http.MethodGet, "/api/v1/sessions/"+id+"/messages?limit=50", tok, nil)
	var probe struct {
		Messages []messageView `json:"messages"`
	}
	decode(t, w2, &probe)
	oldest := probe.Messages[0].ID
	older, more2 := get(fmt.Sprintf("/api/v1/sessions/%s/messages?before_id=%d", id, oldest))
	if len(older) != 5 || more2 || older[0] != "m00" || older[4] != "m04" {
		t.Fatalf("older page = %v more=%v", older, more2)
	}

	// 越界参数 400
	if w := do(r, http.MethodGet, "/api/v1/sessions/"+id+"/messages?limit=0", tok, nil); w.Code != http.StatusBadRequest {
		t.Fatalf("limit=0 = %d", w.Code)
	}
	if w := do(r, http.MethodGet, "/api/v1/sessions/"+id+"/messages?before_id=-1", tok, nil); w.Code != http.StatusBadRequest {
		t.Fatalf("before_id=-1 = %d", w.Code)
	}
}

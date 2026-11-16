package kb

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"

	"github.com/xycxmz/company-platform-v1/server/internal/auth"
	"github.com/xycxmz/company-platform-v1/server/internal/auth/acauth"
	"github.com/xycxmz/company-platform-v1/server/internal/config"
	"github.com/xycxmz/company-platform-v1/server/internal/store"
)

func configFor(m *mockEmbedServer) config.Config {
	return config.Config{MaterialBaseURL: m.server.URL, MaterialAPIKey: "sk-test"}
}

// fakeAuth 同 material 测试：X-Test-User 头顶替 auth.Middleware。
func fakeAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Set(auth.ClaimsKey, &acauth.Claims{
			RegisteredClaims: jwt.RegisteredClaims{Subject: c.GetHeader("X-Test-User")},
		})
		c.Next()
	}
}

func newRouter(t *testing.T, emb EmbedClient) (*gin.Engine, *store.Store, *fakeEmbed) {
	t.Helper()
	dsn := fmt.Sprintf("file:kb-api-test-%d?mode=memory&cache=shared", time.Now().UnixNano())
	st, err := store.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.AutoMigrate(); err != nil {
		t.Fatal(err)
	}
	svc, err := NewService(st, emb)
	if err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterService(r.Group("/api/v1/kb", fakeAuth()), svc)
	fe, _ := emb.(*fakeEmbed)
	return r, st, fe
}

// newSeededRouter 先落一行语料再构造 Service（启动加载路径），用于需要
// 非空索引但 embedding 不可用的场景。
func newSeededRouter(t *testing.T, emb EmbedClient) (*gin.Engine, *store.Store) {
	t.Helper()
	dsn := fmt.Sprintf("file:kb-seed-test-%d?mode=memory&cache=shared", time.Now().UnixNano())
	st, err := store.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.AutoMigrate(); err != nil {
		t.Fatal(err)
	}
	if err := st.CreateKbDoc(&store.KbDoc{ID: "d-seed", UserID: "u1", ChunkCount: 1, CreatedAt: time.Now()},
		[]store.KbChunk{{ID: "c-seed", DocID: "d-seed", Seq: 0, Text: "存量", Embedding: vecToBytes([]float32{1}), CreatedAt: time.Now()}}); err != nil {
		t.Fatal(err)
	}
	svc, err := NewService(st, emb)
	if err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterService(r.Group("/api/v1/kb", fakeAuth()), svc)
	return r, st
}

func do(r *gin.Engine, method, path, user string, body any) *httptest.ResponseRecorder {
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
	if rd != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func defaultFake() *fakeEmbed {
	return &fakeEmbed{tokens: 42, vecFn: func(string) []float32 { return []float32{1, 0} }}
}

// 全链契约：入库（doc 形状）→ 检索（hits 形状 + score 降序）→ 列表
// （更新序）→ 删除 → 检索空 → 列表空。
func TestKbLifecycle(t *testing.T) {
	r, st, emb := newRouter(t, defaultFake())
	emb.qv = []float32{1, 0} // 检索向量与入库同向 → score=1

	w := do(r, http.MethodPost, "/api/v1/kb/docs", "u1", map[string]any{
		"title": "望舒手册", "sourceType": "paste", "sourceRef": "", "content": "第一段。\n\n第二段。",
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", w.Code, w.Body.String())
	}
	var created struct {
		Doc docView `json:"doc"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	d := created.Doc
	if d.ID == "" || d.Title != "望舒手册" || d.SourceType != "paste" || d.SourceRef != "" ||
		d.ChunkCount != 1 || d.CreatedAt.IsZero() {
		t.Fatalf("doc view = %+v", d)
	}

	w = do(r, http.MethodPost, "/api/v1/kb/search", "u1", map[string]any{"q": "望舒"})
	if w.Code != http.StatusOK {
		t.Fatalf("search = %d %s", w.Code, w.Body.String())
	}
	var search struct {
		Hits []Hit `json:"hits"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &search); err != nil {
		t.Fatal(err)
	}
	if len(search.Hits) != 1 {
		t.Fatalf("hits = %+v", search.Hits)
	}
	h := search.Hits[0]
	if h.DocID != d.ID || h.Title != "望舒手册" || h.Seq != 0 || h.Text == "" || h.Score != 1 {
		t.Fatalf("hit = %+v", h)
	}

	w = do(r, http.MethodGet, "/api/v1/kb/docs", "u1", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list = %d %s", w.Code, w.Body.String())
	}
	var list struct {
		Docs []docView `json:"docs"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Docs) != 1 || list.Docs[0].ID != d.ID {
		t.Fatalf("docs = %+v", list.Docs)
	}

	if w = do(r, http.MethodDelete, "/api/v1/kb/docs/"+d.ID, "u1", nil); w.Code != http.StatusOK {
		t.Fatalf("delete = %d %s", w.Code, w.Body.String())
	}
	var del struct {
		Status string `json:"status"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &del)
	if del.Status != "ok" {
		t.Fatalf("delete body = %s", w.Body.String())
	}

	w = do(r, http.MethodPost, "/api/v1/kb/search", "u1", map[string]any{"q": "望舒"})
	if w.Code != http.StatusOK {
		t.Fatalf("search after delete = %d %s", w.Code, w.Body.String())
	}
	search.Hits = nil
	_ = json.Unmarshal(w.Body.Bytes(), &search)
	if len(search.Hits) != 0 {
		t.Fatalf("hits after delete = %+v", search.Hits)
	}
	w = do(r, http.MethodGet, "/api/v1/kb/docs", "u1", nil)
	list.Docs = nil
	_ = json.Unmarshal(w.Body.Bytes(), &list)
	if len(list.Docs) != 0 {
		t.Fatalf("docs after delete = %+v", list.Docs)
	}
	if rows, _ := st.UsageSummary("u1", 1); len(rows) != 1 || rows[0].ModelName != "kb:embedding" {
		t.Fatalf("usage = %+v", rows)
	}
}

// 列表更新序：新入库在前。
func TestKbListNewestFirst(t *testing.T) {
	r, _, _ := newRouter(t, defaultFake())
	for _, title := range []string{"旧", "新"} {
		w := do(r, http.MethodPost, "/api/v1/kb/docs", "u1", map[string]any{
			"title": title, "sourceType": "paste", "content": title + " 内容",
		})
		if w.Code != http.StatusCreated {
			t.Fatalf("create %s = %d %s", title, w.Code, w.Body.String())
		}
		time.Sleep(10 * time.Millisecond) // created_at 分辨率
	}
	w := do(r, http.MethodGet, "/api/v1/kb/docs", "u1", nil)
	var list struct {
		Docs []docView `json:"docs"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &list)
	if len(list.Docs) != 2 || list.Docs[0].Title != "新" || list.Docs[1].Title != "旧" {
		t.Fatalf("order = %+v", list.Docs)
	}
}

// 跨用户隔离：B 列表/检索/删除均不见 A 的文档。
func TestKbOwnershipIsolation(t *testing.T) {
	r, _, emb := newRouter(t, defaultFake())
	w := do(r, http.MethodPost, "/api/v1/kb/docs", "alice", map[string]any{
		"sourceType": "paste", "content": "Alice 的私有内容",
	})
	var created struct {
		Doc docView `json:"doc"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	if created.Doc.ID == "" {
		t.Fatalf("create = %d %s", w.Code, w.Body.String())
	}

	emb.qv = []float32{1, 0}
	if w = do(r, http.MethodGet, "/api/v1/kb/docs", "bob", nil); w.Code != http.StatusOK {
		t.Fatal(w.Code)
	}
	var list struct {
		Docs []docView `json:"docs"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &list)
	if len(list.Docs) != 0 {
		t.Fatalf("bob sees alice's docs: %+v", list.Docs)
	}

	w = do(r, http.MethodPost, "/api/v1/kb/search", "bob", map[string]any{"q": "私有"})
	var search struct {
		Hits []Hit `json:"hits"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &search)
	if len(search.Hits) != 0 {
		t.Fatalf("bob searches alice's corpus: %+v", search.Hits)
	}
	if w = do(r, http.MethodDelete, "/api/v1/kb/docs/"+created.Doc.ID, "bob", nil); w.Code != http.StatusNotFound {
		t.Fatalf("bob deletes alice's doc = %d %s", w.Code, w.Body.String())
	}
	if w = do(r, http.MethodDelete, "/api/v1/kb/docs/"+created.Doc.ID, "alice", nil); w.Code != http.StatusOK {
		t.Fatalf("alice deletes own = %d %s", w.Code, w.Body.String())
	}
}

// 边界校验全部 4xx，且不出网（embedding 零调用）。
func TestKbValidation(t *testing.T) {
	r, _, emb := newRouter(t, defaultFake())
	cases := []struct {
		name         string
		method, path string
		body         map[string]any
	}{
		{"bad sourceType", http.MethodPost, "/api/v1/kb/docs", map[string]any{"sourceType": "telepathy", "content": "x"}},
		{"blank content", http.MethodPost, "/api/v1/kb/docs", map[string]any{"sourceType": "paste", "content": "   "}},
		{"oversize content", http.MethodPost, "/api/v1/kb/docs", map[string]any{"sourceType": "paste", "content": strings.Repeat("超", 1<<20)}},
		{"long title", http.MethodPost, "/api/v1/kb/docs", map[string]any{"sourceType": "paste", "content": "x", "title": strings.Repeat("题", 256)}},
		{"long sourceRef", http.MethodPost, "/api/v1/kb/docs", map[string]any{"sourceType": "url", "content": "x", "sourceRef": strings.Repeat("u", 1025)}},
		{"blank q", http.MethodPost, "/api/v1/kb/search", map[string]any{"q": " "}},
		{"long q", http.MethodPost, "/api/v1/kb/search", map[string]any{"q": strings.Repeat("问", 2001)}},
		{"k zero", http.MethodPost, "/api/v1/kb/search", map[string]any{"q": "问", "k": 0}},
		{"k huge", http.MethodPost, "/api/v1/kb/search", map[string]any{"q": "问", "k": 51}},
	}
	for _, tc := range cases {
		w := do(r, tc.method, tc.path, "u1", tc.body)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s = %d %s", tc.name, w.Code, w.Body.String())
		}
	}
	if emb.calls != 0 {
		t.Fatalf("invalid requests must not reach embedding: %d calls", emb.calls)
	}

	// k 缺省 4；k=1 合法。
	emb.qv = []float32{1, 0}
	if w := do(r, http.MethodPost, "/api/v1/kb/docs", "u1", map[string]any{"sourceType": "paste", "content": "正文"}); w.Code != http.StatusCreated {
		t.Fatalf("valid create = %d %s", w.Code, w.Body.String())
	}
	if w := do(r, http.MethodPost, "/api/v1/kb/search", "u1", map[string]any{"q": "问"}); w.Code != http.StatusOK {
		t.Fatalf("default k search = %d %s", w.Code, w.Body.String())
	}
}

// 未配置（503）与上游失败（502 + 无落库）。
func TestKbEmbeddingFailureModes(t *testing.T) {
	r, _, _ := newRouter(t, &fakeEmbed{err: ErrNotConfigured, vecFn: func(string) []float32 { return []float32{1} }})
	if w := do(r, http.MethodPost, "/api/v1/kb/docs", "u1", map[string]any{"sourceType": "paste", "content": "正文"}); w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "KB_NOT_CONFIGURED") {
		t.Fatalf("not configured create = %d %s", w.Code, w.Body.String())
	}
	// 空语料短路在 embedding 之前：空库检索答 200 空命中（不出网）。
	if w := do(r, http.MethodPost, "/api/v1/kb/search", "u1", map[string]any{"q": "问"}); w.Code != http.StatusOK {
		t.Fatalf("not configured but empty corpus = %d %s", w.Code, w.Body.String())
	}

	// 有语料时未配置才浮出：构造服务前先落一行（启动加载可见），检索
	// → 503。
	r, st := newSeededRouter(t, &fakeEmbed{err: ErrNotConfigured, vecFn: func(string) []float32 { return []float32{1} }})
	if w := do(r, http.MethodPost, "/api/v1/kb/search", "u1", map[string]any{"q": "问"}); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("not configured search with corpus = %d %s", w.Code, w.Body.String())
	}

	r, st, _ = newRouter(t, &fakeEmbed{err: errors.New("upstream down"), vecFn: func(string) []float32 { return []float32{1} }})
	w := do(r, http.MethodPost, "/api/v1/kb/docs", "u1", map[string]any{"sourceType": "paste", "content": "正文"})
	if w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), "KB_EMBEDDING") {
		t.Fatalf("upstream fail = %d %s", w.Code, w.Body.String())
	}
	if docs, _ := st.ListKbDocs("u1"); len(docs) != 0 {
		t.Fatalf("failed ingest leaked rows: %+v", docs)
	}
	if rows, _ := st.UsageSummary("u1", 1); len(rows) != 0 {
		t.Fatalf("failed ingest leaked usage: %+v", rows)
	}
}

// Register（装配入口）路径：mock DashScope server + 真 Embedder，含启动
// 加载存量 → 检索命中。
func TestKbRegisterWithRealEmbedderAndExistingRows(t *testing.T) {
	m := newMockEmbedServer(t, 3)
	dsn := fmt.Sprintf("file:kb-reg-test-%d?mode=memory&cache=shared", time.Now().UnixNano())
	st, err := store.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.AutoMigrate(); err != nil {
		t.Fatal(err)
	}
	// 存量：绕过 API 直接落一行（旧进程留下的语料）。
	if err := st.CreateKbDoc(&store.KbDoc{ID: "seed-doc", UserID: "u1", Title: "存量", SourceType: "paste", ChunkCount: 1, CreatedAt: time.Now()},
		[]store.KbChunk{{ID: "seed-chunk", DocID: "seed-doc", Seq: 0, Text: "存量内容", Embedding: vecToBytes([]float32{1, 0.5, 0}), CreatedAt: time.Now()}}); err != nil {
		t.Fatal(err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	cfg := configFor(m)
	Register(r.Group("/api/v1/kb", fakeAuth()), st, &cfg)

	w := do(r, http.MethodPost, "/api/v1/kb/search", "u1", map[string]any{"q": "存量"})
	if w.Code != http.StatusOK {
		t.Fatalf("search = %d %s", w.Code, w.Body.String())
	}
	var search struct {
		Hits []Hit `json:"hits"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &search)
	if len(search.Hits) != 1 || search.Hits[0].DocID != "seed-doc" || search.Hits[0].Score <= 0 {
		t.Fatalf("hits = %+v (startup load broken)", search.Hits)
	}

	// 新入库走真 Embedder 线格式（model 常量）。
	w = do(r, http.MethodPost, "/api/v1/kb/docs", "u1", map[string]any{"sourceType": "file", "sourceRef": "a.md", "content": "新文档"})
	if w.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", w.Code, w.Body.String())
	}
	if len(m.calls) != 2 || m.calls[len(m.calls)-1].model != "qwen3.7-text-embedding" {
		t.Fatalf("embedder calls = %+v", m.calls)
	}
}

// 同 sourceRef 重入契约：两次 POST 都是 201 + 同形 doc；第一次
// updated=false，第二次 updated=true 且 doc.id 不变。
func TestKbReingestUpdatedFlag(t *testing.T) {
	r, _, _ := newRouter(t, defaultFake())

	post := func() (docView, bool, int) {
		w := do(r, http.MethodPost, "/api/v1/kb/docs", "u1", map[string]any{
			"title": "手册", "sourceType": "url", "sourceRef": "https://a.md", "content": "内容",
		})
		var body struct {
			Doc     docView `json:"doc"`
			Updated *bool   `json:"updated"` // 指针区分缺字段与 false
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body.Doc, body.Updated != nil && *body.Updated, w.Code
	}

	first, updated, code := post()
	if code != http.StatusCreated || updated || first.ID == "" {
		t.Fatalf("first = %d updated=%v doc=%+v", code, updated, first)
	}
	second, updated, code := post()
	if code != http.StatusCreated || !updated {
		t.Fatalf("reingest = %d updated=%v, want 201 true", code, updated)
	}
	if second.ID != first.ID || !second.CreatedAt.Equal(first.CreatedAt) {
		t.Fatalf("reingest doc = %+v, want same id/createdAt as %+v", second, first)
	}

	// 空 ref 连续 POST 不去重：两次都 updated=false。
	w := do(r, http.MethodPost, "/api/v1/kb/docs", "u1", map[string]any{"sourceType": "paste", "content": "粘贴"})
	var paste1 struct {
		Updated bool `json:"updated"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &paste1)
	w = do(r, http.MethodPost, "/api/v1/kb/docs", "u1", map[string]any{"sourceType": "paste", "content": "再粘贴"})
	var paste2 struct {
		Doc     docView `json:"doc"`
		Updated bool    `json:"updated"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &paste2)
	if paste1.Updated || paste2.Updated {
		t.Fatalf("empty-ref pastes flagged updated: %v %v", paste1.Updated, paste2.Updated)
	}
}

// rebuild 端点契约：POST /api/v1/kb/rebuild 200，camelCase 形状
// {rebuilt, approximated, dim}；存量旧档（无 content）计入 approximated；
// 有语料时未配置 503、上游失败 502（空库则无需 embedding，200 零值）。
func TestKbRebuildEndpoint(t *testing.T) {
	r, st, _ := newRouter(t, defaultFake())
	if w := do(r, http.MethodPost, "/api/v1/kb/docs", "u1", map[string]any{"sourceType": "paste", "content": "现行原文"}); w.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", w.Code, w.Body.String())
	}
	if err := st.CreateKbDoc(&store.KbDoc{ID: "d-legacy", UserID: "u1", Title: "旧档", SourceType: "paste", ChunkCount: 1, CreatedAt: time.Now()},
		[]store.KbChunk{{ID: "c-legacy", DocID: "d-legacy", Seq: 0, Text: "旧档近似原文", Embedding: vecToBytes([]float32{1, 0}), CreatedAt: time.Now()}}); err != nil {
		t.Fatal(err)
	}

	w := do(r, http.MethodPost, "/api/v1/kb/rebuild", "u1", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("rebuild = %d %s", w.Code, w.Body.String())
	}
	var res RebuildResult
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.Rebuilt != 2 || res.Approximated != 1 || res.Dim != 2 {
		t.Fatalf("rebuild body = %s, want {rebuilt:2 approximated:1 dim:2}", w.Body.String())
	}

	// bob 空库 rebuild：无 embedding 也 200 全零（本人语义，别人文档不掺入）。
	w = do(r, http.MethodPost, "/api/v1/kb/rebuild", "bob", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("empty rebuild = %d %s", w.Code, w.Body.String())
	}
	res = RebuildResult{}
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	if res.Rebuilt != 0 || res.Approximated != 0 || res.Dim != 0 {
		t.Fatalf("empty rebuild body = %s, want zeros", w.Body.String())
	}

	// 有语料的失败面：未配置 503；上游失败 502 KB_EMBEDDING。
	r2, _ := newSeededRouter(t, &fakeEmbed{err: ErrNotConfigured, vecFn: func(string) []float32 { return []float32{1} }})
	if w = do(r2, http.MethodPost, "/api/v1/kb/rebuild", "u1", nil); w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "KB_NOT_CONFIGURED") {
		t.Fatalf("not configured rebuild = %d %s", w.Code, w.Body.String())
	}
	r3, _ := newSeededRouter(t, &fakeEmbed{err: errors.New("upstream down"), vecFn: func(string) []float32 { return []float32{1} }})
	if w = do(r3, http.MethodPost, "/api/v1/kb/rebuild", "u1", nil); w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), "KB_EMBEDDING") {
		t.Fatalf("upstream fail rebuild = %d %s", w.Code, w.Body.String())
	}
}

// 换模型重建（真 Embedder 线）：mock 上游维度 3 → 6，rebuild 先重置 dim
// 记录再整库重嵌——不重置则真 Embedder 的维度一致校验会拒绝（见
// TestEmbedDimRecordedThenEnforced），rebuild 将 502。
func TestKbRebuildResetsEmbedderDim(t *testing.T) {
	m := newMockEmbedServer(t, 3)
	dsn := fmt.Sprintf("file:kb-rebuild-dim-test-%d?mode=memory&cache=shared", time.Now().UnixNano())
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
	cfg := configFor(m)
	Register(r.Group("/api/v1/kb", fakeAuth()), st, &cfg)

	if w := do(r, http.MethodPost, "/api/v1/kb/docs", "u1", map[string]any{"sourceType": "paste", "content": "重建前的原文"}); w.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", w.Code, w.Body.String())
	}

	m.mu.Lock()
	m.dim = 6 // 换模型：上游从此回 6 维
	m.mu.Unlock()

	w := do(r, http.MethodPost, "/api/v1/kb/rebuild", "u1", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("rebuild after model swap = %d %s", w.Code, w.Body.String())
	}
	var res RebuildResult
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	if res.Rebuilt != 1 || res.Dim != 6 {
		t.Fatalf("rebuild = %+v, want rebuilt 1 at dim 6", res)
	}

	w = do(r, http.MethodPost, "/api/v1/kb/search", "u1", map[string]any{"q": "原文"})
	if w.Code != http.StatusOK {
		t.Fatalf("search after swap rebuild = %d %s", w.Code, w.Body.String())
	}
	var search struct {
		Hits []Hit `json:"hits"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &search)
	if len(search.Hits) != 1 || search.Hits[0].Score <= 0 {
		t.Fatalf("hits = %+v, want the re-embedded chunk", search.Hits)
	}
}

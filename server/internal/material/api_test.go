package material

import (
	"bytes"
	"context"
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
	"github.com/xycxmz/company-platform-v1/server/internal/config"
	"github.com/xycxmz/company-platform-v1/server/internal/store"
)

// scriptStep is one mock DashScope poll reply.
type scriptStep struct {
	status  string
	url     string // results[0].url when SUCCEEDED
	message string // output.message
}

type submitCall struct {
	path        string
	model       string
	prompt      string
	authHeader  string
	asyncHeader string
}

// mockDashScope serves the two submit endpoints plus /api/v1/tasks/{id}.
// Polls advance the script and then repeat its last step; submits are
// recorded for assertions. A non-200 submitStatus makes every submit fail.
type mockDashScope struct {
	mu           sync.Mutex
	server       *httptest.Server
	submits      []submitCall
	submitStatus int
	submitError  string
	script       []scriptStep
}

func newMockDashScope(t *testing.T, script []scriptStep) *mockDashScope {
	t.Helper()
	m := &mockDashScope{script: script, submitStatus: http.StatusOK}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/services/aigc/text2image/image-synthesis", func(w http.ResponseWriter, r *http.Request) {
		m.handleSubmit(w, r)
	})
	mux.HandleFunc("/api/v1/services/aigc/video-generation/video-synthesis", func(w http.ResponseWriter, r *http.Request) {
		m.handleSubmit(w, r)
	})
	mux.HandleFunc("/api/v1/tasks/", func(w http.ResponseWriter, r *http.Request) {
		m.handlePoll(w, r)
	})
	m.server = httptest.NewServer(mux)
	t.Cleanup(m.server.Close)
	return m
}

func (m *mockDashScope) handleSubmit(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	raw, _ := io.ReadAll(r.Body)
	var req submitRequest
	_ = json.Unmarshal(raw, &req)
	m.submits = append(m.submits, submitCall{
		path:        r.URL.Path,
		model:       req.Model,
		prompt:      req.Input.Prompt,
		authHeader:  r.Header.Get("Authorization"),
		asyncHeader: r.Header.Get("X-DashScope-Async"),
	})
	if m.submitStatus != http.StatusOK {
		w.WriteHeader(m.submitStatus)
		_, _ = w.Write([]byte(m.submitError))
		return
	}
	fmt.Fprintf(w, `{"output":{"task_id":"ds-%d","task_status":"PENDING"},"request_id":"r"}`, len(m.submits))
}

func (m *mockDashScope) handlePoll(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	step := scriptStep{status: "RUNNING"}
	if len(m.script) > 0 {
		step = m.script[0]
		if len(m.script) > 1 {
			m.script = m.script[1:]
		}
	}
	out := map[string]any{"task_status": step.status, "results": nil}
	if step.url != "" {
		out["results"] = []map[string]string{{"url": step.url}}
	}
	if step.message != "" {
		out["message"] = step.message
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"output": out, "request_id": "r"})
}

// fakeAuth stands in for auth.Middleware: it derives the user from a header
// so one engine can act as several users. Token verification itself is the
// api package's contract, not this package's.
func fakeAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Set(auth.ClaimsKey, &acauth.Claims{
			RegisteredClaims: jwt.RegisteredClaims{Subject: c.GetHeader("X-Test-User")},
		})
		c.Next()
	}
}

func newEnv(t *testing.T, mock *mockDashScope, apiKey string) (*gin.Engine, *store.Store, *config.Config) {
	t.Helper()
	// Unique shared-cache in-memory DB: one per test, no disk artifacts.
	dsn := fmt.Sprintf("file:material-test-%d?mode=memory&cache=shared", time.Now().UnixNano())
	st, err := store.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.AutoMigrate(); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{
		MaterialBaseURL:    mock.server.URL,
		MaterialAPIKey:     apiKey,
		MaterialImageModel: "wanx-test-t2i",
		MaterialVideoModel: "wan-test-t2v",
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	Register(r.Group("/api/v1", fakeAuth()).Group("/material"), st, cfg)
	return r, st, cfg
}

func startWorker(t *testing.T, st *store.Store, cfg *config.Config) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go NewWorker(st, cfg).Run(ctx)
}

func fastPoll(t *testing.T) {
	t.Helper()
	oldInterval, oldTimeout := pollInterval, taskTimeout
	pollInterval, taskTimeout = 50*time.Millisecond, 15*time.Minute
	t.Cleanup(func() { pollInterval, taskTimeout = oldInterval, oldTimeout })
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

func decode(t *testing.T, w *httptest.ResponseRecorder, into any) {
	t.Helper()
	if err := json.Unmarshal(w.Body.Bytes(), into); err != nil {
		t.Fatalf("decode %s: %v", w.Body.String(), err)
	}
}

func createdTask(t *testing.T, w *httptest.ResponseRecorder) taskView {
	t.Helper()
	var body struct {
		Task taskView `json:"task"`
	}
	decode(t, w, &body)
	if body.Task.ID == "" {
		t.Fatalf("no task id in %s", w.Body.String())
	}
	return body.Task
}

func waitTask(t *testing.T, r *gin.Engine, user, id, want string) taskView {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		w := do(r, http.MethodGet, "/api/v1/material/generations/"+id, user, nil)
		if w.Code != http.StatusOK {
			t.Fatalf("get task = %d %s", w.Code, w.Body.String())
		}
		var body struct {
			Task taskView `json:"task"`
		}
		decode(t, w, &body)
		if body.Task.Status == want {
			return body.Task
		}
		if time.Now().After(deadline) {
			t.Fatalf("task %s stuck at %q, want %q", id, body.Task.Status, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestGenerationLifecycleSucceeds(t *testing.T) {
	fastPoll(t)
	mock := newMockDashScope(t, []scriptStep{
		{status: "PENDING"},
		{status: "SUCCEEDED", url: "https://oss.example/cat.png"},
	})
	r, st, cfg := newEnv(t, mock, "sk-test")
	startWorker(t, st, cfg)

	w := do(r, http.MethodPost, "/api/v1/material/generations", "u1",
		map[string]any{"kind": "image", "prompt": "a red panda astronaut"})
	if w.Code != http.StatusAccepted {
		t.Fatalf("create = %d %s", w.Code, w.Body.String())
	}
	created := createdTask(t, w)
	if created.Kind != "image" || created.Status != store.MaterialPending || created.Prompt != "a red panda astronaut" {
		t.Fatalf("created = %+v", created)
	}

	task := waitTask(t, r, "u1", created.ID, store.MaterialSucceeded)
	if task.ResultURL != "https://oss.example/cat.png" || task.Error != "" {
		t.Fatalf("final task = %+v", task)
	}

	// The submit happened on a worker tick, before success was observable.
	if len(mock.submits) != 1 {
		t.Fatalf("submits = %+v", mock.submits)
	}
	s := mock.submits[0]
	if s.path != imageEndpoint || s.model != "wanx-test-t2i" || s.prompt != "a red panda astronaut" ||
		s.authHeader != "Bearer sk-test" || s.asyncHeader != "enable" {
		t.Fatalf("submit call = %+v", s)
	}

	got, err := st.GetMaterialTask(created.ID, "u1")
	if err != nil || got.UpstreamTaskID != "ds-1" || got.ResultURL != "https://oss.example/cat.png" {
		t.Fatalf("stored task = %+v err = %v", got, err)
	}

	rows, err := st.UsageSummary("u1", 1)
	if err != nil || len(rows) != 1 || rows[0].ModelName != "material:image" ||
		rows[0].Requests != 1 || rows[0].TokensIn != 0 || rows[0].CostCents != 0 {
		t.Fatalf("usage rows = %+v err = %v", rows, err)
	}

	w = do(r, http.MethodGet, "/api/v1/material/generations?limit=10", "u1", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list = %d %s", w.Code, w.Body.String())
	}
	var list struct {
		Tasks []taskView `json:"tasks"`
	}
	decode(t, w, &list)
	if len(list.Tasks) != 1 || list.Tasks[0].ID != created.ID || list.Tasks[0].ResultURL != "https://oss.example/cat.png" {
		t.Fatalf("list = %+v", list.Tasks)
	}
}

func TestVideoGenerationUsesVideoEndpoint(t *testing.T) {
	fastPoll(t)
	mock := newMockDashScope(t, []scriptStep{{status: "SUCCEEDED", url: "https://oss.example/clip.mp4"}})
	r, st, cfg := newEnv(t, mock, "sk-test")
	startWorker(t, st, cfg)

	w := do(r, http.MethodPost, "/api/v1/material/generations", "u1",
		map[string]any{"kind": "video", "prompt": "drone shot over foggy pines"})
	if w.Code != http.StatusAccepted {
		t.Fatalf("create = %d %s", w.Code, w.Body.String())
	}
	created := createdTask(t, w)
	task := waitTask(t, r, "u1", created.ID, store.MaterialSucceeded)
	if task.ResultURL != "https://oss.example/clip.mp4" {
		t.Fatalf("task = %+v", task)
	}

	if len(mock.submits) != 1 || mock.submits[0].path != videoEndpoint ||
		mock.submits[0].model != "wan-test-t2v" {
		t.Fatalf("submits = %+v", mock.submits)
	}
	rows, err := st.UsageSummary("u1", 1)
	if err != nil || len(rows) != 1 || rows[0].ModelName != "material:video" || rows[0].Requests != 1 {
		t.Fatalf("usage = %+v err = %v", rows, err)
	}
}

func TestGenerationsValidation(t *testing.T) {
	mock := newMockDashScope(t, nil)

	r, _, _ := newEnv(t, mock, "")
	w := do(r, http.MethodPost, "/api/v1/material/generations", "u1",
		map[string]any{"kind": "image", "prompt": "x"})
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "MATERIAL_NOT_CONFIGURED") {
		t.Fatalf("no key = %d %s", w.Code, w.Body.String())
	}
	if len(mock.submits) != 0 {
		t.Fatalf("submit without key: %+v", mock.submits)
	}

	r, _, _ = newEnv(t, mock, "sk-test")
	if w = do(r, http.MethodPost, "/api/v1/material/generations", "u1",
		map[string]any{"kind": "audio", "prompt": "x"}); w.Code != http.StatusBadRequest {
		t.Fatalf("bad kind = %d %s", w.Code, w.Body.String())
	}
	if w = do(r, http.MethodPost, "/api/v1/material/generations", "u1",
		map[string]any{"kind": "image", "prompt": "   "}); w.Code != http.StatusBadRequest {
		t.Fatalf("empty prompt = %d %s", w.Code, w.Body.String())
	}
	if w = do(r, http.MethodPost, "/api/v1/material/generations", "u1", "{not json"); w.Code != http.StatusBadRequest {
		t.Fatalf("bad body = %d %s", w.Code, w.Body.String())
	}
	if w = do(r, http.MethodGet, "/api/v1/material/generations?limit=0", "u1", nil); w.Code != http.StatusBadRequest {
		t.Fatalf("limit=0 = %d %s", w.Code, w.Body.String())
	}
	if len(mock.submits) != 0 {
		t.Fatalf("invalid requests must not reach upstream: %+v", mock.submits)
	}
}

func TestGenerationsOwnershipIsolation(t *testing.T) {
	mock := newMockDashScope(t, []scriptStep{{status: "SUCCEEDED", url: "u"}})
	r, _, _ := newEnv(t, mock, "sk-test")

	w := do(r, http.MethodPost, "/api/v1/material/generations", "user-a",
		map[string]any{"kind": "image", "prompt": "private"})
	id := createdTask(t, w).ID

	if w = do(r, http.MethodGet, "/api/v1/material/generations/"+id, "user-b", nil); w.Code != http.StatusNotFound {
		t.Fatalf("B reads A's task = %d %s", w.Code, w.Body.String())
	}
	w = do(r, http.MethodGet, "/api/v1/material/generations", "user-b", nil)
	var list struct {
		Tasks []taskView `json:"tasks"`
	}
	decode(t, w, &list)
	if len(list.Tasks) != 0 {
		t.Fatalf("B sees A's tasks: %+v", list.Tasks)
	}
	if w = do(r, http.MethodGet, "/api/v1/material/generations/"+id, "user-a", nil); w.Code != http.StatusOK {
		t.Fatalf("A reads own task = %d %s", w.Code, w.Body.String())
	}
}

func TestGenerationFailsUpstream(t *testing.T) {
	fastPoll(t)
	mock := newMockDashScope(t, []scriptStep{{status: "FAILED", message: "quota exceeded"}})
	r, st, cfg := newEnv(t, mock, "sk-test")
	startWorker(t, st, cfg)

	w := do(r, http.MethodPost, "/api/v1/material/generations", "u1",
		map[string]any{"kind": "image", "prompt": "doomed"})
	if w.Code != http.StatusAccepted {
		t.Fatalf("create = %d %s", w.Code, w.Body.String())
	}
	task := waitTask(t, r, "u1", createdTask(t, w).ID, store.MaterialFailed)
	if !strings.Contains(task.Error, "quota exceeded") || task.ResultURL != "" {
		t.Fatalf("failed task = %+v", task)
	}
	rows, err := st.UsageSummary("u1", 1)
	if err != nil || len(rows) != 1 || rows[0].Requests != 1 {
		t.Fatalf("usage after failure = %+v err = %v", rows, err)
	}
}

// A rejected submit fails through the worker's submitPending, observed via
// GET — the create route only inserts (2026-11-10 audit fix).
func TestGenerationSubmitRejectedFailsViaWorker(t *testing.T) {
	fastPoll(t)
	mock := newMockDashScope(t, nil)
	mock.submitStatus = http.StatusInternalServerError
	mock.submitError = `{"code":"InternalError","message":"boom"}`
	r, st, cfg := newEnv(t, mock, "sk-test")
	startWorker(t, st, cfg)

	w := do(r, http.MethodPost, "/api/v1/material/generations", "u1",
		map[string]any{"kind": "image", "prompt": "unlucky"})
	if w.Code != http.StatusAccepted {
		t.Fatalf("create = %d %s", w.Code, w.Body.String())
	}
	created := createdTask(t, w)
	if created.Status != store.MaterialPending {
		t.Fatalf("create must answer pending, got %+v", created)
	}
	task := waitTask(t, r, "u1", created.ID, store.MaterialFailed)
	if !strings.Contains(task.Error, "boom") {
		t.Fatalf("task = %+v", task)
	}
	// finishTask 先置终态后记 usage（两写非事务）：终态可见到 usage 落库
	// 之间有窗口，慢机上读方会穿入（CI 2026-11-14 实挂一次）——短重试窗
	// 等待最终一致，而非断言瞬时快照。
	var rows []store.UsageDaily
	deadline := time.Now().Add(3 * time.Second)
	for {
		var err error
		rows, err = st.UsageSummary("u1", 1)
		if err == nil && len(rows) == 1 && rows[0].Requests == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("usage after submit failure = %+v err %v", rows, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// 2026-11-10 audit fix: creation only inserts a pending row — upstream sees
// the first request strictly after a worker tick, and with no worker, never.
func TestCreateDoesNotSubmitUpstream(t *testing.T) {
	fastPoll(t)
	mock := newMockDashScope(t, []scriptStep{{status: "SUCCEEDED", url: "https://oss.example/queued.png"}})
	r, st, cfg := newEnv(t, mock, "sk-test")

	w := do(r, http.MethodPost, "/api/v1/material/generations", "u1",
		map[string]any{"kind": "image", "prompt": "queued"})
	if w.Code != http.StatusAccepted {
		t.Fatalf("create = %d %s", w.Code, w.Body.String())
	}
	created := createdTask(t, w)
	if created.Status != store.MaterialPending {
		t.Fatalf("created = %+v, want pending", created)
	}
	if len(mock.submits) != 0 {
		t.Fatalf("create must not submit upstream: %+v", mock.submits)
	}

	startWorker(t, st, cfg)
	task := waitTask(t, r, "u1", created.ID, store.MaterialSucceeded)
	if task.ResultURL != "https://oss.example/queued.png" {
		t.Fatalf("task = %+v", task)
	}
	if len(mock.submits) != 1 {
		t.Fatalf("worker must be the sole submitter: %+v", mock.submits)
	}
}

func TestGenerationTimesOut(t *testing.T) {
	oldInterval, oldTimeout := pollInterval, taskTimeout
	pollInterval, taskTimeout = 30*time.Millisecond, 150*time.Millisecond
	t.Cleanup(func() { pollInterval, taskTimeout = oldInterval, oldTimeout })

	mock := newMockDashScope(t, []scriptStep{{status: "RUNNING"}})
	r, st, cfg := newEnv(t, mock, "sk-test")
	startWorker(t, st, cfg)

	w := do(r, http.MethodPost, "/api/v1/material/generations", "u1",
		map[string]any{"kind": "video", "prompt": "slow render"})
	if w.Code != http.StatusAccepted {
		t.Fatalf("create = %d %s", w.Code, w.Body.String())
	}
	task := waitTask(t, r, "u1", createdTask(t, w).ID, store.MaterialFailed)
	if !strings.Contains(task.Error, "timed out") {
		t.Fatalf("timeout error = %+v", task)
	}
}

func TestWorkerSubmitsPendingTask(t *testing.T) {
	fastPoll(t)
	mock := newMockDashScope(t, []scriptStep{{status: "SUCCEEDED", url: "https://oss.example/recovered.png"}})
	r, st, cfg := newEnv(t, mock, "sk-test")

	// A pending row with no upstream id is the normal post-create state (or
	// what a crash between insert and submit leaves behind); the worker's
	// scan must submit and finish it.
	pending := &store.MaterialTask{
		ID: "orphan-1", UserID: "u1", Kind: "image",
		Prompt: "recovered", Status: store.MaterialPending,
	}
	if err := st.CreateMaterialTask(pending); err != nil {
		t.Fatal(err)
	}
	startWorker(t, st, cfg)

	task := waitTask(t, r, "u1", "orphan-1", store.MaterialSucceeded)
	if task.ResultURL != "https://oss.example/recovered.png" {
		t.Fatalf("recovered task = %+v", task)
	}
	if len(mock.submits) != 1 {
		t.Fatalf("submits = %+v", mock.submits)
	}
}

func TestGenerationMetersPricedCost(t *testing.T) {
	fastPoll(t)
	mock := newMockDashScope(t, []scriptStep{{status: "SUCCEEDED", url: "https://oss.example/priced.png"}})
	r, st, cfg := newEnv(t, mock, "sk-test")
	seedPrices(t, st, map[string]config.MaterialPrice{
		"image": {Model: "wanx-test-t2i", CentsPerUnit: 17},
		"video": {Model: "wan-test-t2v", CentsPerUnit: 700},
	})
	startWorker(t, st, cfg)

	for _, kind := range []string{"image", "video"} {
		w := do(r, http.MethodPost, "/api/v1/material/generations", "u1",
			map[string]any{"kind": kind, "prompt": "priced render"})
		if w.Code != http.StatusAccepted {
			t.Fatalf("create %s = %d %s", kind, w.Code, w.Body.String())
		}
		waitTask(t, r, "u1", createdTask(t, w).ID, store.MaterialSucceeded)
	}

	// UsageSummary orders by date DESC, model_name ASC: image row first.
	rows, err := st.UsageSummary("u1", 1)
	if err != nil || len(rows) != 2 {
		t.Fatalf("usage rows = %+v err = %v", rows, err)
	}
	if rows[0].ModelName != "material:image" || rows[0].Requests != 1 || rows[0].CostCents != 17 {
		t.Fatalf("image usage = %+v", rows[0])
	}
	if rows[1].ModelName != "material:video" || rows[1].Requests != 1 || rows[1].CostCents != 700 {
		t.Fatalf("video usage = %+v", rows[1])
	}
}

func TestGenerationMetersZeroWhenPriceModelMismatches(t *testing.T) {
	fastPoll(t)
	mock := newMockDashScope(t, []scriptStep{{status: "SUCCEEDED", url: "https://oss.example/unpriced.png"}})
	r, st, cfg := newEnv(t, mock, "sk-test")
	// The price row names a model the client never submits, as when
	// DASHSCOPE_IMAGE_MODEL was overridden after the table was written.
	seedPrices(t, st, map[string]config.MaterialPrice{
		"image": {Model: "some-other-t2i", CentsPerUnit: 17},
	})
	startWorker(t, st, cfg)

	w := do(r, http.MethodPost, "/api/v1/material/generations", "u1",
		map[string]any{"kind": "image", "prompt": "mismatched model"})
	if w.Code != http.StatusAccepted {
		t.Fatalf("create = %d %s", w.Code, w.Body.String())
	}
	waitTask(t, r, "u1", createdTask(t, w).ID, store.MaterialSucceeded)

	rows, err := st.UsageSummary("u1", 1)
	if err != nil || len(rows) != 1 || rows[0].ModelName != "material:image" ||
		rows[0].Requests != 1 || rows[0].CostCents != 0 {
		t.Fatalf("usage rows = %+v err = %v", rows, err)
	}
}

// seedPrices writes the price table straight into system_config (B3 truth
// source): env-loaded cfg.MaterialPrices no longer reaches the worker.
func seedPrices(t *testing.T, st *store.Store, prices map[string]config.MaterialPrice) {
	t.Helper()
	raw, err := json.Marshal(prices)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetSystemConfig(store.SystemKeyMaterialPrices, string(raw)); err != nil {
		t.Fatal(err)
	}
}

// B3（roadmap-r4）热生效证明：worker 每次计量现读 system_config，改表后
// 无需重启即按新价落账。
func TestPriceTaskHotReload(t *testing.T) {
	mock := newMockDashScope(t, nil) // priceTask 不出网，mock 仅占位构造
	_, st, cfg := newEnv(t, mock, "sk-test")
	w := NewWorker(st, cfg)
	task := &store.MaterialTask{ID: "t1", Kind: "image"}

	seedPrices(t, st, map[string]config.MaterialPrice{
		"image": {Model: "wanx-test-t2i", CentsPerUnit: 14},
	})
	if got := w.priceTask(task); got != 14 {
		t.Fatalf("price before reload = %d, want 14", got)
	}
	seedPrices(t, st, map[string]config.MaterialPrice{
		"image": {Model: "wanx-test-t2i", CentsPerUnit: 20},
	})
	if got := w.priceTask(task); got != 20 {
		t.Fatalf("price after reload = %d, want 20 (hot reload broken)", got)
	}
}

package kb

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/xycxmz/company-platform-v1/server/internal/config"
)

type embedCall struct {
	model string
	auth  string
	input []string
}

// mockEmbedServer 扮 DashScope /compatible-mode/v1/embeddings：记录请求，
// 按 script 依次回状态码（跑完后最后一档重复），200 时按 dim 生成向量，
// shuffle=true 时 data 数组乱序但 index 字段正确。
type mockEmbedServer struct {
	mu       sync.Mutex
	server   *httptest.Server
	calls    []embedCall
	statuses []int
	dim      int
	shuffle  bool
}

func newMockEmbedServer(t *testing.T, dim int, statuses ...int) *mockEmbedServer {
	t.Helper()
	m := &mockEmbedServer{dim: dim, statuses: statuses}
	mux := http.NewServeMux()
	mux.HandleFunc(embedEndpoint, func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		defer m.mu.Unlock()
		raw, _ := io.ReadAll(r.Body)
		var req embedRequest
		_ = json.Unmarshal(raw, &req)
		m.calls = append(m.calls, embedCall{model: req.Model, auth: r.Header.Get("Authorization"), input: req.Input})

		status := http.StatusOK
		if len(m.statuses) > 0 {
			status = m.statuses[0]
			if len(m.statuses) > 1 {
				m.statuses = m.statuses[1:]
			}
		}
		if status != http.StatusOK {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(fmt.Sprintf(`{"code":"err","message":"upstream %d"}`, status)))
			return
		}
		data := make([]map[string]any, len(req.Input))
		for i := range req.Input {
			vec := make([]float32, m.dim)
			for j := range vec {
				vec[j] = float32(i+1) + float32(j)/100 // 请求内可辨识：第 i 条首元素 i+1
			}
			data[i] = map[string]any{"index": i, "embedding": vec}
		}
		if m.shuffle && len(data) > 1 {
			data[0], data[len(data)-1] = data[len(data)-1], data[0]
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data":  data,
			"usage": map[string]any{"total_tokens": 7 * len(req.Input)},
			"model": req.Model,
		})
	})
	m.server = httptest.NewServer(mux)
	t.Cleanup(m.server.Close)
	return m
}

func (m *mockEmbedServer) callCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.calls)
}

func newTestEmbedder(m *mockEmbedServer) *Embedder {
	return NewEmbedder(&config.Config{MaterialBaseURL: m.server.URL, MaterialAPIKey: "sk-test"}, nil)
}

func fastRetry(t *testing.T) {
	t.Helper()
	old := embedRetryBackoff
	embedRetryBackoff = time.Millisecond
	t.Cleanup(func() { embedRetryBackoff = old })
}

// 30 条输入按 ≤25/请求切两批（25+5），跨批同序，tokens 累计。
func TestEmbedSplitsBatchesAt25(t *testing.T) {
	m := newMockEmbedServer(t, 4)
	e := newTestEmbedder(m)
	texts := make([]string, 30)
	for i := range texts {
		texts[i] = fmt.Sprintf("文本 %d", i)
	}

	vecs, tokens, err := e.Embed(context.Background(), texts)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.calls) != 2 || len(m.calls[0].input) != 25 || len(m.calls[1].input) != 5 {
		t.Fatalf("batch split: %d calls, sizes %d and %d, want 2 calls of 25+5",
			len(m.calls), len(m.calls[0].input), len(m.calls[1].input))
	}
	if m.calls[0].input[0] != texts[0] || m.calls[1].input[0] != texts[25] {
		t.Fatalf("batch order broken")
	}
	if len(vecs) != 30 {
		t.Fatalf("vecs = %d, want 30", len(vecs))
	}
	// 每条向量首元素 = 其在完整输入里的序号 + 1，验证跨批同序。
	for i, v := range vecs {
		if len(v) != 4 || v[0] != float32(i%25+1) {
			t.Fatalf("vec %d = %v (batch %d, slot %d)", i, v[:2], i/25, i%25)
		}
	}
	if tokens != 7*30 {
		t.Fatalf("tokens = %d, want 210", tokens)
	}
	if e.Dim() != 4 {
		t.Fatalf("dim = %d, want 4", e.Dim())
	}
}

// 429 → 500 → 200：三次尝试后成功，退避生效。
func TestEmbedRetriesOn429And5xx(t *testing.T) {
	fastRetry(t)
	m := newMockEmbedServer(t, 3, http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusOK)
	e := newTestEmbedder(m)

	vecs, _, err := e.Embed(context.Background(), []string{"a"})
	if err != nil || len(vecs) != 1 {
		t.Fatalf("err = %v, vecs = %d", err, len(vecs))
	}
	if m.callCount() != 3 {
		t.Fatalf("attempts = %d, want 3", m.callCount())
	}
}

// 重试耗尽：始终 500 → 首试 + 2 重试 = 3 次后报错。
func TestEmbedRetriesExhausted(t *testing.T) {
	fastRetry(t)
	m := newMockEmbedServer(t, 3, http.StatusInternalServerError)
	e := newTestEmbedder(m)

	if _, _, err := e.Embed(context.Background(), []string{"a"}); err == nil {
		t.Fatal("want error after exhausted retries")
	} else if m.callCount() != 1+embedRetries {
		t.Fatalf("attempts = %d, want %d", m.callCount(), 1+embedRetries)
	}
}

// 400 是不可重试错误：一次即返回。
func TestEmbedDoesNotRetry4xx(t *testing.T) {
	m := newMockEmbedServer(t, 3, http.StatusBadRequest)
	e := newTestEmbedder(m)

	if _, _, err := e.Embed(context.Background(), []string{"a"}); err == nil {
		t.Fatal("want error on 400")
	}
	if m.callCount() != 1 {
		t.Fatalf("attempts = %d, want 1", m.callCount())
	}
}

// 维度动态：首用记录 4；响应改回 6 维报错（防索引混维）。未用时 Dim()==0。
func TestEmbedDimRecordedThenEnforced(t *testing.T) {
	m := newMockEmbedServer(t, 4)
	e := newTestEmbedder(m)
	if e.Dim() != 0 {
		t.Fatalf("dim before first use = %d, want 0", e.Dim())
	}
	if _, _, err := e.Embed(context.Background(), []string{"a"}); err != nil {
		t.Fatal(err)
	}
	if e.Dim() != 4 {
		t.Fatalf("dim = %d, want 4", e.Dim())
	}

	m.mu.Lock()
	m.dim = 6
	m.mu.Unlock()
	_, _, err := e.Embed(context.Background(), []string{"b"})
	if err == nil {
		t.Fatal("dim change must error")
	}
}

// 上游 data 乱序但 index 正确 → 客户端按 index 归位。
func TestEmbedSortsByIndexField(t *testing.T) {
	m := newMockEmbedServer(t, 2)
	m.shuffle = true
	e := newTestEmbedder(m)

	vecs, _, err := e.Embed(context.Background(), []string{"一", "二"})
	if err != nil {
		t.Fatal(err)
	}
	if vecs[0][0] != 1 || vecs[1][0] != 2 {
		t.Fatalf("order broken: v0=%v v1=%v", vecs[0], vecs[1])
	}
}

// 请求线格式：模型名常量、Bearer key、兼容端点路径。
func TestEmbedWireFormat(t *testing.T) {
	m := newMockEmbedServer(t, 2)
	e := newTestEmbedder(m)
	if _, _, err := e.Embed(context.Background(), []string{"x"}); err != nil {
		t.Fatal(err)
	}
	c := m.calls[0]
	if c.model != "qwen3.7-text-embedding" {
		t.Fatalf("model = %q", c.model)
	}
	if c.auth != "Bearer sk-test" {
		t.Fatalf("auth = %q", c.auth)
	}
}

// 空 key：ErrNotConfigured，且不出网。
func TestEmbedNotConfigured(t *testing.T) {
	m := newMockEmbedServer(t, 2)
	e := NewEmbedder(&config.Config{MaterialBaseURL: m.server.URL}, nil)
	_, _, err := e.Embed(context.Background(), []string{"x"})
	if err != ErrNotConfigured {
		t.Fatalf("err = %v, want ErrNotConfigured", err)
	}
	if m.callCount() != 0 {
		t.Fatalf("must not call upstream without key")
	}
}

// 向量编解码：float32 位级 roundtrip + 非法长度报错。
func TestVecCodecRoundtrip(t *testing.T) {
	vec := []float32{1.5, -2.25, 0.1, math.Float32frombits(1), math.MaxFloat32, -0}
	b := vecToBytes(vec)
	if len(b) != 4*len(vec) {
		t.Fatalf("bytes len = %d", len(b))
	}
	back, err := bytesToVec(b)
	if err != nil {
		t.Fatal(err)
	}
	for i := range vec {
		if math.Float32bits(back[i]) != math.Float32bits(vec[i]) {
			t.Fatalf("rune %d: %#08x != %#08x", i, math.Float32bits(back[i]), math.Float32bits(vec[i]))
		}
	}
	if _, err := bytesToVec([]byte{1, 2, 3}); err == nil {
		t.Fatal("len %% 4 != 0 must error")
	}
}

// ResetDim 清记录后新维度重新首录——换 embedding 模型后整库重建的地基：
// 不重置则维度变化被一致性校验拒绝。
func TestEmbedResetDimAllowsNewDim(t *testing.T) {
	m := newMockEmbedServer(t, 4)
	e := newTestEmbedder(m)
	if _, _, err := e.Embed(context.Background(), []string{"a"}); err != nil {
		t.Fatal(err)
	}
	if e.Dim() != 4 {
		t.Fatalf("dim = %d, want 4", e.Dim())
	}

	m.mu.Lock()
	m.dim = 8
	m.mu.Unlock()
	if _, _, err := e.Embed(context.Background(), []string{"b"}); err == nil {
		t.Fatal("dim change without reset must error")
	}

	e.ResetDim()
	if e.Dim() != 0 {
		t.Fatalf("dim after reset = %d, want 0", e.Dim())
	}
	if _, _, err := e.Embed(context.Background(), []string{"c"}); err != nil {
		t.Fatal(err)
	}
	if e.Dim() != 8 {
		t.Fatalf("dim after re-record = %d, want 8", e.Dim())
	}
}

// ResetDim 与 Dim/Embed 并发 hammer（-race 下证 e.mu 有效；终态取决于
// 重置与重录的交错次序，不断言——embed 侧因维度竞相重置报错属预期，
// 忽略返回）。
func TestEmbedResetDimConcurrent(t *testing.T) {
	e := newTestEmbedder(newMockEmbedServer(t, 2))
	if _, _, err := e.Embed(context.Background(), []string{"seed"}); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(3)
		go func() { defer wg.Done(); e.ResetDim() }()
		go func() { defer wg.Done(); _ = e.Dim() }()
		go func() { defer wg.Done(); _, _, _ = e.Embed(context.Background(), []string{"x"}) }()
	}
	wg.Wait()
}

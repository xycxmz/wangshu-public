package kb

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/xycxmz/company-platform-v1/server/internal/config"
	"github.com/xycxmz/company-platform-v1/server/internal/store"
)

// embeddingModel 与端点：DashScope OpenAI 兼容面（与素材管线共用
// DASHSCOPE_API_KEY / DASHSCOPE_BASE_URL）。维度不写死——以真调实返为
// 准，首用记录、此后读写一致校验（Embedder.dim）。
const (
	embeddingModel = "qwen3.7-text-embedding"
	embedEndpoint  = "/compatible-mode/v1/embeddings"
	embedBatchSize = 25 // DashScope embeddings 单请求上限
	embedRetries   = 2  // 429/5xx 退避重试次数（首试之外再试 2 次）
	embedTimeout   = 30 * time.Second
)

// embedRetryBackoff 是重试基础退避（每次翻倍：500ms、1s）；包变量供测试
// 缩短。
var embedRetryBackoff = 500 * time.Millisecond

// ErrNotConfigured 表示 DASHSCOPE_API_KEY 未配置；HTTP 面映射 503。
var ErrNotConfigured = errors.New("kb: DASHSCOPE_API_KEY is not set")

// EmbedClient 是 kb 服务依赖的 embedding 能力面；生产实现是 *Embedder，
// 测试注入 mock。
type EmbedClient interface {
	// Embed 批量把 texts 转成向量（内部按 ≤25/请求切分），返回与输入
	// 同序的向量、上游 total_tokens 合计。
	Embed(ctx context.Context, texts []string) (vecs [][]float32, tokens int64, err error)
	// Dim 返回首用记录的向量维度；未用过返回 0。
	Dim() int
	// ResetDim 清掉首用记录的维度（rebuild 前调用：换 embedding 模型后
	// 整库重嵌，新维度从此重新首录）。
	ResetDim()
}

// Embedder 是 DashScope embeddings 的 OpenAI 兼容客户端。
type Embedder struct {
	baseURL string
	apiKey  string
	hc      *http.Client

	mu  sync.Mutex
	dim int // 首次成功响应记录；此后任何不一致都报错，防索引内混维
}

// NewEmbedder 构造 embedding 客户端。key 双源：env（显式配置）优先，
// 模型池 DashScope key 兜底——生产 key 灌在池里，env 只有开发机会设。
func NewEmbedder(cfg *config.Config, st *store.Store) *Embedder {
	key := cfg.MaterialAPIKey
	if key == "" && st != nil {
		if k, err := st.FirstDashScopeKey(); err == nil {
			key = k
		}
	}
	return &Embedder{
		baseURL: strings.TrimRight(cfg.MaterialBaseURL, "/"),
		apiKey:  key,
		hc:      &http.Client{Timeout: embedTimeout},
	}
}

// Dim 返回已记录的维度（0 = 尚无成功调用）。
func (e *Embedder) Dim() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.dim
}

// ResetDim 清掉已记录的维度，下一次 Embed 重新首录。与 Dim/Embed 共用
// e.mu，并发安全——rebuild 与在线检索/入库可并行。
func (e *Embedder) ResetDim() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.dim = 0
}

type embedRequest struct {
	Model string   `json:"model"`
	Input []string `json:"input"`
}

type embedResponse struct {
	Data []struct {
		Index     int       `json:"index"`
		Embedding []float32 `json:"embedding"`
	} `json:"data"`
	Usage struct {
		TotalTokens int64 `json:"total_tokens"`
	} `json:"usage"`
}

func (e *Embedder) Embed(ctx context.Context, texts []string) ([][]float32, int64, error) {
	if e.apiKey == "" {
		return nil, 0, ErrNotConfigured
	}
	out := make([][]float32, 0, len(texts))
	var tokens int64
	for start := 0; start < len(texts); start += embedBatchSize {
		end := min(start+embedBatchSize, len(texts))
		vecs, used, err := e.embedBatch(ctx, texts[start:end])
		if err != nil {
			return nil, 0, err
		}
		out = append(out, vecs...)
		tokens += used
	}
	return out, tokens, nil
}

// embedBatch 打一个批量请求；429/5xx 按 embedRetries 退避重试，其余错误
// 立即返回。
func (e *Embedder) embedBatch(ctx context.Context, batch []string) ([][]float32, int64, error) {
	body, err := json.Marshal(embedRequest{Model: embeddingModel, Input: batch})
	if err != nil {
		return nil, 0, err
	}
	var lastErr error
	for attempt := 0; attempt <= embedRetries; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(embedRetryBackoff << (attempt - 1)):
			case <-ctx.Done():
				return nil, 0, ctx.Err()
			}
		}
		vecs, tokens, retryable, err := e.postEmbed(ctx, body, len(batch))
		if err == nil {
			return vecs, tokens, nil
		}
		if !retryable {
			return nil, 0, err
		}
		lastErr = err
	}
	return nil, 0, fmt.Errorf("dashscope embeddings: %d texts: %w", len(batch), lastErr)
}

// postEmbed 发请求并解码；retryable 标记 429/5xx（可退避重试）。
func (e *Embedder) postEmbed(ctx context.Context, body []byte, want int) (vecs [][]float32, tokens int64, retryable bool, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.baseURL+embedEndpoint, bytes.NewReader(body))
	if err != nil {
		return nil, 0, false, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+e.apiKey)
	resp, err := e.hc.Do(req)
	if err != nil {
		return nil, 0, false, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, 0, false, err
	}
	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
		return nil, 0, true, fmt.Errorf("status %d: %s", resp.StatusCode, truncateStr(string(raw), 200))
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, 0, false, fmt.Errorf("dashscope embeddings: status %d: %s", resp.StatusCode, truncateStr(string(raw), 200))
	}

	var out embedResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, 0, false, fmt.Errorf("dashscope embeddings: decode: %w", err)
	}
	if len(out.Data) != want {
		return nil, 0, false, fmt.Errorf("dashscope embeddings: got %d vectors for %d inputs", len(out.Data), want)
	}
	// 上游带 index 字段；按 index 归位防乱序。
	vecs = make([][]float32, want)
	for _, d := range out.Data {
		if d.Index < 0 || d.Index >= want {
			return nil, 0, false, fmt.Errorf("dashscope embeddings: index %d out of range", d.Index)
		}
		vecs[d.Index] = d.Embedding
	}
	if err := e.recordDim(vecs); err != nil {
		return nil, 0, false, err
	}
	return vecs, out.Usage.TotalTokens, false, nil
}

// recordDim 首用记录维度，之后校验一致；混维是索引不变量的破坏，报错
// 而非静默截断。
func (e *Embedder) recordDim(vecs [][]float32) error {
	if len(vecs) == 0 || len(vecs[0]) == 0 {
		return fmt.Errorf("dashscope embeddings: empty vector in response")
	}
	d := len(vecs[0])
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, v := range vecs[1:] {
		if len(v) != d {
			return fmt.Errorf("dashscope embeddings: mixed dims %d and %d in one response", d, len(v))
		}
	}
	if e.dim == 0 {
		e.dim = d
		return nil
	}
	if e.dim != d {
		return fmt.Errorf("dashscope embeddings: dim changed: recorded %d, got %d", e.dim, d)
	}
	return nil
}

func truncateStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// vecToBytes / bytesToVec：向量 ↔ float32 小端字节（KbChunk.Embedding 的
// 落库形态；PG bytea / sqlite blob 同型）。
func vecToBytes(v []float32) []byte {
	b := make([]byte, 4*len(v))
	for i, f := range v {
		binary.LittleEndian.PutUint32(b[4*i:], math.Float32bits(f))
	}
	return b
}

func bytesToVec(b []byte) ([]float32, error) {
	if len(b)%4 != 0 {
		return nil, fmt.Errorf("kb: embedding bytes len %d not a multiple of 4", len(b))
	}
	out := make([]float32, len(b)/4)
	for i := range out {
		out[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[4*i:]))
	}
	return out, nil
}

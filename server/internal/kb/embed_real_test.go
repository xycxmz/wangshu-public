package kb

import (
	"context"
	"math"
	"os"
	"strings"
	"testing"

	"github.com/xycxmz/company-platform-v1/server/internal/config"
)

// 真调 DashScope 集成测试（--ignored 语义）：默认跳过，设
// KB_REAL_EMBEDDING=1 跑。key 取 DASHSCOPE_API_KEY env，缺省回落
// server/.env（本机开发约定）。
func TestRealDashScopeEmbedding(t *testing.T) {
	if os.Getenv("KB_REAL_EMBEDDING") == "" {
		t.Skip("set KB_REAL_EMBEDDING=1 to hit the real DashScope embeddings endpoint")
	}
	key := os.Getenv("DASHSCOPE_API_KEY")
	if key == "" {
		key = dotenvKey(t, "../../.env", "DASHSCOPE_API_KEY")
	}
	if key == "" {
		t.Fatal("DASHSCOPE_API_KEY is empty: set it in the environment or fill DASHSCOPE_API_KEY= in server/.env (the home-machine .env carries the key name with an empty value)")
	}

	e := NewEmbedder(&config.Config{
		MaterialBaseURL: "https://dashscope.aliyuncs.com",
		MaterialAPIKey:  key,
	}, nil)
	vecs, tokens, err := e.Embed(context.Background(), []string{
		"望舒知识库 R9-D2 真调探针。", "知识库把资料沉淀为可检索的资产。",
	})
	if err != nil {
		t.Fatalf("real embed: %v", err)
	}
	if len(vecs) != 2 {
		t.Fatalf("vecs = %d, want 2", len(vecs))
	}
	dim := len(vecs[0])
	if dim <= 0 {
		t.Fatalf("dim = %d, want > 0", dim)
	}
	if e.Dim() != dim || len(vecs[1]) != dim {
		t.Fatalf("dim inconsistent: Dim()=%d v0=%d v1=%d", e.Dim(), len(vecs[0]), len(vecs[1]))
	}
	var norm float64
	for _, f := range vecs[0] {
		norm += float64(f) * float64(f)
	}
	if math.IsNaN(norm) || math.IsInf(norm, 0) {
		t.Fatalf("vector not finite: norm = %v", norm)
	}
	if tokens <= 0 {
		t.Fatalf("tokens = %d, want > 0", tokens)
	}
	t.Logf("real embedding ok: model=%s dim=%d tokens=%d norm=%.4f", embeddingModel, dim, tokens, math.Sqrt(norm))
}

// dotenvKey 从形如 KEY=value 的 .env 文件里取一个键（不覆盖已设 env）。
func dotenvKey(t *testing.T, path, key string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if k, v, ok := strings.Cut(line, "="); ok && strings.TrimSpace(k) == key {
			return strings.Trim(strings.TrimSpace(v), `"'`)
		}
	}
	return ""
}

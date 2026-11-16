package material

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/xycxmz/company-platform-v1/server/internal/config"
	"github.com/xycxmz/company-platform-v1/server/internal/store"
)

// C1（roadmap-r10）key 双源：素材客户端复用 kb 的「env 优先/模型池兜底」
// 模式——生产 DashScope key 灌在模型池（seed-models.sh），env 只有开发
// 机会设；env 空的存量部署此前 create 全 503。

// seedPoolKey 灌一个启用的 qwen 系模型进模型池（FirstDashScopeKey 的
// 选取面：enabled 且 name LIKE 'qwen%'）。Enabled 留 nil = 列默认 true。
func seedPoolKey(t *testing.T, st *store.Store, key string) {
	t.Helper()
	if err := st.CreateHostedModel(&store.HostedModel{
		Name: "qwen3.7-plus", Provider: "dashscope",
		BaseURL: "https://up.example/v1/", APIKey: key,
	}); err != nil {
		t.Fatal(err)
	}
}

// newPooledEnv 照 newEnv，但灌池动作发生在 Register 之前（生产时序：
// seed 先于 hub 启动，configured 门与 worker 的 key 都在挂载期解析）。
func newPooledEnv(t *testing.T, mock *mockDashScope, envKey, poolKey string) (*gin.Engine, *store.Store, *config.Config) {
	t.Helper()
	dsn := fmt.Sprintf("file:material-pool-%d?mode=memory&cache=shared", time.Now().UnixNano())
	st, err := store.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.AutoMigrate(); err != nil {
		t.Fatal(err)
	}
	if poolKey != "" {
		seedPoolKey(t, st, poolKey)
	}
	cfg := &config.Config{
		MaterialBaseURL:    mock.server.URL,
		MaterialAPIKey:     envKey,
		MaterialImageModel: "wanx-test-t2i",
		MaterialVideoModel: "wan-test-t2v",
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	Register(r.Group("/api/v1", fakeAuth()).Group("/material"), st, cfg)
	return r, st, cfg
}

// env 空、池有 key（生产实况）：create 不再 503，worker 以池 key 出网。
func TestClientKeyFallsBackToPool(t *testing.T) {
	fastPoll(t)
	mock := newMockDashScope(t, []scriptStep{{status: "SUCCEEDED", url: "https://oss.example/pool.png"}})
	r, st, cfg := newPooledEnv(t, mock, "", "sk-pool")
	startWorker(t, st, cfg)

	w := do(r, http.MethodPost, "/api/v1/material/generations", "u1",
		map[string]any{"kind": "image", "prompt": "pool key render"})
	if w.Code != http.StatusAccepted {
		t.Fatalf("create with pool key = %d %s, want 202", w.Code, w.Body.String())
	}
	task := waitTask(t, r, "u1", createdTask(t, w).ID, store.MaterialSucceeded)
	if task.ResultURL != "https://oss.example/pool.png" {
		t.Fatalf("task = %+v", task)
	}
	if len(mock.submits) != 1 || mock.submits[0].authHeader != "Bearer sk-pool" {
		t.Fatalf("submits = %+v, want Bearer sk-pool", mock.submits)
	}
}

// env 有值时优先于池：双源不改变显式配置的语义。
func TestClientKeyEnvWinsOverPool(t *testing.T) {
	fastPoll(t)
	mock := newMockDashScope(t, []scriptStep{{status: "SUCCEEDED", url: "https://oss.example/env.png"}})
	r, st, cfg := newPooledEnv(t, mock, "sk-env", "sk-pool")
	startWorker(t, st, cfg)

	w := do(r, http.MethodPost, "/api/v1/material/generations", "u1",
		map[string]any{"kind": "image", "prompt": "env key render"})
	if w.Code != http.StatusAccepted {
		t.Fatalf("create = %d %s", w.Code, w.Body.String())
	}
	waitTask(t, r, "u1", createdTask(t, w).ID, store.MaterialSucceeded)
	if len(mock.submits) != 1 || mock.submits[0].authHeader != "Bearer sk-env" {
		t.Fatalf("submits = %+v, want Bearer sk-env", mock.submits)
	}
}

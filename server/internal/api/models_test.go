package api

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestModelsPriceFieldsAndBaseURLRequired(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r, _, priv := newTestServer(t)
	tok := signRoleToken(t, priv, "u-admin", "admin")

	w := do(r, http.MethodPost, "/api/v1/models", tok, map[string]any{
		"name": "m1", "provider": "dashscope", "api_key": "sk-1",
	})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("missing base_url = %d, want 400 (%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "base_url") {
		t.Fatalf("message must name base_url: %s", w.Body.String())
	}

	w = do(r, http.MethodPost, "/api/v1/models", tok, map[string]any{
		"name": "glm-flash", "provider": "dashscope",
		"base_url": "https://up.example/v1/", "api_key": "sk-1",
		"upstream_model":  "glm-4.6-flash",
		"price_in_per_1k": 150, "price_out_per_1k": 450,
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", w.Code, w.Body.String())
	}
	var created struct {
		Model struct {
			Name          string `json:"name"`
			PriceInPer1K  int64  `json:"price_in_per_1k"`
			PriceOutPer1K int64  `json:"price_out_per_1k"`
		} `json:"model"`
	}
	decode(t, w, &created)
	if created.Model.PriceInPer1K != 150 || created.Model.PriceOutPer1K != 450 {
		t.Fatalf("price fields = %+v", created.Model)
	}

	w = do(r, http.MethodGet, "/api/v1/models", tok, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list = %d", w.Code)
	}
	var list struct {
		Models []struct {
			Name          string `json:"name"`
			PriceInPer1K  int64  `json:"price_in_per_1k"`
			PriceOutPer1K int64  `json:"price_out_per_1k"`
		} `json:"models"`
	}
	decode(t, w, &list)
	if len(list.Models) != 1 || list.Models[0].PriceInPer1K != 150 || list.Models[0].PriceOutPer1K != 450 {
		t.Fatalf("list prices = %+v", list.Models)
	}
}

// 2026-11-10 审计 low 批：POST 校验收紧——负价 400（对齐 PATCH 文案）、
// protocol 白名单（gateway 只实现 openai 兼容，anthropic 为未来预留）、
// capabilities 必须是 JSON object（null/字符串/数组 400）。
func TestModelsPOSTValidation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r, _, priv := newTestServer(t)
	tok := signRoleToken(t, priv, "u-admin", "admin")

	base := func() map[string]any {
		return map[string]any{
			"name": "m-validate", "provider": "dashscope",
			"base_url": "https://up.example/v1/", "api_key": "sk-1",
		}
	}

	body := base()
	body["price_in_per_1k"] = -1
	w := do(r, http.MethodPost, "/api/v1/models", tok, body)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "non-negative") {
		t.Fatalf("negative price_in = %d %s, want 400 non-negative", w.Code, w.Body.String())
	}

	body = base()
	body["price_out_per_1k"] = -1
	if w = do(r, http.MethodPost, "/api/v1/models", tok, body); w.Code != http.StatusBadRequest {
		t.Fatalf("negative price_out = %d, want 400", w.Code)
	}

	body = base()
	body["protocol"] = "anthropic"
	w = do(r, http.MethodPost, "/api/v1/models", tok, body)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "openai") {
		t.Fatalf("anthropic protocol = %d %s, want 400 naming openai", w.Code, w.Body.String())
	}
	body = base()
	body["protocol"] = "openai"
	if w = do(r, http.MethodPost, "/api/v1/models", tok, body); w.Code != http.StatusCreated {
		t.Fatalf("openai protocol = %d %s, want 201", w.Code, w.Body.String())
	}

	// capabilities: null/字符串/数组都是合法 JSON 但不是 object，一律 400。
	for i, caps := range []any{nil, "text", []any{1}} {
		body = base()
		body["name"] = fmt.Sprintf("m-caps-%d", i)
		body["capabilities"] = caps
		w = do(r, http.MethodPost, "/api/v1/models", tok, body)
		if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "JSON object") {
			t.Fatalf("capabilities %v = %d %s, want 400 JSON object", caps, w.Code, w.Body.String())
		}
	}
	body = base()
	body["name"] = "m-caps-ok"
	body["capabilities"] = map[string]any{"vision": true}
	if w = do(r, http.MethodPost, "/api/v1/models", tok, body); w.Code != http.StatusCreated {
		t.Fatalf("object capabilities = %d %s, want 201", w.Code, w.Body.String())
	}
}

// PATCH 侧同样收紧：protocol 白名单 + capabilities object（负价 400 已有覆盖）。
func TestModelsPATCHProtocolAndCapabilities(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r, _, priv := newTestServer(t)
	tok := signRoleToken(t, priv, "u-admin", "admin")

	w := do(r, http.MethodPost, "/api/v1/models", tok, map[string]any{
		"name": "m1", "provider": "dashscope",
		"base_url": "https://up.example/v1/", "api_key": "sk-old",
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", w.Code, w.Body.String())
	}

	w = do(r, http.MethodPatch, "/api/v1/models/m1", tok, map[string]any{"protocol": "anthropic"})
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "openai") {
		t.Fatalf("anthropic patch = %d %s, want 400 naming openai", w.Code, w.Body.String())
	}
	if w = do(r, http.MethodPatch, "/api/v1/models/m1", tok, map[string]any{"protocol": "openai"}); w.Code != http.StatusOK {
		t.Fatalf("openai patch = %d %s, want 200", w.Code, w.Body.String())
	}

	w = do(r, http.MethodPatch, "/api/v1/models/m1", tok, map[string]any{"capabilities": nil})
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "JSON object") {
		t.Fatalf("null capabilities = %d %s, want 400 JSON object", w.Code, w.Body.String())
	}
	w = do(r, http.MethodPatch, "/api/v1/models/m1", tok, map[string]any{"capabilities": "[1]"})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("array capabilities = %d, want 400", w.Code)
	}
	w = do(r, http.MethodPatch, "/api/v1/models/m1", tok, map[string]any{"capabilities": map[string]any{"vision": true}})
	if w.Code != http.StatusOK {
		t.Fatalf("object capabilities = %d, want 200", w.Code)
	}
}

// B1（roadmap-r4）管理面角色门：模型池写面（POST/DELETE）仅 admin/owner，
// 无角色或 user 角色 403 FORBIDDEN；列表读面与 /me 等会话面对所有持牌用户开放。
func TestModelsAdminGate(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r, _, priv := newTestServer(t)
	userTok := signRoleToken(t, priv, "u1", "user")
	noRoleTok := signToken(t, priv, "u2")

	body := map[string]any{
		"name": "m1", "provider": "dashscope",
		"base_url": "https://up.example/v1/", "api_key": "sk-1",
	}
	w := do(r, http.MethodPost, "/api/v1/models", userTok, body)
	if w.Code != http.StatusForbidden {
		t.Fatalf("user create = %d %s, want 403", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "FORBIDDEN") {
		t.Fatalf("403 body must follow error envelope: %s", w.Body.String())
	}
	w = do(r, http.MethodDelete, "/api/v1/models/m1", userTok, nil)
	if w.Code != http.StatusForbidden {
		t.Fatalf("user delete = %d, want 403", w.Code)
	}
	w = do(r, http.MethodPost, "/api/v1/models", noRoleTok, body)
	if w.Code != http.StatusForbidden {
		t.Fatalf("role-less create = %d, want 403", w.Code)
	}

	// 读面开放：user 角色可列模型池（空池）
	w = do(r, http.MethodGet, "/api/v1/models", userTok, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("user list = %d %s, want 200", w.Code, w.Body.String())
	}

	// owner 在默认角色集内，可写
	ownerTok := signRoleToken(t, priv, "boss", "owner")
	w = do(r, http.MethodPost, "/api/v1/models", ownerTok, body)
	if w.Code != http.StatusCreated {
		t.Fatalf("owner create = %d %s, want 201", w.Code, w.Body.String())
	}
}

// B2（roadmap-r4）：PATCH /models/:name 部分更新——换 key 经 store 验证
// （view 永不回 key）、启停经 view 验证、404/校验/角色门。
func TestModelsPATCH(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r, st, priv := newTestServer(t)
	adminTok := signRoleToken(t, priv, "u-admin", "admin")
	userTok := signRoleToken(t, priv, "u1", "user")

	w := do(r, http.MethodPost, "/api/v1/models", adminTok, map[string]any{
		"name": "m1", "provider": "dashscope",
		"base_url": "https://up.example/v1/", "api_key": "sk-old",
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", w.Code, w.Body.String())
	}

	// user 角色 403
	w = do(r, http.MethodPatch, "/api/v1/models/m1", userTok, map[string]any{"enabled": false})
	if w.Code != http.StatusForbidden {
		t.Fatalf("user patch = %d %s, want 403", w.Code, w.Body.String())
	}

	// admin 换 key + 停用
	disabled := false
	newKey := "sk-new"
	patchBody := map[string]any{"api_key": newKey, "enabled": disabled}
	w = do(r, http.MethodPatch, "/api/v1/models/m1", adminTok, patchBody)
	if w.Code != http.StatusOK {
		t.Fatalf("admin patch = %d %s", w.Code, w.Body.String())
	}
	var patched struct {
		Model struct {
			Enabled bool `json:"enabled"`
		} `json:"model"`
	}
	decode(t, w, &patched)
	if patched.Model.Enabled {
		t.Fatalf("enabled not updated: %+v", patched.Model)
	}
	got, err := st.EnabledHostedModel("m1")
	if err == nil || got != nil {
		t.Fatalf("disabled model served by gateway: %+v err %v", got, err)
	}
	rows, err := st.ListHostedModels()
	if err != nil || len(rows) != 1 || rows[0].APIKey != newKey {
		t.Fatalf("key not updated: %+v err %v", rows, err)
	}

	// 重新启用
	w = do(r, http.MethodPatch, "/api/v1/models/m1", adminTok, map[string]any{"enabled": true})
	if w.Code != http.StatusOK {
		t.Fatalf("re-enable = %d %s", w.Code, w.Body.String())
	}
	if got, err := st.EnabledHostedModel("m1"); err != nil || got == nil {
		t.Fatalf("re-enabled model not served: %+v err %v", got, err)
	}

	// 校验：空串字段拒绝
	w = do(r, http.MethodPatch, "/api/v1/models/m1", adminTok, map[string]any{"api_key": ""})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("empty api_key patch = %d, want 400", w.Code)
	}
	// 404：未知名
	w = do(r, http.MethodPatch, "/api/v1/models/ghost", adminTok, map[string]any{"enabled": true})
	if w.Code != http.StatusNotFound {
		t.Fatalf("patch ghost = %d, want 404", w.Code)
	}
}

// C4（roadmap-r10）：GET /models 每行带 price_in / price_out（分/百万
// token，前端 worker 计价契约）——表存分/千 token，换算 ×1000；未定价 0。
func TestModelsListPricePerMillion(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r, _, priv := newTestServer(t)
	tok := signRoleToken(t, priv, "u-admin", "admin")

	w := do(r, http.MethodPost, "/api/v1/models", tok, map[string]any{
		"name": "m-priced", "provider": "dashscope",
		"base_url": "https://up.example/v1/", "api_key": "sk-1",
		"price_in_per_1k": 2, "price_out_per_1k": 8,
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("create priced = %d %s", w.Code, w.Body.String())
	}
	w = do(r, http.MethodPost, "/api/v1/models", tok, map[string]any{
		"name": "m-free", "provider": "dashscope",
		"base_url": "https://up.example/v1/", "api_key": "sk-2",
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("create unpriced = %d %s", w.Code, w.Body.String())
	}

	w = do(r, http.MethodGet, "/api/v1/models", tok, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list = %d %s", w.Code, w.Body.String())
	}
	var list struct {
		Models []struct {
			Name     string `json:"name"`
			PriceIn  int64  `json:"price_in"`
			PriceOut int64  `json:"price_out"`
		} `json:"models"`
	}
	decode(t, w, &list)
	byName := map[string][2]int64{}
	for _, m := range list.Models {
		byName[m.Name] = [2]int64{m.PriceIn, m.PriceOut}
	}
	if byName["m-priced"] != [2]int64{2000, 8000} {
		t.Fatalf("priced = %v, want price_in 2000 / price_out 8000 (分/百万 token)", byName["m-priced"])
	}
	if byName["m-free"] != [2]int64{0, 0} {
		t.Fatalf("unpriced = %v, want 0/0", byName["m-free"])
	}
}

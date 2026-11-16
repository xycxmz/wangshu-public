package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/xycxmz/company-platform-v1/server/internal/config"
	"github.com/xycxmz/company-platform-v1/server/internal/store"
)

// B3（roadmap-r4）：material 价目路由——首启 seed 只写一次，PUT 热生效，
// user 角色 403，校验拒绝未知 kind/负价。
func TestMaterialPricingRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r, st, priv := newTestServer(t)
	adminTok := signRoleToken(t, priv, "u-admin", "admin")
	userTok := signRoleToken(t, priv, "u1", "user")

	// seed：env 表只在空表时写入
	SeedMaterialPrices(st, map[string]config.MaterialPrice{
		"image": {Model: "wanx-a", CentsPerUnit: 14},
	})
	SeedMaterialPrices(st, map[string]config.MaterialPrice{
		"image": {Model: "wanx-b", CentsPerUnit: 99}, // 已有表，必须被忽略
	})
	w := do(r, http.MethodGet, "/api/v1/pricing/material", userTok, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("get = %d %s", w.Code, w.Body.String())
	}
	var got struct {
		Prices map[string]config.MaterialPrice `json:"prices"`
	}
	decode(t, w, &got)
	if p := got.Prices["image"]; p.Model != "wanx-a" || p.CentsPerUnit != 14 {
		t.Fatalf("seed ignored existing table or marshal broken: %+v", got.Prices)
	}

	// PUT 热生效（DB 是唯一真相，无重启语义可言）
	w = do(r, http.MethodPut, "/api/v1/pricing/material", adminTok, map[string]any{
		"image": map[string]any{"model": "wanx-c", "cents_per_unit": 20},
		"video": map[string]any{"model": "wanv", "cents_per_unit": 70},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("put = %d %s", w.Code, w.Body.String())
	}
	row, ok, err := st.GetSystemConfig(store.SystemKeyMaterialPrices)
	if err != nil || !ok || row == "" {
		t.Fatalf("system_config not written: ok=%v err=%v", ok, err)
	}
	prices, err := st.MaterialPrices()
	if err != nil || prices["image"].CentsPerUnit != 20 || prices["video"].CentsPerUnit != 70 {
		t.Fatalf("hot table = %+v err %v", prices, err)
	}

	// user 角色 403 + 校验拒绝
	w = do(r, http.MethodPut, "/api/v1/pricing/material", userTok, map[string]any{
		"image": map[string]any{"model": "x", "cents_per_unit": 1},
	})
	if w.Code != http.StatusForbidden {
		t.Fatalf("user put = %d, want 403", w.Code)
	}
	w = do(r, http.MethodPut, "/api/v1/pricing/material", adminTok, map[string]any{
		"image": map[string]any{"model": "x", "cents_per_unit": 1},
		"video": map[string]any{"model": "y", "cents_per_unit": 2},
		"audio": map[string]any{"model": "z", "cents_per_unit": 3},
	})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("unknown kind = %d, want 400", w.Code)
	}
	w = do(r, http.MethodPut, "/api/v1/pricing/material", adminTok, map[string]any{
		"image": map[string]any{"model": "x", "cents_per_unit": -1},
		"video": map[string]any{"model": "y", "cents_per_unit": 2},
	})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("negative cents = %d, want 400", w.Code)
	}
}

// PUT 是整体覆盖语义：缺任一 kind 直接 400，绝不把缺的 kind 静默清零。
func TestMaterialPricingPutRequiresBothKinds(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r, st, priv := newTestServer(t)
	adminTok := signRoleToken(t, priv, "u-admin", "admin")

	seed := func() map[string]any {
		return map[string]any{
			"image": map[string]any{"model": "wanx-a", "cents_per_unit": 14},
			"video": map[string]any{"model": "wanv", "cents_per_unit": 70},
		}
	}
	if err := st.SetSystemConfig(store.SystemKeyMaterialPrices, mustJSON(t, seed())); err != nil {
		t.Fatal(err)
	}

	videoOnly := map[string]any{
		"video": map[string]any{"model": "wanv2", "cents_per_unit": 80},
	}
	w := do(r, http.MethodPut, "/api/v1/pricing/material", adminTok, videoOnly)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "image and video") {
		t.Fatalf("missing image = %d %s, want 400 naming both kinds", w.Code, w.Body.String())
	}

	imageOnly := map[string]any{
		"image": map[string]any{"model": "wanx-b", "cents_per_unit": 15},
	}
	if w = do(r, http.MethodPut, "/api/v1/pricing/material", adminTok, imageOnly); w.Code != http.StatusBadRequest {
		t.Fatalf("missing video = %d, want 400", w.Code)
	}

	// The rejected partial PUT must not have touched the stored table.
	prices, err := st.MaterialPrices()
	if err != nil || prices["image"].CentsPerUnit != 14 || prices["video"].CentsPerUnit != 70 {
		t.Fatalf("rejected PUT mutated the table: %+v err %v", prices, err)
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

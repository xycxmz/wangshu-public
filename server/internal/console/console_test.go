package console

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
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

// newConsole 启一台带 mock account-center 与 sqlite store 的控制台测试引擎。
// center 行为可注入：ok 返回 role 的合法 token；否则回 401。
func newConsole(t *testing.T, role string, centerOK bool) (*gin.Engine, *httptest.Server, *store.Store) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	jwks, _ := json.Marshal(map[string]any{
		"keys": []map[string]string{{
			"kty": "OKP", "crv": "Ed25519", "kid": "k1",
			"x": base64.RawURLEncoding.EncodeToString(pub),
		}},
	})
	mint := func(role string) string {
		claims := jwt.MapClaims{
			"iss": "center", "sub": "u1", "aud": "app", "role": role,
			"iat": time.Now().Add(-time.Minute).Unix(),
			"exp": time.Now().Add(time.Hour).Unix(),
		}
		tok := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
		tok.Header["kid"] = "k1"
		s, err := tok.SignedString(priv)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	center := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !centerOK {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "bad credentials"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"accessToken": mint(role)})
	}))
	t.Cleanup(center.Close)

	st, err := store.Open(filepath.Join(t.TempDir(), "console.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.AutoMigrate(); err != nil {
		t.Fatal(err)
	}

	verifier := acauth.New("http://127.0.0.1:1/never", "app", string(jwks))
	cfg := &config.Config{
		ConsoleSecret:    "test-secret",
		CenterURL:        center.URL,
		AppID:            "app",
		AdminRoles:       []string{"admin", "owner"},
		LoginLimitWindow: time.Minute,
		LoginLimitMax:    10,
	}
	r := gin.New()
	Register(r, cfg, verifier, st)
	return r, center, st
}

func doForm(r *gin.Engine, method, path, cookie string, form url.Values) *httptest.ResponseRecorder {
	var body string
	if form != nil {
		body = form.Encode()
	}
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestConsoleSessionFlow(t *testing.T) {
	r, _, _ := newConsole(t, "admin", true)

	// 未登录 → 302 登录页
	if w := doForm(r, http.MethodGet, "/console/models", "", nil); w.Code != http.StatusFound {
		t.Fatalf("gate without session = %d, want 302", w.Code)
	}

	// 登录成功 → 303 且发会话 cookie
	form := url.Values{"email": {"x@y.z"}, "password": {"p"}}
	w := doForm(r, http.MethodPost, "/console/login", "", form)
	if w.Code != http.StatusSeeOther {
		t.Fatalf("login = %d, body = %s", w.Code, w.Body.String())
	}
	var cookie string
	for _, c := range w.Result().Cookies() {
		if c.Name == cookieName {
			cookie = c.Name + "=" + c.Value
			if !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteStrictMode {
				t.Fatalf("cookie flags missing: %+v", c)
			}
		}
	}
	if cookie == "" {
		t.Fatal("session cookie not issued")
	}

	// 持会话 → 门通过，页面带身份
	w = doForm(r, http.MethodGet, "/console/models", cookie, nil)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "u1 · admin") {
		t.Fatalf("gated page = %d %s", w.Code, w.Body.String())
	}

	// 篡改 cookie → 拒
	w = doForm(r, http.MethodGet, "/console/models", cookieName+"="+url.QueryEscape("x.y"), nil)
	if w.Code != http.StatusFound {
		t.Fatalf("tampered cookie = %d, want 302", w.Code)
	}

	// 登出 → 清 cookie + 回登录页
	w = doForm(r, http.MethodPost, "/console/logout", cookie, nil)
	if w.Code != http.StatusSeeOther {
		t.Fatalf("logout = %d", w.Code)
	}
	cleared := false
	for _, c := range w.Result().Cookies() {
		if c.Name == cookieName && c.MaxAge < 0 {
			cleared = true
		}
	}
	if !cleared {
		t.Fatal("logout must clear the session cookie")
	}
}

func TestConsoleLoginRejectsNonAdminAndBadPassword(t *testing.T) {
	// 非 admin 角色：center 正常发 token，控制台 403
	r, _, _ := newConsole(t, "member", true)
	form := url.Values{"email": {"x@y.z"}, "password": {"p"}}
	if w := doForm(r, http.MethodPost, "/console/login", "", form); w.Code != http.StatusForbidden {
		t.Fatalf("member login = %d, want 403", w.Code)
	}

	// 错密码：center 401 → 登录页 401，不发 cookie
	r2, _, _ := newConsole(t, "admin", false)
	w2 := doForm(r2, http.MethodPost, "/console/login", "", form)
	if w2.Code != http.StatusUnauthorized {
		t.Fatalf("bad password = %d, want 401", w2.Code)
	}
	for _, c := range w2.Result().Cookies() {
		if c.Name == cookieName {
			t.Fatal("failed login must not set a session cookie")
		}
	}
}

func TestConsoleModelsCRUD(t *testing.T) {
	r, _, st := newConsole(t, "admin", true)

	// 登录取会话 cookie
	w := doForm(r, http.MethodPost, "/console/login", "", url.Values{"email": {"x@y.z"}, "password": {"p"}})
	var cookie string
	for _, c := range w.Result().Cookies() {
		if c.Name == cookieName {
			cookie = c.Name + "=" + c.Value
		}
	}
	if cookie == "" {
		t.Fatal("no session cookie")
	}

	// 新增（PRG：303）→ 列表出现
	form := url.Values{
		"name": {"glm-4.7"}, "provider": {"zhipu"},
		"base_url": {"https://open.bigmodel.cn"}, "api_key": {"sk-test"},
		"upstream_model": {"glm-4.7"}, "protocol": {"openai"},
		"price_in": {"10"}, "price_out": {"30"},
	}
	if w := doForm(r, http.MethodPost, "/console/models", cookie, form); w.Code != http.StatusSeeOther {
		t.Fatalf("create = %d, body = %s", w.Code, w.Body.String())
	}
	w = doForm(r, http.MethodGet, "/console/models", cookie, nil)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "glm-4.7") {
		t.Fatalf("models page missing row: %d %s", w.Code, w.Body.String())
	}

	// 同名 → 409 错误行（不出 303）
	if w := doForm(r, http.MethodPost, "/console/models", cookie, form); w.Code != http.StatusConflict {
		t.Fatalf("duplicate = %d, want 409", w.Code)
	}

	// 启停（PRG）→ 状态翻转（Enabled *bool：建时 new(bool)=false → toggle true）
	if w := doForm(r, http.MethodPost, "/console/models/glm-4.7/toggle", cookie, nil); w.Code != http.StatusSeeOther {
		t.Fatalf("toggle = %d", w.Code)
	}
	models, _ := st.ListHostedModels()
	if len(models) != 1 || models[0].Enabled == nil || !*models[0].Enabled {
		t.Fatalf("toggle result = %+v", models)
	}

	// 删除（PRG）→ 行消失
	if w := doForm(r, http.MethodPost, "/console/models/glm-4.7/delete", cookie, nil); w.Code != http.StatusSeeOther {
		t.Fatalf("delete = %d", w.Code)
	}
	models, _ = st.ListHostedModels()
	if len(models) != 0 {
		t.Fatalf("delete left rows: %+v", models)
	}

	// 未登录写操作 → 302 登录（门覆盖所有动词）
	if w := doForm(r, http.MethodPost, "/console/models", "", form); w.Code != http.StatusFound {
		t.Fatalf("ungated create = %d, want 302", w.Code)
	}
}

func TestConsolePricingSave(t *testing.T) {
	r, _, st := newConsole(t, "admin", true)
	w := doForm(r, http.MethodPost, "/console/login", "", url.Values{"email": {"x@y.z"}, "password": {"p"}})
	var cookie string
	for _, c := range w.Result().Cookies() {
		if c.Name == cookieName {
			cookie = c.Name + "=" + c.Value
		}
	}

	// 整表保存 → 落 system_config → 页面回显已保存
	form := url.Values{"image_model": {"wanx-v2"}, "image_cents": {"20"}, "video_model": {"wanx-video"}, "video_cents": {"200"}}
	if w := doForm(r, http.MethodPost, "/console/pricing", cookie, form); w.Code != http.StatusOK ||
		!strings.Contains(w.Body.String(), "已保存") {
		t.Fatalf("pricing save = %d %s", w.Code, w.Body.String())
	}
	prices, _ := st.MaterialPrices()
	if prices["image"].Model != "wanx-v2" || prices["image"].CentsPerUnit != 20 ||
		prices["video"].CentsPerUnit != 200 {
		t.Fatalf("prices after save = %+v", prices)
	}

	// 缺 model → 400 整表拒
	bad := url.Values{"image_model": {""}, "image_cents": {"1"}, "video_model": {"v"}, "video_cents": {"1"}}
	if w := doForm(r, http.MethodPost, "/console/pricing", cookie, bad); w.Code != http.StatusBadRequest {
		t.Fatalf("partial put = %d, want 400", w.Code)
	}
}

func TestConsoleMcpAndMonitors(t *testing.T) {
	r, _, st := newConsole(t, "admin", true)
	w := doForm(r, http.MethodPost, "/console/login", "", url.Values{"email": {"x@y.z"}, "password": {"p"}})
	var cookie string
	for _, c := range w.Result().Cookies() {
		if c.Name == cookieName {
			cookie = c.Name + "=" + c.Value
		}
	}

	// MCP 注册（合法白名单）→ 列表出现；非法白名单 400
	form := url.Values{"name": {"search"}, "base_url": {"https://mcp.example.com"}, "allowed_tools": {`["search"]`}}
	if w := doForm(r, http.MethodPost, "/console/mcp", cookie, form); w.Code != http.StatusSeeOther {
		t.Fatalf("mcp create = %d %s", w.Code, w.Body.String())
	}
	badForm := url.Values{"name": {"x"}, "base_url": {"https://x"}, "allowed_tools": {"not-json"}}
	if w := doForm(r, http.MethodPost, "/console/mcp", cookie, badForm); w.Code != http.StatusBadRequest {
		t.Fatalf("bad tools = %d, want 400", w.Code)
	}
	rows, _ := st.ListMcpUpstreams()
	if len(rows) != 1 || rows[0].AllowedTools != `["search"]` {
		t.Fatalf("upstreams = %+v", rows)
	}

	// 启停 → IsEnabled 翻转；删除 → 空
	if w := doForm(r, http.MethodPost, "/console/mcp/search/toggle", cookie, nil); w.Code != http.StatusSeeOther {
		t.Fatalf("mcp toggle = %d", w.Code)
	}
	rows, _ = st.ListMcpUpstreams()
	if len(rows) != 1 || !rows[0].IsEnabled() {
		t.Fatalf("after toggle = %+v（建时禁用，toggle 后应启用）", rows)
	}
	if w := doForm(r, http.MethodPost, "/console/mcp/search/delete", cookie, nil); w.Code != http.StatusSeeOther {
		t.Fatalf("mcp delete = %d", w.Code)
	}
	rows, _ = st.ListMcpUpstreams()
	if len(rows) != 0 {
		t.Fatalf("after delete = %+v", rows)
	}

	// 监控页渲染（空库 200 即可）
	if w := doForm(r, http.MethodGet, "/console/usage?days=30", cookie, nil); w.Code != http.StatusOK ||
		!strings.Contains(w.Body.String(), "用量") {
		t.Fatalf("usage page = %d", w.Code)
	}
	if w := doForm(r, http.MethodGet, "/console/material", cookie, nil); w.Code != http.StatusOK ||
		!strings.Contains(w.Body.String(), "素材任务") {
		t.Fatalf("material page = %d", w.Code)
	}
	// days 白名单外回默认 30（断言标题，不搜 999——CSS 数值会误伤）
	if w := doForm(r, http.MethodGet, "/console/usage?days=999", cookie, nil); w.Code != http.StatusOK ||
		!strings.Contains(w.Body.String(), "跨用户，30 天") {
		t.Fatalf("days fallback broken")
	}
}

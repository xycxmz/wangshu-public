// Package console serves the hub admin console: a server-rendered MPA
// C1 会话层（HMAC cookie + 登录代理 +
// admin 门）；C2 骨架与视觉（go:embed 模板 + Flight Console token 内联）；
// C3 模型池页（表格 + 新增/删除/启停 PRG）。后续 C4-C6 沿同模式扩页。
package console

import (
	"crypto/hmac"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/xycxmz/company-platform-v1/server/internal/api"
	"github.com/xycxmz/company-platform-v1/server/internal/auth/acauth"
	"github.com/xycxmz/company-platform-v1/server/internal/config"
	"github.com/xycxmz/company-platform-v1/server/internal/store"
)

//go:embed templates/*.html
var templateFS embed.FS

// 每页 = layout + 页 content（login 独立整页）。启动期解析一次。
var (
	layoutTmpl   = template.Must(template.ParseFS(templateFS, "templates/layout.html"))
	loginTmpl    = template.Must(template.ParseFS(templateFS, "templates/login.html"))
	modelsTmpl   = pageTmpl("models.html")
	pricingTmpl  = pageTmpl("pricing.html")
	mcpTmpl      = pageTmpl("mcp.html")
	usageTmpl    = pageTmpl("usage.html")
	materialTmpl = pageTmpl("material.html")
)

func pageTmpl(name string) *template.Template {
	return template.Must(template.Must(layoutTmpl.Clone()).ParseFS(templateFS, "templates/"+name))
}

const (
	cookieName = "hub_console"
	sessionTTL = 12 * time.Hour
)

type server struct {
	secret     []byte
	verifier   *acauth.Verifier
	centerURL  string
	appID      string
	adminRoles []string
	st         *store.Store
}

// pageData 是布局页渲染载荷（各页共用骨架 + 自有数据位）。
type pageData struct {
	Page, Title, UserID, Role, Err string
	Models                         []store.HostedModel
	// pricing
	Saved                  bool
	ImageModel, VideoModel string
	ImageCents, VideoCents int64
	// mcp
	Upstreams []store.McpUpstream
	// usage
	Days  int
	Usage []store.UsageDaily
	// material
	Tasks []store.MaterialTask
}

// Register mounts /console/* on the engine（cmd/hub 装配）。
func Register(r *gin.Engine, cfg *config.Config, verifier *acauth.Verifier, st *store.Store) {
	s := &server{
		secret:     []byte(cfg.ConsoleSecret),
		verifier:   verifier,
		centerURL:  cfg.CenterURL,
		appID:      cfg.AppID,
		adminRoles: cfg.AdminRoles,
		st:         st,
	}
	limiter := api.NewLoginLimiter(cfg.LoginLimitWindow, cfg.LoginLimitMax)
	r.GET("/console", s.gate(func(c *gin.Context) {
		c.Redirect(http.StatusSeeOther, "/console/models")
	}))
	r.GET("/console/login", s.loginPage)
	r.POST("/console/login", api.LoginRateLimit(limiter), s.loginSubmit)
	r.POST("/console/logout", s.logout)
	r.GET("/console/models", s.gate(s.modelsPage))
	r.POST("/console/models", s.gate(s.modelsCreate))
	r.POST("/console/models/:name/delete", s.gate(s.modelsDelete))
	r.POST("/console/models/:name/toggle", s.gate(s.modelsToggle))
	r.GET("/console/pricing", s.gate(s.pricingPage))
	r.POST("/console/pricing", s.gate(s.pricingSave))
	r.GET("/console/mcp", s.gate(s.mcpPage))
	r.POST("/console/mcp", s.gate(s.mcpCreate))
	r.POST("/console/mcp/:name/delete", s.gate(s.mcpDelete))
	r.POST("/console/mcp/:name/toggle", s.gate(s.mcpToggle))
	r.GET("/console/usage", s.gate(s.usagePage))
	r.GET("/console/material", s.gate(s.materialPage))
}

/* ── 会话（HMAC cookie）──────────────────────────────
   payload = userID\x00role\x00expiryUnix；cookie 值 = b64(payload) + "." + b64(hmac)。
   密钥来自 HUB_CONSOLE_SECRET（config 层保证非空，缺省随机——重启即失效，可接受）。 */

func (s *server) issueSession(userID, role string) string {
	payload := fmt.Sprintf("%s\x00%s\x00%d", userID, role, time.Now().Add(sessionTTL).Unix())
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(payload))
	b64 := base64.RawURLEncoding
	return b64.EncodeToString([]byte(payload)) + "." + b64.EncodeToString(mac.Sum(nil))
}

func (s *server) sessionFrom(c *gin.Context) (userID, role string, ok bool) {
	raw, err := c.Cookie(cookieName)
	if err != nil || raw == "" {
		return "", "", false
	}
	if unescaped, err := url.QueryUnescape(raw); err == nil {
		raw = unescaped
	}
	b64 := base64.RawURLEncoding
	dot := strings.LastIndexByte(raw, '.')
	if dot <= 0 {
		return "", "", false
	}
	payload, err1 := b64.DecodeString(raw[:dot])
	sig, err2 := b64.DecodeString(raw[dot+1:])
	if err1 != nil || err2 != nil {
		return "", "", false
	}
	mac := hmac.New(sha256.New, s.secret)
	mac.Write(payload)
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return "", "", false
	}
	parts := strings.Split(string(payload), "\x00")
	if len(parts) != 3 {
		return "", "", false
	}
	exp, err := strconv.ParseInt(parts[2], 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func (s *server) setSessionCookie(c *gin.Context, userID, role string) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     cookieName,
		Value:    url.QueryEscape(s.issueSession(userID, role)),
		Path:     "/console",
		MaxAge:   int(sessionTTL / time.Second),
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
	})
}

// gate wraps a console page: valid admin session or redirect to login.
func (s *server) gate(page gin.HandlerFunc) gin.HandlerFunc {
	return func(c *gin.Context) {
		userID, role, ok := s.sessionFrom(c)
		if !ok {
			c.Redirect(http.StatusFound, "/console/login")
			c.Abort()
			return
		}
		for _, want := range s.adminRoles {
			if role == want {
				c.Set("console.userID", userID)
				c.Set("console.role", role)
				page(c)
				return
			}
		}
		c.String(http.StatusForbidden, "403 需要管理角色（当前 %s）\n", role)
	}
}

func pageCtx(c *gin.Context, page, title string) pageData {
	return pageData{Page: page, Title: title, UserID: c.GetString("console.userID"), Role: c.GetString("console.role")}
}

func renderLogin(c *gin.Context, status int, errMsg string) {
	c.Status(status)
	c.Header("Content-Type", "text/html; charset=utf-8")
	if err := loginTmpl.Execute(c.Writer, map[string]string{"Err": errMsg}); err != nil {
		c.String(http.StatusInternalServerError, "template error")
	}
}

func (s *server) renderPage(c *gin.Context, status int, t *template.Template, data pageData) {
	c.Status(status)
	c.Header("Content-Type", "text/html; charset=utf-8")
	if err := t.ExecuteTemplate(c.Writer, "layout", data); err != nil {
		c.String(http.StatusInternalServerError, "template error")
	}
}

func (s *server) loginPage(c *gin.Context) {
	renderLogin(c, http.StatusOK, "")
}

// loginSubmit 代理 account-center 密码登录（与 /api/v1/auth/login 同上游同限流），
// 本地验签后校验管理角色再发会话。任何失败回登录页带错误行（不区分原因，防枚举）。
func (s *server) loginSubmit(c *gin.Context) {
	email := strings.TrimSpace(c.PostForm("email"))
	password := c.PostForm("password")
	bad := func() {
		renderLogin(c, http.StatusUnauthorized, "登录失败 · 邮箱或密码错误")
	}
	if email == "" || password == "" {
		bad()
		return
	}
	body, _ := json.Marshal(map[string]string{"appId": s.appID, "email": email, "password": password})
	resp, err := http.Post(strings.TrimRight(s.centerURL, "/")+"/api/v1/auth/login", "application/json", strings.NewReader(string(body)))
	if err != nil || resp.StatusCode != http.StatusOK {
		if resp != nil {
			resp.Body.Close()
		}
		bad()
		return
	}
	defer resp.Body.Close()
	var parsed struct {
		AccessToken string `json:"accessToken"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil || parsed.AccessToken == "" {
		bad()
		return
	}
	claims, err := s.verifier.Verify(parsed.AccessToken)
	if err != nil {
		bad()
		return
	}
	for _, want := range s.adminRoles {
		if claims.Role == want {
			s.setSessionCookie(c, claims.UserID(), claims.Role)
			c.Redirect(http.StatusSeeOther, "/console/models")
			return
		}
	}
	renderLogin(c, http.StatusForbidden, "403 需要管理角色")
}

func (s *server) logout(c *gin.Context) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name: cookieName, Value: "", Path: "/console", MaxAge: -1,
		HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode,
	})
	c.Redirect(http.StatusSeeOther, "/console/login")
}

/* ── 模型池页（C3）：读 = st.ListHostedModels；写 = PRG 三动作 ---------- */

var knownProtocols = map[string]bool{"openai": true, "anthropic": true}

func (s *server) modelsPage(c *gin.Context) {
	s.renderModels(c, http.StatusOK, "")
}

// renderModels 出整页（表格+新增表单），errMsg 非空时带错误行。
func (s *server) renderModels(c *gin.Context, status int, errMsg string) {
	data := pageCtx(c, "models", "模型池")
	data.Err = errMsg
	models, err := s.st.ListHostedModels()
	if err != nil {
		c.String(http.StatusInternalServerError, "list models: %v", err)
		return
	}
	data.Models = models
	s.renderPage(c, status, modelsTmpl, data)
}

// modelsCreate 校验镜像 api.POST /models（必填/非负价/协议白名单；409→页面错误行）。
func (s *server) modelsCreate(c *gin.Context) {
	formPrice := func(name string) (int64, bool) {
		raw := strings.TrimSpace(c.PostForm(name))
		if raw == "" {
			return 0, true
		}
		n, err := strconv.ParseInt(raw, 10, 64)
		return n, err == nil && n >= 0
	}
	name := strings.TrimSpace(c.PostForm("name"))
	provider := strings.TrimSpace(c.PostForm("provider"))
	baseURL := strings.TrimSpace(c.PostForm("base_url"))
	apiKey := strings.TrimSpace(c.PostForm("api_key"))
	protocol := c.PostForm("protocol")
	if protocol == "" {
		protocol = "openai"
	}
	priceIn, okIn := formPrice("price_in")
	priceOut, okOut := formPrice("price_out")
	if name == "" || provider == "" || baseURL == "" || apiKey == "" {
		s.renderModels(c, http.StatusBadRequest, "name / provider / base_url / api_key 均必填")
		return
	}
	if !okIn || !okOut {
		s.renderModels(c, http.StatusBadRequest, "价格必须是非负整数")
		return
	}
	if !knownProtocols[protocol] {
		s.renderModels(c, http.StatusBadRequest, "protocol 仅支持 openai / anthropic")
		return
	}
	err := s.st.CreateHostedModel(&store.HostedModel{
		Name: name, Provider: provider, BaseURL: baseURL, APIKey: apiKey,
		UpstreamModel: strings.TrimSpace(c.PostForm("upstream_model")),
		Protocol:      protocol, Capabilities: "{}",
		PriceInPer1K: priceIn, PriceOutPer1K: priceOut, Enabled: new(bool),
	})
	if err != nil {
		if errors.Is(err, gorm.ErrDuplicatedKey) {
			s.renderModels(c, http.StatusConflict, "同名模型已存在")
			return
		}
		c.String(http.StatusInternalServerError, "create model: %v", err)
		return
	}
	c.Redirect(http.StatusSeeOther, "/console/models")
}

func (s *server) modelsDelete(c *gin.Context) {
	if err := s.st.DeleteHostedModel(c.Param("name")); err != nil {
		c.String(http.StatusInternalServerError, "delete model: %v", err)
		return
	}
	c.Redirect(http.StatusSeeOther, "/console/models")
}

func (s *server) modelsToggle(c *gin.Context) {
	name := c.Param("name")
	models, err := s.st.ListHostedModels()
	if err != nil {
		c.String(http.StatusInternalServerError, "list models: %v", err)
		return
	}
	for _, m := range models {
		if m.Name != name {
			continue
		}
		cur := m.Enabled == nil || *m.Enabled // 列默认 true
		next := !cur
		if _, err := s.st.UpdateHostedModel(name, &store.HostedModelPatch{Enabled: &next}); err != nil {
			c.String(http.StatusInternalServerError, "toggle model: %v", err)
			return
		}
		break
	}
	c.Redirect(http.StatusSeeOther, "/console/models")
}

/* ── 计价页（C4）：整表替换语义镜像 api.PUT /pricing/material ──────── */

func (s *server) pricingPage(c *gin.Context) {
	s.renderPricing(c, http.StatusOK, "", false)
}

func (s *server) renderPricing(c *gin.Context, status int, errMsg string, saved bool) {
	data := pageCtx(c, "pricing", "计价")
	data.Err = errMsg
	data.Saved = saved
	prices, err := s.st.MaterialPrices()
	if err != nil {
		c.String(http.StatusInternalServerError, "load prices: %v", err)
		return
	}
	data.ImageModel = prices["image"].Model
	data.ImageCents = prices["image"].CentsPerUnit
	data.VideoModel = prices["video"].Model
	data.VideoCents = prices["video"].CentsPerUnit
	s.renderPage(c, status, pricingTmpl, data)
}

func (s *server) pricingSave(c *gin.Context) {
	cents := func(name string) (int64, bool) {
		raw := strings.TrimSpace(c.PostForm(name))
		if raw == "" {
			return 0, true
		}
		n, err := strconv.ParseInt(raw, 10, 64)
		return n, err == nil && n >= 0
	}
	imageModel := strings.TrimSpace(c.PostForm("image_model"))
	videoModel := strings.TrimSpace(c.PostForm("video_model"))
	imageCents, okI := cents("image_cents")
	videoCents, okV := cents("video_cents")
	if imageModel == "" || videoModel == "" {
		s.renderPricing(c, http.StatusBadRequest, "image / video 的 model 均必填（整表替换）", false)
		return
	}
	if !okI || !okV {
		s.renderPricing(c, http.StatusBadRequest, "单价必须是非负整数", false)
		return
	}
	table := map[string]config.MaterialPrice{
		"image": {Model: imageModel, CentsPerUnit: imageCents},
		"video": {Model: videoModel, CentsPerUnit: videoCents},
	}
	raw, err := json.Marshal(table)
	if err != nil {
		c.String(http.StatusInternalServerError, "marshal prices: %v", err)
		return
	}
	if err := s.st.SetSystemConfig(store.SystemKeyMaterialPrices, string(raw)); err != nil {
		c.String(http.StatusInternalServerError, "save prices: %v", err)
		return
	}
	s.renderPricing(c, http.StatusOK, "", true)
}

/* ── MCP 页（C5）：upstream 注册/启停/删除，AllowedTools 须 JSON 数组 ── */

func (s *server) mcpPage(c *gin.Context) {
	s.renderMcp(c, http.StatusOK, "")
}

func (s *server) renderMcp(c *gin.Context, status int, errMsg string) {
	data := pageCtx(c, "mcp", "MCP")
	data.Err = errMsg
	rows, err := s.st.ListMcpUpstreams()
	if err != nil {
		c.String(http.StatusInternalServerError, "list upstreams: %v", err)
		return
	}
	data.Upstreams = rows
	s.renderPage(c, status, mcpTmpl, data)
}

func (s *server) mcpCreate(c *gin.Context) {
	name := strings.TrimSpace(c.PostForm("name"))
	baseURL := strings.TrimSpace(c.PostForm("base_url"))
	authToken := strings.TrimSpace(c.PostForm("auth_token"))
	tools := strings.TrimSpace(c.PostForm("allowed_tools"))
	if name == "" || baseURL == "" {
		s.renderMcp(c, http.StatusBadRequest, "name / base_url 均必填")
		return
	}
	if tools != "" {
		var probe []any
		if err := json.Unmarshal([]byte(tools), &probe); err != nil {
			s.renderMcp(c, http.StatusBadRequest, "allowed_tools 必须是 JSON 数组，如 [\"search\",\"fetch\"]")
			return
		}
	} else {
		tools = "[]"
	}
	err := s.st.CreateMcpUpstream(&store.McpUpstream{
		Name: name, BaseURL: baseURL, AuthToken: authToken, AllowedTools: tools, Enabled: new(bool),
	})
	if err != nil {
		if errors.Is(err, gorm.ErrDuplicatedKey) {
			s.renderMcp(c, http.StatusConflict, "同名 upstream 已存在")
			return
		}
		c.String(http.StatusInternalServerError, "create upstream: %v", err)
		return
	}
	c.Redirect(http.StatusSeeOther, "/console/mcp")
}

func (s *server) mcpDelete(c *gin.Context) {
	if err := s.st.DeleteMcpUpstream(c.Param("name")); err != nil {
		c.String(http.StatusInternalServerError, "delete upstream: %v", err)
		return
	}
	c.Redirect(http.StatusSeeOther, "/console/mcp")
}

func (s *server) mcpToggle(c *gin.Context) {
	name := c.Param("name")
	rows, err := s.st.ListMcpUpstreams()
	if err != nil {
		c.String(http.StatusInternalServerError, "list upstreams: %v", err)
		return
	}
	for _, u := range rows {
		if u.Name != name {
			continue
		}
		next := !u.IsEnabled()
		if err := s.st.UpdateMcpUpstreamEnabled(name, next); err != nil {
			c.String(http.StatusInternalServerError, "toggle upstream: %v", err)
			return
		}
		break
	}
	c.Redirect(http.StatusSeeOther, "/console/mcp")
}

/* ── 用量与素材监控（C6，只读）────────────────────────────── */

func (s *server) usagePage(c *gin.Context) {
	days := 30
	if q, err := strconv.Atoi(c.Query("days")); err == nil && (q == 7 || q == 30 || q == 90) {
		days = q
	}
	data := pageCtx(c, "usage", "用量")
	data.Days = days
	rows, err := s.st.UsageSummaryAll(days)
	if err != nil {
		c.String(http.StatusInternalServerError, "usage: %v", err)
		return
	}
	data.Usage = rows
	s.renderPage(c, http.StatusOK, usageTmpl, data)
}

func (s *server) materialPage(c *gin.Context) {
	data := pageCtx(c, "material", "素材任务")
	rows, err := s.st.ListMaterialTasksAll(50)
	if err != nil {
		c.String(http.StatusInternalServerError, "material tasks: %v", err)
		return
	}
	data.Tasks = rows
	s.renderPage(c, http.StatusOK, materialTmpl, data)
}

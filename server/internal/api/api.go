// Package api wires the HTTP surface: a public health check plus the
// /api/v1 group behind account-center bearer auth.
package api

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/xycxmz/company-platform-v1/server/internal/auth"
	"github.com/xycxmz/company-platform-v1/server/internal/auth/acauth"
	"github.com/xycxmz/company-platform-v1/server/internal/config"
	"github.com/xycxmz/company-platform-v1/server/internal/gateway"
	"github.com/xycxmz/company-platform-v1/server/internal/kb"
	"github.com/xycxmz/company-platform-v1/server/internal/material"
	"github.com/xycxmz/company-platform-v1/server/internal/mcp"
	"github.com/xycxmz/company-platform-v1/server/internal/store"
	"github.com/xycxmz/company-platform-v1/server/internal/update"
)

// modelView is the wire shape for HostedModel. It deliberately has no key
// field: hosted API keys never leave the server in any response.
type modelView struct {
	Name          string          `json:"name"`
	Provider      string          `json:"provider"`
	UpstreamModel string          `json:"upstream_model"`
	Protocol      string          `json:"protocol"`
	Capabilities  json.RawMessage `json:"capabilities"`
	PriceInPer1K  int64           `json:"price_in_per_1k"`
	PriceOutPer1K int64           `json:"price_out_per_1k"`
	PriceIn       int64           `json:"price_in"`
	PriceOut      int64           `json:"price_out"`
	Enabled       bool            `json:"enabled"`
}

// pricePerMillion 把表存储单位（分/千 token）换算成 price_in / price_out 的
// 契约单位（分/百万 token，前端 worker 按此计价）；未定价 0 原样透传。
func pricePerMillion(per1k int64) int64 {
	return per1k * 1000
}

func viewModel(m *store.HostedModel) modelView {
	caps := json.RawMessage(strings.TrimSpace(m.Capabilities))
	if len(caps) == 0 {
		caps = json.RawMessage("{}")
	}
	return modelView{
		Name:          m.Name,
		Provider:      m.Provider,
		UpstreamModel: m.UpstreamModel,
		Protocol:      m.Protocol,
		Capabilities:  caps,
		PriceInPer1K:  m.PriceInPer1K,
		PriceOutPer1K: m.PriceOutPer1K,
		PriceIn:       pricePerMillion(m.PriceInPer1K),
		PriceOut:      pricePerMillion(m.PriceOutPer1K),
		Enabled:       m.IsEnabled(),
	}
}

// knownProtocols is what the gateway can actually proxy today: it implements
// only the OpenAI-compatible wire protocol. anthropic is a deliberate future
// reservation, not a working value — storing it would create a model the
// gateway silently mis-serves, so the write boundary rejects it loudly.
var knownProtocols = map[string]bool{"openai": true}

const protocolMessage = "protocol must be openai (anthropic is reserved for future support)"

// capabilitiesObject accepts an absent capabilities field and otherwise
// requires a JSON object: null, strings, and arrays are valid JSON but would
// surface as model views consumers cannot read by key.
func capabilitiesObject(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return true
	}
	var obj map[string]json.RawMessage
	return json.Unmarshal(raw, &obj) == nil && obj != nil
}

func Register(r *gin.Engine, cfg *config.Config, st *store.Store, v *acauth.Verifier) {
	r.Use(corsMiddleware(cfg.CORSOrigins))
	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})
	// 根路径标识：浏览器直访不再是裸 404 page not found（API 只在
	// /healthz 与 /api/v1 下）。B3b 品牌面：标识望舒化——HUB_APP_ID 的
	// appId/aud 身份串不在此面，绝不动（见 config.AppID）。
	r.GET("/", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"service": "望舒 wangshu hub",
			"health":  "/healthz",
			"api":     "/api/v1",
		})
	})

	// login is the one unauthenticated /api/v1 route: it exchanges
	// credentials for the center-issued token every other route requires.
	// The per-IP failure limit rides only on this route (audit low-5): an
	// open proxy would let the internet brute-force center credentials
	// through us.
	r.POST("/api/v1/auth/login", LoginRateLimit(NewLoginLimiter(cfg.LoginLimitWindow, cfg.LoginLimitMax)), login(cfg.CenterURL, cfg.AppID))

	api := r.Group("/api/v1", auth.Middleware(v))

	api.GET("/me", func(c *gin.Context) {
		claims := c.MustGet(auth.ClaimsKey).(*acauth.Claims)
		id := claims.UserID()
		if err := st.UpsertUser(&store.User{ID: id, Email: claims.Email, Nickname: claims.Nickname}); err != nil {
			internalError(c, err)
			return
		}
		if err := st.TouchUser(id); err != nil {
			internalError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"id": id, "email": claims.Email, "nickname": claims.Nickname})
	})

	api.GET("/models", func(c *gin.Context) {
		models, err := st.ListHostedModels()
		if err != nil {
			internalError(c, err)
			return
		}
		views := make([]modelView, 0, len(models))
		for i := range models {
			views = append(views, viewModel(&models[i]))
		}
		c.JSON(http.StatusOK, gin.H{"models": views})
	})

	// B1（roadmap-r4）管理面角色门：托管模型池与 MCP upstream 注册表只对
	// admin/owner 开放（HUB_ADMIN_ROLES 可覆盖默认 admin,owner）。对话、会话、
	// 素材代理与 MCP 代理等读写面仍对所有持牌用户可用。
	admin := auth.RequireRoles(cfg.AdminRoles...)
	api.POST("/models", admin, func(c *gin.Context) {
		var req struct {
			Name          string          `json:"name"`
			Provider      string          `json:"provider"`
			BaseURL       string          `json:"base_url"`
			APIKey        string          `json:"api_key"`
			UpstreamModel string          `json:"upstream_model"`
			Protocol      string          `json:"protocol"`
			Capabilities  json.RawMessage `json:"capabilities"`
			PriceInPer1K  int64           `json:"price_in_per_1k"`
			PriceOutPer1K int64           `json:"price_out_per_1k"`
			Enabled       *bool           `json:"enabled"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			badRequest(c, err.Error())
			return
		}
		if req.Name == "" || req.Provider == "" || req.BaseURL == "" || req.APIKey == "" {
			badRequest(c, "name, provider, base_url and api_key are required")
			return
		}
		if req.PriceInPer1K < 0 || req.PriceOutPer1K < 0 {
			badRequest(c, "prices must be non-negative")
			return
		}
		if !capabilitiesObject(req.Capabilities) {
			badRequest(c, "capabilities must be a JSON object")
			return
		}
		if req.Protocol == "" {
			req.Protocol = "openai"
		}
		if !knownProtocols[req.Protocol] {
			badRequest(c, protocolMessage)
			return
		}
		m := &store.HostedModel{
			Name:          req.Name,
			Provider:      req.Provider,
			BaseURL:       req.BaseURL,
			APIKey:        req.APIKey,
			UpstreamModel: req.UpstreamModel,
			Protocol:      req.Protocol,
			Capabilities:  string(req.Capabilities),
			PriceInPer1K:  req.PriceInPer1K,
			PriceOutPer1K: req.PriceOutPer1K,
			Enabled:       req.Enabled, // nil ⇒ column default (true)
		}
		if err := st.CreateHostedModel(m); err != nil {
			if errors.Is(err, gorm.ErrDuplicatedKey) {
				c.JSON(http.StatusConflict, gin.H{"error": gin.H{"code": "CONFLICT", "message": "model name already exists"}})
				return
			}
			internalError(c, err)
			return
		}
		c.JSON(http.StatusCreated, gin.H{"model": viewModel(m)})
	})

	api.DELETE("/models/:name", admin, func(c *gin.Context) {
		if err := st.DeleteHostedModel(c.Param("name")); err != nil {
			internalError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	// B2（roadmap-r4）：模型池部分更新——换 key、启停、调价、改上游映射，
	// 均为可空字段（nil = 不动）。同属管理面角色门。
	api.PATCH("/models/:name", admin, func(c *gin.Context) {
		var req struct {
			Provider      *string         `json:"provider"`
			BaseURL       *string         `json:"base_url"`
			APIKey        *string         `json:"api_key"`
			UpstreamModel *string         `json:"upstream_model"`
			Protocol      *string         `json:"protocol"`
			Capabilities  json.RawMessage `json:"capabilities"`
			PriceInPer1K  *int64          `json:"price_in_per_1k"`
			PriceOutPer1K *int64          `json:"price_out_per_1k"`
			Enabled       *bool           `json:"enabled"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			badRequest(c, err.Error())
			return
		}
		for label, v := range map[string]*string{
			"provider": req.Provider, "base_url": req.BaseURL, "api_key": req.APIKey,
			"upstream_model": req.UpstreamModel, "protocol": req.Protocol,
		} {
			if v != nil && *v == "" {
				badRequest(c, label+" must not be empty when supplied")
				return
			}
		}
		if (req.PriceInPer1K != nil && *req.PriceInPer1K < 0) || (req.PriceOutPer1K != nil && *req.PriceOutPer1K < 0) {
			badRequest(c, "prices must be non-negative")
			return
		}
		if req.Protocol != nil && !knownProtocols[*req.Protocol] {
			badRequest(c, protocolMessage)
			return
		}
		if !capabilitiesObject(req.Capabilities) {
			badRequest(c, "capabilities must be a JSON object")
			return
		}
		patch := &store.HostedModelPatch{
			Provider: req.Provider, BaseURL: req.BaseURL, APIKey: req.APIKey,
			UpstreamModel: req.UpstreamModel, Protocol: req.Protocol,
			PriceInPer1K: req.PriceInPer1K, PriceOutPer1K: req.PriceOutPer1K,
			Enabled: req.Enabled,
		}
		if len(req.Capabilities) > 0 {
			caps := string(req.Capabilities)
			patch.Capabilities = &caps
		}
		m, err := st.UpdateHostedModel(c.Param("name"), patch)
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				c.JSON(http.StatusNotFound, gin.H{"error": gin.H{"code": "NOT_FOUND", "message": "model not found"}})
				return
			}
			internalError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"model": viewModel(m)})
	})

	registerSessions(api, st)
	gateway.New(st).Register(api)
	registerPricing(api, st, admin)
	material.Register(api.Group("/material"), st, cfg)
	kb.Register(api.Group("/kb"), st, cfg)
	mcp.Register(api.Group("/mcp"), st, admin)
	// The update feed is public: the updater client (and a fresh install
	// with no token yet) must reach it. Path traversal is guarded in-package.
	update.Register(r.Group("/api/v1"), cfg.UpdateDir)
}

func badRequest(c *gin.Context, msg string) {
	c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST", "message": msg}})
}

func internalError(c *gin.Context, err error) {
	log.Printf("api error: %v", err)
	c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "INTERNAL", "message": "internal error"}})
}

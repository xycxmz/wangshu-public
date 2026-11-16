// Package mcp is the hub's built-in MCP governance module (P2, toC trimmed):
// an upstream registry, a JSON-RPC reverse proxy that swaps credentials at
// the hub boundary, and a per-user audit log of every proxied call. An
// upstream may carry a tool allowlist: tools/list responses are filtered to
// it, and a tools/call outside it is denied at the hub, never upstream.
package mcp

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/xycxmz/company-platform-v1/server/internal/auth"
	"github.com/xycxmz/company-platform-v1/server/internal/auth/acauth"
	"github.com/xycxmz/company-platform-v1/server/internal/store"
)

// upstreamTimeout bounds one proxied call end to end; upstreamDial bounds
// connection setup only, mirroring the gateway's split. A var so tests can
// shorten it, the material worker's pollInterval precedent.
var (
	upstreamTimeout = 60 * time.Second
	upstreamDial    = 10 * time.Second
)

// upstreamView deliberately has no auth_token field: upstream credentials
// never leave the server in any response, only the fact that one exists.
type upstreamView struct {
	Name         string    `json:"name"`
	BaseURL      string    `json:"base_url"`
	HasToken     bool      `json:"has_token"`
	AllowedTools []string  `json:"allowed_tools"` // empty = every tool visible
	Enabled      bool      `json:"enabled"`
	CreatedAt    time.Time `json:"created_at"`
}

func upstreamViewOf(u *store.McpUpstream) upstreamView {
	tools := u.ToolAllowlist()
	if tools == nil {
		tools = []string{}
	}
	return upstreamView{
		Name:         u.Name,
		BaseURL:      u.BaseURL,
		HasToken:     u.AuthToken != "",
		AllowedTools: tools,
		Enabled:      u.IsEnabled(),
		CreatedAt:    u.CreatedAt,
	}
}

type auditView struct {
	ID         uint64    `json:"id"`
	Upstream   string    `json:"upstream"`
	Method     string    `json:"method"`
	Path       string    `json:"path"`
	StatusCode int       `json:"status_code"`
	DurationMs int64     `json:"duration_ms"`
	CreatedAt  time.Time `json:"created_at"`
}

func auditViewOf(a *store.McpAudit) auditView {
	return auditView{
		ID:         a.ID,
		Upstream:   a.Upstream,
		Method:     a.Method,
		Path:       a.Path,
		StatusCode: a.StatusCode,
		DurationMs: a.DurationMs,
		CreatedAt:  a.CreatedAt,
	}
}

type handler struct {
	store  *store.Store
	client *http.Client
}

// Register mounts the MCP routes on the auth-protected group handed in
// (api.go mounts it at /api/v1/mcp). admin is the management-plane role gate
// (auth.RequireRoles) applied to the upstream registry writes; proxy and
// reads stay open to every authenticated user.
func Register(rg *gin.RouterGroup, st *store.Store, admin gin.HandlerFunc) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = (&net.Dialer{Timeout: upstreamDial}).DialContext
	h := &handler{
		store:  st,
		client: &http.Client{Timeout: upstreamTimeout, Transport: transport},
	}
	rg.GET("/upstreams", h.listUpstreams)
	rg.POST("/upstreams", admin, h.createUpstream)
	rg.PATCH("/upstreams/:name", admin, h.updateUpstream)
	rg.DELETE("/upstreams/:name", admin, h.deleteUpstream)
	rg.GET("/audit", h.listAudit)
	rg.POST("/:name/proxy", h.proxy)
	rg.GET("/:name/proxy", h.proxy)
}

func (h *handler) listUpstreams(c *gin.Context) {
	rows, err := h.store.ListMcpUpstreams()
	if err != nil {
		internalError(c, err)
		return
	}
	views := make([]upstreamView, 0, len(rows))
	for i := range rows {
		views = append(views, upstreamViewOf(&rows[i]))
	}
	c.JSON(http.StatusOK, gin.H{"upstreams": views})
}

func (h *handler) createUpstream(c *gin.Context) {
	var req struct {
		Name         string   `json:"name"`
		BaseURL      string   `json:"base_url"`
		AuthToken    string   `json:"auth_token"`
		AllowedTools []string `json:"allowed_tools"`
		Enabled      *bool    `json:"enabled"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		badRequest(c, err.Error())
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	req.BaseURL = strings.TrimSpace(req.BaseURL)
	if req.Name == "" || req.BaseURL == "" {
		badRequest(c, "name and base_url are required")
		return
	}
	u := &store.McpUpstream{
		Name:      req.Name,
		BaseURL:   req.BaseURL,
		AuthToken: req.AuthToken,
		Enabled:   req.Enabled, // nil left nil: the column default (true) applies
	}
	if len(req.AllowedTools) > 0 {
		raw, err := json.Marshal(req.AllowedTools)
		if err != nil {
			internalError(c, err)
			return
		}
		u.AllowedTools = string(raw)
	}
	if err := h.store.CreateMcpUpstream(u); err != nil {
		if errors.Is(err, gorm.ErrDuplicatedKey) {
			c.JSON(http.StatusConflict, gin.H{"error": gin.H{"code": "CONFLICT", "message": "upstream name already exists"}})
			return
		}
		internalError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"upstream": upstreamViewOf(u)})
}

// updateUpstream is the API-face enable/disable toggle (C3, depth-batch-r9c;
// until now only the console's internal route could flip it). enabled must be
// supplied explicitly — a missing field must not silently disable an upstream.
// Unknown names read as gorm.ErrRecordNotFound from the store and answer 404,
// mirroring the proxy's UPSTREAM_NOT_FOUND envelope.
func (h *handler) updateUpstream(c *gin.Context) {
	var req struct {
		Enabled *bool `json:"enabled"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		badRequest(c, err.Error())
		return
	}
	if req.Enabled == nil {
		badRequest(c, "enabled is required")
		return
	}
	if err := h.store.UpdateMcpUpstreamEnabled(c.Param("name"), *req.Enabled); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			errJSON(c, http.StatusNotFound, "UPSTREAM_NOT_FOUND", "upstream "+c.Param("name")+" is not registered")
			return
		}
		internalError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

func (h *handler) deleteUpstream(c *gin.Context) {
	if err := h.store.DeleteMcpUpstream(c.Param("name")); err != nil {
		internalError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

func (h *handler) listAudit(c *gin.Context) {
	limit := 100
	if q := c.Query("limit"); q != "" {
		n, err := strconv.Atoi(q)
		if err != nil || n < 1 {
			badRequest(c, "limit must be a positive integer")
			return
		}
		// Clamp instead of reject: a big n is a legitimate ask, just not one
		// the store should pay for, so audit reads cap at 500 rows.
		if n > 500 {
			n = 500
		}
		limit = n
	}
	userID := c.MustGet(auth.ClaimsKey).(*acauth.Claims).UserID()
	rows, err := h.store.ListMcpAudit(userID, limit)
	if err != nil {
		internalError(c, err)
		return
	}
	views := make([]auditView, 0, len(rows))
	for i := range rows {
		views = append(views, auditViewOf(&rows[i]))
	}
	c.JSON(http.StatusOK, gin.H{"audit": views})
}

func (h *handler) proxy(c *gin.Context) {
	userID := c.MustGet(auth.ClaimsKey).(*acauth.Claims).UserID()
	name := c.Param("name")

	up, err := h.store.FindEnabledMcpUpstreamByName(name)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		errJSON(c, http.StatusNotFound, "UPSTREAM_NOT_FOUND", "upstream "+name+" is not registered")
		return
	}
	if errors.Is(err, store.ErrMcpUpstreamDisabled) {
		errJSON(c, http.StatusConflict, "UPSTREAM_DISABLED", "upstream "+name+" is disabled")
		return
	}
	if err != nil {
		internalError(c, err)
		return
	}

	start := time.Now()
	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		log.Printf("mcp: read request body: %v", err)
		status := http.StatusBadGateway
		errJSON(c, status, "BAD_GATEWAY", "upstream request failed")
		h.audit(userID, name, c.Request.Method, c.Request.URL.Path, status, time.Since(start))
		return
	}

	// Tool-level visibility gate (visibility is permission, the gateway
	// blueprint): with an allowlist set, a tools/call outside it is answered
	// by the hub and a tools/list response is filtered to it. Any other body
	// shape relays untouched.
	allow := allowSet(up.ToolAllowlist())
	filterTools := false
	if allow != nil && c.Request.Method == http.MethodPost {
		var rpc rpcRequest
		if json.Unmarshal(body, &rpc) == nil {
			if rpc.Method == "tools/call" && rpc.Params.Name != "" && !allow[rpc.Params.Name] {
				denyTool(c, rpc.ID, rpc.Params.Name)
				// The call never travels, so the audit row names what was
				// blocked instead of the transport: method carries
				// tools/call:<name>, path carries the upstream.
				h.audit(userID, name, "tools/call:"+rpc.Params.Name, name, http.StatusOK, time.Since(start))
				return
			}
			filterTools = rpc.Method == "tools/list"
		}
	}

	status, err := h.relay(c, up, body, filterTools, allow)
	if err != nil {
		// Transport failure still audits as 502: an unreachable upstream is
		// governance signal, not something to hide from the log.
		log.Printf("mcp: upstream %s: %v", up.BaseURL, err)
		status = http.StatusBadGateway
		errJSON(c, status, "BAD_GATEWAY", "upstream request failed")
	}
	h.audit(userID, name, c.Request.Method, c.Request.URL.Path, status, time.Since(start))
}

// rpcRequest is the slice of the JSON-RPC envelope the tool gate reads: the
// method, the id echoed back on a local denial, and params.name for tools/call.
type rpcRequest struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params struct {
		Name string `json:"name"`
	} `json:"params"`
}

// allowSet turns an upstream's tool allowlist into a membership set; an empty
// list (no filtering configured) stays nil so the gate is skipped entirely.
func allowSet(tools []string) map[string]bool {
	if len(tools) == 0 {
		return nil
	}
	set := make(map[string]bool, len(tools))
	for _, t := range tools {
		set[t] = true
	}
	return set
}

// denyTool answers a tools/call outside the allowlist in JSON-RPC semantics:
// the error object rides on HTTP 200, the request id is echoed (null when the
// caller sent none), and the upstream never sees the call.
func denyTool(c *gin.Context, id json.RawMessage, tool string) {
	c.JSON(http.StatusOK, gin.H{
		"jsonrpc": "2.0",
		"id":      id,
		"error":   gin.H{"code": -32603, "message": "tool not allowed: " + tool},
	})
}

// filterToolsList rewrites a tools/list response so result.tools carries only
// allowlisted tools, each tool object relayed byte-identically inside the
// re-serialized envelope. Anything unexpected — non-JSON body, a JSON-RPC
// error object, a missing result or tools — is relayed verbatim with one log
// line: a weird upstream degrades the filter, it must not break the proxy.
func filterToolsList(upstream string, body []byte, allow map[string]bool) []byte {
	bad := func(reason string) []byte {
		log.Printf("mcp: %s: tools/list response relayed unfiltered: %s", upstream, reason)
		return body
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(body, &top); err != nil {
		return bad("not JSON")
	}
	resultRaw, ok := top["result"]
	if !ok {
		return bad("no result")
	}
	var result map[string]json.RawMessage
	if err := json.Unmarshal(resultRaw, &result); err != nil {
		return bad("result not an object")
	}
	toolsRaw, ok := result["tools"]
	if !ok {
		return bad("no tools")
	}
	var tools []json.RawMessage
	if err := json.Unmarshal(toolsRaw, &tools); err != nil {
		return bad("tools not an array")
	}
	kept := make([]json.RawMessage, 0, len(tools))
	for _, tool := range tools {
		var name struct {
			Name string `json:"name"`
		}
		// A tool whose name cannot be read cannot be proven allowed, so it is
		// dropped: per-tool visibility never fails open.
		if json.Unmarshal(tool, &name) == nil && allow[name.Name] {
			kept = append(kept, tool)
		}
	}
	keptRaw, err := json.Marshal(kept)
	if err != nil {
		return bad("re-serialize tools")
	}
	result["tools"] = keptRaw
	resultRaw, err = json.Marshal(result)
	if err != nil {
		return bad("re-serialize result")
	}
	top["result"] = resultRaw
	out, err := json.Marshal(top)
	if err != nil {
		return bad("re-serialize response")
	}
	return out
}

// relay forwards the caller's request, already read into body, to the
// upstream BaseURL and copies the response back verbatim, 2xx and non-2xx
// alike — unless filterTools is set, when the tools/list response is reduced
// to the allowlist first. The response body is fully read before anything is
// written, so an error leaves the response clean for the caller's 502.
func (h *handler) relay(c *gin.Context, up *store.McpUpstream, body []byte, filterTools bool, allow map[string]bool) (int, error) {
	req, err := http.NewRequestWithContext(c.Request.Context(), c.Request.Method, up.BaseURL, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	// Credential policy (2026-11-10 audit tightening): a configured upstream
	// token is the only Authorization that may travel. Without one the
	// upstream request carries no Authorization header — the caller's hub
	// JWT never leaves the server, so it is never relayed.
	if up.AuthToken != "" {
		req.Header.Set("Authorization", "Bearer "+up.AuthToken)
	}
	if len(body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := h.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, err
	}
	if filterTools {
		respBody = filterToolsList(up.Name, respBody, allow)
	}
	c.Data(resp.StatusCode, resp.Header.Get("Content-Type"), respBody)
	return resp.StatusCode, nil
}

// audit records one resolved proxy call; a failed write is logged, never
// surfaced — an audit hiccup must not take an already-relayed response down.
func (h *handler) audit(userID, upstream, method, path string, status int, took time.Duration) {
	if err := h.store.CreateMcpAudit(&store.McpAudit{
		UserID:     userID,
		Upstream:   upstream,
		Method:     method,
		Path:       path,
		StatusCode: status,
		DurationMs: took.Milliseconds(),
	}); err != nil {
		log.Printf("mcp: write audit: %v", err)
	}
}

func badRequest(c *gin.Context, msg string) {
	errJSON(c, http.StatusBadRequest, "BAD_REQUEST", msg)
}

func internalError(c *gin.Context, err error) {
	log.Printf("mcp api error: %v", err)
	errJSON(c, http.StatusInternalServerError, "INTERNAL", "internal error")
}

func errJSON(c *gin.Context, status int, code, msg string) {
	c.JSON(status, gin.H{"error": gin.H{"code": code, "message": msg}})
}

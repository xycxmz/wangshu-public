// CORS for the desktop client: the Tauri webview origins plus any the
// operator adds via HUB_CORS_ORIGINS. Preflight is answered for the API group.
package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

func corsMiddleware(extra string) gin.HandlerFunc {
	allowed := map[string]bool{
		"http://localhost:5173":   true, // vite dev server
		"http://127.0.0.1:5173":   true,
		"tauri://localhost":       true, // macOS/Linux webview
		"https://tauri.localhost": true,
		// Tauri 2 Windows WebView2 的生产 origin 是 http 而非 https
		// （2026-11-12 生产包登录「hub 不可达」实测根因：该 origin 的
		// preflight 204 无 ACAO 头，WebView2 拦截 fetch；dev 的 :5173
		// 一直在白名单里，所以 dev 全绿、只有安装包形态踩中）。
		"http://tauri.localhost": true,
	}
	for _, o := range strings.Split(extra, ",") {
		if o = strings.TrimSpace(o); o != "" {
			allowed[o] = true
		}
	}
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin != "" && allowed[origin] {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Vary", "Origin")
			c.Header("Access-Control-Allow-Headers", "Authorization, Content-Type")
			c.Header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
		}
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

// login proxies the account-center password login so the client only ever
// talks to the hub. The center mints the EdDSA access token; hub verifies it
// like any other bearer token on later calls.
func login(centerURL, appID string) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Email    string `json:"email"`
			Password string `json:"password"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || req.Email == "" || req.Password == "" {
			badRequest(c, "email and password are required")
			return
		}
		resp, err := http.Post(strings.TrimRight(centerURL, "/")+"/api/v1/auth/login", "application/json",
			strings.NewReader(`{"appId":`+quoteJSON(appID)+`,"email":`+quoteJSON(req.Email)+`,"password":`+quoteJSON(req.Password)+`}`))
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": gin.H{"code": "BAD_GATEWAY", "message": "account center unreachable"}})
			return
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		c.Data(resp.StatusCode, "application/json", body)
	}
}

func quoteJSON(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

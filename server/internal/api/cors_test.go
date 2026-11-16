package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/xycxmz/company-platform-v1/server/internal/config"
)

// CORS 契约测试：桌面客户端的三类 origin（vite dev / Tauri 2 Windows
// WebView2 生产 / Tauri macOS）必须拿到 ACAO 头，否则 WebView 拦截 fetch，
// 客户端表现为「hub 不可达」。http://tauri.localhost 是 2026-11-12 生产包
// 登录卡死的实测根因（Tauri 2 Windows origin 是 http 而非 https）。
func TestCORSAllowedOrigins(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	Register(r, &config.Config{}, nil, nil)

	allowed := []string{
		"http://localhost:5173",
		"http://127.0.0.1:5173",
		"tauri://localhost",
		"https://tauri.localhost",
		"http://tauri.localhost",
	}
	for _, origin := range allowed {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodOptions, "/api/v1/auth/login", nil)
		req.Header.Set("Origin", origin)
		req.Header.Set("Access-Control-Request-Method", "POST")
		r.ServeHTTP(w, req)
		if got := w.Header().Get("Access-Control-Allow-Origin"); got != origin {
			t.Errorf("origin %s: ACAO = %q, want %q", origin, got, origin)
		}
	}

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodOptions, "/api/v1/auth/login", nil)
	req.Header.Set("Origin", "https://evil.example")
	req.Header.Set("Access-Control-Request-Method", "POST")
	r.ServeHTTP(w, req)
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("unknown origin must not receive ACAO, got %q", got)
	}
}

func TestRootIdentifiesService(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	Register(r, &config.Config{}, nil, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("GET / = %d, want 200", w.Code)
	}
}

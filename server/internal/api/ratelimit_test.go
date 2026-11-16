package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/xycxmz/company-platform-v1/server/internal/config"
)

// loginEngine builds the real route stack against a mock account center
// that answers each attempt by the password the hub forwarded. It returns
// the hit counter so tests can prove a 429 never reached the center.
func loginEngine(t *testing.T, respond func(password string) int) (*gin.Engine, *int32) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	var hits int32
	center := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		var req struct {
			Password string `json:"password"`
		}
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &req)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(respond(req.Password))
		_, _ = w.Write([]byte(`{"error":{"code":"INVALID_CREDENTIALS","message":"mock"}}`))
	}))
	t.Cleanup(center.Close)
	r := gin.New()
	Register(r, &config.Config{CenterURL: center.URL, AppID: "api-test"}, nil, nil)
	return r, &hits
}

func postLogin(r *gin.Engine, xff, password string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
		strings.NewReader(`{"email":"u@example.com","password":`+quoteJSON(password)+`}`))
	req.Header.Set("Content-Type", "application/json")
	if xff != "" {
		req.Header.Set("X-Forwarded-For", xff)
	}
	r.ServeHTTP(w, req)
	return w
}

func TestLoginRateLimitBlocksEleventhFailure(t *testing.T) {
	r, hits := loginEngine(t, func(string) int { return http.StatusUnauthorized })
	for i := 0; i < 10; i++ {
		if w := postLogin(r, "", "bad"); w.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: status = %d, want 401", i+1, w.Code)
		}
	}
	w := postLogin(r, "", "bad")
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("11th attempt: status = %d, want 429", w.Code)
	}
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("429 body is not the error envelope: %v (%s)", err, w.Body.String())
	}
	if body.Error.Code != "RATE_LIMITED" {
		t.Fatalf("429 code = %q, want RATE_LIMITED", body.Error.Code)
	}
	if n := atomic.LoadInt32(hits); n != 10 {
		t.Fatalf("center saw %d requests, want 10 (a 429 must not reach the center)", n)
	}
}

func TestLoginRateLimitSuccessResetsCount(t *testing.T) {
	r, hits := loginEngine(t, func(pw string) int {
		if pw == "good" {
			return http.StatusOK
		}
		return http.StatusUnauthorized
	})
	for i := 0; i < 5; i++ {
		if w := postLogin(r, "", "bad"); w.Code != http.StatusUnauthorized {
			t.Fatalf("failure %d: status = %d, want 401", i+1, w.Code)
		}
	}
	if w := postLogin(r, "", "good"); w.Code != http.StatusOK {
		t.Fatalf("success attempt: status = %d, want 200", w.Code)
	}
	// without the reset, the 5 carried-over failures would trip the limit
	// inside this burst: only 5 more failures would reach the center.
	for i := 0; i < 10; i++ {
		if w := postLogin(r, "", "bad"); w.Code != http.StatusUnauthorized {
			t.Fatalf("post-success failure %d: status = %d, want 401", i+1, w.Code)
		}
	}
	if w := postLogin(r, "", "bad"); w.Code != http.StatusTooManyRequests {
		t.Fatalf("attempt after full burst: status = %d, want 429", w.Code)
	}
	if n := atomic.LoadInt32(hits); n != 16 {
		t.Fatalf("center saw %d requests, want 16 (5 failures + 1 success + 10 failures)", n)
	}
}

func TestLoginRateLimitPerIP(t *testing.T) {
	r, hits := loginEngine(t, func(string) int { return http.StatusUnauthorized })
	for i := 0; i < 10; i++ {
		if w := postLogin(r, "9.9.9.9", "bad"); w.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: status = %d, want 401", i+1, w.Code)
		}
	}
	if w := postLogin(r, "9.9.9.9", "bad"); w.Code != http.StatusTooManyRequests {
		t.Fatalf("blocked IP: status = %d, want 429", w.Code)
	}
	if w := postLogin(r, "8.8.8.8", "bad"); w.Code != http.StatusUnauthorized {
		t.Fatalf("other IP: status = %d, want 401 (limits are per IP)", w.Code)
	}
	if n := atomic.LoadInt32(hits); n != 11 {
		t.Fatalf("center saw %d requests, want 11", n)
	}
}

// The hub runs behind edge-caddy, which appends the peer it saw to any
// client-supplied X-Forwarded-For: the key must be the last element (the
// trusted hop's value), never the spoofable first one.
func TestLoginRateLimitKeysOnLastXFFElement(t *testing.T) {
	r, _ := loginEngine(t, func(string) int { return http.StatusUnauthorized })
	for i := 0; i < 10; i++ {
		if w := postLogin(r, "1.1.1.1, 2.2.2.2", "bad"); w.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: status = %d, want 401", i+1, w.Code)
		}
	}
	if w := postLogin(r, "1.1.1.1, 2.2.2.2", "bad"); w.Code != http.StatusTooManyRequests {
		t.Fatalf("keyed IP: status = %d, want 429", w.Code)
	}
	if w := postLogin(r, "1.1.1.1", "bad"); w.Code != http.StatusUnauthorized {
		t.Fatalf("spoofed first element: status = %d, want 401 (only the last XFF element is the key)", w.Code)
	}
}

func TestLoginLimiterWindowRecovery(t *testing.T) {
	l := NewLoginLimiter(50*time.Millisecond, 3)
	defer l.stop()
	for i := 0; i < 3; i++ {
		l.recordFailure("5.5.5.5")
	}
	if l.allow("5.5.5.5") {
		t.Fatal("3 failures inside the window must block")
	}
	// one-sided assertion: sleeping 3x the window can only be late, never early
	time.Sleep(150 * time.Millisecond)
	if !l.allow("5.5.5.5") {
		t.Fatal("failures must age out once the window has passed")
	}
}

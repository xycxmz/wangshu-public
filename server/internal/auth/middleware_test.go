package auth

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"

	"github.com/xycxmz/company-platform-v1/server/internal/auth/acauth"
)

const (
	testAppID = "test-app"
	testKID   = "k1"
)

// newTestVerifier seeds the verifier with a fallback JWKS only; the URL is
// unreachable on purpose so the test proves verification never needs the center.
func newTestVerifier(t *testing.T) (*acauth.Verifier, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	jwks, err := json.Marshal(map[string]any{
		"keys": []map[string]string{{
			"kty": "OKP",
			"crv": "Ed25519",
			"kid": testKID,
			"x":   base64.RawURLEncoding.EncodeToString(pub),
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return acauth.New("http://127.0.0.1:1/never-fetched", testAppID, string(jwks)), priv
}

func signToken(t *testing.T, priv ed25519.PrivateKey, aud, sub string) string {
	t.Helper()
	claims := &acauth.Claims{
		Email:    sub + "@example.com",
		Nickname: "nick-" + sub,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   sub,
			Audience:  jwt.ClaimStrings{aud},
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	tok.Header["kid"] = testKID
	s, err := tok.SignedString(priv)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func assertUnauthorizedShape(t *testing.T, w *httptest.ResponseRecorder) {
	t.Helper()
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not the error envelope: %v (%s)", err, w.Body.String())
	}
	if body.Error.Code != "UNAUTHORIZED" || body.Error.Message != "invalid token" {
		t.Fatalf("envelope = %+v", body.Error)
	}
}

func TestMiddleware(t *testing.T) {
	gin.SetMode(gin.TestMode)
	verifier, priv := newTestVerifier(t)

	r := gin.New()
	r.GET("/whoami", Middleware(verifier), func(c *gin.Context) {
		claims := c.MustGet(ClaimsKey).(*acauth.Claims)
		c.JSON(http.StatusOK, gin.H{"user_id": claims.UserID(), "email": claims.Email})
	})

	do := func(token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/whoami", nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w
	}

	t.Run("valid token passes and claims are readable", func(t *testing.T) {
		w := do(signToken(t, priv, testAppID, "u1"))
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
		}
		var body struct {
			UserID string `json:"user_id"`
			Email  string `json:"email"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.UserID != "u1" || body.Email != "u1@example.com" {
			t.Fatalf("claims echo = %+v", body)
		}
	})

	t.Run("wrong aud is rejected 401", func(t *testing.T) {
		w := do(signToken(t, priv, "other-app", "u1"))
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
		}
		assertUnauthorizedShape(t, w)
	})

	t.Run("tampered token is rejected 401", func(t *testing.T) {
		// Flip the FIRST signature character: all 6 of its bits are real
		// signature bits. Flipping the last character only touches bits the
		// decoder truncates away, so the signature can survive it.
		parts := strings.Split(signToken(t, priv, testAppID, "u1"), ".")
		if len(parts) != 3 {
			t.Fatal("token is not a three-part JWS")
		}
		sig := []byte(parts[2])
		if sig[0] == 'A' {
			sig[0] = 'B'
		} else {
			sig[0] = 'A'
		}
		w := do(parts[0] + "." + parts[1] + "." + string(sig))
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
		}
		assertUnauthorizedShape(t, w)
	})

	t.Run("missing bearer is rejected 401", func(t *testing.T) {
		w := do("")
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d", w.Code)
		}
		assertUnauthorizedShape(t, w)
	})
}

// B1（roadmap-r4）：AdminRoles 解析——空/空白回默认 admin,owner；自定义集保留
// 非空段；纯逗号回默认。RequireRoles 的放行/拦截由 api/mcp 两包的角色门测试覆盖。
func TestAdminRoles(t *testing.T) {
	cases := []struct {
		env  string
		want []string
	}{
		{"", []string{"admin", "owner"}},
		{"   ", []string{"admin", "owner"}},
		{",,,", []string{"admin", "owner"}},
		{"admin", []string{"admin"}},
		{"admin,owner", []string{"admin", "owner"}},
		{" owner , admin ", []string{"owner", "admin"}},
	}
	for _, tc := range cases {
		got := AdminRoles(tc.env)
		if len(got) != len(tc.want) {
			t.Fatalf("AdminRoles(%q) = %v, want %v", tc.env, got, tc.want)
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Fatalf("AdminRoles(%q) = %v, want %v", tc.env, got, tc.want)
			}
		}
	}
}

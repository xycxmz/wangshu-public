// Command devtoken mints a local Ed25519 keypair, a JWKS document, and an
// account-center-shaped access token signed with it — for driving a locally
// running hub without the real center. Print the pieces, run once per key.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type claims struct {
	Email    string `json:"email,omitempty"`
	Nickname string `json:"nickname,omitempty"`
	Role     string `json:"role,omitempty"`
	jwt.RegisteredClaims
}

func main() {
	app := flag.String("app", "company-platform", "aud claim (hub HUB_APP_ID)")
	sub := flag.String("sub", "dev-user", "subject (user id)")
	role := flag.String("role", "admin", "role claim (admin/owner/user)")
	ttl := flag.Duration("ttl", 24*time.Hour, "token lifetime")
	flag.Parse()

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		fmt.Fprintln(os.Stderr, "keygen:", err)
		os.Exit(1)
	}
	jwks, err := json.Marshal(map[string]any{
		"keys": []map[string]string{{
			"kty": "OKP",
			"crv": "Ed25519",
			"kid": "devkey-1",
			"x":   base64.RawURLEncoding.EncodeToString(pub),
		}},
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "jwks:", err)
		os.Exit(1)
	}

	tok := jwt.NewWithClaims(jwt.SigningMethodEdDSA, &claims{
		Email:    *sub + "@local.dev",
		Nickname: *sub,
		// B1 之后管理写面（模型池/MCP upstream/定价 PUT）有角色门，
		// dev token 默认签 admin 以便本地开发直接可用；生产账号
		// 的 role 由 center grant 决定（invite-only 后只有 xyc=admin）。
		Role: *role,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   *sub,
			Audience:  jwt.ClaimStrings{*app},
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(*ttl)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	})
	tok.Header["kid"] = "devkey-1"
	signed, err := tok.SignedString(priv)
	if err != nil {
		fmt.Fprintln(os.Stderr, "sign:", err)
		os.Exit(1)
	}

	fmt.Println(signed)
	fmt.Println(string(jwks))
}

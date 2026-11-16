// Package acauth verifies Account Center access tokens (EdDSA / Ed25519).
//
// THIS FILE IS THE CANONICAL CONSUMER SNIPPET. Apps integrating with the
// account center copy this single file unchanged (only the package path
// changes). It is compiled and round-trip-tested
// against real center-issued tokens so the snippet cannot drift from
// the tokens the center actually issues.
//
// Deps: github.com/golang-jwt/jwt/v5 only.
package acauth

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type Claims struct {
	Email    string `json:"email,omitempty"`
	Nickname string `json:"nickname,omitempty"`
	Role     string `json:"role,omitempty"`
	LocalID  string `json:"localId,omitempty"` // legacy app-local user id; empty ⇒ use Subject
	jwt.RegisteredClaims
}

// UserID returns the id your app should key data by.
func (c *Claims) UserID() string {
	if c.LocalID != "" {
		return c.LocalID
	}
	return c.Subject
}

var ErrInvalidToken = errors.New("token invalid or expired")

type Verifier struct {
	jwksURL string // e.g. "https://account.secai.fun/.well-known/jwks.json"
	appID   string // your app id, e.g. "game-center" — must equal the token aud

	mu      sync.Mutex
	keys    map[string]ed25519.PublicKey // kid -> key
	fetched time.Time
	client  *http.Client
}

// New builds a verifier. fallbackJWKS (optional, may be "") is a raw JWKS
// document used to seed keys before the first network fetch, so verification
// works even if the center is unreachable at process start.
func New(jwksURL, appID, fallbackJWKS string) *Verifier {
	v := &Verifier{
		jwksURL: jwksURL,
		appID:   appID,
		keys:    map[string]ed25519.PublicKey{},
		client:  &http.Client{Timeout: 5 * time.Second},
	}
	if fallbackJWKS != "" {
		v.mu.Lock()
		v.absorb([]byte(fallbackJWKS))
		v.mu.Unlock()
	}
	return v
}

// Verify checks signature (EdDSA via JWKS kid), aud == appID, and exp.
func (v *Verifier) Verify(tokenStr string) (*Claims, error) {
	claims := &Claims{}
	tok, err := jwt.ParseWithClaims(tokenStr, claims, v.keyFor,
		jwt.WithValidMethods([]string{"EdDSA"}),
		jwt.WithAudience(v.appID),
		jwt.WithExpirationRequired())
	if err != nil || !tok.Valid || claims.Subject == "" {
		return nil, ErrInvalidToken
	}
	return claims, nil
}

func (v *Verifier) keyFor(t *jwt.Token) (any, error) {
	kid, _ := t.Header["kid"].(string)
	if kid == "" {
		return nil, ErrInvalidToken
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if k, ok := v.keys[kid]; ok {
		return k, nil
	}
	// Unknown kid: refetch at most once per minute (covers key rotation).
	if time.Since(v.fetched) > time.Minute {
		v.fetched = time.Now()
		if resp, err := v.client.Get(v.jwksURL); err == nil {
			doc, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
			resp.Body.Close()
			if len(doc) > 0 {
				v.absorb(doc)
			}
		}
	}
	if k, ok := v.keys[kid]; ok {
		return k, nil
	}
	return nil, ErrInvalidToken
}

// absorb parses a JWKS document into the key map. Caller holds v.mu.
func (v *Verifier) absorb(doc []byte) {
	var parsed struct {
		Keys []struct {
			Kty string `json:"kty"`
			Crv string `json:"crv"`
			Kid string `json:"kid"`
			X   string `json:"x"`
		} `json:"keys"`
	}
	if json.Unmarshal(doc, &parsed) != nil {
		return
	}
	for _, k := range parsed.Keys {
		if k.Kty != "OKP" || k.Crv != "Ed25519" {
			continue
		}
		raw, err := base64.RawURLEncoding.DecodeString(k.X)
		if err != nil || len(raw) != ed25519.PublicKeySize {
			continue
		}
		v.keys[k.Kid] = ed25519.PublicKey(raw)
	}
}

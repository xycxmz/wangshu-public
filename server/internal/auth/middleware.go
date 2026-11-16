package auth

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/xycxmz/company-platform-v1/server/internal/auth/acauth"
)

// ClaimsKey is the gin context key holding the verified *acauth.Claims.
const ClaimsKey = "acauth.claims"

// Middleware rejects requests that lack a valid account-center bearer token.
func Middleware(v *acauth.Verifier) gin.HandlerFunc {
	return func(c *gin.Context) {
		h := c.GetHeader("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			unauthorized(c)
			return
		}
		claims, err := v.Verify(strings.TrimPrefix(h, "Bearer "))
		if err != nil {
			unauthorized(c)
			return
		}
		c.Set(ClaimsKey, claims)
		c.Next()
	}
}

// RequireRoles gates a route to tokens whose role claim is one of roles.
// It must run behind Middleware: no claims ⇒ 401, role miss ⇒ 403 FORBIDDEN,
// both in the account-center {"error":{"code","message"}} envelope. Used for
// the management plane (hosted model pool, MCP upstream registry); the
// conversational routes stay open to every authenticated user.
func RequireRoles(roles ...string) gin.HandlerFunc {
	return func(c *gin.Context) {
		v, ok := c.Get(ClaimsKey)
		if !ok {
			unauthorized(c)
			return
		}
		role := v.(*acauth.Claims).Role
		for _, want := range roles {
			if role == want {
				c.Next()
				return
			}
		}
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
			"error": gin.H{"code": "FORBIDDEN", "message": "insufficient role"},
		})
	}
}

// AdminRoles parses a HUB_ADMIN_ROLES value (comma-separated) into the
// RequireRoles set; empty or malformed input falls back to admin,owner.
func AdminRoles(env string) []string {
	if s := strings.TrimSpace(env); s != "" {
		var out []string
		for _, p := range strings.Split(s, ",") {
			if p = strings.TrimSpace(p); p != "" {
				out = append(out, p)
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	return []string{"admin", "owner"}
}

// Error envelope follows the account-center {"error":{"code","message"}} convention.
func unauthorized(c *gin.Context) {
	c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
		"error": gin.H{"code": "UNAUTHORIZED", "message": "invalid token"},
	})
}

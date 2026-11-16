// Package config loads hub runtime configuration from environment variables.
package config

import (
	"crypto/rand"
	"encoding/base64"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/xycxmz/company-platform-v1/server/internal/auth"
)

type Config struct {
	Addr           string   // HTTP listen address
	DSN            string   // postgres://… → PostgreSQL; anything else → sqlite file DSN
	CenterURL      string   // account-center API base (login proxy target)
	CenterJWKSURL  string   // account-center JWKS endpoint
	AppID          string   // account-center app id; must equal the token aud
	CenterJWKSJSON string   // optional inline JWKS fallback handed to acauth
	CORSOrigins    string   // comma-separated extra origins allowed beside the Tauri defaults
	AdminRoles     []string // roles allowed on the management plane (model pool, MCP registry)
	ConsoleSecret  string   // /console 会话 cookie 的 HMAC 密钥（HUB_CONSOLE_SECRET；缺省随机=重启即失效）

	LoginLimitWindow time.Duration // per-IP login-failure window (HUB_LOGIN_LIMIT, default 1min)
	LoginLimitMax    int           // login failures per window before the hub answers 429 (default 10)

	MaterialBaseURL    string // DashScope base for material generation
	MaterialAPIKey     string // DashScope key；空则素材管线兜底模型池 key（kb 同款双源）
	UpdateDir          string // update feed dir: manifest.json + assets/ (no update shipped ⇒ 204)
	MaterialImageModel string // text2image model id
	MaterialVideoModel string // text2video model id

	MaterialPrices map[string]MaterialPrice // kind → unit price; absent kind meters cost 0
}

// MaterialPrice is one row of the material generation price table: a model
// name and what one generated unit (image: per picture, video: per clip)
// costs in cents. JSON tags serve the system_config wire format (B3
// hot-reload: the table lives in the DB after first-boot env seeding).
type MaterialPrice struct {
	Model        string `json:"model"`
	CentsPerUnit int64  `json:"cents_per_unit"`
}

func Load() Config {
	loginWindow, loginMax := loadLoginLimit(os.Getenv("HUB_LOGIN_LIMIT"))
	return Config{
		Addr:             envOr("HUB_ADDR", ":10440"),
		DSN:              envOr("HUB_DSN", "file:hub.db"),
		CenterURL:        envOr("CENTER_URL", "https://account.secai.fun"),
		CenterJWKSURL:    envOr("CENTER_JWKS_URL", "https://account.secai.fun/.well-known/jwks.json"),
		AppID:            envOr("HUB_APP_ID", "company-platform"),
		CenterJWKSJSON:   os.Getenv("CENTER_JWKS_JSON"),
		UpdateDir:        envOr("HUB_UPDATE_DIR", "updates"),
		CORSOrigins:      os.Getenv("HUB_CORS_ORIGINS"),
		ConsoleSecret:    consoleSecretOr(os.Getenv("HUB_CONSOLE_SECRET")),
		AdminRoles:       auth.AdminRoles(os.Getenv("HUB_ADMIN_ROLES")),
		LoginLimitWindow: loginWindow,
		LoginLimitMax:    loginMax,

		MaterialBaseURL:    envOr("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com"),
		MaterialAPIKey:     os.Getenv("DASHSCOPE_API_KEY"),
		MaterialImageModel: envOr("DASHSCOPE_IMAGE_MODEL", "wanx2.1-t2i-turbo"),
		MaterialVideoModel: envOr("DASHSCOPE_VIDEO_MODEL", "wan2.2-t2v-plus"),

		MaterialPrices: loadMaterialPrices(),
	}
}

// loadMaterialPrices reads MATERIAL_PRICE_<KIND> rows of the form
// "<model>,<cents_per_unit>". A missing or malformed row leaves that kind
// unpriced (succeeded tasks meter cost 0) with one warning; the hub keeps
// serving either way.
func loadMaterialPrices() map[string]MaterialPrice {
	prices := map[string]MaterialPrice{}
	for _, kind := range []string{"image", "video"} {
		envKey := "MATERIAL_PRICE_" + strings.ToUpper(kind)
		raw := os.Getenv(envKey)
		if raw == "" {
			log.Printf("config: %s not set; %s generation meters cost 0", envKey, kind)
			continue
		}
		model, cents, ok := strings.Cut(raw, ",")
		model = strings.TrimSpace(model)
		unit, err := strconv.ParseInt(strings.TrimSpace(cents), 10, 64)
		if !ok || model == "" || err != nil || unit < 0 {
			log.Printf("config: %s: malformed %q, want \"<model>,<cents_per_unit>\"; %s generation meters cost 0",
				envKey, raw, kind)
			continue
		}
		prices[kind] = MaterialPrice{Model: model, CentsPerUnit: unit}
	}
	return prices
}

// loadLoginLimit parses HUB_LOGIN_LIMIT of the form "<failures>/<window>",
// e.g. "10/min" (units: s, m/min, h). A missing or malformed value — no
// unit, bad number, max < 1 — falls back to the default with one warning,
// mirroring loadMaterialPrices: the hub keeps serving, and the login route
// never turns into an accidental deny-all (max=0).
func loadLoginLimit(raw string) (window time.Duration, max int) {
	const defWindow = time.Minute
	const defMax = 10
	if raw == "" {
		return defWindow, defMax
	}
	n, unit, ok := strings.Cut(raw, "/")
	max, err := strconv.Atoi(strings.TrimSpace(n))
	switch strings.TrimSpace(unit) {
	case "s":
		window = time.Second
	case "m", "min":
		window = time.Minute
	case "h":
		window = time.Hour
	default:
		ok = false
	}
	if !ok || err != nil || max < 1 {
		log.Printf("config: HUB_LOGIN_LIMIT: malformed %q, want \"<failures>/<s|min|h>\" e.g. \"10/min\"; using default %d per minute", raw, defMax)
		return defWindow, defMax
	}
	return window, max
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// consoleSecretOr: 设置了 HUB_CONSOLE_SECRET 用之；否则每次启动随机生成
// （控制台会话重启即失效，自托管单管理员场景可接受，文档已注明）。
func consoleSecretOr(env string) string {
	if s := strings.TrimSpace(env); s != "" {
		return s
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		log.Fatalf("console secret: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

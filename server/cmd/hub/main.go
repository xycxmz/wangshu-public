// Command hub runs the company-platform server: account-center auth-gated
// API over GORM storage (PostgreSQL or sqlite, see store.Open).
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/xycxmz/company-platform-v1/server/internal/api"
	"github.com/xycxmz/company-platform-v1/server/internal/auth/acauth"
	"github.com/xycxmz/company-platform-v1/server/internal/config"
	"github.com/xycxmz/company-platform-v1/server/internal/console"
	"github.com/xycxmz/company-platform-v1/server/internal/material"
	"github.com/xycxmz/company-platform-v1/server/internal/store"
)

func main() {
	cfg := config.Load()

	st, err := store.Open(cfg.DSN)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	if err := st.AutoMigrate(); err != nil {
		log.Fatalf("migrate: %v", err)
	}

	verifier := acauth.New(cfg.CenterJWKSURL, cfg.AppID, cfg.CenterJWKSJSON)

	// B3：env 价目只在首次启动 seed 进 system_config，此后 DB 行为唯一真相，
	// 改价走 PUT /api/v1/pricing/material 热生效，改 .env 不再影响已初始化的库。
	api.SeedMaterialPrices(st, cfg.MaterialPrices)

	// gin's mode comes from GIN_MODE on its own; never forced here.
	r := gin.Default()
	api.Register(r, &cfg, st, verifier)
	// R7 控制台（MPA）：HUB_CONSOLE_SECRET 缺省随机=会话重启即失效
	console.Register(r, &cfg, verifier, st)

	// material worker drives async generation tasks to a terminal state.
	// P0：worker 随进程退出，不做优雅停机。
	go material.NewWorker(st, &cfg).Run(context.Background())

	log.Printf("hub listening on %s (dsn: %s)", cfg.Addr, dsnKind(cfg.DSN))
	srv := &http.Server{Addr: cfg.Addr, Handler: r}
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("serve: %v", err)
	}
}

func dsnKind(dsn string) string {
	if strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://") {
		return "postgres"
	}
	return "sqlite"
}

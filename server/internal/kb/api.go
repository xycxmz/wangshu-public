package kb

import (
	"errors"
	"log"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/xycxmz/company-platform-v1/server/internal/auth"
	"github.com/xycxmz/company-platform-v1/server/internal/auth/acauth"
	"github.com/xycxmz/company-platform-v1/server/internal/config"
	"github.com/xycxmz/company-platform-v1/server/internal/store"
)

const (
	maxContentBytes   = 1 << 20 // content 上限 1MB（字节）
	maxQueryRunes     = 2000    // q 上限（rune）
	searchKDefault    = 4
	searchKMax        = 50
	titleMaxRunes     = 255  // 对齐 KbDoc.Title 列宽
	sourceRefMaxRunes = 1024 // 对齐 KbDoc.SourceRef 列宽
)

// docView 是 API 契约的 doc 形状（camelCase，与前端 worker 逐字一致）。
type docView struct {
	ID         string    `json:"id"`
	Title      string    `json:"title"`
	SourceType string    `json:"sourceType"`
	SourceRef  string    `json:"sourceRef"`
	ChunkCount int       `json:"chunkCount"`
	CreatedAt  time.Time `json:"createdAt"`
}

func docViewOf(d *store.KbDoc) docView {
	return docView{
		ID: d.ID, Title: d.Title, SourceType: d.SourceType,
		SourceRef: d.SourceRef, ChunkCount: d.ChunkCount, CreatedAt: d.CreatedAt,
	}
}

// Register 是装配入口（api.go 挂 /api/v1/kb）：构造真 Embedder 与
// Service（启动全量加载），加载失败记日志带空索引继续——列表/删除/新
// 入库可用，历史文档检索降级为空，重启自愈。st 为 nil 时只挂路由形状
// （api 包的路由契约测试用 nil store 装配，同 material 惯例）。
func Register(rg *gin.RouterGroup, st *store.Store, cfg *config.Config) {
	var svc *Service
	if st != nil {
		var err error
		svc, err = NewService(st, NewEmbedder(cfg, st))
		if err != nil {
			log.Printf("kb: load index: %v; search over existing docs degraded to empty until restart", err)
		}
	}
	RegisterService(rg, svc)
}

// RegisterService 挂路由（测试注入 mock embedding 的 Service 时用）。
func RegisterService(rg *gin.RouterGroup, svc *Service) {
	rg.POST("/docs", svc.handleCreate)
	rg.GET("/docs", svc.handleList)
	rg.DELETE("/docs/:id", svc.handleDelete)
	rg.POST("/search", svc.handleSearch)
	rg.POST("/rebuild", svc.handleRebuild)
}

func (s *Service) handleCreate(c *gin.Context) {
	var req struct {
		Title      string `json:"title"`
		SourceType string `json:"sourceType"`
		SourceRef  string `json:"sourceRef"`
		Content    string `json:"content"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		badRequest(c, err.Error())
		return
	}
	switch req.SourceType {
	case "url", "paste", "file":
	default:
		badRequest(c, "sourceType must be url, paste or file")
		return
	}
	if len(req.Content) > maxContentBytes {
		badRequest(c, "content exceeds 1MB")
		return
	}
	if len(req.Content) == 0 || isBlank(req.Content) {
		badRequest(c, "content is required")
		return
	}
	if utf8.RuneCountInString(req.Title) > titleMaxRunes {
		badRequest(c, "title exceeds 255 characters")
		return
	}
	if utf8.RuneCountInString(req.SourceRef) > sourceRefMaxRunes {
		badRequest(c, "sourceRef exceeds 1024 characters")
		return
	}

	doc, updated, err := s.Ingest(c.Request.Context(), userIDOf(c), req.Title, req.SourceType, req.SourceRef, req.Content)
	switch {
	case errors.Is(err, ErrNotConfigured):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": gin.H{
			"code": "KB_NOT_CONFIGURED", "message": "DASHSCOPE_API_KEY is not set",
		}})
	case errors.Is(err, ErrEmbedding):
		c.JSON(http.StatusBadGateway, gin.H{"error": gin.H{
			"code": "KB_EMBEDDING", "message": "embedding upstream failed",
		}})
	case err != nil:
		internalError(c, err)
	default:
		c.JSON(http.StatusCreated, gin.H{"doc": docViewOf(doc), "updated": updated})
	}
}

func (s *Service) handleList(c *gin.Context) {
	docs, err := s.store.ListKbDocs(userIDOf(c))
	if err != nil {
		internalError(c, err)
		return
	}
	views := make([]docView, 0, len(docs))
	for i := range docs {
		views = append(views, docViewOf(&docs[i]))
	}
	c.JSON(http.StatusOK, gin.H{"docs": views})
}

func (s *Service) handleDelete(c *gin.Context) {
	if err := s.Delete(userIDOf(c), c.Param("id")); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			notFound(c, "doc not found")
			return
		}
		internalError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

func (s *Service) handleSearch(c *gin.Context) {
	var req struct {
		Q string `json:"q"`
		K *int   `json:"k"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		badRequest(c, err.Error())
		return
	}
	if isBlank(req.Q) {
		badRequest(c, "q is required")
		return
	}
	if utf8.RuneCountInString(req.Q) > maxQueryRunes {
		badRequest(c, "q exceeds 2000 characters")
		return
	}
	k := searchKDefault
	if req.K != nil {
		if *req.K < 1 || *req.K > searchKMax {
			badRequest(c, "k must be between 1 and 50")
			return
		}
		k = *req.K
	}

	hits, err := s.Search(c.Request.Context(), userIDOf(c), req.Q, k)
	switch {
	case errors.Is(err, ErrNotConfigured):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": gin.H{
			"code": "KB_NOT_CONFIGURED", "message": "DASHSCOPE_API_KEY is not set",
		}})
	case errors.Is(err, ErrEmbedding):
		c.JSON(http.StatusBadGateway, gin.H{"error": gin.H{
			"code": "KB_EMBEDDING", "message": "embedding upstream failed",
		}})
	case err != nil:
		internalError(c, err)
	default:
		c.JSON(http.StatusOK, gin.H{"hits": hits})
	}
}

// handleRebuild：POST /api/v1/kb/rebuild（auth 组内，只重建本人语料）。
// 重建期间该用户检索返回空，完成后恢复——单用户可接受，K1 设计拍板；
// 换 embedding 模型后先 rebuild 再检索。失败映射与 create/search 同款
// （503 未配置 / 502 上游失败）；中途失败已重建的文档保持重建态，重试
// rebuild 继续收敛。
func (s *Service) handleRebuild(c *gin.Context) {
	res, err := s.Rebuild(c.Request.Context(), userIDOf(c))
	switch {
	case errors.Is(err, ErrNotConfigured):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": gin.H{
			"code": "KB_NOT_CONFIGURED", "message": "DASHSCOPE_API_KEY is not set",
		}})
	case errors.Is(err, ErrEmbedding):
		c.JSON(http.StatusBadGateway, gin.H{"error": gin.H{
			"code": "KB_EMBEDDING", "message": "embedding upstream failed during rebuild",
		}})
	case err != nil:
		internalError(c, err)
	default:
		c.JSON(http.StatusOK, res)
	}
}

func userIDOf(c *gin.Context) string {
	return c.MustGet(auth.ClaimsKey).(*acauth.Claims).UserID()
}

func isBlank(s string) bool {
	return strings.TrimSpace(s) == ""
}

func badRequest(c *gin.Context, msg string) {
	c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST", "message": msg}})
}

func notFound(c *gin.Context, msg string) {
	c.JSON(http.StatusNotFound, gin.H{"error": gin.H{"code": "NOT_FOUND", "message": msg}})
}

func internalError(c *gin.Context, err error) {
	log.Printf("kb api error: %v", err)
	c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "INTERNAL", "message": "internal error"}})
}

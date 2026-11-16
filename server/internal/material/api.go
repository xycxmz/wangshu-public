package material

import (
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/xycxmz/company-platform-v1/server/internal/auth"
	"github.com/xycxmz/company-platform-v1/server/internal/auth/acauth"
	"github.com/xycxmz/company-platform-v1/server/internal/config"
	"github.com/xycxmz/company-platform-v1/server/internal/store"
)

type taskView struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"`
	Prompt    string    `json:"prompt"`
	Status    string    `json:"status"`
	ResultURL string    `json:"result_url"`
	Error     string    `json:"error"`
	CreatedAt time.Time `json:"created_at"`
}

func taskViewOf(t *store.MaterialTask) taskView {
	return taskView{
		ID:        t.ID,
		Kind:      t.Kind,
		Prompt:    t.Prompt,
		Status:    t.Status,
		ResultURL: t.ResultURL,
		Error:     t.Error,
		CreatedAt: t.CreatedAt,
	}
}

type handler struct {
	store      *store.Store
	configured bool
}

// Register mounts the material routes on the auth-protected group handed in
// (api.go mounts it at /api/v1/material).
func Register(rg *gin.RouterGroup, st *store.Store, cfg *config.Config) {
	h := &handler{
		store:      st,
		configured: resolveAPIKey(cfg, st) != "",
	}
	rg.POST("/generations", h.create)
	rg.GET("/generations", h.list)
	rg.GET("/generations/:id", h.get)
}

// create persists a pending task and answers 202 immediately; the worker's
// next tick submits it upstream (2026-11-10 audit fix: inline submission
// raced the worker's scan into a double submit). The outcome, including a
// rejected submit, is observed via GET.
func (h *handler) create(c *gin.Context) {
	var req struct {
		Kind   string `json:"kind"`
		Prompt string `json:"prompt"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		badRequest(c, err.Error())
		return
	}
	if req.Kind != kindImage && req.Kind != kindVideo {
		badRequest(c, "kind must be image or video")
		return
	}
	if strings.TrimSpace(req.Prompt) == "" {
		badRequest(c, "prompt is required")
		return
	}
	if !h.configured {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": gin.H{
			"code": "MATERIAL_NOT_CONFIGURED", "message": "no DashScope key configured (env or model pool)",
		}})
		return
	}

	id, err := uuid.NewRandom()
	if err != nil {
		internalError(c, err)
		return
	}
	t := &store.MaterialTask{
		ID:     id.String(),
		UserID: c.MustGet(auth.ClaimsKey).(*acauth.Claims).UserID(),
		Kind:   req.Kind,
		Prompt: req.Prompt,
		Status: store.MaterialPending,
	}
	if err := h.store.CreateMaterialTask(t); err != nil {
		internalError(c, err)
		return
	}
	c.JSON(http.StatusAccepted, gin.H{"task": taskViewOf(t)})
}

func (h *handler) list(c *gin.Context) {
	limit := 50
	if q := c.Query("limit"); q != "" {
		n, err := strconv.Atoi(q)
		if err != nil || n < 1 {
			badRequest(c, "limit must be a positive integer")
			return
		}
		limit = n
	}
	userID := c.MustGet(auth.ClaimsKey).(*acauth.Claims).UserID()
	tasks, err := h.store.ListMaterialTasks(userID, limit)
	if err != nil {
		internalError(c, err)
		return
	}
	views := make([]taskView, 0, len(tasks))
	for i := range tasks {
		views = append(views, taskViewOf(&tasks[i]))
	}
	c.JSON(http.StatusOK, gin.H{"tasks": views})
}

func (h *handler) get(c *gin.Context) {
	userID := c.MustGet(auth.ClaimsKey).(*acauth.Claims).UserID()
	t, err := h.store.GetMaterialTask(c.Param("id"), userID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		notFound(c, "task not found")
		return
	}
	if err != nil {
		internalError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"task": taskViewOf(t)})
}

func badRequest(c *gin.Context, msg string) {
	c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST", "message": msg}})
}

func notFound(c *gin.Context, msg string) {
	c.JSON(http.StatusNotFound, gin.H{"error": gin.H{"code": "NOT_FOUND", "message": msg}})
}

func internalError(c *gin.Context, err error) {
	log.Printf("material api error: %v", err)
	c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "INTERNAL", "message": "internal error"}})
}

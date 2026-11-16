package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/xycxmz/company-platform-v1/server/internal/auth"
	"github.com/xycxmz/company-platform-v1/server/internal/auth/acauth"
	"github.com/xycxmz/company-platform-v1/server/internal/store"
)

type sessionView struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	ModelName string    `json:"model_name"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func sessionViewOf(s *store.Session) sessionView {
	return sessionView{
		ID:        s.ID,
		Title:     s.Title,
		ModelName: s.ModelName,
		CreatedAt: s.CreatedAt,
		UpdatedAt: s.UpdatedAt,
	}
}

// searchResultView 是 C2 搜索响应的一行。字段名按设计稿走 camelCase
// （depth-batch-r9c 的前端契约），与本包其余 snake_case 视图不同。
type searchResultView struct {
	SessionID string    `json:"sessionId"`
	Title     string    `json:"title"`
	Snippet   string    `json:"snippet"`
	CreatedAt time.Time `json:"createdAt"`
}

type messageView struct {
	ID        uint64          `json:"id"`
	Role      string          `json:"role"`
	Content   any             `json:"content"` // 纯文本=string；vision 分段=[]ContentPart（R9-A）
	ModelName string          `json:"model_name"`
	TokensIn  int             `json:"tokens_in"`
	TokensOut int             `json:"tokens_out"`
	CostCents int64           `json:"cost_cents"`
	Meta      json.RawMessage `json:"meta,omitempty"` // {"task_id":"h<n>"}（R6-B 溯源），无则省略
	CreatedAt time.Time       `json:"created_at"`
}

// contentValueOf 读侧兼容判据（R9-A）：content 解析为 JSON 数组且元素形似
// ContentPart 才按分段原样回（数组）；否则一律按旧纯文本回字符串，旧会话零迁移。
func contentValueOf(m *store.Message) any {
	if parts, ok := store.DecodeContentParts(m.Content); ok {
		return parts
	}
	return m.Content
}

// metaRawOf 把存储层的 JSON 串还原为响应里的对象；空值省略。
func metaRawOf(m *store.Message) json.RawMessage {
	if m.Meta == nil || strings.TrimSpace(*m.Meta) == "" {
		return nil
	}
	return json.RawMessage(*m.Meta)
}

var taskIDPattern = regexp.MustCompile(`^h?\d{1,19}$`)

// validateMessageMeta 白名单校验并序列化可选 meta：仅接受 {"task_id":"h<n>"}
// 单键形状（R6-B 设计稿拍板）。返回空串表示未携带。
func validateMessageMeta(raw json.RawMessage) (string, error) {
	s := strings.TrimSpace(string(raw))
	if s == "" || s == "null" || s == "{}" {
		return "", nil
	}
	var probe map[string]any
	if err := json.Unmarshal(raw, &probe); err != nil {
		return "", fmt.Errorf("meta must be a JSON object")
	}
	taskID, ok := probe["task_id"].(string)
	if !ok || len(probe) != 1 || !taskIDPattern.MatchString(taskID) {
		return "", fmt.Errorf(`meta only accepts {"task_id":"h<n>"} with a single task_id key`)
	}
	return fmt.Sprintf(`{"task_id":%q}`, taskID), nil
}

type usageView struct {
	Date      string `json:"date"`
	ModelName string `json:"model_name"`
	TokensIn  int64  `json:"tokens_in"`
	TokensOut int64  `json:"tokens_out"`
	CostCents int64  `json:"cost_cents"`
	Requests  int64  `json:"requests"`
}

func userIDOf(c *gin.Context) string {
	return c.MustGet(auth.ClaimsKey).(*acauth.Claims).UserID()
}

func registerSessions(api *gin.RouterGroup, st *store.Store) {
	api.GET("/sessions", func(c *gin.Context) {
		limit := 50
		if q := c.Query("limit"); q != "" {
			n, err := strconv.Atoi(q)
			if err != nil || n < 1 {
				badRequest(c, "limit must be a positive integer")
				return
			}
			limit = n
		}
		sessions, err := st.ListSessions(userIDOf(c), limit)
		if err != nil {
			internalError(c, err)
			return
		}
		views := make([]sessionView, 0, len(sessions))
		for i := range sessions {
			views = append(views, sessionViewOf(&sessions[i]))
		}
		c.JSON(http.StatusOK, gin.H{"sessions": views})
	})

	// C2（depth-batch-r9c）会话搜索：标题或消息内容不区分大小写子串匹配，
	// q 里的 % _ \ 由 store 转义为字面量。同会话只取首个命中，按会话更新
	// 时间倒序限 20 条；q 空白返回空结果不报错。
	api.GET("/sessions/search", func(c *gin.Context) {
		q := c.Query("q")
		if utf8.RuneCountInString(q) > 100 {
			badRequest(c, "q must be at most 100 characters")
			return
		}
		hits, err := st.SearchSessions(userIDOf(c), q, 20)
		if err != nil {
			internalError(c, err)
			return
		}
		views := make([]searchResultView, 0, len(hits))
		for i := range hits {
			views = append(views, searchResultView{
				SessionID: hits[i].SessionID,
				Title:     hits[i].Title,
				Snippet:   hits[i].Snippet,
				CreatedAt: hits[i].CreatedAt,
			})
		}
		c.JSON(http.StatusOK, gin.H{"results": views})
	})

	// model_name 接受 byok: 前缀：BYOK 会话同样有历史，只是不走 hub 网关。
	api.POST("/sessions", func(c *gin.Context) {
		var req struct {
			Title     string `json:"title"`
			ModelName string `json:"model_name"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			badRequest(c, err.Error())
			return
		}
		id, err := uuid.NewRandom()
		if err != nil {
			internalError(c, err)
			return
		}
		sess := &store.Session{ID: id.String(), UserID: userIDOf(c), Title: req.Title, ModelName: req.ModelName}
		if err := st.CreateSession(sess); err != nil {
			internalError(c, err)
			return
		}
		c.JSON(http.StatusCreated, gin.H{"session": sessionViewOf(sess)})
	})

	api.PATCH("/sessions/:id", func(c *gin.Context) {
		var req struct {
			Title     *string `json:"title"`
			ModelName *string `json:"model_name"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			badRequest(c, err.Error())
			return
		}
		sess, err := st.GetSession(c.Param("id"), userIDOf(c))
		if errors.Is(err, gorm.ErrRecordNotFound) {
			notFound(c, "session not found")
			return
		}
		if err != nil {
			internalError(c, err)
			return
		}
		if req.Title != nil {
			sess.Title = *req.Title
		}
		if req.ModelName != nil {
			sess.ModelName = *req.ModelName
		}
		if err := st.UpdateSession(sess); err != nil {
			internalError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"session": sessionViewOf(sess)})
	})

	api.DELETE("/sessions/:id", func(c *gin.Context) {
		if err := st.DeleteSessionCascade(c.Param("id"), userIDOf(c)); err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				notFound(c, "session not found")
				return
			}
			internalError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	api.GET("/sessions/:id/messages", func(c *gin.Context) {
		sess, err := st.GetSession(c.Param("id"), userIDOf(c))
		if errors.Is(err, gorm.ErrRecordNotFound) {
			notFound(c, "session not found")
			return
		}
		if err != nil {
			internalError(c, err)
			return
		}
		// R5-B#2 分页：无参=最新一页（默认 50）；before_id 游标向前翻。
		// has_more=true 表示本页满额，还有更早消息。
		beforeID, limit := 0, 50
		if q := c.Query("before_id"); q != "" {
			n, err := strconv.Atoi(q)
			if err != nil || n <= 0 {
				badRequest(c, "before_id must be a positive integer")
				return
			}
			beforeID = n
		}
		if q := c.Query("limit"); q != "" {
			n, err := strconv.Atoi(q)
			if err != nil || n < 1 || n > 200 {
				badRequest(c, "limit must be 1..200")
				return
			}
			limit = n
		}
		msgs, err := st.ListMessagesPage(sess.ID, beforeID, limit)
		if err != nil {
			internalError(c, err)
			return
		}
		hasMore := len(msgs) == limit
		views := make([]messageView, 0, len(msgs))
		for _, m := range msgs {
			views = append(views, messageView{
				ID:        m.ID,
				Role:      m.Role,
				Content:   contentValueOf(&m),
				ModelName: m.ModelName,
				TokensIn:  m.TokensIn,
				TokensOut: m.TokensOut,
				CostCents: m.CostCents,
				Meta:      metaRawOf(&m),
				CreatedAt: m.CreatedAt,
			})
		}
		c.JSON(http.StatusOK, gin.H{"messages": views, "has_more": hasMore})
	})

	// 独立消息追加（R6-B 溯源通道）：任务卡等非 LLM 回合消息经此落库。
	// role 白名单 user|assistant；meta 白名单见 validateMessageMeta。
	api.POST("/sessions/:id/messages", func(c *gin.Context) {
		var req struct {
			Role      string          `json:"role"`
			Content   string          `json:"content"`
			ModelName string          `json:"model_name"`
			Meta      json.RawMessage `json:"meta"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			badRequest(c, err.Error())
			return
		}
		if req.Role != "user" && req.Role != "assistant" {
			badRequest(c, "role must be user or assistant")
			return
		}
		if strings.TrimSpace(req.Content) == "" {
			badRequest(c, "content must not be empty")
			return
		}
		meta, err := validateMessageMeta(req.Meta)
		if err != nil {
			badRequest(c, err.Error())
			return
		}
		sess, err := st.GetSession(c.Param("id"), userIDOf(c))
		if errors.Is(err, gorm.ErrRecordNotFound) {
			notFound(c, "session not found")
			return
		}
		if err != nil {
			internalError(c, err)
			return
		}
		m := &store.Message{
			SessionID: sess.ID,
			Role:      req.Role,
			Content:   req.Content,
			ModelName: req.ModelName,
		}
		if meta != "" {
			m.Meta = &meta
		}
		if err := st.CreateMessage(m); err != nil {
			internalError(c, err)
			return
		}
		c.JSON(http.StatusCreated, gin.H{"message": messageView{
			ID: m.ID, Role: m.Role, Content: contentValueOf(m), ModelName: m.ModelName,
			Meta: metaRawOf(m), CreatedAt: m.CreatedAt,
		}})
	})

	api.GET("/usage", func(c *gin.Context) {
		days := 30
		if q := c.Query("days"); q != "" {
			n, err := strconv.Atoi(q)
			if err != nil || n < 1 {
				badRequest(c, "days must be a positive integer")
				return
			}
			days = n
		}
		rows, err := st.UsageSummary(userIDOf(c), days)
		if err != nil {
			internalError(c, err)
			return
		}
		views := make([]usageView, 0, len(rows))
		for _, row := range rows {
			views = append(views, usageView{
				Date:      row.Date,
				ModelName: row.ModelName,
				TokensIn:  row.TokensIn,
				TokensOut: row.TokensOut,
				CostCents: row.CostCents,
				Requests:  row.Requests,
			})
		}
		c.JSON(http.StatusOK, gin.H{"usage": views})
	})
}

func notFound(c *gin.Context, msg string) {
	c.JSON(http.StatusNotFound, gin.H{"error": gin.H{"code": "NOT_FOUND", "message": msg}})
}

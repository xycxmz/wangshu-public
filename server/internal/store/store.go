// Package store persists hub state via GORM. PostgreSQL in production; a
// pure-Go sqlite lane for local/self-host runs — see Open for the DSN split.
package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/glebarez/sqlite"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/xycxmz/company-platform-v1/server/internal/config"
)

type User struct { // account-center sub 为主键，首见 upsert
	ID         string `gorm:"primaryKey;size:64"`
	Email      string `gorm:"size:255"`
	Nickname   string `gorm:"size:128"`
	CreatedAt  time.Time
	LastSeenAt time.Time
}

type HostedModel struct { // hub 托管模型池（BYOK 模型不落 hub，永不存）
	ID            uint   `gorm:"primaryKey"`
	Name          string `gorm:"uniqueIndex;size:64"` // 对外名=请求 model 字段
	Provider      string `gorm:"size:32"`             // dashscope/deepseek/openai…
	BaseURL       string `gorm:"size:512"`
	APIKey        string `gorm:"size:256"`               // 托管 key，仅服务端持有
	UpstreamModel string `gorm:"size:128"`               // 上游真实 model_id
	Protocol      string `gorm:"size:16;default:openai"` // openai|anthropic
	Capabilities  string `gorm:"type:jsonb"`             // JSON 串 {"tools":true,"vision":true,"context_window":131072}
	PriceInPer1K  int64  // 分/千 token，0=不计价
	PriceOutPer1K int64
	// Enabled is a tri-state pointer (same GORM zero-value trap as
	// McpUpstream.Enabled): nil means "not supplied", reads back as the
	// column default (true). Resolve only through IsEnabled.
	Enabled   *bool `gorm:"default:true"`
	CreatedAt time.Time
	UpdatedAt time.Time
}

// IsEnabled resolves the Enabled tri-state: nil means the column default
// (true), which also covers rows written before this field existed.
func (m *HostedModel) IsEnabled() bool {
	return m.Enabled == nil || *m.Enabled
}

// HostedModelPatch is a partial update for UpdateHostedModel: nil fields are
// left untouched. Capabilities is normalized (empty ⇒ "{}") like on create.
type HostedModelPatch struct {
	Provider      *string
	BaseURL       *string
	APIKey        *string
	UpstreamModel *string
	Protocol      *string
	Capabilities  *string
	PriceInPer1K  *int64
	PriceOutPer1K *int64
	Enabled       *bool
}

// UpdateHostedModel applies a partial patch to the named model and returns
// the updated row. Unknown name ⇒ gorm.ErrRecordNotFound.
func (s *Store) UpdateHostedModel(name string, p *HostedModelPatch) (*HostedModel, error) {
	updates := map[string]any{}
	if p.Provider != nil {
		updates["provider"] = *p.Provider
	}
	if p.BaseURL != nil {
		updates["base_url"] = *p.BaseURL
	}
	if p.APIKey != nil {
		updates["api_key"] = *p.APIKey
	}
	if p.UpstreamModel != nil {
		updates["upstream_model"] = *p.UpstreamModel
	}
	if p.Protocol != nil {
		updates["protocol"] = *p.Protocol
	}
	if p.Capabilities != nil {
		caps := *p.Capabilities
		if strings.TrimSpace(caps) == "" { // PG jsonb rejects the empty string
			caps = "{}"
		}
		updates["capabilities"] = caps
	}
	if p.PriceInPer1K != nil {
		updates["price_in_per_1k"] = *p.PriceInPer1K
	}
	if p.PriceOutPer1K != nil {
		updates["price_out_per_1k"] = *p.PriceOutPer1K
	}
	if p.Enabled != nil {
		updates["enabled"] = *p.Enabled
	}
	var m HostedModel
	err := s.db.Transaction(func(tx *gorm.DB) error {
		if len(updates) > 0 {
			res := tx.Model(&HostedModel{}).Where("name = ?", name).Updates(updates)
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected == 0 {
				return gorm.ErrRecordNotFound
			}
		} else if err := tx.First(&m, "name = ?", name).Error; err != nil {
			return err // empty patch still verifies existence
		}
		return tx.First(&m, "name = ?", name).Error
	})
	if err != nil {
		return nil, err
	}
	return &m, nil
}

// SystemConfig is one hub-managed runtime setting (hot-reloadable), e.g.
// SystemKeyMaterialPrices. Values are small JSON documents written via the
// admin API; env vars only seed them on first boot.
type SystemConfig struct {
	Key       string `gorm:"primaryKey;size:64"`
	Value     string `gorm:"type:text"`
	UpdatedAt time.Time
}

// SystemKeyMaterialPrices holds the material price table as JSON
// map[kind]{model,cents_per_unit}; kinds outside it meter cost 0.
const SystemKeyMaterialPrices = "material_prices"

// GetSystemConfig returns (value, true, nil) when present, ("", false, nil)
// when absent.
func (s *Store) GetSystemConfig(key string) (string, bool, error) {
	var row SystemConfig
	err := s.db.First(&row, "key = ?", key).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return row.Value, true, nil
}

// SetSystemConfig upserts one setting (Save with primary key = idempotent).
func (s *Store) SetSystemConfig(key, value string) error {
	return s.db.Save(&SystemConfig{Key: key, Value: value}).Error
}

// MaterialPrices reads the hot-reloadable price table (SystemKeyMaterialPrices).
// A missing row, a corrupt row, or a decode failure all degrade to an empty
// table (unpriced kinds meter cost 0) with the error reported for logging.
func (s *Store) MaterialPrices() (map[string]config.MaterialPrice, error) {
	raw, ok, err := s.GetSystemConfig(SystemKeyMaterialPrices)
	if err != nil || !ok {
		return map[string]config.MaterialPrice{}, err
	}
	var prices map[string]config.MaterialPrice
	if err := json.Unmarshal([]byte(raw), &prices); err != nil {
		return map[string]config.MaterialPrice{}, err
	}
	if prices == nil {
		prices = map[string]config.MaterialPrice{}
	}
	return prices, nil
}

type Session struct {
	ID        string `gorm:"primaryKey;size:36"` // uuid
	UserID    string `gorm:"index;size:64"`
	Title     string `gorm:"size:255"`
	ModelName string `gorm:"size:64"` // 快照：HostedModel.Name 或 byok:<name>
	CreatedAt time.Time
	UpdatedAt time.Time
}

// ContentPartImage 是 image_url 分段的内层（OpenAI vision 形态，dataURL 内联）。
type ContentPartImage struct {
	URL string `json:"url"`
}

// ContentPart 是 vision 消息内容分段：text 文本段或 image_url 图片段
// （R9-A A1）。messages.content 仍是一列 TEXT：分段形态存 JSON 序列化，
// 读侧解析失败一律按旧纯文本处理——旧会话零迁移。
type ContentPart struct {
	Type     string            `json:"type"`
	Text     string            `json:"text,omitempty"`
	ImageURL *ContentPartImage `json:"image_url,omitempty"`
}

// EncodeContentParts 序列化分段数组（写侧：落 messages.content）。
func EncodeContentParts(parts []ContentPart) (string, error) {
	b, err := json.Marshal(parts)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// DecodeContentParts 识别 content 是否分段形态：非 JSON 数组、空数组或任一
// 元素形状不符（text 缺字符串 text / image_url 缺内层 url）都返回 false，
// 调用方按旧纯文本原样回退，畸形不外溢。
func DecodeContentParts(content string) ([]ContentPart, bool) {
	trimmed := strings.TrimSpace(content)
	if !strings.HasPrefix(trimmed, "[") {
		return nil, false
	}
	var probe []map[string]any
	if err := json.Unmarshal([]byte(trimmed), &probe); err != nil || len(probe) == 0 {
		return nil, false
	}
	for _, p := range probe {
		switch t, _ := p["type"].(string); t {
		case "text":
			if _, ok := p["text"].(string); !ok {
				return nil, false
			}
		case "image_url":
			img, ok := p["image_url"].(map[string]any)
			if !ok {
				return nil, false
			}
			if _, ok := img["url"].(string); !ok {
				return nil, false
			}
		default:
			return nil, false
		}
	}
	var parts []ContentPart
	if err := json.Unmarshal([]byte(trimmed), &parts); err != nil {
		return nil, false
	}
	return parts, true
}

type Message struct {
	ID        uint64 `gorm:"primaryKey"`
	SessionID string `gorm:"index;size:36"`
	Role      string `gorm:"size:16"` // user|assistant|system|tool
	Content   string `gorm:"type:text"`
	ModelName string `gorm:"size:64"`
	TokensIn  int
	TokensOut int
	CostCents int64 // 分为单位
	// Meta 可选消息注记（R6-B 溯源：{"task_id":"h<n>} 形状的 JSON 串）。
	// 指针走 NULL：PG jsonb 拒空串，sqlite 落 TEXT，AutoMigrate 加法兼容。
	Meta      *string `gorm:"type:jsonb"`
	CreatedAt time.Time
}

type UsageDaily struct { // 复合主键：日期+用户+模型
	Date      string `gorm:"primaryKey;size:10"` // YYYY-MM-DD（本地时区）
	UserID    string `gorm:"primaryKey;size:64"`
	ModelName string `gorm:"primaryKey;size:64"`
	TokensIn  int64
	TokensOut int64
	CostCents int64
	Requests  int64
}

// MaterialTask status vocabulary, written only by internal/material.
const (
	MaterialPending   = "pending"   // row created, DashScope submit not yet accepted
	MaterialRunning   = "running"   // upstream task in flight
	MaterialSucceeded = "succeeded" // ResultURL populated
	MaterialFailed    = "failed"    // Error populated
)

type MaterialTask struct { // hub 内置素材生成任务（图/视频，DashScope 异步流）
	ID             string `gorm:"primaryKey;size:36"` // uuid
	UserID         string `gorm:"index;size:64"`
	Kind           string `gorm:"size:8"` // image|video
	Prompt         string `gorm:"type:text"`
	UpstreamTaskID string `gorm:"size:64"` // DashScope task_id, empty until submit accepted
	Status         string `gorm:"size:12"` // pending|running|succeeded|failed
	ResultURL      string `gorm:"size:1024"`
	Error          string `gorm:"size:512"`
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// McpUpstream is one registered MCP upstream the hub can proxy to.
// Enabled is a tri-state pointer because GORM omits a false bool on INSERT
// when the column default is true: nil means "not supplied" and reads back
// as the default (true). Resolve it only through IsEnabled.
type McpUpstream struct {
	ID        uint   `gorm:"primaryKey"`
	Name      string `gorm:"uniqueIndex;size:64"` // route name: /mcp/<name>/proxy
	BaseURL   string `gorm:"size:512"`
	AuthToken string `gorm:"size:512"` // Bearer injected upstream; empty = no Authorization travels (2026-11-10 audit tightening)
	// AllowedTools is the tool-level visibility allowlist as a JSON array
	// string ("[\"search\",\"fetch\"]"); empty or "[]" relays every tool.
	AllowedTools string `gorm:"type:jsonb"`
	Enabled      *bool  `gorm:"default:true"`
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// IsEnabled resolves the Enabled tri-state: nil means the column default
// (true), which also covers rows written before this field existed.
func (u *McpUpstream) IsEnabled() bool {
	return u.Enabled == nil || *u.Enabled
}

// ToolAllowlist decodes AllowedTools. Empty, "[]", and undecodable values all
// mean "no tool filtering": the column is admin-written via the API, so a
// corrupt row degrades to the documented upstream-level behavior instead of
// silently denying every tool.
func (u *McpUpstream) ToolAllowlist() []string {
	if u.AllowedTools == "" || u.AllowedTools == "[]" {
		return nil
	}
	var tools []string
	if err := json.Unmarshal([]byte(u.AllowedTools), &tools); err != nil {
		return nil
	}
	return tools
}

// McpAudit is the append-only proxy call log; one row per resolved upstream
// call, written after the response is relayed.
type McpAudit struct {
	ID         uint64 `gorm:"primaryKey"`
	UserID     string `gorm:"index;size:64"`
	Upstream   string `gorm:"size:64"`
	Method     string `gorm:"size:128"` // HTTP method, or tools/call:<tool> for hub-denied calls
	Path       string `gorm:"size:256"`
	StatusCode int
	DurationMs int64
	CreatedAt  time.Time
}

// KbDoc 是 R9-D2 知识库的一篇入库文档：元数据 + chunk 数；切块与向量在
// KbChunk 行里。唯一更新路径是同 sourceRef 重入（保 id 与 created_at 换
// 全量 chunks），列表按 created_at 倒序不受更新影响。Content 是 R11-K1
// 加的原文列（≤1MB）：rebuild 用它重切重嵌；存量旧档为空串，rebuild 退
// 化为 chunks 拼接近似重建。
type KbDoc struct {
	ID         string `gorm:"primaryKey;size:36"` // uuid
	UserID     string `gorm:"index;size:64"`
	Title      string `gorm:"size:255"`
	SourceType string `gorm:"size:8"` // url|paste|file
	SourceRef  string `gorm:"size:1024"`
	Content    string `gorm:"type:text"` // 原文（入库边界限 ≤1MB）
	ChunkCount int
	CreatedAt  time.Time
}

// KbChunk 是文档的一个切块：文本 + embedding（dim*4 字节 float32 小端；
// PG bytea / sqlite blob 双库同型）。dim 不落库——以入库时活的 embedding
// 模型实返为准，kb.bytesToVec 读侧还原。
type KbChunk struct {
	ID        string `gorm:"primaryKey;size:36"` // uuid
	DocID     string `gorm:"index;size:36"`
	Seq       int
	Text      string `gorm:"type:text"`
	Embedding []byte
	CreatedAt time.Time
}

type Store struct {
	db *gorm.DB
}

// Open connects dsn: postgres:// / postgresql:// prefixes select PostgreSQL,
// anything else is treated as a sqlite DSN (glebarez, pure Go, no CGO).
func Open(dsn string) (*Store, error) {
	var dialector gorm.Dialector
	if strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://") {
		dialector = postgres.Open(dsn)
	} else {
		dialector = sqlite.Open(dsn)
	}
	// TranslateError maps unique violations to gorm.ErrDuplicatedKey on both lanes.
	db, err := gorm.Open(dialector, &gorm.Config{TranslateError: true})
	if err != nil {
		return nil, err
	}
	return &Store{db: db}, nil
}

// AutoMigrate evolves the schema additively (workspace convention: GORM structs, no SQL migrations).
func (s *Store) AutoMigrate() error {
	return s.db.AutoMigrate(&User{}, &HostedModel{}, &Session{}, &Message{}, &UsageDaily{}, &MaterialTask{}, &McpUpstream{}, &McpAudit{}, &SystemConfig{}, &KbDoc{}, &KbChunk{})
}

// Close releases the connection pool; without it Windows cannot delete a
// test's sqlite file while a pooled handle is still open.
func (s *Store) Close() error {
	sqlDB, err := s.db.DB()
	if err != nil {
		return err
	}
	return sqlDB.Close()
}

// FirstDashScopeKey 取模型池首个启用的 qwen 系模型 key（kb embedding 兜底
// key 源：生产 DashScope key 灌在模型池而非 env——hub 本就是 key 池架构，
// key 不应散落第二处）。无可用行返回空串（调用方再判未配置）。
func (s *Store) FirstDashScopeKey() (string, error) {
	var key string
	err := s.db.Raw("SELECT api_key FROM hosted_models WHERE enabled = true AND name LIKE 'qwen%' ORDER BY name LIMIT 1").Scan(&key).Error
	return key, err
}

// SQLDB 暴露底层 *sql.DB（kb 的 PG16 探针等需要裸 SQL 的场合）。
func (s *Store) SQLDB() (*sql.DB, error) {
	return s.db.DB()
}

// UpsertUser creates the user on first sight and refreshes email/nickname on
// later calls; created_at is left untouched. Idempotent by construction.
func (s *Store) UpsertUser(u *User) error {
	return s.db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "id"}},
		DoUpdates: clause.AssignmentColumns([]string{"email", "nickname"}),
	}).Create(u).Error
}

func (s *Store) TouchUser(id string) error {
	return s.db.Model(&User{}).Where("id = ?", id).Update("last_seen_at", time.Now()).Error
}

// ListHostedModels returns the full pool, disabled included; filtering is the API's call.
func (s *Store) ListHostedModels() ([]HostedModel, error) {
	var ms []HostedModel
	err := s.db.Order("id").Find(&ms).Error
	return ms, err
}

func (s *Store) CreateHostedModel(m *HostedModel) error {
	// PG jsonb rejects the empty string; sqlite stores text, so one normalization covers both.
	if strings.TrimSpace(m.Capabilities) == "" {
		m.Capabilities = "{}"
	}
	return s.db.Create(m).Error
}

// DeleteHostedModel is idempotent: deleting an absent name succeeds.
func (s *Store) DeleteHostedModel(name string) error {
	return s.db.Where("name = ?", name).Delete(&HostedModel{}).Error
}

// EnabledHostedModel returns the model registered under name when it is
// enabled; a disabled or unknown name reads as not found.
func (s *Store) EnabledHostedModel(name string) (*HostedModel, error) {
	var m HostedModel
	if err := s.db.Where("name = ? AND enabled = ?", name, true).First(&m).Error; err != nil {
		return nil, err
	}
	return &m, nil
}

func (s *Store) CreateSession(sess *Session) error {
	return s.db.Create(sess).Error
}

// ListSessions returns the user's sessions, most recently updated first.
func (s *Store) ListSessions(userID string, limit int) ([]Session, error) {
	var out []Session
	err := s.db.Where("user_id = ?", userID).Order("updated_at DESC").Limit(limit).Find(&out).Error
	return out, err
}

// GetSession enforces ownership: another user's session id is
// indistinguishable from a missing one.
func (s *Store) GetSession(id, userID string) (*Session, error) {
	var sess Session
	if err := s.db.Where("id = ? AND user_id = ?", id, userID).First(&sess).Error; err != nil {
		return nil, err
	}
	return &sess, nil
}

func (s *Store) UpdateSession(sess *Session) error {
	return s.db.Save(sess).Error
}

// DeleteSessionCascade removes the session and its messages in one
// transaction; zero rows affected (absent or not the owner) maps to
// gorm.ErrRecordNotFound.
func (s *Store) DeleteSessionCascade(id, userID string) error {
	return s.db.Transaction(func(tx *gorm.DB) error {
		res := tx.Where("id = ? AND user_id = ?", id, userID).Delete(&Session{})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return gorm.ErrRecordNotFound
		}
		return tx.Where("session_id = ?", id).Delete(&Message{}).Error
	})
}

// ListMessages returns the full conversation (P0 has no pagination), oldest
// first; id breaks created_at ties.
func (s *Store) ListMessages(sessionID string) ([]Message, error) {
	var out []Message
	err := s.db.Where("session_id = ?", sessionID).Order("created_at ASC, id ASC").Find(&out).Error
	return out, err
}

// ListMessagesPage 是会话消息分页（R5-B#2）：按 id 游标取一页，返回仍按
// 时间正序（与 ListMessages 同序，客户端直接渲染）。before_id=0 取最新一页；
// limit 上限 200 防滥用，<=0 落默认 50。
func (s *Store) ListMessagesPage(sessionID string, beforeID, limit int) ([]Message, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	q := s.db.Where("session_id = ?", sessionID)
	if beforeID > 0 {
		q = q.Where("id < ?", beforeID)
	}
	var desc []Message
	err := q.Order("id DESC").Limit(limit).Find(&desc).Error
	if err != nil {
		return nil, err
	}
	// DESC 取页后反转为 ASC，与全量路径同序
	for i, j := 0, len(desc)-1; i < j; i, j = i+1, j-1 {
		desc[i], desc[j] = desc[j], desc[i]
	}
	return desc, nil
}

// SearchHit 是会话搜索（C2，depth-batch-r9c）的一行命中：同会话只出一条。
// Snippet 为空串表示命中在标题；消息命中时是命中处前后各 40 字的片段。
type SearchHit struct {
	SessionID string
	Title     string
	Snippet   string
	CreatedAt time.Time
}

// likeEscaper 转义 LIKE 通配符（% _ \），配合 SQL 侧 ESCAPE '\'：q 里的
// 通配符只作字面量，q="%" 不会全匹配（防通配注入）。
var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

// SearchSessions 在本用户会话的标题与消息内容里做不区分大小写的子串
// 匹配（LOWER(col) LIKE LOWER(?)，pg/sqlite 双方言同式），按会话
// updated_at 倒序返回最多 limit 条（钳到 20）。同会话只取首个命中：消息
// 命中取该会话最早命中消息做片段，仅标题命中时 Snippet 为空串。q 空白
// 直接返回空切片。
func (s *Store) SearchSessions(userID, q string, limit int) ([]SearchHit, error) {
	if limit <= 0 || limit > 20 {
		limit = 20
	}
	if strings.TrimSpace(q) == "" {
		return []SearchHit{}, nil
	}
	pat := "%" + likeEscaper.Replace(q) + "%"
	// 消息命中判定放进 JOIN 条件：标题未命中但有命中消息的会话由
	// messages.id IS NOT NULL 放行，MIN(messages.id) 即该会话最早命中消息。
	var rows []struct {
		ID        string    `gorm:"column:id"`
		Title     string    `gorm:"column:title"`
		CreatedAt time.Time `gorm:"column:created_at"`
		FirstMsg  uint64    `gorm:"column:first_msg"`
	}
	err := s.db.Table("sessions").
		Select("sessions.id, sessions.title, sessions.created_at, COALESCE(MIN(messages.id), 0) AS first_msg").
		Joins("LEFT JOIN messages ON messages.session_id = sessions.id AND LOWER(messages.content) LIKE LOWER(?) ESCAPE '\\'", pat).
		Where("sessions.user_id = ? AND (LOWER(sessions.title) LIKE LOWER(?) ESCAPE '\\' OR messages.id IS NOT NULL)", userID, pat).
		Group("sessions.id, sessions.title, sessions.created_at, sessions.updated_at").
		Order("sessions.updated_at DESC, sessions.id DESC").
		Limit(limit).
		Find(&rows).Error
	if err != nil {
		return nil, err
	}
	msgIDs := make([]uint64, 0, len(rows))
	for _, r := range rows {
		if r.FirstMsg > 0 {
			msgIDs = append(msgIDs, r.FirstMsg)
		}
	}
	contentByID := map[uint64]string{}
	if len(msgIDs) > 0 {
		var msgs []Message
		if err := s.db.Where("id IN ?", msgIDs).Find(&msgs).Error; err != nil {
			return nil, err
		}
		for _, m := range msgs {
			contentByID[m.ID] = m.Content
		}
	}
	hits := make([]SearchHit, 0, len(rows))
	for _, r := range rows {
		hits = append(hits, SearchHit{
			SessionID: r.ID,
			Title:     r.Title,
			Snippet:   snippetAround(contentByID[r.FirstMsg], q),
			CreatedAt: r.CreatedAt,
		})
	}
	return hits, nil
}

// snippetAround 取命中处前后各 40 字（rune 计）的片段。按原串字节位推进、
// EqualFold 折叠比对，避免先 ToLower 整串再切片造成字节位漂移；找不到
// 命中（仅方言折叠差异的极端情形）返回空串。
func snippetAround(content, q string) string {
	for i := 0; i+len(q) <= len(content); i++ {
		if !strings.EqualFold(content[i:i+len(q)], q) {
			continue
		}
		runes := []rune(content)
		hit := utf8.RuneCountInString(content[:i])
		width := utf8.RuneCountInString(q)
		start, end := hit-40, hit+width+40
		if start < 0 {
			start = 0
		}
		if end > len(runes) {
			end = len(runes)
		}
		return string(runes[start:end])
	}
	return ""
}

// CreateMessage stores one message and bumps the owning session so the
// list ordering (updated_at DESC) tracks conversation activity, not creation.
func (s *Store) CreateMessage(m *Message) error {
	return s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(m).Error; err != nil {
			return err
		}
		return tx.Model(&Session{}).Where("id = ?", m.SessionID).
			Update("updated_at", time.Now()).Error
	})
}

// AddUsage merges u into the day's row: on composite-key conflict the
// counters accumulate, they never overwrite. The target-table qualifier is
// required on PostgreSQL: a bare column name in DO UPDATE SET is ambiguous
// against excluded (sqlite tolerates it, PG errors 42702 — found live on
// the first production deployment).
func (s *Store) AddUsage(u *UsageDaily) error {
	return s.db.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "date"}, {Name: "user_id"}, {Name: "model_name"}},
		DoUpdates: clause.Assignments(map[string]any{
			"tokens_in":  gorm.Expr("usage_dailies.tokens_in + excluded.tokens_in"),
			"tokens_out": gorm.Expr("usage_dailies.tokens_out + excluded.tokens_out"),
			"cost_cents": gorm.Expr("usage_dailies.cost_cents + excluded.cost_cents"),
			"requests":   gorm.Expr("usage_dailies.requests + excluded.requests"),
		}),
	}).Create(u).Error
}

// UsageSummary returns the user's daily rows for the last days days, today
// included (date >= today-(days-1)), newest first.
func (s *Store) UsageSummary(userID string, days int) ([]UsageDaily, error) {
	cutoff := time.Now().AddDate(0, 0, -(days - 1)).Format("2006-01-02")
	var out []UsageDaily
	err := s.db.Where("user_id = ? AND date >= ?", userID, cutoff).
		Order("date DESC, model_name ASC").Find(&out).Error
	return out, err
}

// UsageSummaryAll 是控制台（R7-C6）的跨用户用量视图：同口径去 user 谓词。
func (s *Store) UsageSummaryAll(days int) ([]UsageDaily, error) {
	cutoff := time.Now().AddDate(0, 0, -(days - 1)).Format("2006-01-02")
	var out []UsageDaily
	err := s.db.Where("date >= ?", cutoff).
		Order("date DESC, model_name ASC").Find(&out).Error
	return out, err
}

func (s *Store) CreateMaterialTask(t *MaterialTask) error {
	return s.db.Create(t).Error
}

// GetMaterialTask enforces ownership: another user's task id is
// indistinguishable from a missing one.
func (s *Store) GetMaterialTask(id, userID string) (*MaterialTask, error) {
	var t MaterialTask
	if err := s.db.Where("id = ? AND user_id = ?", id, userID).First(&t).Error; err != nil {
		return nil, err
	}
	return &t, nil
}

// ListMaterialTasks returns the user's tasks, newest first.
func (s *Store) ListMaterialTasks(userID string, limit int) ([]MaterialTask, error) {
	var out []MaterialTask
	err := s.db.Where("user_id = ?", userID).Order("created_at DESC").Limit(limit).Find(&out).Error
	return out, err
}

// ListMaterialTasksAll 是控制台（R7-C6）的跨用户任务监控视图。
func (s *Store) ListMaterialTasksAll(limit int) ([]MaterialTask, error) {
	var out []MaterialTask
	err := s.db.Order("created_at DESC").Limit(limit).Find(&out).Error
	return out, err
}

func (s *Store) UpdateMaterialTask(t *MaterialTask) error {
	return s.db.Save(t).Error
}

// ListActiveMaterialTasks returns every not-yet-terminal task across users
// for the material worker scan.
func (s *Store) ListActiveMaterialTasks() ([]MaterialTask, error) {
	var out []MaterialTask
	err := s.db.Where("status IN ?", []string{MaterialPending, MaterialRunning}).
		Order("created_at ASC").Find(&out).Error
	return out, err
}

// ErrMcpUpstreamDisabled reports a registered upstream whose Enabled flag is
// off; the proxy surfaces it as 409 rather than the 404 of an unknown name.
var ErrMcpUpstreamDisabled = errors.New("mcp upstream disabled")

func (s *Store) CreateMcpUpstream(u *McpUpstream) error {
	// PG jsonb rejects the empty string; sqlite stores text, so one
	// normalization covers both (same trap as CreateHostedModel's
	// capabilities). Found live on a PG16 probe: the API path leaves
	// AllowedTools empty when no allowlist is supplied.
	if strings.TrimSpace(u.AllowedTools) == "" {
		u.AllowedTools = "[]"
	}
	return s.db.Create(u).Error
}

// ListMcpUpstreams returns the full registry, disabled included.
func (s *Store) ListMcpUpstreams() ([]McpUpstream, error) {
	var out []McpUpstream
	err := s.db.Order("id").Find(&out).Error
	return out, err
}

// DeleteMcpUpstream is idempotent: deleting an absent name succeeds.
func (s *Store) DeleteMcpUpstream(name string) error {
	return s.db.Where("name = ?", name).Delete(&McpUpstream{}).Error
}

// UpdateMcpUpstreamEnabled flips one upstream's enabled flag（控制台启停与
// C3 API 面共用）。unknown name reads as gorm.ErrRecordNotFound, same shape
// as UpdateHostedModel; sqlite/PG both count matched rows, so setting the
// current value again is not a 404.
func (s *Store) UpdateMcpUpstreamEnabled(name string, enabled bool) error {
	res := s.db.Model(&McpUpstream{}).Where("name = ?", name).Update("enabled", enabled)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

// FindEnabledMcpUpstreamByName resolves the routing name in one read:
// unknown names read as gorm.ErrRecordNotFound, registered-but-disabled
// ones as ErrMcpUpstreamDisabled carrying the row.
func (s *Store) FindEnabledMcpUpstreamByName(name string) (*McpUpstream, error) {
	var u McpUpstream
	if err := s.db.Where("name = ?", name).First(&u).Error; err != nil {
		return nil, err
	}
	if !u.IsEnabled() {
		return &u, ErrMcpUpstreamDisabled
	}
	return &u, nil
}

func (s *Store) CreateMcpAudit(a *McpAudit) error {
	return s.db.Create(a).Error
}

// CreateKbDoc 落 doc 与全部 chunk 于单事务：任一步失败两侧都不留行，
// kb 入库的「失败清半成品」即依赖此语义（无 pending 中间态）。
func (s *Store) CreateKbDoc(doc *KbDoc, chunks []KbChunk) error {
	return s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(doc).Error; err != nil {
			return err
		}
		if len(chunks) == 0 {
			return nil
		}
		return tx.Create(&chunks).Error
	})
}

// FindKbDocBySourceRef 返回本用户同 sourceRef 的既有文档（最新一篇，
// 与 ListKbDocs 首行同序），供重入更新判定；无则 gorm.ErrRecordNotFound。
// 历史上无唯一约束，旧数据可能同 ref 多行——只认最新，余篇不静默合并。
func (s *Store) FindKbDocBySourceRef(userID, sourceRef string) (*KbDoc, error) {
	var out KbDoc
	err := s.db.Where("user_id = ? AND source_ref = ?", userID, sourceRef).
		Order("created_at DESC, id DESC").First(&out).Error
	return &out, err
}

// UpdateKbDoc 单事务完成重入更新：更新 doc 行（title/content/chunk_count，
// id 与 created_at 原样）→ 删旧 chunks → 插新 chunks。先更 doc 行带 user_id
// 归属校验（RowsAffected==0 → not found 回滚），非本人的 doc_id 不会误删
// 其 chunks。
func (s *Store) UpdateKbDoc(doc *KbDoc, chunks []KbChunk) error {
	return s.db.Transaction(func(tx *gorm.DB) error {
		res := tx.Model(&KbDoc{}).Where("id = ? AND user_id = ?", doc.ID, doc.UserID).
			Updates(map[string]any{"title": doc.Title, "content": doc.Content, "chunk_count": doc.ChunkCount})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return gorm.ErrRecordNotFound
		}
		if err := tx.Where("doc_id = ?", doc.ID).Delete(&KbChunk{}).Error; err != nil {
			return err
		}
		if len(chunks) == 0 {
			return nil
		}
		return tx.Create(&chunks).Error
	})
}

// ListKbDocs 返回本用户文档，更新序（created_at 倒序即最新入库在前；
// 同 sourceRef 重入更新不动 created_at，位置不前插）。非本人文档不可见
// （同 sessions 惯例）。
func (s *Store) ListKbDocs(userID string) ([]KbDoc, error) {
	var out []KbDoc
	err := s.db.Where("user_id = ?", userID).Order("created_at DESC, id DESC").Find(&out).Error
	return out, err
}

// DeleteKbDocCascade 删文档并级联删 chunk；不存在或非本人一律
// gorm.ErrRecordNotFound（与 DeleteSessionCascade 同形）。
func (s *Store) DeleteKbDocCascade(id, userID string) error {
	return s.db.Transaction(func(tx *gorm.DB) error {
		res := tx.Where("id = ? AND user_id = ?", id, userID).Delete(&KbDoc{})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return gorm.ErrRecordNotFound
		}
		return tx.Where("doc_id = ?", id).Delete(&KbChunk{}).Error
	})
}

// ListKbDocsAll / ListKbChunksAll 供 kb 内存索引启动全量加载（跨用户）。
func (s *Store) ListKbDocsAll() ([]KbDoc, error) {
	var out []KbDoc
	err := s.db.Order("created_at ASC, id ASC").Find(&out).Error
	return out, err
}

func (s *Store) ListKbChunksAll() ([]KbChunk, error) {
	var out []KbChunk
	err := s.db.Order("doc_id ASC, seq ASC").Find(&out).Error
	return out, err
}

// ListKbChunksByUser 返回该用户全部 chunk（doc 归属过滤，doc_id+seq 升序），
// 供 rebuild 对无原文列的存量旧档做 chunks 拼接近似重建。
func (s *Store) ListKbChunksByUser(userID string) ([]KbChunk, error) {
	var out []KbChunk
	err := s.db.Joins("JOIN kb_docs ON kb_docs.id = kb_chunks.doc_id").
		Where("kb_docs.user_id = ?", userID).
		Order("kb_chunks.doc_id ASC, kb_chunks.seq ASC").Find(&out).Error
	return out, err
}

// ListMcpAudit returns the user's audit rows, newest first; id breaks
// created_at ties the same way ListMessages does.
func (s *Store) ListMcpAudit(userID string, limit int) ([]McpAudit, error) {
	var out []McpAudit
	err := s.db.Where("user_id = ?", userID).
		Order("created_at DESC, id DESC").Limit(limit).Find(&out).Error
	return out, err
}

package store

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func openTestStore(t *testing.T) *Store {
	t.Helper()
	st, err := Open("file::memory:?cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.AutoMigrate(); err != nil {
		t.Fatal(err)
	}
	return st
}

func TestUpsertUserIdempotent(t *testing.T) {
	st := openTestStore(t)

	if err := st.UpsertUser(&User{ID: "u1", Email: "first@example.com", Nickname: "one"}); err != nil {
		t.Fatal(err)
	}
	var first User
	if err := st.db.First(&first, "id = ?", "u1").Error; err != nil {
		t.Fatal(err)
	}

	if err := st.UpsertUser(&User{ID: "u1", Email: "second@example.com", Nickname: "two"}); err != nil {
		t.Fatalf("second upsert: %v", err)
	}
	var after User
	if err := st.db.First(&after, "id = ?", "u1").Error; err != nil {
		t.Fatal(err)
	}

	var count int64
	if err := st.db.Model(&User{}).Where("id = ?", "u1").Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("same id produced %d rows, want 1", count)
	}
	if after.Email != "second@example.com" || after.Nickname != "two" {
		t.Fatalf("claims not refreshed: %+v", after)
	}
	if !after.CreatedAt.Equal(first.CreatedAt) {
		t.Fatalf("created_at moved on upsert: %s -> %s", first.CreatedAt, after.CreatedAt)
	}

	if err := st.TouchUser("u1"); err != nil {
		t.Fatal(err)
	}
	var touched User
	if err := st.db.First(&touched, "id = ?", "u1").Error; err != nil {
		t.Fatal(err)
	}
	if touched.LastSeenAt.Before(time.Now().Add(-time.Minute)) {
		t.Fatalf("last_seen_at not touched: %s", touched.LastSeenAt)
	}
}

func TestHostedModelCRUD(t *testing.T) {
	st := openTestStore(t)

	m := &HostedModel{
		Name:          "glm-flash",
		Provider:      "dashscope",
		BaseURL:       "https://dashscope.example/api",
		APIKey:        "sk-secret",
		UpstreamModel: "glm-4.6-flash",
		Capabilities:  `{"tools":true}`,
	}
	if err := st.CreateHostedModel(m); err != nil {
		t.Fatal(err)
	}
	if err := st.CreateHostedModel(&HostedModel{Name: "glm-air", Provider: "deepseek", APIKey: "sk-2"}); err != nil {
		t.Fatal(err)
	}

	models, err := st.ListHostedModels()
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 {
		t.Fatalf("models = %d, want 2 (disabled included)", len(models))
	}
	byName := map[string]HostedModel{}
	for _, got := range models {
		byName[got.Name] = got
	}
	flash := byName["glm-flash"]
	if flash.Provider != "dashscope" || flash.APIKey != "sk-secret" ||
		flash.UpstreamModel != "glm-4.6-flash" || !flash.IsEnabled() {
		t.Fatalf("glm-flash roundtrip mismatch: %+v", flash)
	}
	air := byName["glm-air"]
	if air.Protocol != "openai" {
		t.Fatalf("protocol default not applied: %q", air.Protocol)
	}
	if air.Capabilities != "{}" {
		t.Fatalf("capabilities not normalized to {}: %q", air.Capabilities)
	}
	if !air.IsEnabled() {
		t.Fatal("enabled default not applied")
	}

	if err := st.CreateHostedModel(&HostedModel{Name: "glm-flash", Provider: "x", APIKey: "sk-3"}); err == nil {
		t.Fatal("duplicate name must fail the unique index")
	}

	if err := st.DeleteHostedModel("glm-flash"); err != nil {
		t.Fatal(err)
	}
	models, err = st.ListHostedModels()
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0].Name != "glm-air" {
		t.Fatalf("after delete: %+v", models)
	}
	if err := st.DeleteHostedModel("glm-flash"); err != nil {
		t.Fatalf("delete of absent name must be idempotent: %v", err)
	}
}

// The daily usage rollup has no dedicated store method yet; this pins the
// composite-key upsert semantics the chat pipeline will rely on.
func TestUsageDailyCompositeKeyUpsert(t *testing.T) {
	st := openTestStore(t)

	upsert := func(row UsageDaily) {
		t.Helper()
		err := st.db.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "date"}, {Name: "user_id"}, {Name: "model_name"}},
			DoUpdates: clause.AssignmentColumns([]string{"tokens_in", "tokens_out", "cost_cents", "requests"}),
		}).Create(&row).Error
		if err != nil {
			t.Fatal(err)
		}
	}

	upsert(UsageDaily{Date: "2026-11-04", UserID: "u1", ModelName: "glm-flash", TokensIn: 100, TokensOut: 50, CostCents: 12, Requests: 1})
	upsert(UsageDaily{Date: "2026-11-04", UserID: "u1", ModelName: "glm-flash", TokensIn: 30, TokensOut: 20, CostCents: 7, Requests: 1})
	upsert(UsageDaily{Date: "2026-11-05", UserID: "u1", ModelName: "glm-flash", TokensIn: 1, TokensOut: 1, CostCents: 1, Requests: 1})

	var rows []UsageDaily
	if err := st.db.Order("date").Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2 (same composite key merges, new day inserts)", len(rows))
	}
	if rows[0].TokensIn != 30 || rows[0].TokensOut != 20 || rows[0].CostCents != 7 || rows[0].Requests != 1 {
		t.Fatalf("second write did not win on conflict: %+v", rows[0])
	}
	if rows[1].Date != "2026-11-05" {
		t.Fatalf("new day row missing: %+v", rows[1])
	}
}

func TestAddUsageAccumulates(t *testing.T) {
	st := openTestStore(t)

	add := func(in, out, cost int64) {
		t.Helper()
		err := st.AddUsage(&UsageDaily{
			Date: "2026-11-04", UserID: "au", ModelName: "glm",
			TokensIn: in, TokensOut: out, CostCents: cost, Requests: 1,
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	add(100, 50, 12)
	add(30, 20, 7)
	add(1, 1, 1)

	var rows []UsageDaily
	if err := st.db.Where("user_id = ?", "au").Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want one merged row", len(rows))
	}
	got := rows[0]
	if got.TokensIn != 131 || got.TokensOut != 71 || got.CostCents != 20 || got.Requests != 3 {
		t.Fatalf("counters did not accumulate: %+v", got)
	}
}

func TestUsageSummaryWindowPerUser(t *testing.T) {
	st := openTestStore(t)

	today := time.Now().Format("2006-01-02")
	older := time.Now().AddDate(0, 0, -40).Format("2006-01-02")
	seed := []UsageDaily{
		{Date: today, UserID: "sum1", ModelName: "m1", TokensIn: 1, TokensOut: 2, CostCents: 3, Requests: 4},
		{Date: today, UserID: "sum2", ModelName: "m1", TokensIn: 9, TokensOut: 9, CostCents: 9, Requests: 9},
		{Date: older, UserID: "sum1", ModelName: "m1", TokensIn: 5, TokensOut: 5, CostCents: 5, Requests: 5},
	}
	for _, u := range seed {
		if err := st.AddUsage(&u); err != nil {
			t.Fatal(err)
		}
	}

	rows, err := st.UsageSummary("sum1", 30)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Date != today || rows[0].TokensIn != 1 || rows[0].Requests != 4 {
		t.Fatalf("30-day window = %+v", rows)
	}

	rows, err = st.UsageSummary("sum1", 60)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].Date != today || rows[1].Date != older {
		t.Fatalf("60-day window = %+v", rows)
	}

	rows, err = st.UsageSummary("sum2", 30)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].UserID != "sum2" || rows[0].TokensIn != 9 {
		t.Fatalf("sum2 rows = %+v", rows)
	}
}

// B2：HostedModelPatch 部分更新 + Enabled 三态显式 false 路径。
func TestHostedModelPatchAndDisabledPath(t *testing.T) {
	st := openTestStore(t)
	disabled := false
	m := &HostedModel{Name: "glm-flash", Provider: "dashscope", BaseURL: "https://u.example", APIKey: "sk-1", Enabled: &disabled}
	if err := st.CreateHostedModel(m); err != nil {
		t.Fatal(err)
	}
	if m.IsEnabled() {
		t.Fatal("explicit false must read back false")
	}
	if got, err := st.EnabledHostedModel("glm-flash"); err == nil || got != nil {
		t.Fatalf("disabled model must not be served, got %+v err %v", got, err)
	}

	enabled := true
	newKey := "sk-rotated"
	patched, err := st.UpdateHostedModel("glm-flash", &HostedModelPatch{Enabled: &enabled, APIKey: &newKey})
	if err != nil {
		t.Fatal(err)
	}
	if !patched.IsEnabled() || patched.APIKey != "sk-rotated" || patched.Provider != "dashscope" {
		t.Fatalf("patch mismatch: %+v", patched)
	}
	if got, err := st.EnabledHostedModel("glm-flash"); err != nil || got == nil {
		t.Fatalf("re-enabled model must be served again, got %+v err %v", got, err)
	}

	emptyCaps := "  "
	patched, err = st.UpdateHostedModel("glm-flash", &HostedModelPatch{Capabilities: &emptyCaps})
	if err != nil || patched.Capabilities != "{}" {
		t.Fatalf("capabilities normalization on patch: %+v err %v", patched, err)
	}

	if _, err := st.UpdateHostedModel("ghost", &HostedModelPatch{Enabled: &enabled}); err != gorm.ErrRecordNotFound {
		t.Fatalf("patch of absent name = %v, want ErrRecordNotFound", err)
	}
}

// B3：system_config 读写 upsert。
func TestSystemConfigSetGet(t *testing.T) {
	st := openTestStore(t)
	if v, ok, err := st.GetSystemConfig("k"); err != nil || ok || v != "" {
		t.Fatalf("absent key = %q ok=%v err=%v", v, ok, err)
	}
	if err := st.SetSystemConfig("k", "v1"); err != nil {
		t.Fatal(err)
	}
	if err := st.SetSystemConfig("k", "v2"); err != nil {
		t.Fatal(err)
	}
	if v, ok, _ := st.GetSystemConfig("k"); !ok || v != "v2" {
		t.Fatalf("upsert readback = %q ok=%v", v, ok)
	}
}

// C2 会话搜索：标题/消息命中、同会话去重取最早命中消息、通配转义、
// 用户隔离与更新时间倒序。
func TestSearchSessions(t *testing.T) {
	st := openTestStore(t)
	base := time.Now().Add(-2 * time.Hour)

	if err := st.CreateSession(&Session{ID: "s-report", UserID: "su1", Title: "季度 REPORT 归档", CreatedAt: base, UpdatedAt: base}); err != nil {
		t.Fatal(err)
	}
	if err := st.CreateSession(&Session{ID: "s-notes", UserID: "su1", Title: "随手记", CreatedAt: base.Add(-time.Hour)}); err != nil {
		t.Fatal(err)
	}
	long := strings.Repeat("前", 60) + "report" + strings.Repeat("后", 60)
	for _, m := range []Message{
		{SessionID: "s-notes", Role: "user", Content: long, ModelName: "glm-flash"},
		{SessionID: "s-notes", Role: "assistant", Content: "第二条含 report 的消息", ModelName: "glm-flash"},
	} {
		if err := st.CreateMessage(&m); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.CreateSession(&Session{ID: "s-chat", UserID: "su1", Title: "闲聊", CreatedAt: base}); err != nil {
		t.Fatal(err)
	}
	if err := st.CreateMessage(&Message{SessionID: "s-chat", Role: "user", Content: "总成本 costX100 元", ModelName: "glm-flash"}); err != nil {
		t.Fatal(err)
	}
	if err := st.CreateSession(&Session{ID: "s-bob", UserID: "su2", Title: "bob 的 REPORT", CreatedAt: base}); err != nil {
		t.Fatal(err)
	}

	hits, err := st.SearchSessions("su1", "report", 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 2 {
		t.Fatalf("hits = %+v, want s-notes and s-report only (bob isolated, s-chat no hit)", hits)
	}
	// s-notes 的消息写入 bump 了 updated_at，排在 title-only 的 s-report 前
	if hits[0].SessionID != "s-notes" || hits[1].SessionID != "s-report" {
		t.Fatalf("order = %+v, want updated_at DESC", hits)
	}
	first := hits[0]
	if first.Title != "随手记" {
		t.Fatalf("title = %q", first.Title)
	}
	wantSnippet := strings.Repeat("前", 40) + "report" + strings.Repeat("后", 40)
	if first.Snippet != wantSnippet {
		t.Fatalf("snippet = %q (%d runes), want 40+6+40 window %q", first.Snippet, len([]rune(first.Snippet)), wantSnippet)
	}
	if first.CreatedAt.IsZero() {
		t.Fatal("created_at must ride along")
	}
	if hits[1].Snippet != "" {
		t.Fatalf("title hit must carry empty snippet, got %q", hits[1].Snippet)
	}

	// 空白 q：空切片，不报错
	hits, err = st.SearchSessions("su1", "   ", 20)
	if err != nil || len(hits) != 0 {
		t.Fatalf("blank q = %+v err = %v, want empty and nil", hits, err)
	}

	// 通配注入：q="%" 不得全匹配（fixture 无字面 %）
	hits, err = st.SearchSessions("su1", "%", 20)
	if err != nil || len(hits) != 0 {
		t.Fatalf("q=%% = %+v err = %v, want no match-all", hits, err)
	}
	// 未转义的 _ 会当单字通配匹配 costX100；转义后必须只认字面下划线
	hits, err = st.SearchSessions("su1", "cost_100", 20)
	if err != nil || len(hits) != 0 {
		t.Fatalf("q=cost_100 = %+v err = %v, want no wildcard underscore", hits, err)
	}
	if err := st.CreateMessage(&Message{SessionID: "s-chat", Role: "user", Content: "对账 cost_100 已核", ModelName: "glm-flash"}); err != nil {
		t.Fatal(err)
	}
	if hits, err = st.SearchSessions("su1", "cost_100", 20); err != nil || len(hits) != 1 || hits[0].SessionID != "s-chat" {
		t.Fatalf("literal underscore = %+v err = %v, want s-chat", hits, err)
	}
}

// CreateMcpUpstream 空白 AllowedTools 归一为 "[]"：PG jsonb 拒空串（PG16
// 探针实测 22P02），读侧 "" 与 "[]" 同为不过滤。
func TestCreateMcpUpstreamNormalizesEmptyAllowlist(t *testing.T) {
	st := openTestStore(t)
	u := &McpUpstream{Name: "no-tools", BaseURL: "http://127.0.0.1:1"}
	if err := st.CreateMcpUpstream(u); err != nil {
		t.Fatal(err)
	}
	if u.AllowedTools != "[]" {
		t.Fatalf("allowlist = %q, want [] normalized", u.AllowedTools)
	}
	if tools := u.ToolAllowlist(); tools != nil {
		t.Fatalf("normalized allowlist must not filter: %+v", tools)
	}
}

// R9-A A1：vision 分段内容经 TEXT 列 roundtrip；旧纯文本与畸形 JSON 一律按文本回退。
func TestMessageContentPartsRoundtrip(t *testing.T) {
	st := openTestStore(t)
	if err := st.CreateSession(&Session{ID: "s-parts", UserID: "u1"}); err != nil {
		t.Fatal(err)
	}

	parts := []ContentPart{
		{Type: "text", Text: "[图片]"},
		{Type: "image_url", ImageURL: &ContentPartImage{URL: "data:image/png;base64,AAAA"}},
	}
	encoded, err := EncodeContentParts(parts)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.CreateMessage(&Message{SessionID: "s-parts", Role: "user", Content: encoded, ModelName: "glm-flash"}); err != nil {
		t.Fatal(err)
	}
	rows, err := st.ListMessagesPage("s-parts", 0, 50)
	if err != nil || len(rows) != 1 {
		t.Fatalf("rows = %+v err = %v", rows, err)
	}
	back, ok := DecodeContentParts(rows[0].Content)
	if !ok {
		t.Fatalf("stored content not recognized as parts: %q", rows[0].Content)
	}
	if !reflect.DeepEqual(back, parts) {
		t.Fatalf("roundtrip mismatch: %+v", back)
	}

	// 旧纯文本：普通文本、非数组 JSON、空数组与元素形状不符的数组都按文本处理
	for _, legacy := range []string{
		"hello world",
		"```js\ncode\n```",
		`{"type":"text","text":"x"}`,
		"[not json",
		"[]",
		`[{"type":"bogus"}]`,
		`[{"type":"text","text":1}]`,
		`[{"type":"image_url","image_url":{"url":null}}]`,
		`[{"type":"text","text":"a"},{"type":"text"}]`,
	} {
		if got, ok := DecodeContentParts(legacy); ok {
			t.Fatalf("legacy content %q wrongly decoded as parts: %+v", legacy, got)
		}
	}

	// 前导空白的分段串仍识别（TEXT 列不保证无空白）
	if _, ok := DecodeContentParts("  " + encoded); !ok {
		t.Fatal("whitespace-prefixed parts payload must still decode")
	}
}

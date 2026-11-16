package kb

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"gorm.io/gorm"

	"github.com/xycxmz/company-platform-v1/server/internal/store"
)

// fakeEmbed 是注入用的 EmbedClient mock：vecFn 按文本定向出向量（构造
// 已知几何），检索单条输入且 qv 已设时返回 qv，可脚本化失败。维度语义
// 与真 Embedder 同款：首次成功调用记录、此后不一致报错、ResetDim 清零
// （resets 计数供断言）——rebuild 维度重置测试靠这层强制成为负载证明。
type fakeEmbed struct {
	tokens int64
	err    error
	calls  int
	qv     []float32
	vecFn  func(text string) []float32

	dim    int // 首次成功 Embed 记录；0 = 未用过或已重置
	resets int // ResetDim 调用计数
}

func (f *fakeEmbed) Embed(_ context.Context, texts []string) ([][]float32, int64, error) {
	f.calls++
	if f.err != nil {
		return nil, 0, f.err
	}
	var out [][]float32
	if len(texts) == 1 && f.qv != nil {
		out = [][]float32{f.qv}
	} else {
		out = make([][]float32, len(texts))
		for i, t := range texts {
			out[i] = f.vecFn(t)
		}
	}
	if len(out) > 0 {
		if d := len(out[0]); f.dim == 0 {
			f.dim = d
		} else if f.dim != d {
			return nil, 0, fmt.Errorf("fakeEmbed: dim changed: recorded %d, got %d", f.dim, d)
		}
	}
	return out, f.tokens, nil
}

func (f *fakeEmbed) Dim() int { return f.dim }

func (f *fakeEmbed) ResetDim() {
	f.dim = 0
	f.resets++
}

func newService(t *testing.T, emb EmbedClient) (*Service, *store.Store) {
	t.Helper()
	dsn := fmt.Sprintf("file:kb-test-%d?mode=memory&cache=shared", time.Now().UnixNano())
	st, err := store.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.AutoMigrate(); err != nil {
		t.Fatal(err)
	}
	svc, err := NewService(st, emb)
	if err != nil {
		t.Fatal(err)
	}
	return svc, st
}

// top-k 正确性（已知向量免真 API）：doc-a 各块沿 e0，doc-b 沿 e1，
// doc-c 与 e0 反向。查询 e0 → 同分块按 seq 决胜，跨文档按余弦降序。
func TestSearchTopKOrdering(t *testing.T) {
	emb := &fakeEmbed{
		tokens: 5,
		vecFn: func(text string) []float32 {
			switch []rune(text)[0] {
			case '甲':
				return []float32{1, 0, 0}
			case '乙':
				return []float32{0, 1, 0}
			default: // 丙
				return []float32{-1, 0, 0}
			}
		},
	}
	svc, _ := newService(t, emb)

	for _, d := range []struct {
		marker  string
		title   string
		content string
	}{
		{"甲", "doc-a", repeat("甲", 2000)}, // 3 块，全沿 e0
		{"乙", "doc-b", repeat("乙", 300)},  // 1 块，沿 e1
		{"丙", "doc-c", repeat("丙", 300)},  // 1 块，与 e0 反向
	} {
		if _, _, err := svc.Ingest(context.Background(), "u", d.title, "paste", "", d.content); err != nil {
			t.Fatal(err)
		}
	}

	emb.qv = []float32{1, 0, 0} // 此后的单条输入（检索）定向 e0
	hits, err := svc.Search(context.Background(), "u", "任意问句", 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 5 { // 3+1+1 全命中
		t.Fatalf("hits = %d, want 5", len(hits))
	}
	for i, want := range []struct {
		doc   string
		seq   int
		score float64
	}{
		{"doc-a", 0, 1}, {"doc-a", 1, 1}, {"doc-a", 2, 1},
		{"doc-b", 0, 0}, {"doc-c", 0, -1},
	} {
		if hits[i].Title != want.doc || hits[i].Seq != want.seq || hits[i].Score != want.score {
			t.Fatalf("hit %d = %s seq %d score %v, want %s seq %d score %v",
				i, hits[i].Title, hits[i].Seq, hits[i].Score, want.doc, want.seq, want.score)
		}
		if hits[i].DocID == "" || hits[i].Text == "" {
			t.Fatalf("hit %d missing docId/text", i)
		}
	}

	hits, err = svc.Search(context.Background(), "u", "任意问句", 2)
	if err != nil || len(hits) != 2 || hits[1].Title != "doc-a" {
		t.Fatalf("k=2 hits = %+v err = %v", hits, err)
	}
}

func repeat(s string, n int) string {
	out := make([]byte, 0, len(s)*n)
	for i := 0; i < n; i++ {
		out = append(out, s...)
	}
	return string(out)
}

func TestIngestPersistsAndIndexes(t *testing.T) {
	emb := &fakeEmbed{tokens: 123, vecFn: func(string) []float32 { return []float32{0.5, 1, 0, -0.25} }}
	svc, st := newService(t, emb)

	doc, _, err := svc.Ingest(context.Background(), "u1", "测试文档", "paste", "", "第一段。\n\n第二段。")
	if err != nil {
		t.Fatal(err)
	}
	if doc.ChunkCount != 1 { // 短文单窗收纳
		t.Fatalf("chunkCount = %d, want 1", doc.ChunkCount)
	}

	docs, err := st.ListKbDocs("u1")
	if err != nil || len(docs) != 1 || docs[0].ID != doc.ID || docs[0].Title != "测试文档" {
		t.Fatalf("stored docs = %+v err = %v", docs, err)
	}
	chunks, err := st.ListKbChunksAll()
	if err != nil || len(chunks) != 1 || chunks[0].Text != "第一段。\n\n第二段。" {
		t.Fatalf("stored chunks = %+v err = %v", chunks, err)
	}
	vec, err := bytesToVec(chunks[0].Embedding)
	if err != nil || len(vec) != 4 || vec[0] != 0.5 || vec[3] != -0.25 {
		t.Fatalf("stored vec = %v err = %v", vec, err)
	}

	// 计量落账：modelName、tokens、单价折算。
	rows, err := st.UsageSummary("u1", 1)
	if err != nil || len(rows) != 1 {
		t.Fatalf("usage = %+v err = %v", rows, err)
	}
	if rows[0].ModelName != "kb:embedding" || rows[0].TokensIn != 123 ||
		rows[0].CostCents != 123*kbEmbedPriceNumer/kbEmbedPriceDenom || rows[0].Requests != 1 {
		t.Fatalf("usage row = %+v", rows[0])
	}

	// 删除：库行 + 索引同清；重复删是 not found。
	if err := svc.Delete("u1", doc.ID); err != nil {
		t.Fatal(err)
	}
	if docs, _ = st.ListKbDocs("u1"); len(docs) != 0 {
		t.Fatalf("docs after delete = %d", len(docs))
	}
	if chunks, _ = st.ListKbChunksAll(); len(chunks) != 0 {
		t.Fatalf("chunks after delete = %d", len(chunks))
	}
	if err := svc.Delete("u1", doc.ID); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("double delete = %v, want ErrRecordNotFound", err)
	}
}

// embedding 失败：不落任何行、不计量（半成品清理）。
func TestIngestEmbedFailureLeavesNoRows(t *testing.T) {
	emb := &fakeEmbed{err: errors.New("boom"), vecFn: func(string) []float32 { return []float32{1} }}
	svc, st := newService(t, emb)

	if _, _, err := svc.Ingest(context.Background(), "u1", "t", "paste", "", "正文"); err == nil {
		t.Fatal("want error")
	}
	if docs, _ := st.ListKbDocs("u1"); len(docs) != 0 {
		t.Fatalf("rows leaked: %+v", docs)
	}
	if chunks, _ := st.ListKbChunksAll(); len(chunks) != 0 {
		t.Fatalf("chunks leaked: %+v", chunks)
	}
	if rows, _ := st.UsageSummary("u1", 1); len(rows) != 0 {
		t.Fatalf("usage leaked: %+v", rows)
	}
}

// 未配置（ErrNotConfigured）原样穿透，不裹成 ErrEmbedding。
func TestIngestNotConfiguredPassesThrough(t *testing.T) {
	emb := &fakeEmbed{err: ErrNotConfigured, vecFn: func(string) []float32 { return []float32{1} }}
	svc, _ := newService(t, emb)
	if _, _, err := svc.Ingest(context.Background(), "u1", "t", "paste", "", "正文"); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("err = %v, want ErrNotConfigured", err)
	}
}

// 空语料直接返回空 hits，不发出 embedding 调用（不花 token）。
func TestSearchEmptyCorpusSkipsEmbedding(t *testing.T) {
	emb := &fakeEmbed{tokens: 5, vecFn: func(string) []float32 { return []float32{1} }}
	svc, _ := newService(t, emb)
	hits, err := svc.Search(context.Background(), "nobody", "问题", 4)
	if err != nil || len(hits) != 0 {
		t.Fatalf("hits = %+v err = %v", hits, err)
	}
	if emb.calls != 0 {
		t.Fatalf("embedding called %d times on empty corpus", emb.calls)
	}
}

// 跨用户隔离：B 的检索扫不到 A 的文档，也删不掉。
func TestSearchUserIsolation(t *testing.T) {
	emb := &fakeEmbed{tokens: 5, vecFn: func(string) []float32 { return []float32{1, 0} }}
	svc, _ := newService(t, emb)
	if _, _, err := svc.Ingest(context.Background(), "alice", "A 的文档", "paste", "", "只有 Alice 的内容"); err != nil {
		t.Fatal(err)
	}
	hits, err := svc.Search(context.Background(), "bob", "内容", 4)
	if err != nil || len(hits) != 0 {
		t.Fatalf("bob sees alice's corpus: %+v err = %v", hits, err)
	}
	if err := svc.Delete("bob", "不存在"); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("bob delete = %v, want not found", err)
	}
}

// 启动全量加载：先落库，再构造新 Service，检索能命中存量文档。
func TestNewServiceLoadsExistingRows(t *testing.T) {
	emb := &fakeEmbed{tokens: 5, vecFn: func(string) []float32 { return []float32{1, 0} }}
	svc1, st := newService(t, emb)
	if _, _, err := svc1.Ingest(context.Background(), "u1", "存量", "paste", "", "存量内容"); err != nil {
		t.Fatal(err)
	}

	svc2, err := NewService(st, emb)
	if err != nil {
		t.Fatal(err)
	}
	emb.qv = []float32{1, 0}
	hits, err := svc2.Search(context.Background(), "u1", "存量", 4)
	if err != nil || len(hits) != 1 || hits[0].Title != "存量" {
		t.Fatalf("hits = %+v err = %v", hits, err)
	}
}

// 脏向量行（字节长度非 4 倍数）让构造报错：响亮降级，不静默丢块。
func TestNewServiceRejectsCorruptChunkRow(t *testing.T) {
	emb := &fakeEmbed{tokens: 5, vecFn: func(string) []float32 { return []float32{1} }}
	_, st := newService(t, emb)
	if err := st.CreateKbDoc(&store.KbDoc{ID: "d1", UserID: "u1", ChunkCount: 1, CreatedAt: time.Now()},
		[]store.KbChunk{{ID: "c1", DocID: "d1", Seq: 0, Text: "坏行", Embedding: []byte{1, 2, 3}, CreatedAt: time.Now()}}); err != nil {
		t.Fatal(err)
	}
	if _, err := NewService(st, emb); err == nil {
		t.Fatal("corrupt embedding row must fail NewService")
	}
}

// 维度不一致的存量块（换模型后重启）在检索时跳过，不炸整场查询。
// 全程走公开面：emb1（2 维）入库旧文档 → emb2（4 维）新构造服务再入库
// 新文档 → 检索只命中 4 维块。
func TestSearchSkipsDimMismatchedChunks(t *testing.T) {
	emb1 := &fakeEmbed{tokens: 5, vecFn: func(string) []float32 { return []float32{1, 0} }}
	svc1, st := newService(t, emb1)
	if _, _, err := svc1.Ingest(context.Background(), "u", "旧模型文档", "paste", "", "旧内容"); err != nil {
		t.Fatal(err)
	}

	emb2 := &fakeEmbed{tokens: 5, vecFn: func(string) []float32 { return []float32{1, 0, 0, 0} }}
	svc2, err := NewService(st, emb2)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc2.Ingest(context.Background(), "u", "现行文档", "paste", "", "新内容"); err != nil {
		t.Fatal(err)
	}

	emb2.qv = []float32{1, 0, 0, 0}
	hits, err := svc2.Search(context.Background(), "u", "q", 4)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 || hits[0].Title != "现行文档" {
		t.Fatalf("hits = %+v, want only the dim-matching chunk", hits)
	}
}

// 同 sourceRef 重入 → 更新语义：doc id 与 createdAt 不变，旧 chunks 全删
// 换新切新嵌，title/chunkCount 更新，updated=true；首次 updated=false。
func TestIngestSameSourceRefUpdates(t *testing.T) {
	emb := &fakeEmbed{tokens: 5, vecFn: func(string) []float32 { return []float32{1, 0} }}
	svc, st := newService(t, emb)

	old, updated, err := svc.Ingest(context.Background(), "u1", "旧标题", "url", "https://a.md", repeat("旧", 2000))
	if err != nil {
		t.Fatal(err)
	}
	if updated || old.ChunkCount != 3 {
		t.Fatalf("first ingest updated=%v chunkCount=%d, want false/3", updated, old.ChunkCount)
	}

	fresh, updated, err := svc.Ingest(context.Background(), "u1", "新标题", "url", "https://a.md", "全新短文")
	if err != nil {
		t.Fatal(err)
	}
	if !updated {
		t.Fatal("reingest updated=false, want true")
	}
	if fresh.ID != old.ID {
		t.Fatalf("doc id changed: %s → %s", old.ID, fresh.ID)
	}
	if !fresh.CreatedAt.Equal(old.CreatedAt) {
		t.Fatalf("createdAt changed: %v → %v", old.CreatedAt, fresh.CreatedAt)
	}
	if fresh.Title != "新标题" || fresh.ChunkCount != 1 {
		t.Fatalf("updated doc = %+v, want 新标题/1 chunk", fresh)
	}

	docs, err := st.ListKbDocs("u1")
	if err != nil || len(docs) != 1 || docs[0].ID != old.ID || docs[0].Title != "新标题" || docs[0].ChunkCount != 1 {
		t.Fatalf("stored docs = %+v err = %v", docs, err)
	}
	chunks, err := st.ListKbChunksAll()
	if err != nil || len(chunks) != 1 || chunks[0].Text != "全新短文" {
		t.Fatalf("stored chunks = %+v err = %v", chunks, err)
	}

	// 内存索引同步覆写：检索只命新块（旧 3 块已不在索引）。
	emb.qv = []float32{1, 0}
	hits, err := svc.Search(context.Background(), "u1", "任意", 10)
	if err != nil || len(hits) != 1 || hits[0].Text != "全新短文" || hits[0].Title != "新标题" {
		t.Fatalf("hits after reingest = %+v err = %v", hits, err)
	}
}

// 空 sourceRef（无来源粘贴）不去重：两次入库两篇独立文档。
func TestIngestEmptySourceRefNoDedupe(t *testing.T) {
	emb := &fakeEmbed{tokens: 5, vecFn: func(string) []float32 { return []float32{1, 0} }}
	svc, st := newService(t, emb)

	a, updated, err := svc.Ingest(context.Background(), "u1", "粘贴一", "paste", "", "内容一")
	if err != nil || updated {
		t.Fatalf("first paste = %v updated=%v err=%v", a, updated, err)
	}
	b, updated, err := svc.Ingest(context.Background(), "u1", "粘贴二", "paste", "", "内容二")
	if err != nil || updated {
		t.Fatalf("second paste = %v updated=%v err=%v", b, updated, err)
	}
	if a.ID == b.ID {
		t.Fatalf("empty-ref pastes deduped: both %s", a.ID)
	}
	if docs, _ := st.ListKbDocs("u1"); len(docs) != 2 {
		t.Fatalf("docs = %+v, want 2 independent rows", docs)
	}
}

// 跨用户同 sourceRef 各自独立：bob 重入更新的是 bob 自己的行，alice 的
// 文档原样。
func TestIngestSourceRefUserIsolation(t *testing.T) {
	emb := &fakeEmbed{tokens: 5, vecFn: func(string) []float32 { return []float32{1, 0} }}
	svc, st := newService(t, emb)

	aliceDoc, _, err := svc.Ingest(context.Background(), "alice", "Alice 页", "url", "https://shared.md", "Alice 版本")
	if err != nil {
		t.Fatal(err)
	}
	bobDoc, updated, err := svc.Ingest(context.Background(), "bob", "Bob 页", "url", "https://shared.md", "Bob 版本")
	if err != nil || updated || bobDoc.ID == aliceDoc.ID {
		t.Fatalf("bob same ref = %+v updated=%v err=%v, want own new doc", bobDoc, updated, err)
	}
	bob2, updated, err := svc.Ingest(context.Background(), "bob", "Bob 页二", "url", "https://shared.md", "Bob 更新")
	if err != nil || !updated || bob2.ID != bobDoc.ID {
		t.Fatalf("bob reingest = %+v updated=%v err=%v, want update of bob's own doc", bob2, updated, err)
	}

	aliceDocs, err := st.ListKbDocs("alice")
	if err != nil || len(aliceDocs) != 1 || aliceDocs[0].ID != aliceDoc.ID || aliceDocs[0].Title != "Alice 页" {
		t.Fatalf("alice docs = %+v err = %v, want untouched single doc", aliceDocs, err)
	}
	if docs, _ := st.ListKbDocs("bob"); len(docs) != 1 || docs[0].ID != bobDoc.ID {
		t.Fatalf("bob docs = %+v, want single updated doc", docs)
	}
}

// 同 sourceRef 并发入库不炸：单条 Ingest 内 find→create/update 的竞窗口
// 可能双建（无唯一约束，后写胜出属定案行为），断言的是终态一致——每个
// doc 行的 chunk 行数恰为其 chunkCount，检索可用。
func TestIngestConcurrentSameSourceRef(t *testing.T) {
	emb := &fakeEmbed{tokens: 5, vecFn: func(string) []float32 { return []float32{1, 0} }}
	svc, st := newService(t, emb)

	const n = 8
	errs := make(chan error, n)
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		go func() {
			<-start
			_, _, err := svc.Ingest(context.Background(), "u1", "并发", "url", "https://race.md", repeat("并", 1000))
			errs <- err
		}()
	}
	close(start)
	for i := 0; i < n; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("concurrent ingest errored: %v", err)
		}
	}

	docs, err := st.ListKbDocs("u1")
	if err != nil {
		t.Fatal(err)
	}
	if len(docs) == 0 || len(docs) > n {
		t.Fatalf("docs = %d, want 1..%d", len(docs), n)
	}
	byDoc := map[string]int{}
	chunks, err := st.ListKbChunksAll()
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range chunks {
		byDoc[c.DocID]++
	}
	want := 0
	for _, d := range docs {
		if byDoc[d.ID] != d.ChunkCount {
			t.Fatalf("doc %s chunk rows = %d, chunkCount = %d", d.ID, byDoc[d.ID], d.ChunkCount)
		}
		want += d.ChunkCount
	}
	if len(chunks) != want {
		t.Fatalf("chunk rows = %d, want %d", len(chunks), want)
	}

	emb.qv = []float32{1, 0}
	hits, err := svc.Search(context.Background(), "u1", "任意", 100)
	if err != nil || len(hits) != want {
		t.Fatalf("hits = %d err = %v, want %d (index consistent with rows)", len(hits), err, want)
	}
}

// 原文落库：新建与重入更新两路径都把 content 存进 doc 行（rebuild 的
// 精确重建源）。
func TestIngestStoresContent(t *testing.T) {
	emb := &fakeEmbed{tokens: 5, vecFn: func(string) []float32 { return []float32{1, 0} }}
	svc, st := newService(t, emb)

	if _, _, err := svc.Ingest(context.Background(), "u1", "页", "url", "https://a.md", "第一版正文"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.Ingest(context.Background(), "u1", "页", "url", "https://a.md", "第二版正文"); err != nil {
		t.Fatal(err)
	}
	docs, err := st.ListKbDocs("u1")
	if err != nil || len(docs) != 1 || docs[0].Content != "第二版正文" {
		t.Fatalf("docs = %+v err = %v, want reingested content persisted", docs, err)
	}
}

// 原文重建：有 content 的文档按原文重切重嵌——doc id/content/createdAt
// 不变，chunk 行全换新，检索照常命中。
func TestRebuildFromStoredContent(t *testing.T) {
	emb := &fakeEmbed{tokens: 5, vecFn: func(string) []float32 { return []float32{1, 0} }}
	svc, st := newService(t, emb)

	content := repeat("段", 2000) // 3 块
	doc, _, err := svc.Ingest(context.Background(), "u1", "手册", "paste", "", content)
	if err != nil {
		t.Fatal(err)
	}
	before, err := st.ListKbChunksAll()
	if err != nil || len(before) != 3 {
		t.Fatalf("chunks before = %+v err = %v", before, err)
	}
	oldIDs := map[string]bool{}
	for _, c := range before {
		oldIDs[c.ID] = true
	}

	res, err := svc.Rebuild(context.Background(), "u1")
	if err != nil {
		t.Fatal(err)
	}
	if res.Rebuilt != 1 || res.Approximated != 0 || res.Dim != 2 {
		t.Fatalf("rebuild = %+v, want {1 0 2}", res)
	}

	docs, err := st.ListKbDocs("u1")
	if err != nil || len(docs) != 1 {
		t.Fatalf("docs = %+v err = %v", docs, err)
	}
	d := docs[0]
	if d.ID != doc.ID || d.Content != content || d.ChunkCount != 3 || !d.CreatedAt.Equal(doc.CreatedAt) {
		t.Fatalf("rebuilt doc = %+v, want same id/content/chunkCount/createdAt as %+v", d, doc)
	}
	after, err := st.ListKbChunksAll()
	if err != nil || len(after) != 3 {
		t.Fatalf("chunks after = %+v err = %v", after, err)
	}
	for _, c := range after {
		if oldIDs[c.ID] {
			t.Fatalf("chunk %s survived rebuild, want fresh rows", c.ID)
		}
		if c.DocID != doc.ID {
			t.Fatalf("chunk %s points at doc %s, want %s", c.ID, c.DocID, doc.ID)
		}
	}

	emb.qv = []float32{1, 0}
	hits, err := svc.Search(context.Background(), "u1", "任意", 10)
	if err != nil || len(hits) != 3 {
		t.Fatalf("hits = %d err = %v, want 3", len(hits), err)
	}
}

// 近似重建：无 content 的存量旧档按 seq 拼接 chunks 文本重切重嵌，计入
// approximated；content 不伪造（仍空），检索命中重建后的块。
func TestRebuildApproximatesLegacyDocs(t *testing.T) {
	emb := &fakeEmbed{tokens: 5, vecFn: func(string) []float32 { return []float32{1, 0} }}
	svc, st := newService(t, emb)
	if err := st.CreateKbDoc(&store.KbDoc{ID: "legacy", UserID: "u1", Title: "旧档", SourceType: "paste", ChunkCount: 2, CreatedAt: time.Now()},
		[]store.KbChunk{
			{ID: "lc0", DocID: "legacy", Seq: 0, Text: "第一段近似原文", Embedding: vecToBytes([]float32{1, 0}), CreatedAt: time.Now()},
			{ID: "lc1", DocID: "legacy", Seq: 1, Text: "第二段近似原文", Embedding: vecToBytes([]float32{0, 1}), CreatedAt: time.Now()},
		}); err != nil {
		t.Fatal(err)
	}

	res, err := svc.Rebuild(context.Background(), "u1")
	if err != nil {
		t.Fatal(err)
	}
	if res.Rebuilt != 1 || res.Approximated != 1 || res.Dim != 2 {
		t.Fatalf("rebuild = %+v, want {1 1 2}", res)
	}

	docs, err := st.ListKbDocs("u1")
	if err != nil || len(docs) != 1 || docs[0].ID != "legacy" || docs[0].Content != "" || docs[0].ChunkCount != 1 {
		t.Fatalf("docs = %+v err = %v, want legacy doc intact, no fabricated content", docs, err)
	}
	chunks, err := st.ListKbChunksAll()
	if err != nil || len(chunks) != 1 || chunks[0].ID == "lc0" {
		t.Fatalf("chunks = %+v err = %v, want one fresh row", chunks, err)
	}
	want := "第一段近似原文\n\n第二段近似原文"
	if chunks[0].Text != want {
		t.Fatalf("chunk text = %q, want joined %q", chunks[0].Text, want)
	}

	emb.qv = []float32{1, 0}
	hits, err := svc.Search(context.Background(), "u1", "任意", 4)
	if err != nil || len(hits) != 1 || hits[0].Text != want {
		t.Fatalf("hits = %+v err = %v", hits, err)
	}
}

// 维度重置后混维重建不炸：2 维入库两档（一篇现行有原文、一篇存量旧档）
// → 「换模型」切 4 维 → rebuild 先 ResetDim 再整库重嵌，两档分别精确/
// 近似重建成功且全库 4 维。mock 的维度强制与真 Embedder 同款：ResetDim
// 缺席则重嵌首批向量即报 dim changed——本测试即重置语义的负载证明。
func TestRebuildResetsDimForModelSwap(t *testing.T) {
	emb := &fakeEmbed{tokens: 5, vecFn: func(string) []float32 { return []float32{1, 0} }}
	svc, st := newService(t, emb)
	if _, _, err := svc.Ingest(context.Background(), "u", "现行档", "paste", "", "现行内容"); err != nil {
		t.Fatal(err)
	}
	if err := st.CreateKbDoc(&store.KbDoc{ID: "legacy", UserID: "u", Title: "存量旧档", SourceType: "paste", ChunkCount: 1, CreatedAt: time.Now()},
		[]store.KbChunk{{ID: "lc0", DocID: "legacy", Seq: 0, Text: "存量近似内容", Embedding: vecToBytes([]float32{0, 1}), CreatedAt: time.Now()}}); err != nil {
		t.Fatal(err)
	}

	emb.vecFn = func(string) []float32 { return []float32{1, 0, 0, 0} } // 换模型：2 维 → 4 维
	res, err := svc.Rebuild(context.Background(), "u")
	if err != nil {
		t.Fatal(err)
	}
	if res.Rebuilt != 2 || res.Approximated != 1 || res.Dim != 4 {
		t.Fatalf("rebuild = %+v, want {2 1 4}", res)
	}
	if emb.resets != 1 {
		t.Fatalf("ResetDim calls = %d, want 1", emb.resets)
	}

	emb.qv = []float32{1, 0, 0, 0}
	hits, err := svc.Search(context.Background(), "u", "任意", 10)
	if err != nil || len(hits) != 2 {
		t.Fatalf("hits = %+v err = %v, want both docs re-embedded at dim 4", hits, err)
	}
}

// rebuild 用户隔离：bob 重建只动 bob 的行——alice 的 chunk 行原样（同 id
// 同向量字节），双方检索各自可用。
func TestRebuildUserIsolation(t *testing.T) {
	emb := &fakeEmbed{tokens: 5, vecFn: func(string) []float32 { return []float32{1, 0} }}
	svc, st := newService(t, emb)

	aliceDoc, _, err := svc.Ingest(context.Background(), "alice", "Alice 档", "paste", "", "Alice 原文")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.Ingest(context.Background(), "bob", "Bob 档", "paste", "", "Bob 原文"); err != nil {
		t.Fatal(err)
	}
	aliceBefore, err := st.ListKbChunksByUser("alice")
	if err != nil || len(aliceBefore) != 1 {
		t.Fatalf("alice chunks = %+v err = %v", aliceBefore, err)
	}

	res, err := svc.Rebuild(context.Background(), "bob")
	if err != nil || res.Rebuilt != 1 || res.Approximated != 0 {
		t.Fatalf("bob rebuild = %+v err = %v", res, err)
	}
	aliceAfter, err := st.ListKbChunksByUser("alice")
	if err != nil || len(aliceAfter) != 1 ||
		aliceAfter[0].ID != aliceBefore[0].ID || string(aliceAfter[0].Embedding) != string(aliceBefore[0].Embedding) {
		t.Fatalf("alice chunks after bob's rebuild = %+v, want untouched %+v", aliceAfter, aliceBefore)
	}
	aliceDocs, err := st.ListKbDocs("alice")
	if err != nil || len(aliceDocs) != 1 || aliceDocs[0].ID != aliceDoc.ID || aliceDocs[0].ChunkCount != 1 {
		t.Fatalf("alice docs = %+v err = %v, want untouched", aliceDocs, err)
	}

	emb.qv = []float32{1, 0}
	for _, user := range []string{"alice", "bob"} {
		hits, err := svc.Search(context.Background(), user, "任意", 4)
		if err != nil || len(hits) != 1 {
			t.Fatalf("%s hits = %+v err = %v", user, hits, err)
		}
	}
}

// 空库 rebuild：零文档 → {0, 0, 0}，无 embed 调用；ResetDim 仍无条件执行
// （dim 记录清零），别人的索引原样。
func TestRebuildEmptyLibrary(t *testing.T) {
	emb := &fakeEmbed{tokens: 5, vecFn: func(string) []float32 { return []float32{1, 0} }}
	svc, _ := newService(t, emb)
	if _, _, err := svc.Ingest(context.Background(), "other", "别人的档", "paste", "", "别人的原文"); err != nil {
		t.Fatal(err)
	}
	callsBefore := emb.calls

	res, err := svc.Rebuild(context.Background(), "u1")
	if err != nil {
		t.Fatal(err)
	}
	if res.Rebuilt != 0 || res.Approximated != 0 || res.Dim != 0 {
		t.Fatalf("empty rebuild = %+v, want all zero", res)
	}
	if emb.resets != 1 || emb.calls != callsBefore {
		t.Fatalf("resets = %d embed calls delta = %d, want 1 and 0", emb.resets, emb.calls-callsBefore)
	}

	emb.qv = []float32{1, 0}
	hits, err := svc.Search(context.Background(), "other", "任意", 4)
	if err != nil || len(hits) != 1 {
		t.Fatalf("other hits = %+v err = %v, want corpus intact", hits, err)
	}
}

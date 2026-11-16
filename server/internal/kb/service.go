package kb

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/xycxmz/company-platform-v1/server/internal/store"
)

// kbUsageModel 是计量落账的 modelName（与素材 "material:<kind>" 同表同
// 仪表盘）。
const kbUsageModel = "kb:embedding"

// kbEmbedPrice 按 text-embedding-v3 档 0.0005 元/千 token 折算（待校准，
// 校准后改这两个常量即可）：1 token = 0.00005 分 →
// costCents = tokens * 5 / 100000（整除截断）。
const (
	kbEmbedPriceNumer = 5
	kbEmbedPriceDenom = 100000
)

// ErrEmbedding 包装上游 embedding 失败（HTTP 面映射 502，区别于 503 的
// 未配置与 5xx 的库错）。
var ErrEmbedding = errors.New("kb: embedding upstream error")

// Hit 是检索命中的一行（API 契约的 hits 元素）。
type Hit struct {
	DocID string  `json:"docId"`
	Title string  `json:"title"`
	Seq   int     `json:"seq"`
	Text  string  `json:"text"`
	Score float64 `json:"score"`
}

type chunkRec struct {
	seq  int
	text string
	vec  []float32
}

// docEntry 把文档标题与切块收在一处：检索命中需要 title，而文档不可变，
// 入索引时冗余一份免去查询回表。
type docEntry struct {
	title  string
	chunks []chunkRec // seq 升序（加载与入库都按序追加）
}

// Service 是知识库核心：持久化（store）+ embedding 客户端 + 内存索引
// （userID → docID → chunks）。索引建模为按用户嵌套的 map，用户隔离在
// 数据结构层面成立——检索只扫请求者自己的语料。启动全量加载（eager），
// 写路径（入库/删除）同步更新。
type Service struct {
	store  *store.Store
	embed  EmbedClient
	mu     sync.RWMutex
	byUser map[string]map[string]*docEntry
}

// NewService 构造并全量加载索引。返回的 Service 永远可用：加载失败时
// 带空索引返回 + err（调用方记日志降级——历史文档检索为空直到重启，
// 列表/删除/新入库不受影响）。
func NewService(st *store.Store, emb EmbedClient) (*Service, error) {
	s := &Service{store: st, embed: emb, byUser: map[string]map[string]*docEntry{}}
	docs, err := st.ListKbDocsAll()
	if err != nil {
		return s, err
	}
	chunks, err := st.ListKbChunksAll()
	if err != nil {
		return s, err
	}
	byDoc := make(map[string][]chunkRec, len(docs))
	for _, c := range chunks {
		vec, err := bytesToVec(c.Embedding)
		if err != nil {
			return s, fmt.Errorf("kb: load chunk %s: %w", c.ID, err)
		}
		byDoc[c.DocID] = append(byDoc[c.DocID], chunkRec{seq: c.Seq, text: c.Text, vec: vec})
	}
	for i := range docs {
		d := &docs[i]
		user, ok := s.byUser[d.UserID]
		if !ok {
			user = map[string]*docEntry{}
			s.byUser[d.UserID] = user
		}
		user[d.ID] = &docEntry{title: d.Title, chunks: byDoc[d.ID]}
	}
	return s, nil
}

// Ingest 同步入库：切块 → embedding → 单事务落库 → 内存索引追加。
// 原文（≤1MB，入库边界校验）随 doc 行落 content 列，新建与重入更新两路
// 径都存，供 rebuild 精确重切。sourceRef 非空且同用户已有同 ref 文档 →
// 重入更新（保 doc id 与 created_at，删旧 chunks 换重切重嵌的新块），
// updated=true；否则新建，updated=false（空 ref 不去重，重贴=新文档）。
// 半成品清理靠顺序与事务：embedding 失败时尚未落库；落库失败时事务回滚
// 两侧都不留行；索引只在落库成功后追加（内存操作不会失败）。
func (s *Service) Ingest(ctx context.Context, userID, title, sourceType, sourceRef, content string) (*store.KbDoc, bool, error) {
	texts := chunkText(content)
	vecs, tokens, err := s.embed.Embed(ctx, texts)
	if err != nil {
		if errors.Is(err, ErrNotConfigured) {
			return nil, false, err
		}
		return nil, false, fmt.Errorf("%w: %v", ErrEmbedding, err)
	}
	if len(vecs) != len(texts) {
		return nil, false, fmt.Errorf("%w: got %d vectors for %d chunks", ErrEmbedding, len(vecs), len(texts))
	}
	now := time.Now()

	if sourceRef != "" {
		existing, ferr := s.store.FindKbDocBySourceRef(userID, sourceRef)
		switch {
		case ferr == nil:
			existing.Title = title
			existing.Content = content
			existing.ChunkCount = len(texts)
			chunks, cerr := newChunks(existing.ID, texts, vecs, now)
			if cerr != nil {
				return nil, false, cerr
			}
			if uerr := s.store.UpdateKbDoc(existing, chunks); uerr != nil {
				return nil, false, uerr
			}
			s.indexSet(userID, existing.ID, title, texts, vecs)
			s.meterUsage(userID, tokens)
			return existing, true, nil
		case !errors.Is(ferr, gorm.ErrRecordNotFound):
			return nil, false, ferr
		}
	}

	docID, err := uuid.NewRandom()
	if err != nil {
		return nil, false, err
	}
	doc := &store.KbDoc{
		ID: docID.String(), UserID: userID, Title: title,
		SourceType: sourceType, SourceRef: sourceRef,
		Content: content, ChunkCount: len(texts), CreatedAt: now,
	}
	chunks, err := newChunks(doc.ID, texts, vecs, now)
	if err != nil {
		return nil, false, err
	}
	if err := s.store.CreateKbDoc(doc, chunks); err != nil {
		return nil, false, err
	}

	s.indexSet(userID, doc.ID, title, texts, vecs)
	s.meterUsage(userID, tokens)
	return doc, false, nil
}

// newChunks 按切好的 texts + 向量组装落库行（新建与重入更新同构）。
func newChunks(docID string, texts []string, vecs [][]float32, now time.Time) ([]store.KbChunk, error) {
	chunks := make([]store.KbChunk, len(texts))
	for i := range texts {
		id, err := uuid.NewRandom()
		if err != nil {
			return nil, err
		}
		chunks[i] = store.KbChunk{
			ID: id.String(), DocID: docID, Seq: i,
			Text: texts[i], Embedding: vecToBytes(vecs[i]), CreatedAt: now,
		}
	}
	return chunks, nil
}

// indexSet 落库成功后同步内存索引；新建与重入更新同 docID 直接覆写，
// 旧 entry 连同旧 chunks 一并被替换。
func (s *Service) indexSet(userID, docID, title string, texts []string, vecs [][]float32) {
	s.mu.Lock()
	user, ok := s.byUser[userID]
	if !ok {
		user = map[string]*docEntry{}
		s.byUser[userID] = user
	}
	recs := make([]chunkRec, len(texts))
	for i := range texts {
		recs[i] = chunkRec{seq: i, text: texts[i], vec: vecs[i]}
	}
	user[docID] = &docEntry{title: title, chunks: recs}
	s.mu.Unlock()
}

// Search 先 embed 查询再对本用户语料做余弦 top-k（score 降序，平分按
// docId、seq 决胜保稳定）。空语料直接返回空，不花 embedding 调用。
func (s *Service) Search(ctx context.Context, userID, q string, k int) ([]Hit, error) {
	s.mu.RLock()
	empty := len(s.byUser[userID]) == 0
	s.mu.RUnlock()
	if empty {
		return []Hit{}, nil
	}
	vecs, tokens, err := s.embed.Embed(ctx, []string{q})
	if err != nil {
		if errors.Is(err, ErrNotConfigured) {
			return nil, err
		}
		return nil, fmt.Errorf("%w: %v", ErrEmbedding, err)
	}
	if len(vecs) != 1 {
		return nil, fmt.Errorf("%w: got %d vectors for query", ErrEmbedding, len(vecs))
	}
	s.meterUsage(userID, tokens)

	qv := vecs[0]
	s.mu.RLock()
	defer s.mu.RUnlock()
	var hits []Hit
	skipped := 0
	for docID, entry := range s.byUser[userID] {
		for _, c := range entry.chunks {
			if len(c.vec) != len(qv) {
				skipped++ // 模型换维的存量块：跳过而非报错（重建索引 v2 再议）
				continue
			}
			hits = append(hits, Hit{
				DocID: docID, Title: entry.title,
				Seq: c.seq, Text: c.text, Score: cosine(qv, c.vec),
			})
		}
	}
	if skipped > 0 {
		log.Printf("kb: search skipped %d chunks whose dim differs from query (%d)", skipped, len(qv))
	}
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].Score != hits[j].Score {
			return hits[i].Score > hits[j].Score
		}
		if hits[i].DocID != hits[j].DocID {
			return hits[i].DocID < hits[j].DocID
		}
		return hits[i].Seq < hits[j].Seq
	})
	if len(hits) > k {
		hits = hits[:k]
	}
	return hits, nil
}

// Delete 级联删库行并从内存索引剔除；不存在或非本人 → gorm.ErrRecordNotFound。
func (s *Service) Delete(userID, docID string) error {
	if err := s.store.DeleteKbDocCascade(docID, userID); err != nil {
		return err
	}
	s.mu.Lock()
	if user := s.byUser[userID]; user != nil {
		delete(user, docID)
	}
	s.mu.Unlock()
	return nil
}

// RebuildResult 是 rebuild 的响应形状（API 契约 {rebuilt, approximated,
// dim}，camelCase 由 struct tag 承担）。
type RebuildResult struct {
	Rebuilt      int `json:"rebuilt"`
	Approximated int `json:"approximated"`
	Dim          int `json:"dim"`
}

// Rebuild 全量重建该用户索引（R11-K1）：清 Embedder 维度记录（换
// embedding 模型后整库重嵌，新维度重新首录）→ 清该用户内存索引 → 遍历
// 文档逐个重切重嵌、覆写库行与索引（保 doc id/created_at/content）。
// 有原文（K1 起入库落 content 列）按原文精确重建；无原文的存量旧档按
// seq 拼接 chunks 文本近似重建（滑窗重叠区文本会重复，计入 approximated）。
// 清索引到逐文档回填之间该用户检索返回空（单用户可接受，设计已拍板）。
// 逐文档覆写是幂等单元：中途失败已完成的文档保持重建态，重试继续收敛。
func (s *Service) Rebuild(ctx context.Context, userID string) (RebuildResult, error) {
	var res RebuildResult
	docs, err := s.store.ListKbDocs(userID)
	if err != nil {
		return res, err
	}
	// 存量旧档（无 content 列值）的重建源 = chunks 文本按 seq 拼接。
	legacy := make(map[string][]string, len(docs))
	for i := range docs {
		if docs[i].Content == "" {
			legacy[docs[i].ID] = nil
		}
	}
	if len(legacy) > 0 {
		chunks, err := s.store.ListKbChunksByUser(userID)
		if err != nil {
			return res, err
		}
		for _, c := range chunks {
			if _, ok := legacy[c.DocID]; ok {
				legacy[c.DocID] = append(legacy[c.DocID], c.Text)
			}
		}
	}

	s.embed.ResetDim()
	s.mu.Lock()
	delete(s.byUser, userID)
	s.mu.Unlock()

	now := time.Now()
	for i := range docs {
		d := &docs[i]
		approx := d.Content == ""
		src := d.Content
		if approx {
			src = strings.Join(legacy[d.ID], "\n\n")
		}
		texts := chunkText(src)
		vecs, tokens, err := s.embed.Embed(ctx, texts)
		if err != nil {
			if errors.Is(err, ErrNotConfigured) {
				return res, err
			}
			return res, fmt.Errorf("%w: rebuild doc %s (%s): %v", ErrEmbedding, d.ID, d.Title, err)
		}
		if len(vecs) != len(texts) {
			return res, fmt.Errorf("%w: rebuild doc %s: got %d vectors for %d chunks", ErrEmbedding, d.ID, len(vecs), len(texts))
		}
		d.ChunkCount = len(texts)
		chunks, err := newChunks(d.ID, texts, vecs, now)
		if err != nil {
			return res, err
		}
		if err := s.store.UpdateKbDoc(d, chunks); err != nil {
			return res, fmt.Errorf("kb: rebuild doc %s (%s): %w", d.ID, d.Title, err)
		}
		s.indexSet(userID, d.ID, d.Title, texts, vecs)
		s.meterUsage(userID, tokens)
		res.Rebuilt++
		if approx {
			res.Approximated++
		}
	}
	res.Dim = s.embed.Dim()
	return res, nil
}

// cosine 是普通循环的余弦相似度（float64 累加防大向量精度损失；零向量
// 记 0 分）。
func cosine(a, b []float32) float64 {
	var dot, na, nb float64
	for i := range a {
		dot += float64(a[i]) * float64(b[i])
		na += float64(a[i]) * float64(a[i])
		nb += float64(b[i]) * float64(b[i])
	}
	if na == 0 || nb == 0 {
		return 0
	}
	return dot / (math.Sqrt(na) * math.Sqrt(nb))
}

// meterUsage 落一条当日用量（tokens×单价）；失败只记日志，不影响主流程
// （与素材计量同口径）。
func (s *Service) meterUsage(userID string, tokens int64) {
	if tokens <= 0 {
		return
	}
	err := s.store.AddUsage(&store.UsageDaily{
		Date:      time.Now().Format("2006-01-02"),
		UserID:    userID,
		ModelName: kbUsageModel,
		TokensIn:  tokens,
		CostCents: tokens * kbEmbedPriceNumer / kbEmbedPriceDenom,
		Requests:  1,
	})
	if err != nil {
		log.Printf("kb: meter usage: %v", err)
	}
}

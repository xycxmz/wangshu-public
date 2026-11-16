package kb

import (
	"fmt"
	"math"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/xycxmz/company-platform-v1/server/internal/store"
)

// PG16 真库探针（一次性容器，探后清理）：默认跳过，设 KB_PG_PROBE=1
// 跑。验证生产同款镜像上 KbDoc/KbChunk 的 DDL（embedding 列 bytea、
// R11-K1 content 列对老表自动加列且存量行读为空串）、向量字节落读一致
// 性（BYTEA 不做任何字符集改写）、float32 位级 roundtrip、content 原文
// 落读与 ListKbChunksByUser join，最后级联删除清场。
func TestPG16ByteAFloatRoundtripProbe(t *testing.T) {
	if os.Getenv("KB_PG_PROBE") == "" {
		t.Skip("set KB_PG_PROBE=1 to run the one-off postgres:16-alpine container probe")
	}

	name := fmt.Sprintf("kb-pgprobe-%d", time.Now().UnixNano())
	out, err := exec.Command("docker", "run", "-d", "--rm", "--name", name,
		"-e", "POSTGRES_USER=probe", "-e", "POSTGRES_PASSWORD=probe", "-e", "POSTGRES_DB=probe",
		"-p", "127.0.0.1::5432", "postgres:16-alpine").CombinedOutput()
	if err != nil {
		t.Fatalf("docker run: %v: %s", err, out)
	}
	t.Cleanup(func() {
		if r := exec.Command("docker", "rm", "-f", name).Run(); r != nil {
			t.Logf("cleanup container %s: %v", name, r)
		}
	})

	portOut, err := exec.Command("docker", "port", name, "5432/tcp").CombinedOutput()
	if err != nil || len(strings.TrimSpace(string(portOut))) == 0 {
		t.Fatalf("docker port: %v: %s", err, portOut)
	}
	_, port, ok := strings.Cut(strings.TrimSpace(string(portOut)), ":")
	if !ok || port == "" {
		t.Fatalf("cannot parse mapped port from %q", portOut)
	}
	dsn := fmt.Sprintf("postgres://probe:probe@127.0.0.1:%s/probe?sslmode=disable", port)

	var st *store.Store
	deadline := time.Now().Add(60 * time.Second)
	for {
		st, err = store.Open(dsn)
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("postgres never became ready: %v", err)
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Cleanup(func() { _ = st.Close() })

	db, _ := st.SQLDB()
	// 老库形态先行：R11-K1 之前建的 kb_docs（无 content 列）带一行存量
	// 数据——AutoMigrate 的生产迁移路径就是给这张表加列。
	if _, err := db.Exec(`CREATE TABLE kb_docs (
		id varchar(36) PRIMARY KEY,
		user_id varchar(64),
		title varchar(255),
		source_type varchar(8),
		source_ref varchar(1024),
		chunk_count bigint,
		created_at timestamptz
	)`); err != nil {
		t.Fatalf("create old-shape kb_docs: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO kb_docs (id, user_id, title, source_type, source_ref, chunk_count, created_at)
		VALUES ('probe-legacy', 'probe-user', '存量旧档', 'paste', '', 1, now())`); err != nil {
		t.Fatalf("seed legacy row: %v", err)
	}

	if err := st.AutoMigrate(); err != nil {
		t.Fatalf("AutoMigrate on PG16 (old-shape kb_docs): %v", err)
	}

	// 列类型断言：embedding 必须落在 bytea（BYTEA 一致性的前提）；content
	// 列必须已对老表加出且为 text。
	var colType string
	if err := db.QueryRow(`SELECT data_type FROM information_schema.columns
		WHERE table_name = 'kb_chunks' AND column_name = 'embedding'`).Scan(&colType); err != nil {
		t.Fatalf("read column type: %v", err)
	}
	if colType != "bytea" {
		t.Fatalf("kb_chunks.embedding column type = %q, want bytea", colType)
	}
	if err := db.QueryRow(`SELECT data_type FROM information_schema.columns
		WHERE table_name = 'kb_docs' AND column_name = 'content'`).Scan(&colType); err != nil {
		t.Fatalf("content column missing after AutoMigrate: %v", err)
	}
	if colType != "text" {
		t.Fatalf("kb_docs.content column type = %q, want text", colType)
	}

	// 落读：字节一致 + float32 位级一致（含次正规数与最大值等硬例）。
	vecA := []float32{1.5, -2.25, 0.1, math.Float32frombits(1), math.MaxFloat32, -0, 3.4028235e38}
	vecB := []float32{0, 0, 0}
	now := time.Now()
	content := "第一段原文。\n\n第二段原文（中文、换行与 \"引号\" 混排）。"
	doc := &store.KbDoc{ID: "probe-doc", UserID: "probe-user", Title: "探针", SourceType: "paste", Content: content, ChunkCount: 2, CreatedAt: now}
	chunks := []store.KbChunk{
		{ID: "probe-c0", DocID: doc.ID, Seq: 0, Text: "第一块", Embedding: vecToBytes(vecA), CreatedAt: now},
		{ID: "probe-c1", DocID: doc.ID, Seq: 1, Text: "第二块", Embedding: vecToBytes(vecB), CreatedAt: now},
	}
	if err := st.CreateKbDoc(doc, chunks); err != nil {
		t.Fatalf("create on PG16: %v", err)
	}

	docs, err := st.ListKbDocsAll()
	if err != nil || len(docs) != 2 {
		t.Fatalf("docs = %+v err = %v", docs, err)
	}
	byID := map[string]store.KbDoc{}
	for _, d := range docs {
		byID[d.ID] = d
	}
	// 存量行 content 读为空串（近似重建的判据）；新行原文逐字一致。
	if l, ok := byID["probe-legacy"]; !ok || l.Content != "" {
		t.Fatalf("legacy doc = %+v ok=%v, want content empty string", l, ok)
	}
	if p, ok := byID[doc.ID]; !ok || p.Content != content || p.ChunkCount != 2 {
		t.Fatalf("probe doc = %+v ok=%v, want content roundtrip exact", p, ok)
	}
	got, err := st.ListKbChunksAll()
	if err != nil || len(got) != 2 {
		t.Fatalf("chunks = %+v err = %v", got, err)
	}
	// ListKbChunksByUser（rebuild 近似路径的 join）在 PG 上按人过滤。
	own, err := st.ListKbChunksByUser("probe-user")
	if err != nil || len(own) != 2 || own[0].DocID != doc.ID || own[1].DocID != doc.ID || own[0].Seq != 0 || own[1].Seq != 1 {
		t.Fatalf("chunks by user = %+v err = %v", own, err)
	}
	if other, _ := st.ListKbChunksByUser("nobody"); len(other) != 0 {
		t.Fatalf("chunks by other user = %+v, want none", other)
	}
	if string(got[0].Embedding) != string(vecToBytes(vecA)) {
		t.Fatalf("BYTEA write/read mismatch: %d bytes vs %d", len(got[0].Embedding), 4*len(vecA))
	}
	back, err := bytesToVec(got[0].Embedding)
	if err != nil {
		t.Fatal(err)
	}
	for i := range vecA {
		if math.Float32bits(back[i]) != math.Float32bits(vecA[i]) {
			t.Fatalf("float roundtrip bit %d: %#08x != %#08x", i, math.Float32bits(back[i]), math.Float32bits(vecA[i]))
		}
	}
	if v, _ := bytesToVec(got[1].Embedding); len(v) != 3 || v[0] != 0 {
		t.Fatalf("zero vector roundtrip = %v", v)
	}

	if err := st.DeleteKbDocCascade(doc.ID, doc.UserID); err != nil {
		t.Fatalf("cascade delete on PG16: %v", err)
	}
	if n, _ := st.ListKbChunksAll(); len(n) != 0 {
		t.Fatalf("cascade left %d chunks", len(n))
	}
	t.Logf("pg16 probe ok: bytea column, content column added on old-shape table, %d-byte vector roundtrip bit-exact, legacy row content empty, join filtered, cascade clean", len(got[0].Embedding))
}

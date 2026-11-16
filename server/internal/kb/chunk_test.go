package kb

import (
	"strings"
	"testing"
)

// assertChunkInvariants 校验切块的对外契约：每块 ≤800 rune、非末块与前一
// 块精确重叠 80、按重叠步进走完全文（无内容丢失）。pos 模拟滑窗推进：
// 每块起点 = 上一块终点 - 80。
func assertChunkInvariants(t *testing.T, text string, chunks []string) {
	t.Helper()
	runes := []rune(text)
	pos := 0
	for i, ch := range chunks {
		n := len([]rune(ch))
		if n > chunkMaxRunes {
			t.Fatalf("chunk %d len %d exceeds cap %d", i, n, chunkMaxRunes)
		}
		if pos+n > len(runes) || string(runes[pos:pos+n]) != ch {
			t.Fatalf("chunk %d not at window [%d,%d) of source", i, pos, pos+n)
		}
		if i == len(chunks)-1 {
			if pos+n != len(runes) {
				t.Fatalf("last chunk ends at %d, want %d (content lost)", pos+n, len(runes))
			}
			return
		}
		pos += n - chunkOverlap
	}
	if len(chunks) == 0 && len(runes) > 0 {
		t.Fatalf("no chunks for non-empty text")
	}
}

func repeatRune(r string, n int) string {
	return strings.Repeat(r, n)
}

func TestChunkTextEmptyAndBlank(t *testing.T) {
	for _, in := range []string{"", "   ", "\n\n\n\n", " \n\n \n\n\t"} {
		if got := chunkText(in); got != nil {
			t.Fatalf("chunkText(%q) = %v, want nil", in, got)
		}
	}
}

func TestChunkTextSingleParagraph(t *testing.T) {
	text := "望舒是自托管工作台。"
	got := chunkText(text)
	if len(got) != 1 || got[0] != text {
		t.Fatalf("got %q, want single chunk of the text", got)
	}
}

// 精确 800：无边界且恰好等于上限，应整段一块，不人为拆分。
func TestChunkTextExact800(t *testing.T) {
	text := repeatRune("永", 800)
	got := chunkText(text)
	if len(got) != 1 || len([]rune(got[0])) != 800 {
		t.Fatalf("got %d chunks, want 1 of 800 runes", len(got))
	}
}

// 无边界超长文本：硬 800 切、步进 720（重叠 80）。2000 rune →
// [0,800)+[720,1520)+[1440,2000) 共 3 块。
func TestChunkTextLongUnbrokenWindow(t *testing.T) {
	text := repeatRune("甲", 2000)
	got := chunkText(text)
	if len(got) != 3 {
		t.Fatalf("got %d chunks, want 3", len(got))
	}
	assertChunkInvariants(t, text, got)
	if !strings.HasPrefix(got[1], got[0][720:]) {
		t.Fatalf("chunk 2 must open with the 80-rune tail of chunk 1")
	}
}

// 超长段（5000 rune）依旧只受硬上限与重叠约束。
func TestChunkTextOversizedParagraph(t *testing.T) {
	text := repeatRune("乙", 5000)
	got := chunkText(text)
	assertChunkInvariants(t, text, got)
	if len(got) != 7 {
		t.Fatalf("got %d chunks, want 7 (800 window, 720 stride)", len(got))
	}
}

// 塞得进上限就整段收尾：602 rune 双段、606 rune 带小尾巴，都是 1 块，
// 不产 85 rune 的退化尾块。
func TestChunkTextSmallDocSingleChunk(t *testing.T) {
	a, b := repeatRune("子", 300), repeatRune("丑", 300)
	for _, text := range []string{a + "\n\n" + b, repeatRune("寅", 600) + "\n\n结论短段"} {
		got := chunkText(text)
		if len(got) != 1 || got[0] != text {
			t.Fatalf("got %d chunks for %d runes, want the whole text in one",
				len(got), len([]rune(text)))
		}
	}
}

// 段落边界优先（必须切时）：7 段 ×285 rune，总长 2007 超上限——每个
// 非末块都收在 \n\n 边界上；同长无边界文本则硬切 800（对照）。
func TestChunkTextPrefersParagraphBoundary(t *testing.T) {
	var paras []string
	for i := 0; i < 7; i++ {
		paras = append(paras, repeatRune(string(rune('午'+i)), 285))
	}
	text := strings.Join(paras, "\n\n")
	got := chunkText(text)
	assertChunkInvariants(t, text, got)
	if len(got) < 5 {
		t.Fatalf("got %d chunks, want ≥5 forced splits", len(got))
	}
	for i := 0; i < len(got)-1; i++ {
		if !strings.HasSuffix(got[i], "\n\n") {
			t.Fatalf("non-final chunk %d must end on a paragraph boundary", i)
		}
	}

	// 对照：无边界等长文本第一块恰好硬切 800。
	plain := chunkText(repeatRune("未", 2007))
	if len(plain) == 0 || len([]rune(plain[0])) != chunkMaxRunes {
		t.Fatalf("boundary-less text must hard-cut at %d, first chunk %d runes",
			chunkMaxRunes, len([]rune(plain[0])))
	}
}

// 空段与首尾空白被清洗后再切：内容不丢、块内无空段。
func TestChunkTextDropsBlankParagraphs(t *testing.T) {
	got := chunkText("  a  \n\n\n\n\n\nb\n\n  \n\n c ")
	want := []string{"a\n\nb\n\nc"}
	if len(got) != 1 || got[0] != want[0] {
		t.Fatalf("got %q, want %q", got, want[0])
	}
}

// 多段长文：全部不变量成立（≤800、重叠 80、覆盖到尾）。
func TestChunkTextMultiParagraphInvariants(t *testing.T) {
	var paras []string
	for i := 0; i < 20; i++ {
		paras = append(paras, repeatRune(string(rune('丙'+i%20)), 100))
	}
	text := strings.Join(paras, "\n\n")
	got := chunkText(text)
	assertChunkInvariants(t, text, got)
	if len(got) < 2 {
		t.Fatalf("2038-rune text must split, got %d chunks", len(got))
	}
}

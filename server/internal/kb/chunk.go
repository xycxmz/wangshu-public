// Package kb 实现知识库（R9-D2）：段落感知切块、DashScope embedding
// 客户端、内存余弦索引与 /api/v1/kb HTTP 面。
package kb

import "strings"

const (
	chunkTargetRunes = 500 // 目标块长（rune）
	chunkMaxRunes    = 800 // 硬上限：任何块不得超过
	chunkOverlap     = 80  // 相邻块重叠（rune）
)

// chunkText 把正文切成检索块：段落感知滑窗。剩余文本塞得进上限
// （≤800 rune）就整段收尾；必须切时优先 \n\n 边界——目标内取最后一个
// 边界，目标与上限之间取最靠近目标的边界——无边界连续文本按 800 硬
// 切、步进 720（重叠 80）。空白正文返回 nil。纯函数，可独立单测。
func chunkText(text string) []string {
	paras := make([]string, 0, 16)
	for _, p := range strings.Split(text, "\n\n") {
		if p = strings.TrimSpace(p); p != "" {
			paras = append(paras, p)
		}
	}
	if len(paras) == 0 {
		return nil
	}
	runes := []rune(strings.Join(paras, "\n\n"))

	var chunks []string
	start := 0
	for start < len(runes) {
		cut := len(runes)
		if len(runes)-start > chunkMaxRunes {
			// 边界必须越过重叠区（cut > start+80），否则相邻块退化为
			// 纯重叠副本；三分支都保证 cut ≤ start+800。
			floor := start + chunkOverlap
			target := start + chunkTargetRunes
			if b := lastBoundaryEnd(runes, target, floor); b > 0 {
				cut = b
			} else if b := firstBoundaryEnd(runes, target+1, start+chunkMaxRunes); b > 0 {
				cut = b
			} else {
				cut = start + chunkMaxRunes
			}
		}
		chunks = append(chunks, string(runes[start:cut]))
		if cut >= len(runes) {
			break
		}
		start = cut - chunkOverlap
	}
	return chunks
}

// lastBoundaryEnd 在 (floor, hi] 内找最后一个 \n\n 边界的结束位（第二个
// 换行后一位）；找不到返回 -1。
func lastBoundaryEnd(runes []rune, hi, floor int) int {
	for i := min(hi, len(runes)); i > floor; i-- {
		if runes[i-1] == '\n' && runes[i-2] == '\n' {
			return i
		}
	}
	return -1
}

// firstBoundaryEnd 在 [lo, hi] 内找第一个 \n\n 边界的结束位；找不到返回 -1。
func firstBoundaryEnd(runes []rune, lo, hi int) int {
	for i := max(lo, 2); i <= hi; i++ {
		if runes[i-1] == '\n' && runes[i-2] == '\n' {
			return i
		}
	}
	return -1
}

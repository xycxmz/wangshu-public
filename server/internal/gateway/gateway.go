// Package gateway proxies OpenAI-compatible chat completions to hosted
// models: it rewrites the model id, injects stream options, relays the
// response byte-for-byte, and meters usage into the store.
package gateway

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/xycxmz/company-platform-v1/server/internal/auth"
	"github.com/xycxmz/company-platform-v1/server/internal/auth/acauth"
	"github.com/xycxmz/company-platform-v1/server/internal/store"
)

// upstreamTimeout bounds one proxied request end to end; upstreamDial bounds
// connection setup only, so an open stream is never cut short at 10s.
const (
	upstreamTimeout = 120 * time.Second
	upstreamDial    = 10 * time.Second
)

type Handler struct {
	store  *store.Store
	client *http.Client
}

func New(st *store.Store) *Handler {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = (&net.Dialer{Timeout: upstreamDial}).DialContext
	return &Handler{
		store:  st,
		client: &http.Client{Timeout: upstreamTimeout, Transport: transport},
	}
}

// Register mounts POST /chat/completions on the auth-protected group.
func (h *Handler) Register(rg *gin.RouterGroup) {
	rg.POST("/chat/completions", h.handleChat)
}

// chatMessage keeps content raw: the wire format allows a plain string or a
// multimodal parts array, and the hub never rewrites message bodies.
type chatMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

type contentPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type chatRequest struct {
	Model     string        `json:"model"`
	Stream    bool          `json:"stream"`
	SessionID string        `json:"session_id"`
	Messages  []chatMessage `json:"messages"`
}

// lastUserStoredContent returns what recordTurn persists for the final user
// message (R9-A): a plain string stays a string; a vision parts array is
// stored as its canonical JSON serialization, which readers decode back via
// store.DecodeContentParts. Any other array shape degrades to the flattened
// text items. The upstream forwarding path is untouched (raw passthrough).
func (r *chatRequest) lastUserStoredContent() string {
	for i := len(r.Messages) - 1; i >= 0; i-- {
		if r.Messages[i].Role != "user" {
			continue
		}
		raw := r.Messages[i].Content
		var s string
		if json.Unmarshal(raw, &s) == nil {
			return s
		}
		if parts, ok := store.DecodeContentParts(string(raw)); ok {
			if enc, err := store.EncodeContentParts(parts); err == nil {
				return enc
			}
		}
		var loose []contentPart
		if json.Unmarshal(raw, &loose) == nil {
			texts := make([]string, 0, len(loose))
			for _, p := range loose {
				if p.Type == "text" {
					texts = append(texts, p.Text)
				}
			}
			return strings.Join(texts, "\n")
		}
		return ""
	}
	return ""
}

type usageStats struct {
	PromptTokens     int64 `json:"prompt_tokens"`
	CompletionTokens int64 `json:"completion_tokens"`
}

type completionResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Usage *usageStats `json:"usage"`
}

type streamChunk struct {
	Choices []struct {
		Delta struct {
			Content string `json:"content"`
		} `json:"delta"`
	} `json:"choices"`
	Usage *usageStats `json:"usage"`
}

func (h *Handler) handleChat(c *gin.Context) {
	userID := c.MustGet(auth.ClaimsKey).(*acauth.Claims).UserID()

	raw, err := io.ReadAll(c.Request.Body)
	if err != nil {
		errJSON(c, http.StatusBadRequest, "BAD_REQUEST", "cannot read request body")
		return
	}
	var fields chatRequest
	if err := json.Unmarshal(raw, &fields); err != nil {
		errJSON(c, http.StatusBadRequest, "BAD_REQUEST", "body must be a JSON object")
		return
	}
	var fwd map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fwd); err != nil {
		errJSON(c, http.StatusBadRequest, "BAD_REQUEST", "body must be a JSON object")
		return
	}

	if strings.HasPrefix(fields.Model, "byok:") {
		errJSON(c, http.StatusBadRequest, "BYOK_NOT_SUPPORTED",
			"BYOK requests go direct from the client; hub only proxies hosted models")
		return
	}
	m, err := h.store.EnabledHostedModel(fields.Model)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		errJSON(c, http.StatusNotFound, "MODEL_NOT_FOUND", "model "+fields.Model+" is not hosted or enabled")
		return
	}
	if err != nil {
		log.Printf("gateway: lookup model %q: %v", fields.Model, err)
		errJSON(c, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}

	delete(fwd, "session_id")
	upstreamName := m.UpstreamModel
	if upstreamName == "" {
		upstreamName = m.Name
	}
	nameJSON, err := json.Marshal(upstreamName)
	if err != nil {
		errJSON(c, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	fwd["model"] = nameJSON
	if fields.Stream {
		fwd["stream_options"] = json.RawMessage(`{"include_usage":true}`)
	}
	payload, err := json.Marshal(fwd)
	if err != nil {
		log.Printf("gateway: encode upstream request: %v", err)
		errJSON(c, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}

	upstreamURL := strings.TrimRight(m.BaseURL, "/") + "/chat/completions"
	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, upstreamURL, bytes.NewReader(payload))
	if err != nil {
		log.Printf("gateway: build request %s: %v", upstreamURL, err)
		errJSON(c, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+m.APIKey)

	resp, err := h.client.Do(req)
	if err != nil {
		log.Printf("gateway: upstream %s: %v", upstreamURL, err)
		errJSON(c, http.StatusBadGateway, "BAD_GATEWAY", "upstream request failed")
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		h.pipeError(c, resp)
		return
	}
	if fields.Stream {
		h.proxyStream(c, userID, m, &fields, resp)
		return
	}
	h.proxyFull(c, userID, m, &fields, resp)
}

// pipeError relays an upstream failure verbatim, body capped at 4KB so a
// chatty upstream cannot balloon hub memory.
func (h *Handler) pipeError(c *gin.Context, resp *http.Response) {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	c.Data(resp.StatusCode, resp.Header.Get("Content-Type"), body)
}

func (h *Handler) proxyFull(c *gin.Context, userID string, m *store.HostedModel, fields *chatRequest, resp *http.Response) {
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Printf("gateway: read upstream body: %v", err)
		errJSON(c, http.StatusBadGateway, "BAD_GATEWAY", "upstream response unreadable")
		return
	}
	c.Data(resp.StatusCode, resp.Header.Get("Content-Type"), body)

	var cr completionResponse
	_ = json.Unmarshal(body, &cr)
	reply := ""
	if len(cr.Choices) > 0 {
		reply = cr.Choices[0].Message.Content
	}
	h.recordTurn(userID, m, fields, reply, cr.Usage)
}

// proxyStream relays SSE line by line with an immediate flush, keeping the
// last usage object seen and the concatenated delta content for metering.
func (h *Handler) proxyStream(c *gin.Context, userID string, m *store.HostedModel, fields *chatRequest, resp *http.Response) {
	c.Header("Content-Type", resp.Header.Get("Content-Type"))
	c.Status(resp.StatusCode)
	flusher, canFlush := c.Writer.(http.Flusher)

	var content strings.Builder
	var usage *usageStats
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for sc.Scan() {
		line := sc.Bytes()
		if _, err := c.Writer.Write(line); err != nil {
			break
		}
		if _, err := c.Writer.WriteString("\n"); err != nil {
			break
		}
		if canFlush {
			flusher.Flush()
		}
		payload, ok := dataPayload(line)
		if !ok {
			continue
		}
		if string(payload) == "[DONE]" {
			break
		}
		var chunk streamChunk
		if json.Unmarshal(payload, &chunk) != nil {
			continue
		}
		for _, ch := range chunk.Choices {
			content.WriteString(ch.Delta.Content)
		}
		if chunk.Usage != nil {
			usage = chunk.Usage
		}
	}
	if err := sc.Err(); err != nil {
		log.Printf("gateway: stream read: %v", err)
	}
	h.recordTurn(userID, m, fields, content.String(), usage)
}

// recordTurn meters one 2xx turn: the usage row, plus for an owned session
// the user/assistant message pair (turn tokens ride on the assistant row).
func (h *Handler) recordTurn(userID string, m *store.HostedModel, fields *chatRequest, assistantText string, usage *usageStats) {
	in, out := int64(0), int64(0)
	if usage != nil {
		in, out = usage.PromptTokens, usage.CompletionTokens
	} else {
		// Estimation when upstream reports no usage: reply rune count / 4, applied to both directions.
		n := int64(utf8.RuneCountInString(assistantText) / 4)
		in, out = n, n
	}
	cost := turnCostCents(in, out, m.PriceInPer1K, m.PriceOutPer1K)

	if err := h.store.AddUsage(&store.UsageDaily{
		Date:      time.Now().Format("2006-01-02"), // local-calendar day by design
		UserID:    userID,
		ModelName: m.Name,
		TokensIn:  in,
		TokensOut: out,
		CostCents: cost,
		Requests:  1,
	}); err != nil {
		log.Printf("gateway: add usage: %v", err)
	}

	if fields.SessionID == "" {
		return
	}
	sess, err := h.store.GetSession(fields.SessionID, userID)
	if err != nil {
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			log.Printf("gateway: get session %s: %v", fields.SessionID, err)
		}
		return
	}
	if err := h.store.CreateMessage(&store.Message{
		SessionID: sess.ID, Role: "user", Content: fields.lastUserStoredContent(), ModelName: m.Name,
	}); err != nil {
		log.Printf("gateway: save user message: %v", err)
	}
	if err := h.store.CreateMessage(&store.Message{
		SessionID: sess.ID, Role: "assistant", Content: assistantText, ModelName: m.Name,
		TokensIn: int(in), TokensOut: int(out), CostCents: cost,
	}); err != nil {
		log.Printf("gateway: save assistant message: %v", err)
	}
}

// turnCostCents prices one turn at whole cents, round-half-up on the combined
// exact value. Per-term integer division truncated both directions and biased
// every turn low against upstream bills, which settle on cumulative usage;
// rounding only bounds the per-turn error to ±0.5 cent. cost_cents stays a
// display aggregate: exact reconciliation recomputes tokens_in/out × price as
// floats from the stored rows.
func turnCostCents(in, out, priceInPer1K, priceOutPer1K int64) int64 {
	return (in*priceInPer1K + out*priceOutPer1K + 500) / 1000
}

func dataPayload(line []byte) ([]byte, bool) {
	rest, ok := bytes.CutPrefix(line, []byte("data:"))
	if !ok {
		return nil, false
	}
	return bytes.TrimSpace(rest), true
}

func errJSON(c *gin.Context, status int, code, msg string) {
	c.JSON(status, gin.H{"error": gin.H{"code": code, "message": msg}})
}

package gateway

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"

	"github.com/xycxmz/company-platform-v1/server/internal/auth"
	"github.com/xycxmz/company-platform-v1/server/internal/auth/acauth"
	"github.com/xycxmz/company-platform-v1/server/internal/store"
)

const (
	testAppID = "gw-test"
	testKID   = "k1"
)

func newEngine(t *testing.T) (*gin.Engine, *store.Store, string) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	jwks, err := json.Marshal(map[string]any{
		"keys": []map[string]string{{
			"kty": "OKP", "crv": "Ed25519", "kid": testKID,
			"x": base64.RawURLEncoding.EncodeToString(pub),
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(filepath.Join(t.TempDir(), "hub.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.AutoMigrate(); err != nil {
		t.Fatal(err)
	}
	verifier := acauth.New("http://127.0.0.1:1/never-fetched", testAppID, string(jwks))
	r := gin.New()
	New(st).Register(r.Group("/api/v1", auth.Middleware(verifier)))
	return r, st, signToken(t, priv, "u1")
}

func signToken(t *testing.T, priv ed25519.PrivateKey, sub string) string {
	t.Helper()
	claims := &acauth.Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   sub,
			Audience:  jwt.ClaimStrings{testAppID},
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	tok.Header["kid"] = testKID
	s, err := tok.SignedString(priv)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func chat(r *gin.Engine, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func addModel(t *testing.T, st *store.Store, baseURL string) {
	t.Helper()
	err := st.CreateHostedModel(&store.HostedModel{
		Name: "glm-flash", Provider: "dashscope", BaseURL: baseURL,
		APIKey: "sk-test", UpstreamModel: "glm-4.6-flash",
		PriceInPer1K: 150, PriceOutPer1K: 450,
	})
	if err != nil {
		t.Fatal(err)
	}
}

func todayUsage(t *testing.T, st *store.Store, user string) []store.UsageDaily {
	t.Helper()
	rows, err := st.UsageSummary(user, 1)
	if err != nil {
		t.Fatal(err)
	}
	return rows
}

func errorCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var env struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("not the error envelope: %v (%s)", err, w.Body.String())
	}
	return env.Error.Code
}

// fakeUpstream asserts the hop contract (auth header, rewritten model,
// session_id stripped) and lets each test script the response.
func fakeUpstream(t *testing.T, respond func(t *testing.T, w http.ResponseWriter, body map[string]any)) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Errorf("upstream received invalid JSON: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer sk-test" {
			t.Errorf("upstream Authorization = %q", got)
		}
		if _, leaked := body["session_id"]; leaked {
			t.Error("session_id must be stripped before forwarding")
		}
		if body["model"] != "glm-4.6-flash" {
			t.Errorf("upstream model = %v, want rewritten glm-4.6-flash", body["model"])
		}
		respond(t, w, body)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestChatNonStreamProxiesAndMeters(t *testing.T) {
	gin.SetMode(gin.TestMode)
	up := fakeUpstream(t, func(t *testing.T, w http.ResponseWriter, _ map[string]any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"cmpl-1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"Hello there"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":34}}`))
	})
	r, st, tok := newEngine(t)
	addModel(t, st, up.URL+"/v1/")

	w := chat(r, tok, `{"model":"glm-flash","messages":[{"role":"user","content":"hi"}]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var passed completionResponse
	if err := json.Unmarshal(w.Body.Bytes(), &passed); err != nil {
		t.Fatal(err)
	}
	if len(passed.Choices) != 1 || passed.Choices[0].Message.Content != "Hello there" {
		t.Fatalf("passthrough body mangled: %s", w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Fatalf("Content-Type = %q", ct)
	}

	rows := todayUsage(t, st, "u1")
	if len(rows) != 1 {
		t.Fatalf("usage rows = %+v", rows)
	}
	got := rows[0]
	if got.TokensIn != 12 || got.TokensOut != 34 || got.Requests != 1 || got.ModelName != "glm-flash" {
		t.Fatalf("metered usage = %+v", got)
	}
	// turnCostCents(12, 34, 150, 450) = round((1800+15300)/1000) = 17.
	if got.CostCents != 17 {
		t.Fatalf("cost_cents = %d, want 17", got.CostCents)
	}
	if got.Date != time.Now().Format("2006-01-02") {
		t.Fatalf("date = %q, want today", got.Date)
	}
}

func TestChatStreamRelaysChunksAndMeters(t *testing.T) {
	gin.SetMode(gin.TestMode)
	up := fakeUpstream(t, func(t *testing.T, w http.ResponseWriter, body map[string]any) {
		if so, ok := body["stream_options"].(map[string]any); !ok || so["include_usage"] != true {
			t.Errorf("stream_options not injected: %v", body["stream_options"])
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl := w.(http.Flusher)
		for _, chunk := range []string{
			`{"id":"c1","choices":[{"delta":{"role":"assistant","content":"Hel"}}]}`,
			`{"id":"c1","choices":[{"delta":{"content":"lo"}}]}`,
			`{"id":"c1","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}`,
		} {
			fmt.Fprintf(w, "data: %s\n\n", chunk)
			fl.Flush()
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
		fl.Flush()
	})
	r, st, tok := newEngine(t)
	addModel(t, st, up.URL+"/v1")
	if err := st.CreateSession(&store.Session{ID: "s-stream", UserID: "u1"}); err != nil {
		t.Fatal(err)
	}

	w := chat(r, tok, `{"model":"glm-flash","stream":true,"session_id":"s-stream","messages":[{"role":"user","content":"hello"}]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	for _, want := range []string{`"content":"Hel"`, `"content":"lo"`, `"prompt_tokens":7`, "data: [DONE]"} {
		if !strings.Contains(body, want) {
			t.Fatalf("stream body missing %q:\n%s", want, body)
		}
	}
	if n := strings.Count(body, "data: "); n != 4 {
		t.Fatalf("expected 4 data lines (3 chunks + DONE), got %d:\n%s", n, body)
	}

	rows := todayUsage(t, st, "u1")
	// turnCostCents(7, 3, 150, 450) = round((1050+1350)/1000) = 2.
	if len(rows) != 1 || rows[0].TokensIn != 7 || rows[0].TokensOut != 3 || rows[0].CostCents != 2 {
		t.Fatalf("stream metering = %+v", rows)
	}
	msgs, err := st.ListMessages("s-stream")
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 {
		t.Fatalf("messages = %+v", msgs)
	}
	if msgs[0].Role != "user" || msgs[0].Content != "hello" || msgs[0].ModelName != "glm-flash" {
		t.Fatalf("user message = %+v", msgs[0])
	}
	if msgs[1].Role != "assistant" || msgs[1].Content != "Hello" {
		t.Fatalf("assistant content not aggregated from deltas: %+v", msgs[1])
	}
	if msgs[1].TokensIn != 7 || msgs[1].TokensOut != 3 || msgs[1].CostCents != 2 {
		t.Fatalf("assistant message metering = %+v", msgs[1])
	}
}

func TestChatSessionNotOwnedWritesNoMessages(t *testing.T) {
	gin.SetMode(gin.TestMode)
	up := fakeUpstream(t, func(t *testing.T, w http.ResponseWriter, _ map[string]any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`))
	})
	r, st, tok := newEngine(t)
	addModel(t, st, up.URL+"/v1")
	if err := st.CreateSession(&store.Session{ID: "s-other", UserID: "u2"}); err != nil {
		t.Fatal(err)
	}

	w := chat(r, tok, `{"model":"glm-flash","session_id":"s-other","messages":[{"role":"user","content":"hi"}]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	msgs, err := st.ListMessages("s-other")
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 0 {
		t.Fatalf("someone else's session must not gain messages: %+v", msgs)
	}
}

func TestChatByokRejected(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r, _, tok := newEngine(t)

	w := chat(r, tok, `{"model":"byok:sk-mine/glm","messages":[]}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	if code := errorCode(t, w); code != "BYOK_NOT_SUPPORTED" {
		t.Fatalf("code = %s", code)
	}
}

func TestChatUnknownModelNotFound(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r, _, tok := newEngine(t)

	w := chat(r, tok, `{"model":"nope","messages":[]}`)
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	if code := errorCode(t, w); code != "MODEL_NOT_FOUND" {
		t.Fatalf("code = %s", code)
	}
}

func TestChatUpstreamErrorPassthrough(t *testing.T) {
	gin.SetMode(gin.TestMode)
	up := fakeUpstream(t, func(t *testing.T, w http.ResponseWriter, _ map[string]any) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write(bytes.Repeat([]byte("x"), 8192))
	})
	r, st, tok := newEngine(t)
	addModel(t, st, up.URL+"/v1")

	w := chat(r, tok, `{"model":"glm-flash","messages":[{"role":"user","content":"hi"}]}`)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	if w.Body.Len() != 4096 {
		t.Fatalf("body = %d bytes, want truncation at 4096", w.Body.Len())
	}
	if ct := w.Header().Get("Content-Type"); !strings.Contains(ct, "text/plain") {
		t.Fatalf("Content-Type = %q", ct)
	}
	if rows := todayUsage(t, st, "u1"); len(rows) != 0 {
		t.Fatalf("non-2xx must not meter: %+v", rows)
	}
}

func TestChatUpstreamUnreachableBadGateway(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r, st, tok := newEngine(t)
	addModel(t, st, "http://127.0.0.1:1") // nothing listens there

	w := chat(r, tok, `{"model":"glm-flash","messages":[]}`)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	if code := errorCode(t, w); code != "BAD_GATEWAY" {
		t.Fatalf("code = %s", code)
	}
}

func TestChatUsageEstimatedWhenMissing(t *testing.T) {
	gin.SetMode(gin.TestMode)
	up := fakeUpstream(t, func(t *testing.T, w http.ResponseWriter, _ map[string]any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"c","choices":[{"message":{"role":"assistant","content":"Hello there"}}]}`))
	})
	r, st, tok := newEngine(t)
	addModel(t, st, up.URL+"/v1")

	w := chat(r, tok, `{"model":"glm-flash","messages":[{"role":"user","content":"hi"}]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	rows := todayUsage(t, st, "u1")
	if len(rows) != 1 {
		t.Fatalf("usage rows = %+v", rows)
	}
	// "Hello there" = 11 runes; 11/4 = 2 on both directions.
	if rows[0].TokensIn != 2 || rows[0].TokensOut != 2 {
		t.Fatalf("estimated usage = %+v", rows[0])
	}
}

// R9-A A1: vision parts content passes upstream verbatim (no flattening on
// the forwarding path) and persists into the session as decodable parts JSON.
func TestChatVisionPartsPassthroughAndStored(t *testing.T) {
	gin.SetMode(gin.TestMode)
	up := fakeUpstream(t, func(t *testing.T, w http.ResponseWriter, body map[string]any) {
		msgs, _ := body["messages"].([]any)
		if len(msgs) != 1 {
			t.Errorf("upstream messages = %v", body["messages"])
		} else if raw, ok := msgs[0].(map[string]any)["content"]; ok {
			// 首请求（parts 形态）必须逐段透传；次请求是纯字符串，只验在场
			if parts, isArr := raw.([]any); isArr && len(parts) != 2 {
				t.Errorf("upstream content parts not relayed verbatim: %v", raw)
			}
			if s, isStr := raw.(string); isStr && s != "plain" {
				t.Errorf("upstream string content mangled: %q", s)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"seen"}}],"usage":{"prompt_tokens":5,"completion_tokens":1}}`))
	})
	r, st, tok := newEngine(t)
	addModel(t, st, up.URL+"/v1")
	if err := st.CreateSession(&store.Session{ID: "s-vision", UserID: "u1"}); err != nil {
		t.Fatal(err)
	}

	w := chat(r, tok, `{"model":"glm-flash","session_id":"s-vision","messages":[{"role":"user","content":[{"type":"text","text":"看图"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}]}]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	msgs, err := st.ListMessages("s-vision")
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 {
		t.Fatalf("messages = %+v", msgs)
	}
	parts, ok := store.DecodeContentParts(msgs[0].Content)
	if !ok || len(parts) != 2 || parts[0].Text != "看图" ||
		parts[1].ImageURL == nil || parts[1].ImageURL.URL != "data:image/png;base64,AAAA" {
		t.Fatalf("user message not stored as parts: %q -> %+v", msgs[0].Content, parts)
	}
	if msgs[1].Role != "assistant" || msgs[1].Content != "seen" {
		t.Fatalf("assistant message = %+v", msgs[1])
	}

	// 纯字符串形态仍走旧路径，逐字节不变
	w = chat(r, tok, `{"model":"glm-flash","session_id":"s-vision","messages":[{"role":"user","content":"plain"}]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("plain status = %d, body = %s", w.Code, w.Body.String())
	}
	msgs, err = st.ListMessages("s-vision")
	if err != nil {
		t.Fatal(err)
	}
	if got := msgs[2].Content; got != "plain" {
		t.Fatalf("plain string content = %q, want verbatim", got)
	}
}

// R5-A-②: cost rounds the combined exact value half-up instead of truncating
// each direction, which biased every turn up to ~2 cents low against the
// upstream's cumulative bill.
func TestTurnCostCentsRoundsHalfUp(t *testing.T) {
	cases := []struct {
		name              string
		in, out           int64
		priceIn, priceOut int64
		want              int64
	}{
		{"999/1000 of a cent rounds up, not to zero", 999, 0, 1, 1, 1},
		{"exact half rounds up", 500, 0, 1, 1, 1},
		{"under half rounds down", 499, 0, 1, 1, 0},
		{"sub-half terms sum past half", 499, 499, 1, 1, 1},
		{"zero usage stays zero cents", 0, 0, 150, 450, 0},
		{"matches non-stream integration turn", 12, 34, 150, 450, 17},
	}
	for _, tc := range cases {
		if got := turnCostCents(tc.in, tc.out, tc.priceIn, tc.priceOut); got != tc.want {
			t.Errorf("%s: turnCostCents(%d, %d, %d, %d) = %d, want %d",
				tc.name, tc.in, tc.out, tc.priceIn, tc.priceOut, got, tc.want)
		}
	}
}

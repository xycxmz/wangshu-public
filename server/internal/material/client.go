// Package material implements hub's built-in image/video generation: a thin
// DashScope async-task client, a single-goroutine worker that drives tasks to
// a terminal state, and the /material HTTP routes.
package material

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/xycxmz/company-platform-v1/server/internal/config"
	"github.com/xycxmz/company-platform-v1/server/internal/store"
)

const (
	kindImage = "image"
	kindVideo = "video"

	imageEndpoint = "/api/v1/services/aigc/text2image/image-synthesis"
	videoEndpoint = "/api/v1/services/aigc/video-generation/video-synthesis"

	// DashScope size strings use an asterisk, not an x.
	imageDefaultSize = "1024*1024"
	imageDefaultN    = 1
	videoDefaultSize = "1280*720"

	httpTimeout = 30 * time.Second
)

// Client talks to DashScope's async task API: Submit creates an upstream task,
// Poll reads its state. It normalizes the upstream status vocabulary into the
// store's pending|running|succeeded|failed.
type Client struct {
	baseURL    string
	apiKey     string
	imageModel string
	videoModel string
	hc         *http.Client
}

func NewClient(cfg *config.Config, st *store.Store) *Client {
	return &Client{
		baseURL:    strings.TrimRight(cfg.MaterialBaseURL, "/"),
		apiKey:     resolveAPIKey(cfg, st),
		imageModel: cfg.MaterialImageModel,
		videoModel: cfg.MaterialVideoModel,
		hc:         &http.Client{Timeout: httpTimeout},
	}
}

// resolveAPIKey 是素材管线的 key 双源解析：env（显式配置）优先，模型池
// DashScope key 兜底——与 kb.NewEmbedder 同款（生产 key 灌在池里，env 只
// 有开发机会设）。启动期解析一次：池后灌需重启生效，与 kb 一致。
func resolveAPIKey(cfg *config.Config, st *store.Store) string {
	key := cfg.MaterialAPIKey
	if key == "" && st != nil {
		if k, err := st.FirstDashScopeKey(); err == nil {
			key = k
		}
	}
	return key
}

type submitRequest struct {
	Model      string         `json:"model"`
	Input      submitInput    `json:"input"`
	Parameters map[string]any `json:"parameters"`
}

type submitInput struct {
	Prompt string `json:"prompt"`
}

// Model returns the model id Submit sends for kind; it is the name a price
// row must match for that kind to meter cost.
func (c *Client) Model(kind string) string {
	if kind == kindImage {
		return c.imageModel
	}
	return c.videoModel
}

// Submit posts the generation request and returns the upstream task id.
func (c *Client) Submit(kind, prompt string) (string, error) {
	model, endpoint := c.videoModel, videoEndpoint
	params := map[string]any{"size": videoDefaultSize}
	if kind == kindImage {
		model, endpoint = c.imageModel, imageEndpoint
		params["n"] = imageDefaultN
		params["size"] = imageDefaultSize
	}
	body, err := json.Marshal(submitRequest{
		Model:      model,
		Input:      submitInput{Prompt: prompt},
		Parameters: params,
	})
	if err != nil {
		return "", err
	}

	var out struct {
		Output struct {
			TaskID     string `json:"task_id"`
			TaskStatus string `json:"task_status"`
		} `json:"output"`
	}
	if err := c.postJSON(c.baseURL+endpoint, body, &out); err != nil {
		return "", err
	}
	if out.Output.TaskID == "" {
		return "", fmt.Errorf("dashscope submit %s: no task_id in response", endpoint)
	}
	return out.Output.TaskID, nil
}

// Poll fetches one upstream task. status is one of the store status constants;
// for store.MaterialFailed the returned err carries the upstream message. An
// empty status with a non-nil err is a transport/protocol error the caller
// may retry on a later tick.
func (c *Client) Poll(taskID string) (status, resultURL string, err error) {
	req, err := http.NewRequest(http.MethodGet, c.baseURL+"/api/v1/tasks/"+taskID, nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	resp, err := c.hc.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return "", "", fmt.Errorf("dashscope poll: status %d: %s", resp.StatusCode, truncate(string(raw), 200))
	}

	var out struct {
		Output struct {
			TaskStatus string `json:"task_status"`
			Results    []struct {
				URL string `json:"url"`
			} `json:"results"`
			Message string `json:"message"`
		} `json:"output"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", "", fmt.Errorf("dashscope poll: decode: %w", err)
	}

	switch out.Output.TaskStatus {
	case "PENDING":
		return store.MaterialPending, "", nil
	case "RUNNING":
		return store.MaterialRunning, "", nil
	case "SUCCEEDED":
		if len(out.Output.Results) == 0 || out.Output.Results[0].URL == "" {
			return "", "", fmt.Errorf("dashscope poll: SUCCEEDED without result url")
		}
		return store.MaterialSucceeded, out.Output.Results[0].URL, nil
	case "FAILED", "CANCELED", "UNKNOWN":
		msg := strings.TrimSpace(out.Output.Message)
		if msg == "" {
			msg = "upstream task " + strings.ToLower(out.Output.TaskStatus)
		}
		return store.MaterialFailed, "", fmt.Errorf("%s", msg)
	default:
		return "", "", fmt.Errorf("dashscope poll: unknown task_status %q", out.Output.TaskStatus)
	}
}

// postJSON sends body with the async headers and decodes a 2xx reply into out.
func (c *Client) postJSON(url string, body []byte, out any) error {
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("X-DashScope-Async", "enable")
	resp, err := c.hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("dashscope submit: status %d: %s", resp.StatusCode, truncate(string(raw), 200))
	}
	return json.Unmarshal(raw, out)
}

// truncate keeps stored/reportable error strings inside the column budget.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

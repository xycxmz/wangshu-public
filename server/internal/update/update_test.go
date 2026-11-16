package update

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
)

func serve(t *testing.T) (*gin.Engine, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	dir := t.TempDir()
	r := gin.New()
	grp := r.Group("")
	Register(grp, dir)
	return r, dir
}

func TestManifestServed(t *testing.T) {
	r, dir := serve(t)
	os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(`{"version":"0.1.0"}`), 0o644)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/update/manifest", nil))
	if w.Code != http.StatusOK || w.Body.String() != `{"version":"0.1.0"}` {
		t.Fatalf("code=%d body=%s", w.Code, w.Body.String())
	}
}

func TestManifestMissingIs204(t *testing.T) {
	r, _ := serve(t)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/update/manifest", nil))
	if w.Code != http.StatusNoContent {
		t.Fatalf("missing manifest should be 204, got %d", w.Code)
	}
}

func TestAssetDownloadAndTraversalRejected(t *testing.T) {
	r, dir := serve(t)
	os.MkdirAll(filepath.Join(dir, "assets"), 0o755)
	os.WriteFile(filepath.Join(dir, "assets", "app.msi.zip"), []byte("PKG"), 0o644)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/update/assets/app.msi.zip", nil))
	if w.Code != http.StatusOK || w.Body.String() != "PKG" {
		t.Fatalf("asset download code=%d body=%q", w.Code, w.Body.String())
	}

	for _, bad := range []string{"/update/assets/..%2Fmanifest.json", "/update/assets/app.msi.zip/../../secret"} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, bad, nil))
		if w.Code == http.StatusOK {
			t.Fatalf("traversal %q should not resolve, got 200", bad)
		}
	}
}

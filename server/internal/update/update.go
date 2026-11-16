// Package update serves the desktop client's update feed: a Tauri-updater
// manifest plus the bundled installers, all from one operator-managed
// directory. No upload API — artifacts land there via deploy tooling.
package update

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

func Register(r *gin.RouterGroup, dir string) {
	manifestPath := filepath.Join(dir, "manifest.json")

	r.GET("/update/manifest", func(c *gin.Context) {
		data, err := os.ReadFile(manifestPath)
		if err != nil {
			// The updater treats a missing manifest as "no update": 204 keeps
			// clients quiet on a hub that has never shipped a release.
			c.Status(http.StatusNoContent)
			return
		}
		c.Data(http.StatusOK, "application/json", data)
	})

	r.GET("/update/assets/:file", func(c *gin.Context) {
		name := filepath.Clean(c.Param("file"))
		if name == "." || name == ".." || strings.ContainsAny(name, `/\`) {
			c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST", "message": "invalid file name"}})
			return
		}
		full := filepath.Join(dir, "assets", name)
		st, err := os.Stat(full)
		if err != nil || st.IsDir() {
			log.Printf("update: asset %q not found", name)
			c.JSON(http.StatusNotFound, gin.H{"error": gin.H{"code": "NOT_FOUND", "message": "asset not found"}})
			return
		}
		c.File(full)
	})
}

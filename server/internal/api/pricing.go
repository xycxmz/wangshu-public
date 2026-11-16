// Material pricing routes over the system_config-backed price table
// (B3, roadmap-r4): env MATERIAL_PRICE_* only seeds on first boot; after
// that the DB row is the single truth and PUT changes take effect without a
// hub restart — the material worker re-reads the table per finished task.
package api

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/xycxmz/company-platform-v1/server/internal/config"
	"github.com/xycxmz/company-platform-v1/server/internal/store"
)

var materialPriceKinds = map[string]bool{"image": true, "video": true}

// SeedMaterialPrices writes the env-loaded price table into system_config on
// first boot only: an existing row wins (deployments adjust prices via the
// API, so a .env change must never silently revert them). Best effort — a
// failure logs and leaves pricing to whatever the table already holds.
func SeedMaterialPrices(st *store.Store, prices map[string]config.MaterialPrice) {
	if _, ok, err := st.GetSystemConfig(store.SystemKeyMaterialPrices); err != nil {
		log.Printf("pricing: seed check failed: %v", err)
		return
	} else if ok {
		return
	}
	if prices == nil {
		prices = map[string]config.MaterialPrice{}
	}
	raw, err := json.Marshal(prices)
	if err != nil {
		log.Printf("pricing: seed marshal: %v", err)
		return
	}
	if err := st.SetSystemConfig(store.SystemKeyMaterialPrices, string(raw)); err != nil {
		log.Printf("pricing: seed write failed: %v", err)
		return
	}
	log.Printf("pricing: seeded material price table from env (%d kinds)", len(prices))
}

// loadMaterialPrices is st.MaterialPrices(); kept local for readability.
func loadMaterialPrices(st *store.Store) (map[string]config.MaterialPrice, error) {
	return st.MaterialPrices()
}

func pricingGet(st *store.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		prices, err := st.MaterialPrices()
		if err != nil {
			internalError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"prices": prices})
	}
}

func pricingPut(st *store.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req map[string]config.MaterialPrice
		if err := c.ShouldBindJSON(&req); err != nil {
			badRequest(c, err.Error())
			return
		}
		// The PUT replaces the whole price table, so both kinds must ride in
		// one body — a partial PUT would silently re-price the missing kind
		// to the zero value. Reject rather than merge.
		for _, kind := range []string{"image", "video"} {
			if _, ok := req[kind]; !ok {
				badRequest(c, "both image and video are required: PUT replaces the whole price table")
				return
			}
		}
		for kind, p := range req {
			if !materialPriceKinds[kind] {
				badRequest(c, "unknown kind "+kind+" (want image|video)")
				return
			}
			if p.Model == "" {
				badRequest(c, kind+": model is required")
				return
			}
			if p.CentsPerUnit < 0 {
				badRequest(c, kind+": cents_per_unit must be non-negative")
				return
			}
		}
		raw, err := json.Marshal(req)
		if err != nil {
			internalError(c, err)
			return
		}
		if err := st.SetSystemConfig(store.SystemKeyMaterialPrices, string(raw)); err != nil {
			internalError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"prices": req})
	}
}

func registerPricing(api *gin.RouterGroup, st *store.Store, admin gin.HandlerFunc) {
	api.GET("/pricing/material", pricingGet(st))
	api.PUT("/pricing/material", admin, pricingPut(st))
}

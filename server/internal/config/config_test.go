package config

import (
	"os"
	"reflect"
	"testing"
	"time"
)

func TestLoadMaterialPrices(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string // MATERIAL_PRICE_* values; every var unset first
		want map[string]MaterialPrice
	}{
		{
			name: "missing env leaves kind unpriced",
			env:  map[string]string{},
			want: map[string]MaterialPrice{},
		},
		{
			name: "valid rows",
			env: map[string]string{
				"MATERIAL_PRICE_IMAGE": "wanx2.1-t2i-turbo,20",
				"MATERIAL_PRICE_VIDEO": "wan2.2-t2v-plus,700",
			},
			want: map[string]MaterialPrice{
				"image": {Model: "wanx2.1-t2i-turbo", CentsPerUnit: 20},
				"video": {Model: "wan2.2-t2v-plus", CentsPerUnit: 700},
			},
		},
		{
			name: "whitespace tolerated",
			env:  map[string]string{"MATERIAL_PRICE_IMAGE": " wanx2.1-t2i-turbo , 20 "},
			want: map[string]MaterialPrice{
				"image": {Model: "wanx2.1-t2i-turbo", CentsPerUnit: 20},
			},
		},
		{
			name: "zero cents is a valid free row",
			env:  map[string]string{"MATERIAL_PRICE_IMAGE": "free-model,0"},
			want: map[string]MaterialPrice{
				"image": {Model: "free-model", CentsPerUnit: 0},
			},
		},
		{
			name: "malformed row drops only its kind",
			env: map[string]string{
				"MATERIAL_PRICE_IMAGE": "no-comma",
				"MATERIAL_PRICE_VIDEO": "wan2.2-t2v-plus,700",
			},
			want: map[string]MaterialPrice{
				"video": {Model: "wan2.2-t2v-plus", CentsPerUnit: 700},
			},
		},
		{
			name: "bad cents",
			env:  map[string]string{"MATERIAL_PRICE_IMAGE": "m,abc"},
			want: map[string]MaterialPrice{},
		},
		{
			name: "empty model",
			env:  map[string]string{"MATERIAL_PRICE_IMAGE": ",20"},
			want: map[string]MaterialPrice{},
		},
		{
			name: "negative cents",
			env:  map[string]string{"MATERIAL_PRICE_IMAGE": "m,-20"},
			want: map[string]MaterialPrice{},
		},
		{
			name: "trailing segment",
			env:  map[string]string{"MATERIAL_PRICE_IMAGE": "m,20,30"},
			want: map[string]MaterialPrice{},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, key := range []string{"MATERIAL_PRICE_IMAGE", "MATERIAL_PRICE_VIDEO"} {
				os.Unsetenv(key)
				if v, ok := tc.env[key]; ok {
					t.Setenv(key, v)
				}
			}
			if got := loadMaterialPrices(); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("prices = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestLoadLoginLimit(t *testing.T) {
	cases := []struct {
		name       string
		raw        string
		wantWindow time.Duration
		wantMax    int
	}{
		{name: "unset defaults to 10/min", raw: "", wantWindow: time.Minute, wantMax: 10},
		{name: "explicit default", raw: "10/min", wantWindow: time.Minute, wantMax: 10},
		{name: "per second", raw: "5/s", wantWindow: time.Second, wantMax: 5},
		{name: "per hour", raw: "3/h", wantWindow: time.Hour, wantMax: 3},
		{name: "spaces tolerated", raw: " 7 / min ", wantWindow: time.Minute, wantMax: 7},
		{name: "missing unit", raw: "10", wantWindow: time.Minute, wantMax: 10},
		{name: "bad number", raw: "abc/min", wantWindow: time.Minute, wantMax: 10},
		{name: "zero max is malformed (would 429 everyone)", raw: "0/min", wantWindow: time.Minute, wantMax: 10},
		{name: "unknown unit", raw: "10/fortnight", wantWindow: time.Minute, wantMax: 10},
		{name: "trailing segment", raw: "10/min/x", wantWindow: time.Minute, wantMax: 10},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			window, max := loadLoginLimit(tc.raw)
			if window != tc.wantWindow || max != tc.wantMax {
				t.Fatalf("loadLoginLimit(%q) = (%v, %d), want (%v, %d)", tc.raw, window, max, tc.wantWindow, tc.wantMax)
			}
		})
	}
}

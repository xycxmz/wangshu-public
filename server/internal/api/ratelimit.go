// Per-IP failure rate limit for the login proxy. When the hub is exposed
// through a reverse proxy, an open
// /api/v1/auth/login would let the internet brute-force account-center
// credentials through us. Only FAILED attempts count: a sliding window with
// >= max failures blocks the IP; a success clears it.
package api

import (
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	defaultLoginWindow = time.Minute
	defaultLoginMax    = 10
)

// loginLimiter is a per-IP sliding-window failure counter approximated by
// two half-window buckets (prev + cur, rotated as time passes). prev+cur
// slightly overcounts near bucket edges — conservative for a blocking
// limiter, which is the safe direction.
type loginLimiter struct {
	mu     sync.Mutex
	half   time.Duration // sub-window length; the sliding window is 2*half
	max    int           // failures inside the window that trip the block
	counts map[string]*failBuckets
	stopCh chan struct{}
}

type failBuckets struct {
	prev, cur int       // failures in the previous and current half-window
	curStart  time.Time // start of the current half-window
}

// newLoginLimiter normalizes non-positive window/max to the defaults so a
// zero-value config.Config (tests build them by hand) cannot turn the login
// route into a deny-all (max=0).
func NewLoginLimiter(window time.Duration, max int) *loginLimiter {
	if window <= 0 {
		window = defaultLoginWindow
	}
	if max <= 0 {
		max = defaultLoginMax
	}
	l := &loginLimiter{
		half:   window / 2,
		max:    max,
		counts: map[string]*failBuckets{},
		stopCh: make(chan struct{}),
	}
	// Expiry cleanup runs as a background sweep rather than lazily inside
	// allow(): map iteration order is random, so finding the "oldest expired
	// entry" would need extra ordering state, and the hub owns exactly one
	// limiter for its process lifetime. The sweep only reclaims memory — a
	// stale entry self-zeroes through bucket rotation when its IP returns,
	// so correctness never depends on when the sweep runs.
	go l.sweep(window)
	return l
}

func (l *loginLimiter) stop() { close(l.stopCh) }

// sweep drops entries whose whole window has passed: every failure they
// hold landed >= window ago and can no longer trip the limit.
func (l *loginLimiter) sweep(window time.Duration) {
	t := time.NewTicker(window)
	defer t.Stop()
	for {
		select {
		case <-l.stopCh:
			return
		case now := <-t.C:
			l.mu.Lock()
			for ip, b := range l.counts {
				if now.Sub(b.curStart) >= 2*l.half {
					delete(l.counts, ip)
				}
			}
			l.mu.Unlock()
		}
	}
}

// advance rotates the bucket pair so failures age out of the window even
// for IPs that idle between attempts.
func (b *failBuckets) advance(now time.Time, half time.Duration) {
	for now.Sub(b.curStart) >= half {
		b.prev = b.cur
		b.cur = 0
		b.curStart = b.curStart.Add(half)
	}
}

// allow reports whether ip may attempt a login right now.
func (l *loginLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.counts[ip]
	if b == nil {
		return true
	}
	b.advance(time.Now(), l.half)
	return b.prev+b.cur < l.max
}

// recordFailure counts one failed attempt for ip.
func (l *loginLimiter) recordFailure(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	b := l.counts[ip]
	if b == nil {
		b = &failBuckets{curStart: now}
		l.counts[ip] = b
	}
	b.advance(now, l.half)
	b.cur++
}

// recordSuccess clears ip: a login the center accepted proves a legitimate
// user, and deleting the entry also frees the key.
func (l *loginLimiter) recordSuccess(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.counts, ip)
}

// loginRateLimit gates the login route. Failure is what the center rejects
// (401/403); 400 (malformed body) and 502 (center unreachable) say nothing
// about the credentials, so they neither count nor reset.
func LoginRateLimit(l *loginLimiter) gin.HandlerFunc {
	return func(c *gin.Context) {
		ip := forwardedIP(c)
		if !l.allow(ip) {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
				"error": gin.H{"code": "RATE_LIMITED", "message": "too many attempts, retry later"},
			})
			return
		}
		c.Next()
		switch s := c.Writer.Status(); {
		case s == http.StatusUnauthorized || s == http.StatusForbidden:
			l.recordFailure(ip)
		case s >= 200 && s < 300:
			l.recordSuccess(ip)
		}
	}
}

// forwardedIP picks the rate-limit key. The fronting reverse proxy appends
// the socket peer it saw to any client-supplied X-Forwarded-For, so the
// LAST element is the value our trusted hop added; earlier elements are
// attacker-controlled, and keying on the first one would let a rotating
// fake XFF sidestep the per-IP limit. No XFF at all (direct access to the
// loopback-bound port) falls back to the socket address.
func forwardedIP(c *gin.Context) string {
	if vals := c.Request.Header.Values("X-Forwarded-For"); len(vals) > 0 {
		parts := strings.Split(strings.Join(vals, ","), ",")
		for i := len(parts) - 1; i >= 0; i-- {
			if ip := strings.TrimSpace(parts[i]); ip != "" {
				return ip
			}
		}
	}
	return c.ClientIP()
}

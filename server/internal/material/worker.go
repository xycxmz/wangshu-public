package material

import (
	"context"
	"log"
	"time"

	"github.com/xycxmz/company-platform-v1/server/internal/config"
	"github.com/xycxmz/company-platform-v1/server/internal/store"
)

// Package variables so tests can shrink the cadence; production defaults are
// a 3s poll loop and a 15m hard ceiling per task.
var (
	pollInterval = 3 * time.Second
	taskTimeout  = 15 * time.Minute
)

// Worker is the single background goroutine that shepherds active tasks:
// unsubmitted ones get submitted, running ones polled, and the whole scan is
// just a DB query plus a map of per-task deadlines. No queue library.
type Worker struct {
	store     *store.Store
	client    *Client
	deadlines map[string]time.Time // running task id → poll deadline, set on first sight
}

func NewWorker(st *store.Store, cfg *config.Config) *Worker {
	return &Worker{
		store:     st,
		client:    NewClient(cfg, st),
		deadlines: map[string]time.Time{},
	}
}

func (w *Worker) Run(ctx context.Context) {
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.tick()
		}
	}
}

func (w *Worker) tick() {
	tasks, err := w.store.ListActiveMaterialTasks()
	if err != nil {
		log.Printf("material: scan active tasks: %v", err)
		return
	}
	for i := range tasks {
		w.step(&tasks[i])
	}
}

func (w *Worker) step(t *store.MaterialTask) {
	if t.Status == store.MaterialPending {
		// The worker is the only submitter (2026-11-10 audit fix): every
		// task starts pending and the next tick submits it, which also
		// recovers a row orphaned by a crash between insert and submit.
		submitPending(w.client, w.store, t)
		return
	}

	deadline, seen := w.deadlines[t.ID]
	if !seen {
		deadline = time.Now().Add(taskTimeout)
		w.deadlines[t.ID] = deadline
	}
	if time.Now().After(deadline) {
		finishTask(w.store, t, store.MaterialFailed, "", "generation timed out after "+taskTimeout.String(), 0)
		delete(w.deadlines, t.ID)
		return
	}

	status, url, err := w.client.Poll(t.UpstreamTaskID)
	switch status {
	case store.MaterialSucceeded:
		finishTask(w.store, t, store.MaterialSucceeded, url, "", w.priceTask(t))
		delete(w.deadlines, t.ID)
	case store.MaterialFailed:
		msg := "generation failed"
		if err != nil {
			msg = err.Error()
		}
		finishTask(w.store, t, store.MaterialFailed, "", truncate(msg, 512), 0)
		delete(w.deadlines, t.ID)
	case store.MaterialPending, store.MaterialRunning:
		// still in flight upstream; nothing to persist this tick
	default:
		// transport/protocol error: retry next tick under the same deadline
		log.Printf("material: poll task %s: %v", t.ID, err)
	}
}

// submitPending submits an unsubmitted task and persists the outcome. The
// worker's tick is the only submission path (2026-11-10 audit fix): the
// create route inserts pending and returns 202, so nothing races the worker
// into submitting the same row twice.
func submitPending(cl *Client, st *store.Store, t *store.MaterialTask) {
	id, err := cl.Submit(t.Kind, t.Prompt)
	if err != nil {
		finishTask(st, t, store.MaterialFailed, "", truncate(err.Error(), 512), 0)
		return
	}
	t.UpstreamTaskID = id
	t.Status = store.MaterialRunning
	if err := st.UpdateMaterialTask(t); err != nil {
		log.Printf("material: task %s to running: %v", t.ID, err)
	}
}

// priceTask meters one finished task at CentsPerUnit × n, reading the price
// table from system_config at meter time (B3 hot reload: a PUT to
// /pricing/material takes effect for tasks finishing after it, no restart).
// An unpriced kind prices 0, and so does a priced kind whose row names a
// different model than the one the client actually submits
// (DASHSCOPE_*_MODEL was overridden). A broken table prices 0 and logs.
func (w *Worker) priceTask(t *store.MaterialTask) int64 {
	prices, err := w.store.MaterialPrices()
	if err != nil {
		log.Printf("material: load price table: %v; task %s meters cost 0", err, t.ID)
		return 0
	}
	p, ok := prices[t.Kind]
	if !ok {
		return 0
	}
	model := w.client.Model(t.Kind)
	if model != p.Model {
		log.Printf("material: task %s ran model %q but %s is priced for %q; metering cost 0",
			t.ID, model, t.Kind, p.Model)
		return 0
	}
	const n = 1 // MaterialTask carries no count; Submit fixes image n at 1 and a video task is one clip
	return p.CentsPerUnit * n
}

// finishTask moves a task to a terminal state, persists it, and meters one
// request with costCents against the day's usage row.
func finishTask(st *store.Store, t *store.MaterialTask, status, resultURL, errMsg string, costCents int64) {
	t.Status = status
	t.ResultURL = resultURL
	t.Error = errMsg
	if err := st.UpdateMaterialTask(t); err != nil {
		log.Printf("material: finish task %s: %v", t.ID, err)
	}
	if err := st.AddUsage(&store.UsageDaily{
		Date:      time.Now().Format("2006-01-02"), // local-calendar day, matches gateway metering
		UserID:    t.UserID,
		ModelName: "material:" + t.Kind,
		CostCents: costCents,
		Requests:  1,
	}); err != nil {
		log.Printf("material: meter task %s: %v", t.ID, err)
	}
}

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// RunRecord is written before the session starts. It is the evidence that a
// ticket was dispatched, and it holds the exact argv that was used.
type RunRecord struct {
	Key        string   `json:"key"`
	Project    string   `json:"project"`
	EventID    string   `json:"eventId"`
	Event      string   `json:"event"`
	Actor      string   `json:"actor"`
	Summary    string   `json:"summary"`
	URL        string   `json:"url"`
	Workspace  string   `json:"workspace"`
	Argv       []string `json:"argv"`
	PromptFile string   `json:"promptFile"`
	SpoolFile  string   `json:"spoolFile"`
	StartedAt  string   `json:"startedAt"`
}

type Dispatcher struct {
	cfg *Config
	log *log.Logger
}

func NewDispatcher(cfg *Config, logger *log.Logger) *Dispatcher {
	return &Dispatcher{cfg: cfg, log: logger}
}

func (d *Dispatcher) path(parts ...string) string {
	return filepath.Join(append([]string{d.cfg.StateDir}, parts...)...)
}

// Dispatch records the run, takes the per-ticket lock, and starts the session
// in the background. It returns as soon as the local bookkeeping is durable,
// so the webhook endpoint answers before Jira times out.
func (d *Dispatcher) Dispatch(p *Payload, raw []byte) Decision {
	seen, err := d.MarkSeen(p)
	if err != nil {
		return Decision{Kind: KindRejected, Reason: "cannot record the event: " + err.Error()}
	}
	if seen {
		return Decision{Kind: KindDuplicate, Reason: "event already handled: " + p.EventID()}
	}

	// Every failure past this point unmarks the event, so a Jira retry is not
	// swallowed by the dedupe set.
	reject := func(reason string) Decision {
		d.UnmarkSeen(p)
		return Decision{Kind: KindRejected, Reason: reason}
	}

	held, err := d.lockHeld(p.Issue.Key)
	if err != nil {
		return reject("cannot take the lock: " + err.Error())
	}
	if held {
		return Decision{Kind: KindInFlight, Reason: "a run for " + p.Issue.Key + " is already in flight"}
	}

	// The workspace path carries the ticket key, so it is only known now.
	proj := d.cfg.Projects[p.ProjectKey()]
	proj.Workspace = Substitute(proj.Workspace, ticketValues(p))
	proj.PrepareDir = Substitute(proj.PrepareDir, ticketValues(p))

	if err := os.MkdirAll(proj.Workspace, 0o755); err != nil {
		return reject("cannot create the workspace: " + err.Error())
	}

	record, err := d.recordRun(p, proj, raw)
	if err != nil {
		return reject("cannot write the run record: " + err.Error())
	}

	go d.run(record, proj)
	return Decision{Kind: KindDispatch, Reason: "started a session for " + p.Issue.Key}
}

// ticketValues are the placeholders known before the workspace is resolved.
func ticketValues(p *Payload) map[string]string {
	return map[string]string{
		"{key}":     p.Issue.Key,
		"{project}": p.ProjectKey(),
	}
}

// seenPath is the dedupe marker for one event.
func (d *Dispatcher) seenPath(p *Payload) string {
	sum := sha256.Sum256([]byte(p.EventID()))
	return filepath.Join(d.path("seen"), hex.EncodeToString(sum[:])+".json")
}

// MarkSeen records the event id. It returns true when the event was already
// recorded. The create is exclusive, so two concurrent deliveries cannot both
// win.
func (d *Dispatcher) MarkSeen(p *Payload) (bool, error) {
	if err := os.MkdirAll(d.path("seen"), 0o755); err != nil {
		return false, err
	}

	f, err := os.OpenFile(d.seenPath(p), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		if os.IsExist(err) {
			return true, nil
		}
		return false, err
	}
	defer f.Close()
	return false, json.NewEncoder(f).Encode(p)
}

// UnmarkSeen forgets the event id, so a later retry can be dispatched.
func (d *Dispatcher) UnmarkSeen(p *Payload) {
	if err := os.Remove(d.seenPath(p)); err != nil && !os.IsNotExist(err) {
		d.log.Printf("cannot unmark event %s: %v", p.EventID(), err)
	}
}

// lockHeld reports whether a run for this ticket is still in flight. The lock
// lives for the whole session. A lock older than lockTtlHours is stale, which
// covers a receiver that died mid-run, and is taken over.
func (d *Dispatcher) lockHeld(key string) (bool, error) {
	dir := d.path("lock")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false, err
	}
	file := filepath.Join(dir, key)

	for attempt := 0; attempt < 2; attempt++ {
		f, err := os.OpenFile(file, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			fmt.Fprintf(f, "%s\n", time.Now().UTC().Format(time.RFC3339))
			f.Close()
			return false, nil
		}
		if !os.IsExist(err) {
			return false, err
		}

		info, statErr := os.Stat(file)
		if statErr != nil {
			return false, statErr
		}
		if time.Since(info.ModTime()) < time.Duration(d.cfg.LockTTLHours*float64(time.Hour)) {
			return true, nil
		}
		d.log.Printf("lock for %s is older than the TTL, taking it over", key)
		if err := os.Remove(file); err != nil {
			return false, err
		}
	}
	return false, fmt.Errorf("could not take the lock for %s", key)
}

// ReleaseLock removes the per-ticket lock. A finished run calls it so the next
// event on the same ticket can start.
func (d *Dispatcher) ReleaseLock(key string) {
	if err := os.Remove(filepath.Join(d.path("lock"), key)); err != nil && !os.IsNotExist(err) {
		d.log.Printf("release lock for %s: %v", key, err)
	}
}

// recordRun writes the run record, the prompt and the raw payload to the
// state directory.
func (d *Dispatcher) recordRun(p *Payload, proj Project, raw []byte) (*RunRecord, error) {
	stamp := time.Now().UTC().Format("20060102T150405.000000000Z")
	for _, sub := range []string{"runs", "spool", "logs"} {
		if err := os.MkdirAll(d.path(sub), 0o755); err != nil {
			return nil, err
		}
	}

	values := map[string]string{
		"{key}":       p.Issue.Key,
		"{project}":   p.ProjectKey(),
		"{summary}":   p.Issue.Fields.Summary,
		"{url}":       p.BrowseURL(d.cfg.JiraBaseURL),
		"{workspace}": proj.Workspace,
	}

	spoolFile := d.path("spool", fmt.Sprintf("%s.%s.json", p.Issue.Key, stamp))
	if err := os.WriteFile(spoolFile, raw, 0o644); err != nil {
		return nil, err
	}

	promptFile := d.path("spool", fmt.Sprintf("%s.%s.prompt.txt", p.Issue.Key, stamp))
	prompt := Substitute(proj.PromptTemplate, values)
	if err := os.WriteFile(promptFile, []byte(prompt), 0o644); err != nil {
		return nil, err
	}

	// Launch may use {prompt} to pass the rendered message. The value is one
	// argv element, so a newline in the prompt cannot change the command.
	launchValues := make(map[string]string, len(values)+1)
	for key, value := range values {
		launchValues[key] = value
	}
	launchValues["{prompt}"] = prompt

	record := &RunRecord{
		Key:        p.Issue.Key,
		Project:    p.ProjectKey(),
		EventID:    p.EventID(),
		Event:      p.WebhookEvent,
		Actor:      p.User.EmailAddress,
		Summary:    p.Issue.Fields.Summary,
		URL:        values["{url}"],
		Workspace:  proj.Workspace,
		Argv:       SubstituteArgv(proj.Launch, launchValues),
		PromptFile: promptFile,
		SpoolFile:  spoolFile,
		StartedAt:  time.Now().UTC().Format(time.RFC3339),
	}

	file := d.path("runs", fmt.Sprintf("%s.%s.json", stamp, p.Issue.Key))
	if err := writeJSON(file, record); err != nil {
		return nil, err
	}
	return record, nil
}

// run prepares the workspace and starts the session. It runs in its own
// goroutine, so the webhook has already been answered.
func (d *Dispatcher) run(r *RunRecord, proj Project) {
	defer d.ReleaseLock(r.Key)

	out := d.path("logs", filepath.Base(strings.TrimSuffix(r.SpoolFile, ".json"))+".log")
	logFile, openErr := os.OpenFile(out, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if openErr != nil {
		d.log.Printf("%s: cannot open run log: %v", r.Key, openErr)
		return
	}
	defer logFile.Close()

	if len(proj.Prepare) > 0 {
		argv := SubstituteArgv(proj.Prepare, map[string]string{
			"{key}":       r.Key,
			"{project}":   r.Project,
			"{summary}":   r.Summary,
			"{url}":       r.URL,
			"{workspace}": proj.Workspace,
		})
		fmt.Fprintf(logFile, "$ %s\n", strings.Join(argv, " "))
		cmd := exec.Command(argv[0], argv[1:]...)
		cmd.Dir = proj.PrepareDir
		cmd.Stdout = logFile
		cmd.Stderr = logFile
		if err := cmd.Run(); err != nil {
			d.log.Printf("%s: prepare failed: %v", r.Key, err)
			fmt.Fprintf(logFile, "prepare failed: %v\n", err)
			return
		}
	}

	cmd, err := StartDetached(r.Argv, proj.Workspace, logFile)
	if err != nil {
		d.log.Printf("%s: launch failed: %v", r.Key, err)
		fmt.Fprintf(logFile, "launch failed: %v\n", err)
		return
	}
	d.log.Printf("%s: session started: %s", r.Key, strings.Join(r.Argv, " "))

	// Hold the ticket lock for the whole session, so a second event on the
	// same ticket cannot start a second session. Waiting also reaps the child.
	if err := cmd.Wait(); err != nil {
		d.log.Printf("%s: session exited with an error: %v", r.Key, err)
		fmt.Fprintf(logFile, "session exited with an error: %v\n", err)
	}
}

// StartDetached starts argv without waiting for it to finish. The child gets
// its own session, so restarting the receiver does not signal a running
// session.
func StartDetached(argv []string, dir string, out io.Writer) (*exec.Cmd, error) {
	if len(argv) == 0 {
		return nil, fmt.Errorf("empty argv")
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = dir
	cmd.Stdout = out
	cmd.Stderr = out
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return cmd, nil
}

// Substitute replaces placeholders in one string.
func Substitute(text string, values map[string]string) string {
	pairs := make([]string, 0, len(values)*2)
	for key, value := range values {
		pairs = append(pairs, key, value)
	}
	return strings.NewReplacer(pairs...).Replace(text)
}

// SubstituteArgv replaces placeholders in each argv element. Every element is
// replaced independently, so a value never changes the shape of the command.
func SubstituteArgv(argv []string, values map[string]string) []string {
	out := make([]string, 0, len(argv))
	for _, arg := range argv {
		out = append(out, Substitute(arg, values))
	}
	return out
}

func writeJSON(path string, value any) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	return enc.Encode(value)
}

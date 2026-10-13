package main

import (
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func testConfig(t *testing.T) *Config {
	t.Helper()
	marker := filepath.Join(t.TempDir(), "workmode")
	if err := os.WriteFile(marker, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	return &Config{
		WorkModePath:  marker,
		AllowedEvents: []string{"jira:issue_assigned"},
		AllowedActors: []string{"me@example.com"},
		TriggerLabels: []string{"agent-ready"},
		Projects: map[string]Project{
			"ADAM": {Workspace: "/tmp/ws", Launch: []string{"true"}, PromptTemplate: "do {key}"},
		},
	}
}

func testPayload(t *testing.T, event, key string, labels []string, actor string) *Payload {
	t.Helper()
	p := &Payload{WebhookEvent: event, Timestamp: 1750000000}
	p.Issue.Key = key
	p.Issue.ID = "1"
	p.Issue.Fields.Summary = "Fix the thing"
	p.Issue.Fields.Labels = labels
	p.User.EmailAddress = actor
	p.Changelog.ID = "chg-1"
	return p
}

func TestVerifySignature(t *testing.T) {
	secret := "s3cret"
	body := []byte(`{"webhookEvent":"jira:issue_assigned"}`)
	good := "sha256=" + hex.EncodeToString(hmacSHA256(secret, body))

	if !VerifySignature(secret, body, good) {
		t.Error("a correct sha256= signature must be accepted")
	}
	if !VerifySignature(secret, body, hex.EncodeToString(hmacSHA256(secret, body))) {
		t.Error("a bare hex signature must be accepted")
	}
	if VerifySignature(secret, body, "sha256="+hex.EncodeToString(hmacSHA256("other", body))) {
		t.Error("a signature from another secret must be rejected")
	}
	if VerifySignature(secret, body, "") {
		t.Error("an empty header must be rejected")
	}
	if VerifySignature(secret, body, "sha256=not-hex") {
		t.Error("a malformed signature must be rejected")
	}
	if VerifySignature(secret, body, "sha1="+hex.EncodeToString(hmacSHA256(secret, body))) {
		t.Error("another algorithm must be rejected")
	}
}

func TestEvaluateAcceptsTheHappyPath(t *testing.T) {
	cfg := testConfig(t)
	p := testPayload(t, "jira:issue_assigned", "ADAM-1", []string{"agent-ready"}, "me@example.com")
	if got := Evaluate(cfg, p); got.Kind != KindDispatch {
		t.Fatalf("want a dispatch, got %s (%s)", got.Kind, got.Reason)
	}
}

func TestEvaluateFilters(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*Config, *Payload)
	}{
		{"work mode off", func(c *Config, p *Payload) { c.WorkModePath = "/does/not/exist" }},
		{"event not allowed", func(c *Config, p *Payload) { p.WebhookEvent = "jira:issue_deleted" }},
		{"actor is not allowed", func(c *Config, p *Payload) { p.User.EmailAddress = "other@example.com" }},
		{"missing trigger label", func(c *Config, p *Payload) { p.Issue.Fields.Labels = []string{"chore"} }},
		{"unknown project", func(c *Config, p *Payload) { p.Issue.Key = "OTHER-1" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := testConfig(t)
			p := testPayload(t, "jira:issue_assigned", "ADAM-1", []string{"agent-ready"}, "me@example.com")
			tc.mutate(cfg, p)
			got := Evaluate(cfg, p)
			if got.Kind != KindIgnore {
				t.Fatalf("want ignored, got %s (%s)", got.Kind, got.Reason)
			}
			if got.Reason == "" {
				t.Error("an ignored event must carry a reason")
			}
		})
	}
}

func TestEmptyFilterListsAcceptAnything(t *testing.T) {
	cfg := testConfig(t)
	cfg.AllowedActors = nil
	cfg.TriggerLabels = nil
	p := testPayload(t, "jira:issue_assigned", "ADAM-1", nil, "anyone@example.com")
	if got := Evaluate(cfg, p); got.Kind != KindDispatch {
		t.Fatalf("empty filters must accept anything, got %s (%s)", got.Kind, got.Reason)
	}
}

func TestProjectKey(t *testing.T) {
	p := testPayload(t, "jira:issue_assigned", "ADAM-1234", nil, "me@example.com")
	if got := p.ProjectKey(); got != "ADAM" {
		t.Fatalf("want ADAM, got %s", got)
	}
}

func TestEventIDUsesTheChangelogOrTheTimestamp(t *testing.T) {
	withChangelog := testPayload(t, "jira:issue_updated", "ADAM-1", nil, "me@example.com")
	if got := withChangelog.EventID(); got != "chg-1" {
		t.Fatalf("want the changelog id, got %s", got)
	}

	withoutChangelog := testPayload(t, "jira:issue_assigned", "ADAM-1", nil, "me@example.com")
	withoutChangelog.Changelog = Changelog{}
	first := withoutChangelog.EventID()
	if first != withoutChangelog.EventID() {
		t.Fatal("the event id must be stable for the same payload")
	}

	other := testPayload(t, "jira:issue_assigned", "ADAM-1", nil, "me@example.com")
	other.Changelog = Changelog{}
	other.Timestamp++
	if other.EventID() == first {
		t.Fatal("a different timestamp must produce a different event id")
	}
}

func TestSubstituteDoesNotRescanTheValue(t *testing.T) {
	// The summary itself contains a placeholder. It must survive as text.
	got := Substitute("{key}: {summary}", map[string]string{
		"{key}":     "ADAM-1",
		"{summary}": "rename {key} everywhere",
	})
	want := "ADAM-1: rename {key} everywhere"
	if got != want {
		t.Fatalf("want %q, got %q", want, got)
	}
}

func TestSubstituteArgvKeepsTheShape(t *testing.T) {
	argv := SubstituteArgv([]string{"run", "--title", "{key}", "{prompt}"}, map[string]string{
		"{key}":    "ADAM-1",
		"{prompt}": "line one\nline two",
	})
	if len(argv) != 4 {
		t.Fatalf("want 4 elements, got %d: %v", len(argv), argv)
	}
	if argv[2] != "ADAM-1" {
		t.Fatalf("want ADAM-1, got %q", argv[2])
	}
	if argv[3] != "line one\nline two" {
		t.Fatalf("the prompt must stay one element, got %q", argv[3])
	}
}

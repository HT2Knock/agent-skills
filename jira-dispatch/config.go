package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Project holds everything that differs between Jira projects. One accepted
// ticket becomes one OpenCode session in one workspace.
type Project struct {
	// Workspace is the directory the session runs in. It must exist by the
	// time Prepare finishes.
	Workspace string `json:"workspace"`
	// PrepareDir is the directory Prepare runs in. Empty means Workspace.
	PrepareDir string `json:"prepareDir"`
	// Prepare runs once before the session starts. Argv form, no shell.
	Prepare []string `json:"prepare"`
	// Launch starts the session. Argv form, no shell. It runs detached, so
	// the webhook answers before the session finishes. In addition to the
	// placeholders above, {prompt} expands to the rendered PromptTemplate as
	// one argv element, so a newline in the prompt is safe.
	Launch []string `json:"launch"`
	// PromptTemplate is the message sent to the session.
	// Placeholders: {key} {project} {summary} {url} {workspace}
	PromptTemplate string `json:"promptTemplate"`
}

type Config struct {
	Listen string `json:"listen"`
	// SecretEnv names the environment variable that holds the webhook secret.
	// The secret itself never appears in this file.
	SecretEnv string `json:"secretEnv"`
	StateDir  string `json:"stateDir"`
	// WorkModePath is a marker file. When it does not exist, the receiver
	// accepts the event and starts nothing.
	WorkModePath string `json:"workModePath"`
	JiraBaseURL  string `json:"jiraBaseUrl"`
	// AllowedActors lists the account emails or ids whose events may start a
	// session. Empty means any actor.
	AllowedActors []string `json:"allowedActors"`
	// AllowedEvents lists accepted webhookEvent values. Empty means any.
	AllowedEvents []string `json:"allowedEvents"`
	// TriggerLabels: the issue must carry one of these labels. Empty means
	// any issue. This is the deliberate hand-off switch.
	TriggerLabels []string `json:"triggerLabels"`
	// LockTTLHours bounds how long one ticket stays single-flight. A run
	// longer than this may be started twice.
	LockTTLHours float64            `json:"lockTtlHours"`
	Projects     map[string]Project `json:"projects"`
}

// DefaultConfig returns the values used when the file omits a field.
func DefaultConfig() Config {
	home, _ := os.UserHomeDir()
	return Config{
		Listen:        "127.0.0.1:8787",
		SecretEnv:     "JIRA_WEBHOOK_SECRET",
		StateDir:      filepath.Join(home, ".local", "state", "jira-dispatch"),
		WorkModePath:  filepath.Join(home, ".local", "state", "agent-work-mode"),
		AllowedEvents: []string{"jira:issue_assigned", "jira:issue_updated"},
		TriggerLabels: []string{"agent-ready"},
		LockTTLHours:  6,
	}
}

// LoadConfig reads the file, fills the defaults, and checks that the result
// can run. Unknown keys are an error, so a typo fails loudly at start.
func LoadConfig(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	cfg := DefaultConfig()
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cfg); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}

	if cfg.StateDir, err = expandHome(cfg.StateDir); err != nil {
		return nil, err
	}
	if cfg.WorkModePath, err = expandHome(cfg.WorkModePath); err != nil {
		return nil, err
	}
	for key, proj := range cfg.Projects {
		proj.Workspace, err = expandHome(proj.Workspace)
		if err != nil {
			return nil, err
		}
		if proj.PrepareDir == "" {
			proj.PrepareDir = proj.Workspace
		} else if proj.PrepareDir, err = expandHome(proj.PrepareDir); err != nil {
			return nil, err
		}
		proj.Prepare = expandArgvHome(proj.Prepare)
		proj.Launch = expandArgvHome(proj.Launch)
		cfg.Projects[key] = proj
	}

	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func (c *Config) validate() error {
	if c.SecretEnv == "" {
		return fmt.Errorf("secretEnv must name an environment variable")
	}
	if c.Listen == "" {
		return fmt.Errorf("listen must not be empty")
	}
	for key, proj := range c.Projects {
		if len(proj.Launch) == 0 {
			return fmt.Errorf("project %s: launch must not be empty", key)
		}
		if proj.Workspace == "" {
			return fmt.Errorf("project %s: workspace must not be empty", key)
		}
		if proj.PromptTemplate == "" {
			return fmt.Errorf("project %s: promptTemplate must not be empty", key)
		}
	}
	return nil
}

// Secret reads the webhook secret from the configured environment variable.
func (c *Config) Secret() (string, error) {
	secret := os.Getenv(c.SecretEnv)
	if secret == "" {
		return "", fmt.Errorf("environment variable %s is empty", c.SecretEnv)
	}
	return secret, nil
}

// WorkModeOff reports whether the work-mode marker file is absent. A missing
// marker means "not at work", so the receiver starts nothing.
func (c *Config) WorkModeOff() bool {
	_, err := os.Stat(c.WorkModePath)
	return err != nil
}

func expandHome(path string) (string, error) {
	if path == "" || path[0] != '~' {
		return path, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if path == "~" {
		return home, nil
	}
	if !strings.HasPrefix(path, "~/") {
		return path, nil
	}
	return filepath.Join(home, path[2:]), nil
}

func expandArgvHome(argv []string) []string {
	out := make([]string, 0, len(argv))
	for _, arg := range argv {
		expanded, err := expandHome(arg)
		if err != nil {
			expanded = arg
		}
		out = append(out, expanded)
	}
	return out
}

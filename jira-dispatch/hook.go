package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"strings"
)

// maxBodyBytes bounds how much of a request body the receiver reads.
const maxBodyBytes = 1 << 20

// Account is the shape Jira uses for an issue assignee and for the user who
// made the change.
type Account struct {
	AccountID    string `json:"accountId"`
	EmailAddress string `json:"emailAddress"`
	DisplayName  string `json:"displayName"`
}

type ChangelogItem struct {
	Field      string `json:"field"`
	FromString string `json:"fromString"`
	ToString   string `json:"toString"`
}

type Changelog struct {
	ID    string          `json:"id"`
	Items []ChangelogItem `json:"items"`
}

type IssueFields struct {
	Summary  string   `json:"summary"`
	Labels   []string `json:"labels"`
	Assignee *Account `json:"assignee"`
	Reporter *Account `json:"reporter"`
	Priority *struct {
		Name string `json:"name"`
	} `json:"priority"`
	IssueType *struct {
		Name string `json:"name"`
	} `json:"issuetype"`
}

type Issue struct {
	ID     string      `json:"id"`
	Key    string      `json:"key"`
	Self   string      `json:"self"`
	Fields IssueFields `json:"fields"`
}

// Payload is the part of a Jira webhook body the receiver reads. Jira sends
// more; unknown fields are ignored.
type Payload struct {
	WebhookEvent string    `json:"webhookEvent"`
	Timestamp    int64     `json:"timestamp"`
	Issue        Issue     `json:"issue"`
	User         Account   `json:"user"`
	Changelog    Changelog `json:"changelog"`
}

func ParsePayload(body []byte) (*Payload, error) {
	var p Payload
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, err
	}
	if p.WebhookEvent == "" {
		return nil, fmt.Errorf("body has no webhookEvent")
	}
	if p.Issue.Key == "" {
		return nil, fmt.Errorf("body has no issue.key")
	}
	return &p, nil
}

// ProjectKey returns the project part of the issue key, for example ADAM.
func (p *Payload) ProjectKey() string {
	if i := strings.IndexByte(p.Issue.Key, '-'); i > 0 {
		return p.Issue.Key[:i]
	}
	return p.Issue.Key
}

// EventID is the dedupe key. Jira delivers at least once, so the same event
// can arrive more than once.
func (p *Payload) EventID() string {
	if p.Changelog.ID != "" {
		return p.Changelog.ID
	}
	return fmt.Sprintf("%s:%s:%d:%d", p.WebhookEvent, p.Issue.Key, p.Timestamp, p.changeDigest())
}

// changeDigest makes two events that share a timestamp and an event type
// distinguishable by their changelog content.
func (p *Payload) changeDigest() uint32 {
	hasher := fnv.New32a()
	for _, item := range p.Changelog.Items {
		fmt.Fprintf(hasher, "%s|%s|%s\n", item.Field, item.FromString, item.ToString)
	}
	return hasher.Sum32()
}

func (p *Payload) BrowseURL(base string) string {
	base = strings.TrimRight(base, "/")
	if base == "" {
		return ""
	}
	return base + "/browse/" + p.Issue.Key
}

// VerifySignature checks a Jira Cloud webhook signature header. Jira sends
// X-Hub-Signature with the form "sha256=<hex>". The comparison is constant
// time.
func VerifySignature(secret string, body []byte, header string) bool {
	header = strings.TrimSpace(header)
	if header == "" || secret == "" {
		return false
	}
	want := hmacSHA256(secret, body)
	for _, part := range strings.Split(header, ",") {
		value := strings.TrimSpace(part)
		if i := strings.IndexByte(value, '='); i >= 0 {
			if algo := strings.ToLower(strings.TrimSpace(value[:i])); algo != "sha256" {
				continue
			}
			value = strings.TrimSpace(value[i+1:])
		}
		got, err := hex.DecodeString(value)
		if err != nil {
			continue
		}
		if hmac.Equal(got, want) {
			return true
		}
	}
	return false
}

func hmacSHA256(secret string, body []byte) []byte {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return mac.Sum(nil)
}

// Decision kinds. The HTTP handler maps each to a status code.
const (
	KindDispatch  = "dispatched"
	KindIgnore    = "ignored"
	KindDuplicate = "duplicate"
	KindInFlight  = "in-flight"
	// KindRejected means the receiver accepted the event and could not act on
	// it. It maps to a 5xx so Jira retries.
	KindRejected = "rejected"
)

type Decision struct {
	Kind   string
	Reason string
}

func ignore(reason string) Decision {
	return Decision{Kind: KindIgnore, Reason: reason}
}

// Evaluate applies the read-only filters: work mode, event type, actor and
// trigger label. It has no side effects, so it is safe to call twice and easy
// to test.
func Evaluate(cfg *Config, p *Payload) Decision {
	if cfg.WorkModeOff() {
		return ignore("work mode is off")
	}
	if !containsFold(cfg.AllowedEvents, p.WebhookEvent) {
		return ignore("event not in allowedEvents: " + p.WebhookEvent)
	}
	if len(cfg.AllowedActors) > 0 && !matchesActor(cfg.AllowedActors, p.User) {
		return ignore("actor is not allowed: " + p.User.EmailAddress + p.User.AccountID)
	}
	if len(cfg.TriggerLabels) > 0 && !hasAnyLabel(p.Issue.Fields.Labels, cfg.TriggerLabels) {
		return ignore("issue has none of the trigger labels")
	}
	// A session comments on its own ticket. Without this rule, that comment is
	// an issue_updated event, the label is still present, and the receiver
	// starts a second session on the work the first one just reported. Accept
	// an update only when it added a trigger label.
	if len(cfg.TriggerLabels) > 0 && p.WebhookEvent == "jira:issue_updated" && !p.addsTriggerLabel(cfg.TriggerLabels) {
		return ignore("this change did not add a trigger label")
	}
	if _, ok := cfg.Projects[p.ProjectKey()]; !ok {
		return ignore("no project mapping for " + p.ProjectKey())
	}
	return Decision{Kind: KindDispatch, Reason: "accepted"}
}

func containsFold(haystack []string, needle string) bool {
	for _, item := range haystack {
		if strings.EqualFold(item, needle) {
			return true
		}
	}
	return false
}

func matchesActor(allowed []string, user Account) bool {
	for _, item := range allowed {
		if strings.EqualFold(item, user.EmailAddress) || (user.AccountID != "" && item == user.AccountID) {
			return true
		}
	}
	return false
}

func hasAnyLabel(have []string, want []string) bool {
	for _, w := range want {
		for _, h := range have {
			if strings.EqualFold(h, w) {
				return true
			}
		}
	}
	return false
}

// addsTriggerLabel reports whether this change added one of the labels. Jira
// lists the label field's before and after values as space or comma separated
// text.
func (p *Payload) addsTriggerLabel(want []string) bool {
	for _, item := range p.Changelog.Items {
		if !strings.EqualFold(item.Field, "labels") {
			continue
		}
		added := strings.FieldsFunc(item.ToString, func(r rune) bool {
			return r == ' ' || r == ','
		})
		if hasAnyLabel(added, want) {
			return true
		}
	}
	return false
}

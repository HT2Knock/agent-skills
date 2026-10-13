// Command jira-dispatch receives Jira Cloud webhooks and starts one OpenCode
// session per accepted ticket.
//
// It verifies the webhook signature, filters the event, records it, and
// launches the session detached. It answers the webhook before the session
// finishes, because Jira times out a slow endpoint.
package main

import (
	"encoding/json"
	"flag"
	"io"
	"log"
	"net"
	"net/http"
	"os"
)

type Server struct {
	cfg    *Config
	secret string
	disp   *Dispatcher
	log    *log.Logger
}

func main() {
	configPath := flag.String("config", "config.json", "path to the config file")
	addr := flag.String("addr", "", "override the listen address; a port of 0 picks a free one")
	flag.Parse()

	logger := log.New(os.Stderr, "", log.LstdFlags|log.LUTC)

	cfg, err := LoadConfig(*configPath)
	if err != nil {
		logger.Fatalf("config: %v", err)
	}
	if *addr != "" {
		cfg.Listen = *addr
	}
	secret, err := cfg.Secret()
	if err != nil {
		logger.Fatalf("secret: %v", err)
	}

	server := &Server{
		cfg:    cfg,
		secret: secret,
		disp:   NewDispatcher(cfg, logger),
		log:    logger,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /jira/hook", server.handleHook)
	mux.HandleFunc("GET /healthz", server.handleHealth)

	listener, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		logger.Fatalf("listen: %v", err)
	}

	// The tests read this line to learn the port when the config asks for 0.
	logger.Printf("listening on http://%s", listener.Addr())
	os.Stdout.WriteString("listening on http://" + listener.Addr().String() + "\n")

	if err := http.Serve(listener, mux); err != nil {
		logger.Fatalf("serve: %v", err)
	}
}

// response is the JSON body the receiver returns. It exists so a caller can
// see why an event did or did not start a session.
type response struct {
	Kind   string `json:"kind"`
	Reason string `json:"reason"`
	Key    string `json:"key,omitempty"`
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	workMode := "off"
	if !s.cfg.WorkModeOff() {
		workMode = "on"
	}
	writeResponse(w, http.StatusOK, response{Kind: "ok", Reason: "work mode " + workMode})
}

func (s *Server) handleHook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes+1))
	if err != nil {
		writeResponse(w, http.StatusBadRequest, response{Kind: "rejected", Reason: "cannot read body: " + err.Error()})
		return
	}
	if len(body) > maxBodyBytes {
		writeResponse(w, http.StatusRequestEntityTooLarge, response{Kind: "rejected", Reason: "body too large"})
		return
	}

	if !VerifySignature(s.secret, body, r.Header.Get("X-Hub-Signature")) {
		s.log.Printf("rejected an unsigned or wrongly signed request from %s", r.RemoteAddr)
		writeResponse(w, http.StatusUnauthorized, response{Kind: "rejected", Reason: "bad or missing signature"})
		return
	}

	payload, err := ParsePayload(body)
	if err != nil {
		writeResponse(w, http.StatusBadRequest, response{Kind: "rejected", Reason: err.Error()})
		return
	}

	decision := Evaluate(s.cfg, payload)
	if decision.Kind == KindDispatch {
		decision = s.disp.Dispatch(payload, body)
	}

	status := http.StatusOK
	if decision.Kind == KindDispatch {
		status = http.StatusAccepted
	}
	s.log.Printf("%s %s -> %s (%s)", payload.WebhookEvent, payload.Issue.Key, decision.Kind, decision.Reason)
	writeResponse(w, status, response{Kind: decision.Kind, Reason: decision.Reason, Key: payload.Issue.Key})
}

func writeResponse(w http.ResponseWriter, status int, body response) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

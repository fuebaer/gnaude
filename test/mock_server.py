#!/usr/bin/env python3
"""Fake Anthropic Messages API for local tests (no network, no API costs).

Every answer starts with a thinking block whose signature binds it to the
conversation prefix (system prompt + all earlier messages), like the real API.
A request that replays a thinking block after its prefix changed gets the
API's 400 "bound to a different conversation" error.

The reply depends on the last user message:
  contains "AUTHFAIL" -> HTTP 401 error body
  contains "REFUSE"   -> streamed refusal (stop_reason "refusal")
  contains "SLOW"     -> streamed answer with a delay between deltas
  otherwise           -> streamed Markdown answer naming the question number

GET /last returns the headers and body of the most recent POST as JSON.
Usage: mock_server.py PORT
"""

import hashlib
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ANSWER = [
    "# Antwort {n}\n\n",
    "Das ist **fett**, das *kursiv* und `code`.\n\n",
    "- Punkt eins\n- Punkt zwei\n\n",
    "```python\nprint('hallo <welt>')\n```\n",
    "Fertig & gut.",
]

last_request = {}


def signature(system, messages):
    prefix = json.dumps({"system": system, "messages": messages},
                        sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return "sig_" + hashlib.sha256(prefix.encode()).hexdigest()[:32]


def invalid_thinking(body):
    """Path of the first replayed thinking block whose prefix changed, if any."""
    messages = body["messages"]
    for i, message in enumerate(messages):
        if message["role"] != "assistant" or isinstance(message["content"], str):
            continue
        for j, block in enumerate(message["content"]):
            if block.get("type") == "thinking" and \
                    block.get("signature") != signature(body.get("system"), messages[:i]):
                return f"messages.{i}.content.{j}"
    return None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"  # close-delimited body, like a streamed response

    def log_message(self, *args):
        pass

    def do_GET(self):
        body = json.dumps(last_request).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length))
        last_request.clear()
        last_request.update(headers={k.lower(): v for k, v in self.headers.items()}, body=body)

        messages = body["messages"]
        prompt = messages[-1]["content"]
        if "AUTHFAIL" in prompt:
            return self.error(401, "authentication_error", "invalid x-api-key")
        if path := invalid_thinking(body):
            return self.error(400, "invalid_request_error",
                              f"{path}: Invalid `signature` in `thinking` block. "
                              "The block is bound to a different conversation.")

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        self.event("message_start", {"message": {"id": "msg_test", "model": body["model"]}})

        if "REFUSE" in prompt:
            self.event("content_block_start", {"index": 0, "content_block": {"type": "text", "text": ""}})
            self.event("content_block_delta", {"index": 0, "delta": {"type": "text_delta", "text": "Teilweise"}})
            self.event("message_delta", {"delta": {"stop_reason": "refusal",
                                                   "stop_details": {"type": "refusal", "category": "cyber"}}})
            return self.event("message_stop", {})

        self.event("content_block_start",
                   {"index": 0, "content_block": {"type": "thinking", "thinking": "", "signature": ""}})
        self.event("ping", {})
        self.event("content_block_delta", {"index": 0, "delta": {
            "type": "signature_delta", "signature": signature(body.get("system"), messages)}})
        self.event("content_block_stop", {"index": 0})
        self.event("content_block_start", {"index": 1, "content_block": {"type": "text", "text": ""}})
        question = sum(1 for m in messages if m["role"] == "user")
        for chunk in ANSWER:
            if "SLOW" in prompt:
                time.sleep(1.5)
            self.event("content_block_delta",
                       {"index": 1, "delta": {"type": "text_delta", "text": chunk.replace("{n}", str(question))}})
        self.event("content_block_stop", {"index": 1})
        self.event("message_delta", {"delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 42}})
        self.event("message_stop", {})

    def event(self, kind, payload):
        payload = {"type": kind, **payload}
        self.wfile.write(f"event: {kind}\ndata: {json.dumps(payload)}\n\n".encode())
        self.wfile.flush()

    def error(self, status, kind, message):
        body = json.dumps({"type": "error", "error": {"type": kind, "message": message}}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()

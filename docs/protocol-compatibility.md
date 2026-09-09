# Protocol compatibility matrix

This document mirrors the machine-readable contract in
`apps/api/src/protocol-compatibility.ts`. The service is a Claude-compatible
surface backed by a ChatGPT/Codex text backend; it is not a full semantic
bridge.

## Status legend

Only these status values are used by the manifest:

- `supported`: implemented behavior with direct support.
- `partial`: implemented subset; some semantics are not complete.
- `downgraded`: preserved in Canonical IR but represented as an explicit fallback.
- `estimated`: locally calculated value, not provider/tokenizer parity.
- `unsupported`: rejected or not implemented.
- `backend_dependent`: mapped safely where possible, but upstream support determines the result.

## Claude Messages API

| Manifest feature | Status | Notes |
| --- | --- | --- |
| `messages_non_stream_text` | `supported` | Text input maps to backend text and returns Claude-shaped responses. |
| `messages_stream_text` | `supported` | Text streaming emits Claude SSE text block events. |
| `models` | `supported` | Enabled, resolvable aliases and discovered passthrough models are listed. |
| `count_tokens` | `estimated` | Returns a local heuristic estimate, not Anthropic tokenizer parity. |
| `tools_and_tool_choice` | `backend_dependent` | Typed and mapped where possible; backend execution is not guaranteed. |
| `tool_result_and_tool_use_blocks` | `downgraded` | Preserved in Canonical IR and flattened when the backend cannot represent them. |
| `image_blocks` | `downgraded` | Preserved in Canonical IR and rendered as an explicit fallback for text backends. |
| `thinking_blocks` | `downgraded` | Preserved in Canonical IR and rendered as explicit placeholders. |
| `input_json_delta` | `unsupported` | Tool streaming is not implemented. |
| `thinking_and_signature_deltas` | `unsupported` | Thinking streaming is not implemented. |
| `usage_accounting` | `estimated` | Usage is estimated unless upstream usage is available. |
| `stop_reasons_and_error_envelopes` | `partial` | Common backend results and validation failures are mapped. |

## Client base-URL cookbook

Use the root service origin (`http://127.0.0.1:3000`) for Claude Code and Anthropic SDK clients because they append `/v1/...` request paths. Use the versioned URL (`http://127.0.0.1:3000/v1`) for OpenAI SDK clients because they address compatibility resources relative to that prefix. A root URL is therefore incorrect for a versioned client that does not append `/v1`, while adding `/v1` to a client that already appends it produces a duplicated path.

- Claude Code / Anthropic SDK: root origin; Messages calls resolve to `POST /v1/messages`.
- OpenAI SDK: versioned `/v1` origin; Chat Completions resolve to `POST /v1/chat/completions` and Responses to `POST /v1/responses`.
- `POST /v1/messages/count_tokens` always returns the Claude-shaped `{ "input_tokens": number }` body and labels the local heuristic with `x-chat2claude-token-count-mode: heuristic`.
- `GET /v1/models` retains the OpenAI-style top-level `{ "data": [...] }` shape. Entries can expose capabilities and `token_counting_mode` metadata.

## Real-client smoke scenarios

Use a Runtime API Key for all client smokes; do not use an Admin API Key as a normal client credential.

| Client | Base URL | Primary smoke endpoints | Notes |
| --- | --- | --- | --- |
| Claude Code | `http://127.0.0.1:3000` | `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models` | Set `ANTHROPIC_BASE_URL` to the root origin because Claude Code appends `/v1` paths. |
| Anthropic SDK | `http://127.0.0.1:3000` | `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models` | Set `baseURL` to the root origin because the SDK appends Claude-compatible `/v1` paths. |
| OpenAI SDK | `http://127.0.0.1:3000/v1` | `/v1/chat/completions`, `/v1/responses`, `/v1/models` | Set `baseURL` to the versioned origin for OpenAI-compatible resources. |
| Cline | `http://127.0.0.1:3000` | `/v1/messages`, `/v1/models` | Use an Anthropic/Claude-compatible custom provider pointed at the root origin. |
| Roo | `http://127.0.0.1:3000` | `/v1/messages`, `/v1/models` | Use an Anthropic/Claude-compatible custom provider pointed at the root origin. |
| Continue | `http://127.0.0.1:3000/v1` | `/v1/chat/completions`, `/v1/models` | Use an OpenAI-compatible provider pointed at the versioned origin. |
| Cherry Studio | `http://127.0.0.1:3000/v1` | `/v1/chat/completions`, `/v1/models` | Use an OpenAI-compatible provider pointed at the versioned origin. |

## OpenAI compatibility routes

| Protocol | Manifest feature | Status | Notes |
| --- | --- | --- | --- |
| Chat Completions | `text_and_streaming` | `supported` | Text responses and SSE chunks use OpenAI-like shapes. |
| Chat Completions | `content_parts_tools_and_structured_output` | `backend_dependent` | Mapped where possible; strict semantics depend on the backend. |
| Responses | `text_and_streaming` | `supported` | Common response objects and SSE events are emitted. |
| Responses | `input_tools_and_continuation_options` | `backend_dependent` | Mapped or locally retained where documented; upstream support varies. |

## ChatGPT/Codex backend

| Manifest feature | Status | Notes |
| --- | --- | --- |
| `dynamic_model_discovery` | `supported` | Backend model catalogs are discovered dynamically. |
| `oauth_authorization_and_text_completion` | `partial` | Implemented with backend-dependent upstream availability. |
| `reasoning_and_speed_selection` | `backend_dependent` | Controls are resolved safely but provider support varies. |
| `images_and_tool_calls` | `unsupported` | Backend mappings are not implemented. |
| `real_usage` | `unsupported` | Upstream usage parsing is not implemented. |

## Design direction

1. Parse Claude/OpenAI requests into Canonical IR.
2. Preserve non-text semantics in IR.
3. Return an explicit fallback or error when the selected backend cannot support a feature.
4. Never silently drop content blocks.
5. Add provider adapters incrementally while preserving existing streaming behavior.

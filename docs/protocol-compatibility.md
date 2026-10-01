# Protocol compatibility matrix

This document mirrors the machine-readable contract in
`apps/api/src/protocol-compatibility.ts`. The service is a Claude-compatible
surface backed by a ChatGPT/Codex text backend; it is not a full semantic
bridge.

## Status legend

Only these status values are used by the manifest:

- `supported`: implemented behavior with direct support.
- `partial`: implemented subset; some semantics are not complete.
- `downgraded`: preserved in Canonical IR but represented as an explicit fallback or safe omission.
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
| `tool_result_and_tool_use_blocks` | `backend_dependent` | Mapped to native function calls and outputs, including text/image tool results, for the session backend; text-only backends receive a fallback. |
| `image_blocks` | `backend_dependent` | URL and base64 images map to native input images for the session backend; model vision support is required. |
| `thinking_blocks` | `downgraded` | Client-supplied thinking blocks are preserved in Canonical IR but not replayed to text backends; readable upstream reasoning output streams separately via thinking_and_signature_deltas. |
| `input_json_delta` | `supported` | Upstream function-call arguments stream as Claude input_json_delta events. |
| `thinking_and_signature_deltas` | `partial` | Readable upstream reasoning text streams as Claude thinking_delta; signatures are unavailable. |
| `safe_progress_status_deltas` | `partial` | Safe lifecycle and tool progress statuses are internal diagnostics; they may open an empty thinking block but are omitted from Claude thinking_delta content. |
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
| Responses | `image_generation_output_streaming` | `partial` | Safe allowlisted image-generation results are emitted as Responses output items; upstream image availability remains backend-dependent. |

Native Responses preserves message IDs, text/refusal content, and the order of the safe output projection. Added-item and added-content events use consecutive indexes for SDK compatibility. When preceding output items or content parts cannot yet be projected safely, affected text is buffered until the completed snapshot supplies their order. A validated encrypted reasoning prefix can be published before live message text. Claude and Chat Completions continue to expose text/refusal deltas directly.

## ChatGPT/Codex backend

| Manifest feature | Status | Notes |
| --- | --- | --- |
| `dynamic_model_discovery` | `supported` | Backend model catalogs are discovered dynamically. |
| `oauth_authorization_and_text_completion` | `partial` | Implemented with backend-dependent upstream availability. |
| `reasoning_and_speed_selection` | `backend_dependent` | Ordinary effort values are preserved; Ultra resolves a base effort and encourages delegation through caller-supplied tools. Provider and client support determine execution. |
| `image_generation_output` | `backend_dependent` | Safe image-generation output fields are mapped for OpenAI Responses only when supplied by the upstream backend. |
| `tool_calls` | `backend_dependent` | Function tools, tool choice, argument deltas, and results are mapped; availability and execution depend on the model and caller. |
| `real_usage` | `partial` | Upstream input/output token counts are parsed when present; missing usage uses a local estimate. |

## Design direction

Reasoning effort is validated against the selected account's discovered model controls. Ordinary efforts, including `max`, `xhigh`, and future provider IDs, retain their original values. Known spelling aliases are resolved only after checking for an exact native match, and unknown IDs retain case and underscores. Unsupported explicit efforts are rejected before dispatch.

Ultra is a mode adaptation. The selected value remains `ultra`, while upstream `reasoning.effort` follows the [Codex 0.155.0-alpha.9.2 resolver](https://github.com/openai/codex/blob/4607249e430dac1c961df4dc615beae88e33cec8/codex-rs/protocol/src/openai_models/reasoning_effort.rs#L10): a supported `multi_agent_reasoning_effort`, then supported `max`, then the last non-Ultra option, then `medium`. A developer instruction encourages proactive delegation through the caller's existing tools. The service does not create subagents or send a hosted multi-agent flag. Actual delegation, concurrency, and turns remain the client's responsibility; a client without delegation tools uses the main model directly. `capabilities.ultra_execution` exposes the resolved effort and `delegation: "caller_tools"`. This is not the complete Codex runtime or a guarantee of equivalent execution. See the usage guides for protocol field precedence, effective-default metadata, and implicit-default fallback behavior.

Different account catalogs can resolve the same model's Ultra selection to different base efforts. Aggregated `ultra_execution` then exposes `account_dependent: true` without a single `reasoning_effort`; effective defaults expose `reasoning_account_dependent: true` without `upstream_reasoning_effort`. The base effort is resolved from the selected account's catalog during request routing, not from the union of account capabilities.

1. Parse Claude/OpenAI requests into Canonical IR.
2. Preserve non-text semantics in IR.
3. Return an explicit fallback or error when the selected backend cannot support a feature.
4. Never silently drop content blocks.
5. Add provider adapters incrementally while preserving existing streaming behavior.

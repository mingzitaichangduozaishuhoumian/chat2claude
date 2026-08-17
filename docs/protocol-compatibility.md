# Protocol compatibility matrix

This project is not yet a full Claude/OpenAI semantic bridge. The current implementation is a Claude-compatible API surface backed by a ChatGPT/Codex text backend, with explicit downgrade markers for non-text content so fields are no longer silently dropped.

## Status legend

- Supported: implemented and covered by tests.
- Downgraded: accepted and preserved in Canonical IR, then rendered to a text placeholder for the current backend.
- Unsupported: rejected or not implemented yet.

## Claude Messages API

| Feature | Current status | Notes |
| --- | --- | --- |
| `POST /v1/messages` non-stream text | Supported | String and text block input map to backend text. |
| `POST /v1/messages` stream text | Supported | Emits Claude SSE text block events. |
| `GET /v1/models` | Supported | Uses backend discovery plus alias overlay. |
| `POST /v1/messages/count_tokens` | Supported, estimated | Returns `{ input_tokens }` with the local length-based estimator; this is not Anthropic tokenizer parity. |
| `tools` definitions | Typed/pass-through only | Accepted by request shape, not executed by backend yet. |
| `tool_choice` | Typed/pass-through only | No backend enforcement yet. |
| `tool_result` input block | Downgraded | Preserved in Canonical IR and flattened as text for backend. |
| `tool_use` content block | Downgraded | Preserved in Canonical IR and flattened as an explicit placeholder. Real tool calling is pending. |
| `image` input block | Downgraded | Preserved in Canonical IR and flattened as `[unsupported:image]`; no image upload/multimodal backend mapping yet. |
| `thinking` / `redacted_thinking` blocks | Downgraded | Preserved in Canonical IR and flattened as explicit placeholders. Real thinking output is pending. |
| SSE `input_json_delta` | Unsupported | Pending tool streaming implementation. |
| SSE `thinking_delta` / `signature_delta` | Unsupported | Pending thinking streaming implementation. |
| Usage accounting | Downgraded | Uses estimated tokens unless upstream usage is added later. |
| Stop reasons | Partially supported | Common backend finish reasons map to Claude stop reasons. |
| Error envelope | Partially supported | Routes return Claude-like error envelopes for validation/model/auth failures. |

## OpenAI Chat Completions API

| Feature | Current status | Notes |
| --- | --- | --- |
| `POST /v1/chat/completions` non-stream text | Supported alpha | Maps OpenAI chat messages to the backend request and returns OpenAI-like chat completions. |
| `POST /v1/chat/completions` stream text | Supported alpha | Emits OpenAI SSE chat completion chunks. |
| OpenAI `messages[]` text/content parts | Partially supported | Text maps directly; image content parts are preserved as structured backend input when possible and downgraded in text fallback. |
| OpenAI `tool_calls` / `tool` messages | Partially supported | Mapped to structured backend function call/input items; backend execution support remains backend-specific. |
| `tools` / `tool_choice` | Partially supported | Function tool definitions and common choices are mapped to backend fields. |
| `response_format` structured output | Partial alpha | Accepted and mapped to backend `responsesBody.text.format` for session backend pass-through; no guarantee of strict schema enforcement. |

## OpenAI Responses API

| Feature | Current status | Notes |
| --- | --- | --- |
| `POST /v1/responses` non-stream text | Supported alpha | Maps common Responses input shapes and returns OpenAI-like response objects. |
| `POST /v1/responses` stream text | Supported alpha | Emits common Responses SSE events for text and tool-call deltas. |
| Response input items/content parts | Partially supported | Message, function call/output, text, and image input shapes are mapped where possible with explicit fallbacks. |
| Response tools/tool_choice | Partially supported | Function tools and common choices are mapped to backend fields. Responses hosted/built-in tools such as `web_search_preview`, `file_search`, and `code_interpreter` are passed through to the session backend best-effort; real support depends on ChatGPT/Codex upstream. |
| `previous_response_id`, `store`, `metadata`, `parallel_tool_calls`, `truncation`, `text` | Partial alpha | Accepted for compatibility. `store:true` only enables local short-lived `ResponsesStore` persistence for `previous_response_id` continuation and is not forwarded to ChatGPT/Codex upstream; `previous_response_id`, `metadata`, `parallel_tool_calls`, `truncation`, and `text` remain allowlisted for session backend Responses-body pass-through. |
| `response_format` structured output | Partial alpha | Used as a fallback to `text.format` when `text` is absent; strict output semantics depend on upstream backend support. |

## ChatGPT/Codex backend

| Capability | Current status | Notes |
| --- | --- | --- |
| Dynamic model discovery | Supported | `listModels(context?)` discovers backend models. |
| Codex OAuth account authorization | Supported alpha | OAuth PKCE flow provisions a runtime account/API key. |
| Text completion | Supported alpha | Session backend streams and aggregates text deltas. |
| Text streaming | Supported alpha | Backend events currently only expose text deltas and done. |
| Reasoning effort/speed selection | Downgraded | Request preferences are resolved and carried in backend request; exact upstream field support is still backend-specific. |
| Images/multimodal | Unsupported | Canonical IR now represents image blocks, but backend mapping is pending. |
| Tool calls | Unsupported | Canonical IR now represents tool blocks, but backend mapping is pending. |
| Real usage | Unsupported | Needs upstream usage parsing and pass-through. |

## Design direction

The compatibility strategy is now:

1. Parse Claude/OpenAI provider requests into Canonical IR.
2. Preserve non-text semantics in IR.
3. If the selected backend cannot support a feature, return a clear error or downgrade with explicit diagnostics/placeholders.
4. Never silently drop content blocks.
5. Add provider adapters incrementally: Claude Messages first, then OpenAI Chat Completions, then OpenAI Responses.

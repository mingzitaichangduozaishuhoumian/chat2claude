# Protocol compatibility matrix

This project is not yet a full Claude/OpenAI semantic bridge. The current implementation is a Claude-compatible API surface backed by a ChatGPT/Codex text backend, with explicit downgrade markers for non-text content so fields are no longer silently dropped.

## Status legend

- Supported: implemented and covered by tests.
- Downgraded: accepted and preserved in Canonical IR, then rendered to a text placeholder for the current backend.
- Unsupported: rejected or not implemented yet.

## Claude Messages API

| Feature | Current status | Notes |
|---|---|---|
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
|---|---|---|
| `POST /v1/chat/completions` | Unsupported | Planned after Canonical IR stabilizes. |
| OpenAI `messages[]` | Unsupported | Needs OpenAI -> Canonical adapter. |
| OpenAI `tool_calls` | Unsupported | Will map to Canonical `tool_use` / Claude `tool_use`. |
| OpenAI streaming chunks | Unsupported | Will map through Canonical stream events. |

## OpenAI Responses API

| Feature | Current status | Notes |
|---|---|---|
| `POST /v1/responses` | Unsupported | Planned later; current ChatGPT/Codex backend internally uses a responses-like endpoint but outward OpenAI Responses compatibility is not implemented. |
| Response items/reasoning/tools | Unsupported | Needs separate adapter and capability matrix. |

## ChatGPT/Codex backend

| Capability | Current status | Notes |
|---|---|---|
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

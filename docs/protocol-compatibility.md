# Protocol compatibility matrix

This document mirrors the machine-readable contract in
`apps/api/src/protocol-compatibility.ts`. The service is a Claude-compatible
surface backed by ChatGPT/Codex text and Images adapters; it is not a full semantic
bridge. Images generation and Responses image tools are separate upstream paths.

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
| `generated_image_output` | `unsupported` | Generated images return an explicit 501 error, or an SSE error after headers; use Images or Responses instead of expecting image output from Messages. |
| `thinking_blocks` | `downgraded` | Client-supplied thinking blocks are preserved in Canonical IR but not replayed to text backends; readable upstream reasoning output streams separately via thinking_and_signature_deltas. |
| `input_json_delta` | `supported` | Upstream function-call arguments stream as Claude input_json_delta events. |
| `thinking_and_signature_deltas` | `partial` | Readable upstream reasoning text streams as Claude thinking_delta; signatures are unavailable. |
| `safe_progress_status_deltas` | `partial` | Safe lifecycle and tool progress statuses are internal diagnostics; they may open an empty thinking block but are omitted from Claude thinking_delta content. |
| `usage_accounting` | `estimated` | Usage is estimated unless upstream usage is available. |
| `stop_reasons_and_error_envelopes` | `partial` | Common backend results and validation failures are mapped. |

## Client base-URL cookbook

Use the root service origin (`http://127.0.0.1:3000`) for Claude Code and Anthropic SDK clients because they append `/v1/...` request paths. Use the versioned URL (`http://127.0.0.1:3000/v1`) for OpenAI SDK clients because they address compatibility resources relative to that prefix. A root URL is therefore incorrect for a versioned client that does not append `/v1`, while adding `/v1` to a client that already appends it produces a duplicated path.

- Claude Code / Anthropic SDK: root origin; Messages calls resolve to `POST /v1/messages`.
- OpenAI SDK: versioned `/v1` origin; Chat Completions resolve to `POST /v1/chat/completions`, Responses to `POST /v1/responses`, and `images.generate` to `POST /v1/images/generations`.
- `POST /v1/messages/count_tokens` always returns the Claude-shaped `{ "input_tokens": number }` body and labels the local heuristic with `x-chat2claude-token-count-mode: heuristic`.
- `GET /v1/models` retains the OpenAI-style top-level `{ "data": [...] }` shape. Entries can expose capabilities and `token_counting_mode` metadata.

## Real-client smoke scenarios

Use a Runtime API Key for all client smokes; do not use an Admin API Key as a normal client credential.

| Client | Base URL | Primary smoke endpoints | Notes |
| --- | --- | --- | --- |
| Claude Code | `http://127.0.0.1:3000` | `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models` | Set `ANTHROPIC_BASE_URL` to the root origin because Claude Code appends `/v1` paths. |
| Anthropic SDK | `http://127.0.0.1:3000` | `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models` | Set `baseURL` to the root origin because the SDK appends Claude-compatible `/v1` paths. |
| OpenAI SDK | `http://127.0.0.1:3000/v1` | `/v1/chat/completions`, `/v1/responses`, `/v1/images/generations`, `/v1/models` | Set `baseURL` to the versioned origin for OpenAI-compatible resources. |
| Cline | `http://127.0.0.1:3000` | `/v1/messages`, `/v1/models` | Use an Anthropic/Claude-compatible custom provider pointed at the root origin. |
| Roo | `http://127.0.0.1:3000` | `/v1/messages`, `/v1/models` | Use an Anthropic/Claude-compatible custom provider pointed at the root origin. |
| Continue | `http://127.0.0.1:3000/v1` | `/v1/chat/completions`, `/v1/models` | Use an OpenAI-compatible provider pointed at the versioned origin. |
| Cherry Studio | `http://127.0.0.1:3000/v1` | `/v1/chat/completions`, `/v1/models` | Use an OpenAI-compatible provider pointed at the versioned origin. |

## OpenAI compatibility routes

| Protocol | Manifest feature | Status | Notes |
| --- | --- | --- | --- |
| Chat Completions | `text_and_streaming` | `supported` | Text responses and SSE chunks use OpenAI-like shapes. |
| Chat Completions | `content_parts_tools_and_structured_output` | `backend_dependent` | Mapped where possible; strict semantics depend on the backend. |
| Chat Completions | `generated_image_output` | `unsupported` | Generated images return an explicit 501 error, or an SSE error after headers; use Images or Responses instead of expecting image output from Chat Completions. |
| Responses | `text_and_streaming` | `supported` | Common response objects and SSE events are emitted. |
| Responses | `input_tools_and_continuation_options` | `backend_dependent` | Mapped or locally retained where documented; upstream support varies. |
| Responses | `image_generation_output_streaming` | `partial` | When upstream supplies image events, validated previews follow output_item.added and final images require a matching completed snapshot; live image-tool availability on the current Responses host has not been established. |
| Responses | `generated_image_history` | `unsupported` | Responses containing generated images are not stored, including with store=true; previous_response_id cannot continue their IDs and returns 404 without upstream dispatch. |
| Images | `generations_json` | `backend_dependent` | POST /v1/images/generations uses the current ChatGPT account and defaults to gpt-image-2; returns PNG base64 JSON for n=1..10, subject to account/model access. |
| Images | `generations_streaming` | `partial` | stream=true supports n=1 and emits only image_generation.completed after the upstream JSON result; partial_images must be 0 or omitted. |
| Images | `model_descriptor` | `supported` | GET /v1/models conditionally advertises source=image_endpoint, endpoint=/v1/images/generations and backend-dependent availability; gpt-image-2 and aliases targeting it are rejected by text routes with 400. |
| Images | `edits_variations_and_url_output` | `unsupported` | Image edits, variations, URL output, JPEG/WebP selection and compression parameters are not implemented by this Images adapter. |

Native Responses preserves message IDs, text/refusal content, and the order of the safe output projection. Added-item and added-content events use consecutive indexes for SDK compatibility. When preceding output items or content parts cannot yet be projected safely, affected text is buffered until the completed snapshot supplies their order. A validated encrypted reasoning prefix can be published before live message text. Claude and Chat Completions continue to expose text/refusal deltas directly.

Function-call argument strings are retained for Chat Completions, native Responses, and Claude streaming JSON deltas. Replay matching and tool snapshot validation compare numeric tokens without rounding through JavaScript numbers. Comparisons accept at most 64 levels of nesting; number tokens with exponents longer than 128 digits require identical spelling and may conservatively reject reformatted snapshots. Claude non-streaming `tool_use.input` also preserves upstream numeric values in HTTP JSON: numbers that would lose precision use native raw JSON primitives, while ordinary values remain normal JavaScript values. This requires Node.js 22.15.0 or a supported newer runtime with `JSON.rawJSON` and JSON parser source context; missing capabilities return a clear error. A client that parses the result into floating-point numbers can still lose precision, and values already rounded by a custom backend without the original argument string cannot be recovered.

## Image endpoint boundaries

The dedicated Images API reuses the configured ChatGPT account and the Codex 0.160 Images service. It defaults to `gpt-image-2` and returns PNG data as `data[].b64_json`. A single real generation with this model has succeeded; this does not establish access for every account or model. The JSON endpoint accepts `n=1..10`. With `stream:true`, only `n=1` is accepted, and one `image_generation.completed` SSE event is emitted after the complete upstream JSON response. It is not a preview stream: `partial_images` must be omitted or zero.

The image request has an independent `CHATGPT_IMAGE_REQUEST_TIMEOUT_MS=300000` timeout. Image payload limits count serialized base64 and metadata: 16 MiB per item, 64 MiB per bundle, at most 10 images. Responses previews are limited to three per image, 30 events and 64 MiB in total. The existing 4 MiB non-image output guard and hidden replay/cache budgets are unchanged.

Responses can forward validated `response.image_generation_call.partial_image` events and final image output items if the upstream supplies them. Each preview follows its item's added event; an uncertain preceding projection is buffered until terminal order is known. A preview is not success: the authoritative completed snapshot must contain the matching final image. This conversion is covered by synthetic Session/HTTP tests, but real image-tool execution on the current host's Responses endpoint has not been established. Use the dedicated Images route for the verified generation path.

Responses containing generated-image output are not stored, regardless of image size or `store:true`. Their returned IDs cannot be used with `previous_response_id`: the lookup returns 404 without dispatching another upstream request. Use `store:false`. Generated-image history editing/replay is not implemented.

Explicitly including an `image_generation_call` item in the input array returns 400 before account acquisition or dispatch. Ordinary `input_image` input remains supported for vision; clients must supply it explicitly instead of replaying a generated output item.

The default image descriptor in `/v1/models` is conditional on backend capability and an available account. Its `source: "image_endpoint"` is not a discovered text-model claim. Sending `gpt-image-2` or an alias bound to it to Messages, Chat Completions or Responses returns 400 with the Images endpoint. Other text requests are not preemptively rejected, but image output reaching Messages or Chat Completions produces an explicit 501 error, or the protocol's SSE error after headers, without poisoning account credentials.

See the [usage guide](USAGE.en.md#independent-gpt-image-generation) for SDK and curl examples. Protocol references: [OpenAI image generation guide](https://developers.openai.com/api/docs/guides/image-generation), [Codex image tool at 0.160](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/ext/image-generation/src/tool.rs), and [Codex Images client](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/codex-api/src/endpoint/images.rs). Public API documentation describes a broader surface than this adapter.

## ChatGPT/Codex backend

| Manifest feature | Status | Notes |
| --- | --- | --- |
| `dynamic_model_discovery` | `supported` | Backend model catalogs are discovered dynamically. |
| `context_window_metadata` | `backend_dependent` | Catalog limits are shown without inferred defaults; missing or conflicting account values remain unknown or account-dependent. |
| `oauth_authorization_and_text_completion` | `partial` | Implemented with backend-dependent upstream availability. |
| `reasoning_and_speed_selection` | `backend_dependent` | Ordinary effort values are preserved; Ultra resolves a base effort and encourages delegation through caller-supplied tools. Provider and client support determine execution. |
| `image_generation_output` | `backend_dependent` | Safe image events are mapped for Responses when supplied upstream; image budgets are independent at 16 MiB per item, 64 MiB per bundle and 10 images, without enlarging text or hidden replay budgets. |
| `codex_images_service` | `backend_dependent` | The Codex 0.160 Images service uses the existing account at /backend-api/codex/images/generations with a separate 300000 ms default timeout; one gpt-image-2 generation was verified, not every model or account. |
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

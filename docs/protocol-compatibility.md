# Protocol compatibility matrix

This document mirrors the machine-readable contract in
`apps/api/src/protocol-compatibility.ts`. The service is a Claude-compatible
surface backed by ChatGPT/Codex text and Images adapters or a separately deployed
ordinary ChatGPT web gateway; it is not a full semantic bridge. Images generation
and Responses image tools are separate upstream paths.

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
| Images | `generations_json` | `backend_dependent` | POST /v1/images/generations uses the current ChatGPT account and defaults to gpt-image-2; five base IDs retain their names and four local resolution aliases map to Flare/Sunburst plus size. PNG base64 JSON supports n=1..10, subject to account/model access. |
| Images | `generations_streaming` | `partial` | stream=true supports n=1 and emits only image_generation.completed after the upstream JSON result; partial_images must be 0 or omitted. |
| Images | `model_descriptor` | `supported` | Public/Admin views expose nine image_endpoint descriptors: five base IDs and four local size aliases with alias_of, default_size and post_processing metadata. Availability is backend-dependent; image IDs and text aliases targeting them are rejected by text routes with 400. |
| Images | `image_quality` | `backend_dependent` | Standard qualities are low, medium, high and auto; xhigh/max are accepted for the three base 2.5 IDs, their four exact resolution aliases and the Flare/Sunburst 2026-09-08 snapshots. |
| Images | `resolution_aliases` | `supported` | Four exact Flare/Sunburst -2k/-4k aliases default to 2048x2048/3840x2160; explicit size wins and auto preserves dimensions. Final PNGs use local proportional Catmull-Rom resizing and padding, retain alpha, report decoded size and fail on invalid output or budgets. This does not establish additional native detail. |
| Images | `edits_variations_and_url_output` | `unsupported` | Image edits, variations, URL output, JPEG/WebP selection and compression parameters are not implemented by this Images adapter. |

Native Responses preserves message IDs, text/refusal content, and the order of the safe output projection. Added-item and added-content events use consecutive indexes for SDK compatibility. When preceding output items or content parts cannot yet be projected safely, affected text is buffered until the completed snapshot supplies their order. A validated encrypted reasoning prefix can be published before live message text. Claude and Chat Completions continue to expose text/refusal deltas directly.

Function-call argument strings are retained for Chat Completions, native Responses, and Claude streaming JSON deltas. Replay matching and tool snapshot validation compare numeric tokens without rounding through JavaScript numbers. Comparisons accept at most 64 levels of nesting; number tokens with exponents longer than 128 digits require identical spelling and may conservatively reject reformatted snapshots. Claude non-streaming `tool_use.input` also preserves upstream numeric values in HTTP JSON: numbers that would lose precision use native raw JSON primitives, while ordinary values remain normal JavaScript values. This requires Node.js 22.15.0 or a supported newer runtime with `JSON.rawJSON` and JSON parser source context; missing capabilities return a clear error. A client that parses the result into floating-point numbers can still lose precision, and values already rounded by a custom backend without the original argument string cannot be recovered.

## Image endpoint boundaries

The dedicated Images API reuses the configured ChatGPT account and the Codex 0.160 Images service. It defaults to `gpt-image-2` and returns PNG data as `data[].b64_json`. On 2026-10-04 all five base IDs each passed one real generation on one account using low quality and n=1: HTTP 200, final image_generation.completed SSE and PNG decoding succeeded in approximately 13.4–15.5 seconds each. Requested 1024x1024 output actually measured 1254×1254 in all five PNGs, delivered unchanged. Those checks did not establish exact requested base-model dimensions, other accounts, higher quality or edits. The JSON endpoint accepts `n=1..10`. With `stream:true`, only `n=1` is accepted, and one `image_generation.completed` SSE event is emitted after the complete upstream JSON response. It is not a preview stream: `partial_images` must be omitted or zero.

The image request has an independent `CHATGPT_IMAGE_REQUEST_TIMEOUT_MS=300000` timeout. Image payload limits count serialized base64 and metadata: 16 MiB per item, 64 MiB per bundle, at most 10 images. Responses previews are limited to three per image, 30 events and 64 MiB in total. The existing 4 MiB non-image output guard and hidden replay/cache budgets are unchanged.

The five base IDs are `gpt-image-1.5`, `gpt-image-2`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` and `gpt-image-2.5`, matching [CPA built-in registration](https://github.com/router-for-me/CLIProxyAPI/blob/8ef43e4df3b216a42493105d31c2873b69191473/internal/registry/model_definitions.go#L245). They are endpoint presets, not upstream text discovery or verified account entitlements. All five retain their IDs on the independent Images wire, including bare 2.5. See [CPA direct routing](https://github.com/router-for-me/CLIProxyAPI/blob/8ef43e4df3b216a42493105d31c2873b69191473/internal/runtime/executor/codex_openai_images.go#L659).

Flare and Sunburst each add two exact local aliases: `-2k` defaults to 2048×2048 and `-4k` to 3840×2160. Explicit `size`, including `auto`, takes precedence; orientation is not inferred from prompts. Names and defaults follow [codex2api's documented size aliases](https://github.com/james-6-23/codex2api/blob/5ee6c29273773a2398531d061d23f199ca8c25f7/docs/API.md#L297). This adapter retains its independent Images transport. It maps these four aliases to base IDs, then fits the final PNG proportionally to the requested canvas with Catmull-Rom interpolation and centered padding. Alpha is preserved; opaque padding is white. Matching dimensions retain original bytes, and `auto` does not impose a target. Decoded physical size is returned. Failures are explicit rather than silently returning a smaller image. Targets are bounded by 3840 per edge, 8,294,400 total pixels and existing image budgets. Interpolation is local processing and does not establish native high-resolution detail. Synthetic PNG/HTTP tests cover all four aliases. This change does not add a drawing studio or progressive Images previews.

On 2026-10-20, one account completed two real requests through this API with `x-chat2claude-backend: codex`, `quality:low` and `n:1`:

| Requested alias | Background | Response | Decoded PNG | Duration |
| --- | --- | --- | --- | --- |
| `gpt-image-2.5-flare-2k` | `opaque` | HTTP 200 JSON | 2048×2048 | 15.0 s |
| `gpt-image-2.5-sunburst-4k` | `transparent` | HTTP 200, one final SSE completion | 3840×2160 | 19.9 s |

The response size matched each decoded PNG. The delivered 4K PNG contained transparent and partially transparent pixels, including within the central rectangle spanning 50% of the width and 50% of the height. The probe did not capture the source PNG before local processing, so it establishes delivered alpha and dimensions, without establishing native upstream dimensions, transparency or additional detail. The other two aliases, higher qualities, multi-image batches, edits, other accounts and the Responses image tool remain unverified with live generation. The temporary runtime key was revoked, account leases returned to zero and global Web routing stayed unchanged. Choose Codex for image requests when the global mode is Web; the per-request header preserves the global selection.

The [official Images API reference](https://developers.openai.com/api/reference/resources/images/methods/generate) documents multiple public image models and `xhigh`/`max` for Flare/Sunburst. This adapter accepts those qualities for the three base 2.5 IDs, their four local resolution aliases and the two exact Flare/Sunburst `2026-09-08` snapshots; 1.5, 2 and unknown IDs accept only `low`, `medium`, `high`, `auto`. Snapshots are not additional built-in descriptors. Valid response quality metadata is retained. CPA compatibility for bare 2.5 does not establish a public API alias or real-generation access for this private host.

Responses can forward validated `response.image_generation_call.partial_image` events and final image output items if the upstream supplies them. Each preview follows its item's added event; an uncertain preceding projection is buffered until terminal order is known. A preview is not success: the authoritative completed snapshot must contain the matching final image. This conversion is covered by synthetic Session/HTTP tests, but real image-tool execution on the current host's Responses endpoint has not been established. Use the dedicated Images route for the verified generation path.

Responses containing generated-image output are not stored, regardless of image size or `store:true`. Their returned IDs cannot be used with `previous_response_id`: the lookup returns 404 without dispatching another upstream request. Use `store:false`. Generated-image history editing/replay is not implemented.

Explicitly including an `image_generation_call` item in the input array returns 400 before account acquisition or dispatch. Ordinary `input_image` input remains supported for vision; clients must supply it explicitly instead of replaying a generated output item.

The nine image descriptors in `/v1/models` are conditional on backend capability and an eligible account. Local resolution entries include `alias_of`, `default_size` and `post_processing:"resize"`. Their `source: "image_endpoint"` is not a discovered text-model claim. Sending a registered image model or an alias bound to it to Messages, Chat Completions or Responses returns 400 with the Images endpoint. Other text requests are not preemptively rejected, but image output reaching Messages or Chat Completions produces an explicit 501 error, or the protocol's SSE error after headers, without poisoning account credentials.

Admin account/model views expose these endpoint descriptors as separate `imageModels` arrays. Account cards count text and image entries independently, for example 10 text models and 9 image entries (five base IDs and four local size aliases), and a dedicated panel is visible in both UI modes. The image count describes the endpoint entries exposed here, not the complete public OpenAI image model catalog. Text `modelCount`, `discoveredModels`, registry discovery and alias choices are unchanged. The descriptor is based on image-route eligibility, including an otherwise eligible busy account; it is not an upstream text-discovery record or a per-account image-permission verification.

See the [usage guide](USAGE.en.md#independent-gpt-image-generation) for SDK and curl examples. Protocol references: [OpenAI image generation guide](https://developers.openai.com/api/docs/guides/image-generation), [Codex image tool at 0.160](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/ext/image-generation/src/tool.rs), and [Codex Images client](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/codex-api/src/endpoint/images.rs). Public API documentation describes a broader surface than this adapter.

## ChatGPT/Codex backend

| Manifest feature | Status | Notes |
| --- | --- | --- |
| `dynamic_model_discovery` | `supported` | Backend model catalogs are discovered dynamically. |
| `context_window_metadata` | `backend_dependent` | Catalog limits are shown without inferred defaults; missing or conflicting account values remain unknown or account-dependent. |
| `oauth_authorization_and_text_completion` | `partial` | Implemented with backend-dependent upstream availability. |
| `reasoning_and_speed_selection` | `backend_dependent` | Ordinary effort values are preserved; Ultra resolves a base effort and encourages delegation through caller-supplied tools. Provider and client support determine execution. |
| `image_generation_output` | `backend_dependent` | Safe image events are mapped for Responses when supplied upstream; image budgets are independent at 16 MiB per item, 64 MiB per bundle and 10 images, without enlarging text or hidden replay budgets. |
| `codex_images_service` | `backend_dependent` | The Codex 0.160 Images service uses /backend-api/codex/images/generations with a separate 300000 ms default timeout. The five base IDs passed one low/n=1 PNG check on one account on 2026-10-04. On 2026-10-20, one account passed Flare-2k opaque JSON and Sunburst-4k transparent final SSE at low/n=1, delivering 2048x2048 and 3840x2160 PNGs with matching size metadata. Local processing does not establish native high-resolution detail or upstream alpha; higher qualities, batches and other accounts remain unverified. |
| `tool_calls` | `backend_dependent` | Function tools, tool choice, argument deltas, and results are mapped; availability and execution depend on the model and caller. |
| `real_usage` | `partial` | Upstream input/output token counts are parsed when present; missing usage uses a local estimate. |

## ChatGPT Web backend

| Manifest feature | Status | Notes |
| --- | --- | --- |
| `upstream_selection` | `supported` | Enable Web before choosing Auto or manual Codex/Web. Auto prefers Web by default and matches model, capabilities and availability; manual selection limits the provider. Disabling Web uses only Codex while retaining settings. No cross-backend retry occurs after dispatch; native history retains account affinity unless an opt-in visible handoff applies. |
| `exact_models_and_explicit_mappings` | `supported` | Configured model IDs match exactly; auto is not a wildcard. Explicit client-model or alias mappings may substitute a configured web model without claiming equivalence to the original model. |
| `text_and_streaming_bridge` | `backend_dependent` | A separately deployed and authenticated gateway exposes OpenAI Chat Completions; its text JSON and SSE responses are adapted to Claude Messages, Chat Completions and Responses. Gateway and model behavior determine availability. |
| `user_image_inputs` | `backend_dependent` | Image input is disabled by default. When declared supported, user messages may contain HTTPS image URLs or PNG/JPEG/WebP/GIF base64 data URLs, forwarded as OpenAI image_url parts within the shared 16 MiB serialized request limit. Vision support depends on the gateway and model. |
| `tool_calls_and_text_results` | `backend_dependent` | Tool support is disabled by default. When declared supported, function tools, tool choice, calls and text results map through Chat Completions; the client executes local file and command tools. Each request selects one backend without an automatic Web/Codex collaboration cycle. |
| `visible_context_handoff` | `supported` | contextHandoff defaults to false and can be preset by CHATGPT_CONTEXT_HANDOFF. Opt-in Responses continuation and completed Messages/Chat tool cycles may transfer the same API owner's known visible history across providers or an explicit model change. Private reasoning and native message IDs are removed; unknown native items and incomplete tools are rejected. The same provider and model keep original account affinity. Owner-isolated memory retention is bounded and expires or resets on restart; clients must retain complete history. This does not synchronize ChatGPT Projects or mount project files. |
| `pinned_gateway_tool_protocol` | `backend_dependent` | The pinned local patch uses a validated text protocol to return JSON/SSE tool_calls for client execution. It accepts up to 128 unique functions with 1-64 character ASCII names, at most 8 new calls or 1 with parallel_tool_calls=false, and at most 128 fully paired calls per assistant history group. Each argument string is capped at 1 MiB with original numeric tokens retained. strict:true is rejected; native strict-schema execution is not promised. The gateway native Responses endpoint rejects tools. |
| `pinned_gateway_image_history` | `backend_dependent` | The pinned local patch retains current and historical user-image ownership and text order, with up to 10 canonical Base64 PNG/JPEG/WebP/GIF images, 10 MiB total decoded image data and 16 MiB whole JSON per request. Remote HTTPS and non-user images are rejected. Its native Responses endpoint rejects images; main-service Responses uses Chat Completions instead. |
| `tool_result_images_and_image_generation` | `unsupported` | Tool-result and assistant-message images are rejected. The web adapter does not generate images; manual Web mode rejects the Images API, while Auto can use an eligible Codex account for that separate route. |
| `native_reasoning_tiers_and_structured_output` | `unsupported` | Native reasoning replay, non-default reasoning-effort controls, non-default service tiers and structured output are unsupported by the web adapter. Unsupported request semantics are rejected instead of silently discarded. The separate local runner forces CHAT2CLAUDE_MAX_THINKING=true as a UI policy: select the highest recognized account menu/slider level, require read-back confirmation and recheck before submission; a disabled or unconfirmed top level rejects before sending. This does not add arbitrary reasoning_effort support or model selection. |
| `credentials_and_enable_boundary` | `supported` | Gateway credentials are configured separately from Codex OAuth and stored in server runtime state with optional existing encryption; GET responses do not expose the Key. The Web enable switch takes precedence over Auto and request overrides; a web override while disabled returns 403. |
| `configured_catalog_and_health_checks` | `partial` | Generation and model listing use configured IDs without calling gateway /models. Admin health checks currently require GET /v1/models to return an OpenAI-shaped model list; a failed check marks the account with a health error. |
| `ordinary_chat_validation` | `partial` | Web means ordinary Chat at chatgpt.com. On 2026-10-20, one manually signed-in account passed direct installed-gateway Chat Completions JSON at Pro with one PNG: recognition returned 73 and a named record_digits request returned standard tool_calls with digits as the string 73. Both confirmed Pro after selection and before submission, with HTTP 200, thinking_mode=pro, thinking_verified=true, requested_verified=true, thinking_fallback=null and image_inputs_attached=1. The tool request produced one observed conversation POST, image attachment and multimodal image part. No client tool, Codex request or port-3000 generation ran. Pro SSE, multiple images and a complete tool-result round trip remain untested. Earlier that day at Instant, an in-memory app continued one synthetic Codex response on real Web with two PNGs (73 and 29), without private reasoning or native message IDs; pairing the real call ID with a simulated client result then passed full-history Messages SSE with HTTP 200, backend web, complete message_stop and correct receipt. Historical 2026-10-19 single-PNG JSON/SSE checks remain recorded. Other accounts, formats, long-term reliability and quotas remain unverified. |

### Pinned local gateway integration

The source checkout includes [setup and login helpers](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/blob/v0.3.0/integrations/gpt-web-gateway/README.md) for a separate local `stufently/gpt-web-gateway`. They pin upstream commit `893f553be358210a5c045aa9f62b56ba1edc5c78` and apply the repository's chat-image patch. This narrower gateway contract is separate from the generic Web adapter capabilities in the manifest above. It uses ordinary Chat at chatgpt.com with manual login in a separate Chrome window; it does not use ChatGPT Work or the main app's Codex OAuth session.

| Patched gateway behavior | Contract |
| --- | --- |
| Chat image input | Current and historical user messages may carry canonical Base64 PNG/JPEG/WebP/GIF images with matching MIME signatures. Their original message ownership and text order are retained. |
| Request limits and rejection | 16 MiB whole JSON request, up to 10 images and 10 MiB decoded image data across all user messages. Remote URLs including HTTPS, non-user images, unsupported content parts and malformed encoding return HTTP 400 before browser dispatch. |
| Attachment and reply | The browser confirms every attachment before submission. JSON and SSE return text or standard tool calls; `applied.image_inputs_attached` reports confirmed attachment count, not recognition accuracy. |
| Cancellation and retry | Disconnected clients are cancelled before queued execution or submission. A failed image turn after sending is not automatically resent and reports `should_retry: false`; callers should preserve that decision. |
| Native gateway Responses | The gateway's own `/v1/responses` route rejects images and tools. Main-service Responses calls gateway Chat Completions, so the patched chat subset remains available through that bridge. |
| Tools, models and health | Text-protocol tool calls are returned for the client to execute. The gateway does not execute tools or provide `/v1/models`; `model` is ignored, so configure `auto`. Main-app health checks requiring `/v1/models` do not establish chat availability. |
| Installation and private state | Helpers manage a separate installation in the Git-ignored `apps/api/data/web-gateway/` by default. It contains the random gateway Key and browser session. Connect enables manual Web, images, tools, contextHandoff and `sonnet=auto`; capability configuration is not live verification. |
| Ordinary Chat and observed UI | The local runner forces strict ordinary-Chat checks for text and images; Work and unknown pages are rejected before sending, including the Enter fallback. Chinese Chat/Work `aria-pressed` and exact Chinese attachment labels are handled. Only known positive aria-current tokens count as active; false, empty and unknown values do not confirm the surface. Request filenames use unique ASCII UUIDs; strict new-chat setup waits up to 60 seconds for the composer. Upstream text without the strict option retains best-effort mode selection. |
| Highest thinking level (local runner) | CHAT2CLAUDE_MAX_THINKING=true is forced by the local runner. Every ordinary-Chat request selects the current account's highest recognized menu or slider level, requires read-back confirmation and rechecks before submission. A disabled or unconfirmed top level rejects without silently using Instant, a lower level or Work. This separate gateway policy does not add arbitrary reasoning_effort support in the generic Web adapter; model remains ignored, so use auto. One account passed Pro single-PNG recognition and tool-request JSON; Pro SSE, multiple images and a complete tool-result round trip remain untested. |
| Auto and gateway extensions | Generic capability declarations do not predict every gateway limit. HTTPS images or excess input may select Web and receive 400, without a Codex retry after dispatch. Connect declares supportsStrictTools:false so strict:true is filtered before Web dispatch. Native gateway `applied` and `should_retry` extensions are not currently forwarded by the main compatibility API. |
| Current live validation (2026-10-20, Pro level) | Direct installed-gateway Chat Completions JSON on one manually signed-in ordinary Chat account with one PNG. Plain recognition returned 73; a named single record_digits request returned standard tool_calls with digits as the string 73. Both returned HTTP 200, thinking_mode=pro, thinking_verified=true, requested_verified=true, thinking_fallback=null and image_inputs_attached=1, with Pro confirmed after selection and before submission. The tool request had one observed conversation POST, attachment and multimodal image part. No client-tool execution, Codex request or port-3000 generation occurred. Pro SSE, multiple images and a full tool-result cycle remain untested. |
| Earlier live validation (2026-10-20, Instant level) | One ordinary Chat account passed two-PNG Responses history continuation and standard tool-call arguments, followed by full-history Messages SSE with a simulated client result paired to the real call ID: HTTP 200, backend web, complete message_stop and correct project code, digits and receipt. Source Codex was one mock call; no real Codex or file/command execution occurred. Generation used an in-memory app; port 3000 was configured only. This does not validate the highest-level policy. |
| Historical live validation (2026-10-19) | One PNG passed recognition through direct gateway JSON and in-memory Messages SSE, with HTTP 200, backend web, complete message_stop and zero Codex calls. The running main service was configured only. This check covers the former single-image version. |
| Offline validation limits | The installed patch passed 11 vision parser/HTTP groups, 18 tool-protocol tests and 100 Node tests (26 maximum-thinking, 72 attachment/text-mode, 2 shutdown). The current complete pnpm check passed with exit 0: build, 2707 Vitest tests in 113 files, build-cache 8/8, runner 19/19 and all typechecks. The patch applies cleanly to the original pinned SHA; the dependency audit passed. Earlier default-concurrency timeouts and bounded-worker reruns remain recorded in the integration history. Upstream Windows signal mutation-rollback tests remain 14/16 at both patched and original pinned SHA. No quota increase is established. |

## Design direction

Reasoning effort is validated against the selected account's discovered model controls. Ordinary efforts, including `max`, `xhigh`, and future provider IDs, retain their original values. Known spelling aliases are resolved only after checking for an exact native match, and unknown IDs retain case and underscores. Unsupported explicit efforts are rejected before dispatch.

Ultra is a mode adaptation. The selected value remains `ultra`, while upstream `reasoning.effort` follows the [Codex 0.155.0-alpha.9.2 resolver](https://github.com/openai/codex/blob/4607249e430dac1c961df4dc615beae88e33cec8/codex-rs/protocol/src/openai_models/reasoning_effort.rs#L10): a supported `multi_agent_reasoning_effort`, then supported `max`, then the last non-Ultra option, then `medium`. A developer instruction encourages proactive delegation through the caller's existing tools. The service does not create subagents or send a hosted multi-agent flag. Actual delegation, concurrency, and turns remain the client's responsibility; a client without delegation tools uses the main model directly. `capabilities.ultra_execution` exposes the resolved effort and `delegation: "caller_tools"`. This is not the complete Codex runtime or a guarantee of equivalent execution. See the usage guides for protocol field precedence, effective-default metadata, and implicit-default fallback behavior.

Different account catalogs can resolve the same model's Ultra selection to different base efforts. Aggregated `ultra_execution` then exposes `account_dependent: true` without a single `reasoning_effort`; effective defaults expose `reasoning_account_dependent: true` without `upstream_reasoning_effort`. The base effort is resolved from the selected account's catalog during request routing, not from the union of account capabilities.

1. Parse Claude/OpenAI requests into Canonical IR.
2. Preserve non-text semantics in IR.
3. Return an explicit fallback or error when the selected backend cannot support a feature.
4. Never silently drop content blocks.
5. Add provider adapters incrementally while preserving existing streaming behavior.

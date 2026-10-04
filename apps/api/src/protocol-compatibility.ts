export const protocolCompatibilityStatuses = [
  'supported',
  'partial',
  'downgraded',
  'estimated',
  'unsupported',
  'backend_dependent',
] as const;

export type ProtocolCompatibilityStatus = typeof protocolCompatibilityStatuses[number];

export interface ProtocolCompatibilityEntry {
  protocol: 'claude_messages' | 'openai_chat_completions' | 'openai_responses' | 'openai_images' | 'chatgpt_codex_backend';
  feature: string;
  status: ProtocolCompatibilityStatus;
  note: string;
}

export interface ClientCompatibilitySmokeScenario {
  client: 'Claude Code' | 'Anthropic SDK' | 'OpenAI SDK' | 'Cline' | 'Roo' | 'Continue' | 'Cherry Studio';
  baseUrl: 'root_origin' | 'versioned_v1';
  endpoints: string[];
  note: string;
}

export const clientCompatibilitySmokeScenarios: readonly ClientCompatibilitySmokeScenario[] = [
  { client: 'Claude Code', baseUrl: 'root_origin', endpoints: ['/v1/messages', '/v1/messages/count_tokens', '/v1/models'], note: 'Set ANTHROPIC_BASE_URL to the service root origin; Claude Code appends /v1 request paths.' },
  { client: 'Anthropic SDK', baseUrl: 'root_origin', endpoints: ['/v1/messages', '/v1/messages/count_tokens', '/v1/models'], note: 'Set baseURL to the service root origin; the SDK appends Claude-compatible /v1 paths.' },
  { client: 'OpenAI SDK', baseUrl: 'versioned_v1', endpoints: ['/v1/chat/completions', '/v1/responses', '/v1/images/generations', '/v1/models'], note: 'Set baseURL to the versioned /v1 origin; images.generate uses the separate Images endpoint and requires an image-capable backend/account.' },
  { client: 'Cline', baseUrl: 'root_origin', endpoints: ['/v1/messages', '/v1/models'], note: 'Use an Anthropic/Claude-compatible custom provider pointed at the service root origin.' },
  { client: 'Roo', baseUrl: 'root_origin', endpoints: ['/v1/messages', '/v1/models'], note: 'Use an Anthropic/Claude-compatible custom provider pointed at the service root origin.' },
  { client: 'Continue', baseUrl: 'versioned_v1', endpoints: ['/v1/chat/completions', '/v1/models'], note: 'Use an OpenAI-compatible provider pointed at the versioned /v1 origin.' },
  { client: 'Cherry Studio', baseUrl: 'versioned_v1', endpoints: ['/v1/chat/completions', '/v1/models'], note: 'Use an OpenAI-compatible provider pointed at the versioned /v1 origin.' },
] as const;

/**
 * Machine-readable compatibility contract. Keep the human matrix in
 * docs/protocol-compatibility.md aligned with this manifest.
 */
export const protocolCompatibilityManifest: readonly ProtocolCompatibilityEntry[] = [
  { protocol: 'claude_messages', feature: 'messages_non_stream_text', status: 'supported', note: 'Text input maps to backend text and returns Claude-shaped responses.' },
  { protocol: 'claude_messages', feature: 'messages_stream_text', status: 'supported', note: 'Text streaming emits Claude SSE text block events.' },
  { protocol: 'claude_messages', feature: 'models', status: 'supported', note: 'Enabled, resolvable aliases and discovered passthrough models are listed.' },
  { protocol: 'claude_messages', feature: 'count_tokens', status: 'estimated', note: 'Returns a local heuristic estimate, not Anthropic tokenizer parity.' },
  { protocol: 'claude_messages', feature: 'tools_and_tool_choice', status: 'backend_dependent', note: 'Typed and mapped where possible; backend execution is not guaranteed.' },
  { protocol: 'claude_messages', feature: 'tool_result_and_tool_use_blocks', status: 'backend_dependent', note: 'Mapped to native function calls and outputs, including text/image tool results, for the session backend; text-only backends receive a fallback.' },
  { protocol: 'claude_messages', feature: 'image_blocks', status: 'backend_dependent', note: 'URL and base64 images map to native input images for the session backend; model vision support is required.' },
  { protocol: 'claude_messages', feature: 'generated_image_output', status: 'unsupported', note: 'Generated images return an explicit 501 error, or an SSE error after headers; use Images or Responses instead of expecting image output from Messages.' },
  { protocol: 'claude_messages', feature: 'thinking_blocks', status: 'downgraded', note: 'Client-supplied thinking blocks are preserved in Canonical IR but not replayed to text backends; readable upstream reasoning output streams separately via thinking_and_signature_deltas.' },
  { protocol: 'claude_messages', feature: 'input_json_delta', status: 'supported', note: 'Upstream function-call arguments stream as Claude input_json_delta events.' },
  { protocol: 'claude_messages', feature: 'thinking_and_signature_deltas', status: 'partial', note: 'Readable upstream reasoning text streams as Claude thinking_delta; signatures are unavailable.' },
  { protocol: 'claude_messages', feature: 'safe_progress_status_deltas', status: 'partial', note: 'Safe lifecycle and tool progress statuses are internal diagnostics; they may open an empty thinking block but are omitted from Claude thinking_delta content.' },
  { protocol: 'claude_messages', feature: 'usage_accounting', status: 'estimated', note: 'Usage is estimated unless upstream usage is available.' },
  { protocol: 'claude_messages', feature: 'stop_reasons_and_error_envelopes', status: 'partial', note: 'Common backend results and validation failures are mapped.' },
  { protocol: 'openai_chat_completions', feature: 'text_and_streaming', status: 'supported', note: 'Text responses and SSE chunks use OpenAI-like shapes.' },
  { protocol: 'openai_chat_completions', feature: 'content_parts_tools_and_structured_output', status: 'backend_dependent', note: 'Mapped where possible; strict semantics depend on the backend.' },
  { protocol: 'openai_chat_completions', feature: 'generated_image_output', status: 'unsupported', note: 'Generated images return an explicit 501 error, or an SSE error after headers; use Images or Responses instead of expecting image output from Chat Completions.' },
  { protocol: 'openai_responses', feature: 'text_and_streaming', status: 'supported', note: 'Common response objects and SSE events are emitted.' },
  { protocol: 'openai_responses', feature: 'input_tools_and_continuation_options', status: 'backend_dependent', note: 'Mapped or locally retained where documented; upstream support varies.' },
  { protocol: 'openai_responses', feature: 'image_generation_output_streaming', status: 'partial', note: 'When upstream supplies image events, validated previews follow output_item.added and final images require a matching completed snapshot; live image-tool availability on the current Responses host has not been established.' },
  { protocol: 'openai_responses', feature: 'generated_image_history', status: 'unsupported', note: 'Responses containing generated images are not stored, including with store=true; previous_response_id cannot continue their IDs and returns 404 without upstream dispatch.' },
  { protocol: 'openai_images', feature: 'generations_json', status: 'backend_dependent', note: 'POST /v1/images/generations uses the current ChatGPT account, registers the five CPA image IDs and defaults to gpt-image-2; IDs including bare gpt-image-2.5 are forwarded unchanged and return PNG base64 JSON for n=1..10, subject to account/model access.' },
  { protocol: 'openai_images', feature: 'generations_streaming', status: 'partial', note: 'stream=true supports n=1 and emits only image_generation.completed after the upstream JSON result; partial_images must be 0 or omitted.' },
  { protocol: 'openai_images', feature: 'model_descriptor', status: 'supported', note: 'Public/Admin views expose five built-in image_endpoint descriptors with backend-dependent availability, separate from account text discovery and aliases; the registered image IDs and aliases targeting them are rejected by text routes with 400.' },
  { protocol: 'openai_images', feature: 'image_quality', status: 'backend_dependent', note: 'Standard qualities are low, medium, high and auto; xhigh/max are accepted for the three registered 2.5 IDs and the Flare/Sunburst 2026-09-08 snapshots, without renaming the requested model.' },
  { protocol: 'openai_images', feature: 'edits_variations_and_url_output', status: 'unsupported', note: 'Image edits, variations, URL output, JPEG/WebP selection and compression parameters are not implemented by this Images adapter.' },
  { protocol: 'chatgpt_codex_backend', feature: 'dynamic_model_discovery', status: 'supported', note: 'Backend model catalogs are discovered dynamically.' },
  { protocol: 'chatgpt_codex_backend', feature: 'context_window_metadata', status: 'backend_dependent', note: 'Catalog limits are shown without inferred defaults; missing or conflicting account values remain unknown or account-dependent.' },
  { protocol: 'chatgpt_codex_backend', feature: 'oauth_authorization_and_text_completion', status: 'partial', note: 'Implemented with backend-dependent upstream availability.' },
  { protocol: 'chatgpt_codex_backend', feature: 'reasoning_and_speed_selection', status: 'backend_dependent', note: 'Ordinary effort values are preserved; Ultra resolves a base effort and encourages delegation through caller-supplied tools. Provider and client support determine execution.' },
  { protocol: 'chatgpt_codex_backend', feature: 'image_generation_output', status: 'backend_dependent', note: 'Safe image events are mapped for Responses when supplied upstream; image budgets are independent at 16 MiB per item, 64 MiB per bundle and 10 images, without enlarging text or hidden replay budgets.' },
  { protocol: 'chatgpt_codex_backend', feature: 'codex_images_service', status: 'backend_dependent', note: 'The Codex 0.160 Images service uses /backend-api/codex/images/generations with a separate 300000 ms default timeout; all five registered IDs passed one low/n=1 final-SSE PNG check on one account on 2026-10-04. Requested 1024x1024 produced 1254x1254; exact dimensions, other accounts and higher quality are not verified.' },
  { protocol: 'chatgpt_codex_backend', feature: 'tool_calls', status: 'backend_dependent', note: 'Function tools, tool choice, argument deltas, and results are mapped; availability and execution depend on the model and caller.' },
  { protocol: 'chatgpt_codex_backend', feature: 'real_usage', status: 'partial', note: 'Upstream input/output token counts are parsed when present; missing usage uses a local estimate.' },
] as const;

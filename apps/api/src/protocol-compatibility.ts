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
  protocol: 'claude_messages' | 'openai_chat_completions' | 'openai_responses' | 'chatgpt_codex_backend';
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
  { client: 'OpenAI SDK', baseUrl: 'versioned_v1', endpoints: ['/v1/chat/completions', '/v1/responses', '/v1/models'], note: 'Set baseURL to the versioned /v1 origin for OpenAI-compatible resources.' },
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
  { protocol: 'claude_messages', feature: 'tool_result_and_tool_use_blocks', status: 'downgraded', note: 'Preserved in Canonical IR and flattened when the backend cannot represent them.' },
  { protocol: 'claude_messages', feature: 'image_blocks', status: 'downgraded', note: 'Preserved in Canonical IR and rendered as an explicit fallback for text backends.' },
  { protocol: 'claude_messages', feature: 'thinking_blocks', status: 'downgraded', note: 'Preserved in Canonical IR and rendered as explicit placeholders.' },
  { protocol: 'claude_messages', feature: 'input_json_delta', status: 'unsupported', note: 'Tool streaming is not implemented.' },
  { protocol: 'claude_messages', feature: 'thinking_and_signature_deltas', status: 'unsupported', note: 'Thinking streaming is not implemented.' },
  { protocol: 'claude_messages', feature: 'usage_accounting', status: 'estimated', note: 'Usage is estimated unless upstream usage is available.' },
  { protocol: 'claude_messages', feature: 'stop_reasons_and_error_envelopes', status: 'partial', note: 'Common backend results and validation failures are mapped.' },
  { protocol: 'openai_chat_completions', feature: 'text_and_streaming', status: 'supported', note: 'Text responses and SSE chunks use OpenAI-like shapes.' },
  { protocol: 'openai_chat_completions', feature: 'content_parts_tools_and_structured_output', status: 'backend_dependent', note: 'Mapped where possible; strict semantics depend on the backend.' },
  { protocol: 'openai_responses', feature: 'text_and_streaming', status: 'supported', note: 'Common response objects and SSE events are emitted.' },
  { protocol: 'openai_responses', feature: 'input_tools_and_continuation_options', status: 'backend_dependent', note: 'Mapped or locally retained where documented; upstream support varies.' },
  { protocol: 'chatgpt_codex_backend', feature: 'dynamic_model_discovery', status: 'supported', note: 'Backend model catalogs are discovered dynamically.' },
  { protocol: 'chatgpt_codex_backend', feature: 'oauth_authorization_and_text_completion', status: 'partial', note: 'Implemented with backend-dependent upstream availability.' },
  { protocol: 'chatgpt_codex_backend', feature: 'reasoning_and_speed_selection', status: 'backend_dependent', note: 'Controls are resolved safely but provider support varies.' },
  { protocol: 'chatgpt_codex_backend', feature: 'images_and_tool_calls', status: 'unsupported', note: 'Backend mappings are not implemented.' },
  { protocol: 'chatgpt_codex_backend', feature: 'real_usage', status: 'unsupported', note: 'Upstream usage parsing is not implemented.' },
] as const;

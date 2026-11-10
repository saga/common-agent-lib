import type { ContentPart, ContextMessage, ContextSnapshot, ContextTool, MessageRole, NormalizeOptions } from './model.js';

const SECRET_KEY = /authorization|api[_-]?key|password|secret|cookie|credential|private[_-]?key|access[_-]?token/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const obj = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const stringify = (value: unknown): string => { try { return typeof value === 'string' ? value : JSON.stringify(value, null, 2); } catch { return String(value); } };
function safe(value: unknown, redact: boolean): unknown {
  if (!redact) return value;
  if (Array.isArray(value)) return value.map((item) => safe(item, redact));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[REDACTED]' : safe(item, redact)]));
  return typeof value === 'string' ? value.replace(BEARER, 'Bearer [REDACTED]') : value;
}
function roleOf(value: unknown): MessageRole {
  const role = String(value ?? 'unknown').toLowerCase();
  return ['system', 'developer', 'user', 'assistant', 'tool'].includes(role) ? role as MessageRole : 'unknown';
}
function partsOf(content: unknown): ContentPart[] {
  if (typeof content === 'string') return content ? [{ kind: 'text', text: content }] : [];
  if (content == null) return [];
  if (!Array.isArray(content)) return [{ kind: 'json', value: content }];
  return content.map((item: unknown): ContentPart => {
    if (typeof item === 'string') return { kind: 'text', text: item };
    const p = obj(item); const type = String(p.type ?? p.kind ?? 'unknown');
    if (['text', 'input_text', 'output_text'].includes(type)) return { kind: 'text', text: String(p.text ?? p.content ?? '') };
    if (['thinking', 'reasoning', 'redacted_thinking'].includes(type)) return { kind: 'thinking', text: stringify(p.thinking ?? p.text ?? p.data ?? ''), ...(p.signature ? { signature: String(p.signature) } : {}) };
    if (['image', 'image_url', 'input_image'].includes(type)) { const image = obj(p.image_url ?? p.source ?? p); return { kind: 'image', url: image.url ?? image.data, mediaType: image.media_type ?? image.mediaType, detail: image.detail, alt: p.alt }; }
    if (['tool_use', 'tool_call', 'function_call'].includes(type)) { const fn = obj(p.function); return { kind: 'tool-call', id: p.id ?? p.call_id, name: String(p.name ?? fn.name ?? 'unknown'), arguments: p.input ?? p.arguments ?? fn.arguments ?? {} }; }
    if (['tool_result', 'function_call_output'].includes(type)) return { kind: 'tool-result', toolCallId: p.tool_use_id ?? p.call_id, name: p.name, content: p.content ?? p.output ?? p, isError: Boolean(p.is_error ?? p.isError) };
    if (type === 'refusal') return { kind: 'refusal', text: String(p.refusal ?? p.text ?? '') };
    if (['json', 'output_json'].includes(type)) return { kind: 'json', value: p.json ?? p.value ?? p };
    return { kind: 'unknown', type, value: item };
  });
}
function messageOf(input: unknown, index: number, prefix: string, redact: boolean): ContextMessage {
  const m = obj(input); const parts = partsOf(m.content ?? m.text ?? m.input);
  for (const call of Array.isArray(m.tool_calls) ? m.tool_calls : []) { const fn = obj(call.function); parts.push({ kind: 'tool-call', id: call.id, name: String(fn.name ?? call.name ?? 'unknown'), arguments: fn.arguments ?? call.arguments ?? {} }); }
  if (m.type === 'tool_use' && !parts.some((part) => part.kind === 'tool-call')) parts.push({ kind: 'tool-call', id: m.id, name: String(m.name ?? 'unknown'), arguments: m.input ?? {} });
  if ((m.type === 'tool_result' || (m.role === 'tool' && m.tool_call_id)) && !parts.some((part) => part.kind === 'tool-result')) parts.splice(0, parts.length, { kind: 'tool-result', toolCallId: m.tool_use_id ?? m.tool_call_id, name: m.name, content: m.content ?? m.output, isError: Boolean(m.is_error) });
  return {
    id: String(m.id ?? m.message_id ?? m.tool_call_id ?? (prefix + '-' + index)), index, role: roleOf(m.role ?? m.type),
    ...(m.name ? { name: String(m.name) } : {}), ...(m.recipient ?? m.to ? { recipient: String(m.recipient ?? m.to) } : {}),
    ...(m.channel ?? (m.type && !['message', 'text'].includes(m.type)) ? { channel: String(m.channel ?? m.type) } : {}),
    ...(m.timestamp ? { timestamp: String(m.timestamp) } : {}), parts: parts.map((part) => safe(part, redact) as ContentPart),
    raw: safe(input, redact), ...(typeof m.tokenCount === 'number' ? { tokenCount: m.tokenCount } : {}),
    metadata: safe(obj(m.metadata), redact) as Record<string, unknown>,
  };
}
function requestMessages(req: Record<string, any>): unknown[] {
  if (Array.isArray(req.messages)) return req.messages;
  if (Array.isArray(req.input)) return req.input;
  if (Array.isArray(req.contents)) return req.contents;
  return [];
}
function responseMessages(res: Record<string, any>): unknown[] {
  if (Array.isArray(res.choices)) return res.choices.map((choice: any) => ({ ...obj(choice.message ?? choice.delta), role: obj(choice.message ?? choice.delta).role ?? 'assistant', finish_reason: choice.finish_reason }));
  if (Array.isArray(res.output)) return res.output;
  if (res.content !== undefined || res.text !== undefined) return [{ role: 'assistant', content: res.content ?? res.text }];
  if (res.message) return [res.message];
  return [];
}
function toolsOf(req: Record<string, any>, redact: boolean): ContextTool[] {
  return (Array.isArray(req.tools) ? req.tools : []).map((raw: unknown) => {
    const tool = obj(raw); const fn = obj(tool.function ?? tool);
    return { name: String(fn.name ?? tool.name ?? 'unknown'), ...(fn.description ?? tool.description ? { description: String(fn.description ?? tool.description) } : {}), ...(fn.parameters ?? tool.input_schema ?? tool.parameters ? { inputSchema: safe(fn.parameters ?? tool.input_schema ?? tool.parameters, redact) } : {}), raw: safe(raw, redact) };
  });
}
/** Normalize OpenAI Chat/Responses-compatible, Anthropic-style and generic payloads. */
export function normalizeContext(request: unknown, response?: unknown, options: NormalizeOptions = {}): ContextSnapshot {
  const req = obj(request); const res = obj(response); const redact = options.redactSecrets ?? true;
  const msgs = requestMessages(req).map((m, i) => messageOf(m, i, 'request', redact));
  const outputs = responseMessages(res).map((m, i) => messageOf(m, i, 'response', redact));
  const usage = obj(res.usage ?? obj(res.choices?.[0]).usage);
  const input = usage.input_tokens ?? usage.prompt_tokens; const output = usage.output_tokens ?? usage.completion_tokens;
  const cached = usage.cache_read_input_tokens ?? obj(usage.prompt_tokens_details).cached_tokens;
  const reasoning = obj(usage.output_tokens_details).reasoning_tokens;
  const system = typeof req.system === 'string' ? req.system : msgs.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => m.parts.map((p) => p.kind === 'text' ? p.text : '').join('')).join('\n\n') || undefined;
  const warnings: string[] = [];
  if (!msgs.length) warnings.push('No messages/input array was found in the request payload.');
  if (response !== undefined && !outputs.length) warnings.push('Response payload did not contain a recognized message/output shape.');
  if (options.includeRaw === false) warnings.push('Raw provider payloads were omitted by configuration.');
  const params = Object.fromEntries(['temperature', 'top_p', 'top_k', 'max_tokens', 'max_completion_tokens', 'stop', 'stream', 'response_format', 'tool_choice'].filter((key) => req[key] !== undefined).map((key) => [key, req[key]]));
  return {
    id: options.id ?? String(req.id ?? res.id ?? ('context-' + Date.now())),
    provider: options.provider ?? (Array.isArray(req.messages) ? 'openai-compatible' : Array.isArray(req.input) ? 'responses-compatible' : 'generic'),
    ...(req.model ?? res.model ? { model: String(req.model ?? res.model) } : {}),
    ...(res.created ? { createdAt: new Date(Number(res.created) * 1000).toISOString() } : {}),
    messages: msgs, tools: toolsOf(req, redact), parameters: safe(params, redact) as Record<string, unknown>,
    ...(system ? { system } : {}), rawRequest: options.includeRaw === false ? null : safe(request, redact),
    ...(response !== undefined && options.includeRaw !== false ? { rawResponse: safe(response, redact) } : {}),
    responseMessages: outputs,
    ...(typeof input === 'number' || typeof output === 'number' ? { usage: {
      ...(typeof input === 'number' ? { inputTokens: input } : {}), ...(typeof output === 'number' ? { outputTokens: output } : {}),
      ...(typeof usage.total_tokens === 'number' ? { totalTokens: usage.total_tokens } : {}),
      ...(typeof cached === 'number' ? { cachedInputTokens: cached } : {}), ...(typeof reasoning === 'number' ? { reasoningTokens: reasoning } : {}),
    } } : {}), warnings,
  };
}

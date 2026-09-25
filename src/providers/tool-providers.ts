import type { AIProvider, ProviderConfig } from '../types.ts';
import { contextWindowTokens } from '../utils/context-budget.ts';
import { buildOpenAICompatibleUrl } from './ai-providers.ts';

// Chat with tool calling for deep mode. Each provider's API describes tools,
// tool calls and tool results differently; this module maps them to one
// shape. Text is streamed through onText; tool calls are returned when the
// model's turn ends.

export interface ToolDefinition {
  name: string;
  description: string;
  // JSON Schema of the arguments (type "object").
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ToolMessage =
  | { role: 'user'; content: string }
  // raw: the provider's own form of this turn, replayed as is where the API
  // needs it (Gemini's function-call parts may carry thought signatures).
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; raw?: unknown }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ToolTurn {
  text: string;
  toolCalls: ToolCall[];
  raw?: unknown;
}

// Reads a streamed response line by line (SSE "data:" lines or JSON lines).
async function* readLines(response: Response): AsyncGenerator<string> {
  if (!response.body) throw new Error('No response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) yield line;
  }
  if (buffer) yield buffer;
}

const parseArguments = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

async function send(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal, label: string): Promise<Response> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  if (!response.ok) throw new ToolProviderError(`${label} error ${response.status}: ${await response.text()}`, response.status);
  return response;
}

// An HTTP error from the provider. A 4xx on a tool request usually means the
// model or endpoint does not support tools; the caller then falls back.
export class ToolProviderError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function chatWithTools(
  providerId: AIProvider,
  messages: readonly ToolMessage[],
  systemPrompt: string,
  tools: readonly ToolDefinition[],
  config: ProviderConfig,
  signal: AbortSignal,
  onText: (text: string) => void
): Promise<ToolTurn> {
  let text = '';
  const emit = (token: string) => {
    if (!token) return;
    text += token;
    onText(token);
  };

  // ─── Anthropic Messages API ───
  if (providerId === 'claude') {
    const anthropicMessages: Array<{ role: string; content: unknown }> = [];
    for (const message of messages) {
      if (message.role === 'tool') {
        const block = { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content };
        const previous = anthropicMessages[anthropicMessages.length - 1];
        // Consecutive tool results go into one user message.
        if (previous?.role === 'user' && Array.isArray(previous.content)) (previous.content as unknown[]).push(block);
        else anthropicMessages.push({ role: 'user', content: [block] });
      } else if (message.role === 'assistant') {
        anthropicMessages.push({
          role: 'assistant',
          content: [
            ...(message.content ? [{ type: 'text', text: message.content }] : []),
            ...(message.toolCalls || []).map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })),
          ],
        });
      } else {
        anthropicMessages.push({ role: 'user', content: message.content });
      }
    }
    const response = await send('https://api.anthropic.com/v1/messages', {
      'x-api-key': config.apiKey || '',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    }, {
      model: config.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: anthropicMessages,
      ...(tools.length ? { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}),
      stream: true,
    }, signal, 'Claude API');
    const blocks: Array<{ type: string; id?: string; name?: string; json: string }> = [];
    for await (const line of readLines(response)) {
      if (!line.startsWith('data: ')) continue;
      let event: any;
      try { event = JSON.parse(line.slice(6)); } catch { continue; }
      if (event.type === 'content_block_start') {
        blocks[event.index] = { type: event.content_block?.type, id: event.content_block?.id, name: event.content_block?.name, json: '' };
      } else if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'text_delta') emit(event.delta.text);
        else if (event.delta?.type === 'input_json_delta' && blocks[event.index]) blocks[event.index].json += event.delta.partial_json || '';
      } else if (event.type === 'error') {
        throw new Error(`Claude API error: ${event.error?.message || 'stream error'}`);
      }
    }
    const toolCalls = blocks
      .filter((block) => block?.type === 'tool_use')
      .map((block) => ({ id: block.id || '', name: block.name || '', arguments: parseArguments(block.json) }));
    return { text, toolCalls };
  }

  // ─── Gemini ───
  if (providerId === 'gemini') {
    const contents: Array<{ role: string; parts: unknown[] }> = [];
    for (const message of messages) {
      if (message.role === 'tool') {
        const part = { functionResponse: { name: message.name, response: { content: message.content } } };
        const previous = contents[contents.length - 1];
        if (previous?.role === 'user' && previous.parts.every((item) => (item as any).functionResponse)) previous.parts.push(part);
        else contents.push({ role: 'user', parts: [part] });
      } else if (message.role === 'assistant') {
        contents.push({
          role: 'model',
          parts: (message.raw as unknown[]) || [
            ...(message.content ? [{ text: message.content }] : []),
            ...(message.toolCalls || []).map((call) => ({ functionCall: { name: call.name, args: call.arguments } })),
          ],
        });
      } else {
        contents.push({ role: 'user', parts: [{ text: message.content }] });
      }
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse`;
    const response = await send(url, { 'x-goog-api-key': config.apiKey || '' }, {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      ...(tools.length ? { tools: [{ functionDeclarations: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }] } : {}),
    }, signal, 'Gemini');
    const parts: unknown[] = [];
    const toolCalls: ToolCall[] = [];
    for await (const line of readLines(response)) {
      if (!line.startsWith('data: ')) continue;
      let event: any;
      try { event = JSON.parse(line.slice(6)); } catch { continue; }
      for (const part of event.candidates?.[0]?.content?.parts || []) {
        parts.push(part);
        if (typeof part.text === 'string' && !part.thought) emit(part.text);
        if (part.functionCall) {
          toolCalls.push({ id: `call-${toolCalls.length + 1}`, name: part.functionCall.name, arguments: parseArguments(part.functionCall.args) });
        }
      }
    }
    return { text, toolCalls, raw: parts };
  }

  // ─── Ollama ───
  if (providerId === 'ollama') {
    const response = await send(`${config.baseUrl || 'http://localhost:11434'}/api/chat`, {}, {
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.map((message) => {
          if (message.role === 'tool') return { role: 'tool', content: message.content, tool_name: message.name };
          if (message.role === 'assistant') {
            return {
              role: 'assistant',
              content: message.content,
              ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map((call) => ({ function: { name: call.name, arguments: call.arguments } })) } : {}),
            };
          }
          return { role: 'user', content: message.content };
        }),
      ],
      ...(tools.length ? { tools: tools.map((tool) => ({ type: 'function', function: tool })) } : {}),
      stream: true,
      options: { num_ctx: contextWindowTokens(config) },
    }, signal, 'Ollama');
    const toolCalls: ToolCall[] = [];
    for await (const line of readLines(response)) {
      if (!line.trim()) continue;
      let event: any;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.error) throw new ToolProviderError(`Ollama error: ${event.error}`, 400);
      emit(event.message?.content || '');
      for (const call of event.message?.tool_calls || []) {
        toolCalls.push({ id: `call-${toolCalls.length + 1}`, name: call.function?.name || '', arguments: parseArguments(call.function?.arguments) });
      }
    }
    return { text, toolCalls };
  }

  // ─── OpenAI and OpenAI-compatible ───
  const url = providerId === 'openai'
    ? 'https://api.openai.com/v1/chat/completions'
    : buildOpenAICompatibleUrl(config.baseUrl || '');
  const response = await send(url, { Authorization: `Bearer ${config.apiKey || ''}` }, {
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages.map((message) => {
        if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
        if (message.role === 'assistant') {
          return {
            role: 'assistant',
            content: message.content || null,
            ...(message.toolCalls?.length ? {
              tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
            } : {}),
          };
        }
        return { role: 'user', content: message.content };
      }),
    ],
    ...(tools.length ? { tools: tools.map((tool) => ({ type: 'function', function: tool })) } : {}),
    stream: true,
  }, signal, providerId === 'openai' ? 'OpenAI' : 'OpenAI-compatible API');
  // Tool calls arrive in pieces keyed by index: the first piece carries the
  // id and name, later pieces append to the arguments string.
  const pending: Array<{ id: string; name: string; arguments: string }> = [];
  for await (const line of readLines(response)) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') break;
    let event: any;
    try { event = JSON.parse(data); } catch { continue; }
    const delta = event.choices?.[0]?.delta;
    if (!delta) continue;
    emit(delta.content || '');
    for (const piece of delta.tool_calls || []) {
      const index = typeof piece.index === 'number' ? piece.index : pending.length;
      pending[index] ??= { id: '', name: '', arguments: '' };
      if (piece.id) pending[index].id = piece.id;
      if (piece.function?.name) pending[index].name += piece.function.name;
      if (piece.function?.arguments) pending[index].arguments += piece.function.arguments;
    }
  }
  return {
    text,
    toolCalls: pending.filter(Boolean).map((call, index) => ({
      id: call.id || `call-${index + 1}`,
      name: call.name,
      arguments: parseArguments(call.arguments),
    })),
  };
}

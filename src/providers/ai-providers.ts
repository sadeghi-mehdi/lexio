import type { ProviderConfig, ChatMessage } from '../types.ts';

// ─── Base Interface ───

export interface AIStreamCallbacks {
  onToken: (token: string) => void;
  onDone: () => void;
  onError: (err: Error) => void;
}

export interface AIProviderInterface {
  chat(
    messages: ChatMessage[],
    systemPrompt: string,
    config: ProviderConfig,
    signal: AbortSignal,
    callbacks: AIStreamCallbacks
  ): Promise<void>;
}

// ─── Ollama ───

const ollamaProvider: AIProviderInterface = {
  async chat(messages, systemPrompt, config, signal, cb) {
    const url = `${config.baseUrl || 'http://localhost:11434'}/api/chat`;
    const body = {
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      stream: true,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) throw new Error(`Ollama error: ${res.status} ${res.statusText}`);
    if (!res.body) throw new Error('No response body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // A JSON line can be split across network chunks. Keep the unfinished
      // tail in the buffer until its newline arrives.
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json.message?.content) cb.onToken(json.message.content);
          if (json.done) cb.onDone();
        } catch {}
      }
    }
    if (buffer.trim()) {
      try {
        const json = JSON.parse(buffer);
        if (json.message?.content) cb.onToken(json.message.content);
      } catch {}
    }
    cb.onDone();
  },
};

// ─── Claude (Anthropic) ───

const claudeProvider: AIProviderInterface = {
  async chat(messages, systemPrompt, config, signal, cb) {
    const url = 'https://api.anthropic.com/v1/messages';
    const body = {
      model: config.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey || '',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Claude API error ${res.status}: ${err}`);
    }
    if (!res.body) throw new Error('No response body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            cb.onDone();
            return;
          }
          try {
            const json = JSON.parse(data);
            if (json.type === 'content_block_delta' && json.delta?.text) {
              cb.onToken(json.delta.text);
            }
            if (json.type === 'message_stop') cb.onDone();
          } catch {}
        }
      }
    }
    cb.onDone();
  },
};

// ─── OpenAI-compatible APIs ───

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

// Local providers keep document text on this machine (or the user's own
// Ollama server). Everything else is treated as a cloud upload.
export function isLocalProvider(config: ProviderConfig): boolean {
  return config.id === 'ollama' || (config.id === 'openaiCompatible' && isLoopbackUrl(config.baseUrl || ''));
}

export function buildOpenAICompatibleUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) {
    throw new Error('Enter the API base URL in Settings.');
  }
  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error('The API base URL must start with http:// or https://');
  }
  // Plain http would send the API key and the document text unencrypted.
  // It is only allowed for a server on this machine.
  if (/^http:\/\//i.test(normalized) && !isLoopbackUrl(normalized)) {
    throw new Error('Use https:// for remote API servers. Plain http:// is only allowed for localhost.');
  }
  return normalized.endsWith('/chat/completions')
    ? normalized
    : `${normalized}/chat/completions`;
}

function createOpenAICompatibleProvider(
  defaultBaseUrl: string,
  label: string,
  allowCustomBaseUrl: boolean
): AIProviderInterface {
  return {
    async chat(messages, systemPrompt, config, signal, cb) {
      const url = buildOpenAICompatibleUrl(
        allowCustomBaseUrl ? config.baseUrl || defaultBaseUrl : defaultBaseUrl
      );
      if (!config.model.trim()) throw new Error('Enter a model name in Settings.');

    const body = {
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      stream: true,
    };

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey || ''}`,
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`${label} error ${res.status}: ${err}`);
      }
      if (!res.body) throw new Error('No response body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              cb.onDone();
              return;
            }
            try {
              const json = JSON.parse(data);
              const token = json.choices?.[0]?.delta?.content;
              if (token) cb.onToken(token);
            } catch {}
          }
        }
      }
      cb.onDone();
    }
  };
}

const openaiProvider = createOpenAICompatibleProvider(
  'https://api.openai.com/v1',
  'OpenAI',
  false
);

const genericOpenAIProvider = createOpenAICompatibleProvider(
  '',
  'OpenAI-compatible API',
  true
);

// ─── Gemini ───

const geminiProvider: AIProviderInterface = {
  async chat(messages, systemPrompt, config, signal, cb) {
    // The key goes in a header, not the URL, so it never lands in logs or
    // error messages that echo the request URL.
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse`;

    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const body = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.apiKey || '',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini error ${res.status}: ${err}`);
    }
    if (!res.body) throw new Error('No response body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const json = JSON.parse(line.slice(6));
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) cb.onToken(text);
          } catch {}
        }
      }
    }
    cb.onDone();
  },
};

// ─── Provider Registry ───

export const providers: Record<string, AIProviderInterface> = {
  ollama: ollamaProvider,
  claude: claudeProvider,
  openai: openaiProvider,
  openaiCompatible: genericOpenAIProvider,
  gemini: geminiProvider,
};

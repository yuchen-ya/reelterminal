import { z } from 'zod';
import { taskModelEndpoint } from './task-review-model-config';

export interface TaskModelRequest {
  endpoint: string;
  model: string;
  apiKey: string;
  system: string;
  input: string;
  maxOutputTokens: number;
  signal: AbortSignal;
  onDelta?: (delta: string) => void;
}
export class TaskModelError extends Error {
  constructor(message: string, readonly retryable = false) { super(message); }
}
const chunkSchema = z.object({
  error: z.unknown().optional(),
  choices: z.array(z.object({
    index: z.number().int().optional(),
    delta: z.object({ content: z.string().nullable().optional() }),
    finish_reason: z.string().nullable().optional(),
  })).optional(),
});
const MAX_STREAM_BYTES = 512 * 1024;

/** Bounded, cancellable OpenAI-compatible SSE. Error bodies never leave main. */
export async function streamTaskModel(request: TaskModelRequest, fetcher: typeof fetch = fetch): Promise<string> {
  request.signal.throwIfAborted();
  const endpoint = taskModelEndpoint(request.endpoint);
  const officialDeepSeek = new URL(endpoint).origin === 'https://api.deepseek.com';
  // DeepSeek documents max_tokens and defaults to thinking/high. Use its
  // explicit non-thinking mode for the fast review/feedback lane, preserving
  // the existing OpenAI-compatible contract for every other endpoint.
  const providerOptions = officialDeepSeek
    ? { max_tokens: request.maxOutputTokens, thinking: { type: 'disabled' } }
    : { max_completion_tokens: request.maxOutputTokens, store: false };
  let response: Response;
  try {
    response = await fetcher(`${endpoint}/chat/completions`, {
      method: 'POST', redirect: 'error', signal: request.signal,
      headers: { Authorization: `Bearer ${request.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: request.model, stream: true, ...providerOptions,
        messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.input }] }),
    });
  } catch (error) {
    request.signal.throwIfAborted();
    if (error instanceof TypeError) throw new TaskModelError('Cannot connect to model provider', true);
    throw error;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new TaskModelError(`Model provider returned HTTP ${response.status}`, response.status === 429 || response.status >= 500);
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
    await response.body?.cancel();
    throw new TaskModelError('Model provider did not return an event stream');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let output = '';
  let bytes = 0;
  let stopped = false;
  let done = false;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  request.signal.addEventListener('abort', abort, { once: true });
  function event(raw: string) {
    const data = raw.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data === '[DONE]') { done = true; return; }
    let chunk: z.infer<typeof chunkSchema>;
    try { chunk = chunkSchema.parse(JSON.parse(data)); }
    catch { throw new TaskModelError('Invalid model stream event'); }
    if (chunk.error || !chunk.choices) throw new TaskModelError('Model provider reported a stream error');
    for (const choice of chunk.choices) {
      if (choice.index !== undefined && choice.index !== 0) continue;
      if (choice.finish_reason) {
        if (choice.finish_reason !== 'stop') throw new TaskModelError('Model output did not finish normally');
        stopped = true;
      }
      const delta = choice.delta.content;
      if (delta) { output += delta; request.onDelta?.(delta); }
    }
  }
  try {
    while (!done) {
      request.signal.throwIfAborted();
      const item = await reader.read();
      request.signal.throwIfAborted();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > MAX_STREAM_BYTES) throw new TaskModelError('Model output exceeded the response budget');
      buffer += decoder.decode(item.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        event(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2);
        if (done) break;
      }
    }
    if (!done || !stopped) throw new TaskModelError('Model stream ended before completion');
    return output;
  } finally {
    request.signal.removeEventListener('abort', abort);
    await reader.cancel();
    reader.releaseLock();
  }
}

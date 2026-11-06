import { createServer, type RequestListener, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { streamTaskModel, TaskModelError, type TaskModelRequest } from './task-review-provider';

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
  server = undefined;
});
async function endpoint(handler: RequestListener) {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}
function request(url: string, signal = new AbortController().signal): TaskModelRequest {
  return { endpoint: url, apiKey: 'private-test-key', model: 'configured-model', system: 'system rule', input: 'untrusted text', maxOutputTokens: 500, signal };
}
const event = (content: string, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\r\n\r\n`;

describe('task review model transport', () => {
  it('sends the configured contract and incrementally decodes split UTF-8 SSE', async () => {
    let body: unknown;
    let auth: string | undefined;
    let path: string | undefined;
    const url = await endpoint(async (req, res) => {
      auth = req.headers.authorization; path = req.url;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      body = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const bytes = Buffer.from(event('审阅') + event('', 'stop') + 'data: [DONE]\r\n\r\n');
      const split = bytes.indexOf(Buffer.from('审')) + 1;
      res.write(bytes.subarray(0, split)); setTimeout(() => res.end(bytes.subarray(split)), 5);
    });
    const deltas: string[] = [];
    expect(await streamTaskModel({ ...request(url), onDelta: (delta) => deltas.push(delta) })).toBe('审阅');
    expect(deltas).toEqual(['审阅']);
    expect(auth).toBe('Bearer private-test-key');
    expect(path).toBe('/v1/chat/completions');
    expect(body).toEqual({ model: 'configured-model', stream: true, store: false, max_completion_tokens: 500, messages: [{ role: 'system', content: 'system rule' }, { role: 'user', content: 'untrusted text' }] });
  });
  it('cancels an active response without accepting partial text as completed', async () => {
    let disconnected!: () => void;
    const closed = new Promise<void>((resolve) => { disconnected = resolve; });
    const url = await endpoint((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(event('partial'));
      res.on('close', disconnected);
    });
    const controller = new AbortController();
    const pending = streamTaskModel({ ...request(url, controller.signal), onDelta: () => controller.abort() });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await closed;
  });
  it('uses the documented bounded non-thinking contract only for the official DeepSeek origin', async () => {
    let body: unknown;
    const local = await endpoint(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      body = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(event('建议') + event('', 'stop') + 'data: [DONE]\n\n');
    });
    const transport: typeof fetch = async (url, init) => {
      expect(url).toBe('https://api.deepseek.com/chat/completions');
      // Redirect the test transport to local HTTP without changing the actual
      // request body produced by the production provider.
      return fetch(`${local}/chat/completions`, init);
    };
    expect(await streamTaskModel({ ...request('https://api.deepseek.com'), model: 'deepseek-flash' }, transport)).toBe('建议');
    expect(body).toEqual({ model: 'deepseek-flash', stream: true, max_tokens: 500, thinking: { type: 'disabled' }, messages: [{ role: 'system', content: 'system rule' }, { role: 'user', content: 'untrusted text' }] });
  });
  it.each([
    ['truncated stream', event('partial')],
    ['truncated output', event('partial', 'length') + 'data: [DONE]\n\n'],
    ['malformed event', 'data: {invalid}\n\n'],
  ])('rejects %s', async (_label, text) => {
    const url = await endpoint((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(text); });
    await expect(streamTaskModel(request(url))).rejects.toBeInstanceOf(TaskModelError);
  });
  it('sanitizes error bodies and marks transient failures retryable', async () => {
    const url = await endpoint((_req, res) => { res.writeHead(429); res.end('private-test-key untrusted text'); });
    await expect(streamTaskModel(request(url))).rejects.toMatchObject({ message: 'Model provider returned HTTP 429', retryable: true });
  });
});

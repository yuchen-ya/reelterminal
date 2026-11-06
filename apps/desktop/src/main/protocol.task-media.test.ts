import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
const state = vi.hoisted(() => ({ handler: undefined as undefined | ((request: Request) => Promise<Response>), fetch: vi.fn() }));
vi.mock('electron', () => ({ protocol: { handle: (_scheme: string, handler: typeof state.handler) => { state.handler = handler; }, registerSchemesAsPrivileged: vi.fn() }, net: { fetch: state.fetch } }));
vi.mock('./review-file-response', () => ({ reviewFileResponse: vi.fn(async (_request: Request, resource: { path: string; mime: string }) => new Response(resource.path, { headers: { 'Content-Type': resource.mime } })) }));
import { handleAppScheme } from './protocol';

describe('registered task media protocol boundary', () => {
  it('resolves only task-scoped registered asset/source identities and never falls through to renderer paths', async () => {
    const task = randomUUID(); const asset = randomUUID();
    const resolve = vi.fn(async () => ({ path: 'controlled-task-asset', mime: 'image/png' }));
    handleAppScheme('/unused-renderer', undefined, undefined, resolve);
    const response = await state.handler!(new Request(`app://reelterminal/task-media/${task}/${asset}`));
    expect(await response.text()).toBe('controlled-task-asset');
    expect(resolve).toHaveBeenCalledExactlyOnceWith(task, asset);
    for (const address of [`app://foreign/task-media/${task}/${asset}`, `app://reelterminal/task-media/${task}/arbitrary-file.png`, `app://reelterminal/task-media/${task}/extra/${asset}`]) expect((await state.handler!(new Request(address))).status).toBe(404);
    expect(state.fetch).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
    await state.handler!(new Request(`app://reelterminal/task-media/${task}/source-${asset}`));
    expect(resolve).toHaveBeenLastCalledWith(task, `source-${asset}`);
  });
  it('returns explicit missing/version conflicts without granting private-board or arbitrary-path access', async () => {
    const task = randomUUID(); const asset = randomUUID();
    const resolve = vi.fn().mockRejectedValueOnce(Object.assign(new Error('unregistered'), { code: 'ENOENT' })).mockRejectedValueOnce(Object.assign(new Error('changed'), { code: 'SOURCE_CHANGED' }));
    handleAppScheme('/unused-renderer', undefined, undefined, resolve);
    const request = () => new Request(`app://reelterminal/task-media/${task}/${asset}`);
    expect((await state.handler!(request())).status).toBe(404);
    expect((await state.handler!(request())).status).toBe(409);
    handleAppScheme('/unused-renderer');
    expect((await state.handler!(request())).status).toBe(404);
  });
});

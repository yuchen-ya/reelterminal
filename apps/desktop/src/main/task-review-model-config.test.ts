import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskReviewModelConfigStore, taskModelEndpoint } from './task-review-model-config';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
describe('task review model configuration', () => {
  it('stores only OS-encrypted credentials and never returns them to renderer', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-config-')); roots.push(root);
    const file = path.join(root, 'config.json');
    const storage = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from([...value].reverse().join('')), decryptString: (value: Buffer) => [...value.toString()].reverse().join('') };
    const store = new TaskReviewModelConfigStore(file, storage);
    const result = await store.save({ endpoint: 'https://provider.example/v1', backgroundModel: 'review-model', completionModel: 'fast-model', apiKey: 'secret-provider-key' });
    expect(result).toEqual({ endpoint: 'https://provider.example/v1', backgroundModel: 'review-model', completionModel: 'fast-model', hasApiKey: true });
    expect(await fs.readFile(file, 'utf8')).not.toContain('secret-provider-key');
    expect(await store.forRequest('completion')).toEqual({ endpoint: 'https://provider.example/v1', model: 'fast-model', apiKey: 'secret-provider-key' });
    await expect(store.save({ endpoint: 'https://other.example/v1', backgroundModel: 'review', completionModel: 'fast' })).rejects.toThrow('Re-enter');
    await store.save({ endpoint: 'https://provider.example/v1', backgroundModel: 'review', completionModel: 'fast', apiKey: '' });
    await expect(store.forRequest('background')).rejects.toThrow('Configure');
  });
  it('refuses plaintext fallback and credential-bearing endpoints', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-config-')); roots.push(root);
    const store = new TaskReviewModelConfigStore(path.join(root, 'config.json'), { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('must not encrypt'); }, decryptString: () => { throw new Error('must not decrypt'); } });
    await expect(store.save({ endpoint: 'http://127.0.0.1:1234/v1', backgroundModel: 'review', completionModel: 'fast', apiKey: 'secret' })).rejects.toThrow('encryption');
    expect(() => taskModelEndpoint('https://user:secret@example.com/v1')).toThrow();
    expect(() => taskModelEndpoint('http://external.example/v1')).toThrow();
    expect(() => taskModelEndpoint('https://example.com/v1?key=secret')).toThrow();
  });
  it('serializes profile authorization and model edits without losing either or exposing grants', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-config-')); roots.push(root);
    const store = new TaskReviewModelConfigStore(path.join(root, 'config.json'), { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() });
    const grant = { taskId: 'task', scope: 'sources' as const, sourceEntryIds: ['entry'], endpoint: 'https://provider.example/v1', createdAt: Date.now() };
    await Promise.all([
      store.saveGrant(root, grant),
      store.save({ endpoint: 'https://provider.example/v1', backgroundModel: 'review', completionModel: 'fast', apiKey: 'secret' }),
    ]);
    expect(await store.getGrant(root, 'task')).toEqual(grant);
    expect(await store.get()).toEqual({ endpoint: 'https://provider.example/v1', backgroundModel: 'review', completionModel: 'fast', hasApiKey: true });
    expect((await store.forRequest('background')).apiKey).toBe('secret');
    await Promise.all([
      store.save({ endpoint: 'https://provider.example/v1', backgroundModel: 'new-model', completionModel: 'fast' }),
      store.get(),
      store.forRequest('completion'),
      store.revokeGrant(root, 'task'),
      store.getGrant(root, 'task'),
    ]);
    expect(await store.getGrant(root, 'task')).toBeUndefined();
    expect((await store.get()).backgroundModel).toBe('new-model');
  });
});

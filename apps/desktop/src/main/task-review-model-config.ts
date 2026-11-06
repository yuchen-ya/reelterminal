import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import type { TaskAgentGrant, TaskModelConfig, TaskModelConfigInput } from '../shared/task-review-runtime-types';

export interface TaskCredentialStorage {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(buffer: Buffer): string;
}
const configSchema = z.object({
  endpoint: z.string().max(2048),
  backgroundModel: z.string().trim().min(1).max(200),
  completionModel: z.string().trim().min(1).max(200),
  encryptedApiKey: z.string().optional(),
  grants: z.array(z.object({
    root: z.string().min(1),
    grant: z.object({ taskId: z.string(), scope: z.enum(['task', 'sources']), sourceEntryIds: z.array(z.string()), endpoint: z.string(), createdAt: z.number() }).strict(),
  }).strict()).default([]),
}).strict();
const inputSchema = configSchema.omit({ encryptedApiKey: true, grants: true }).extend({ apiKey: z.string().max(4096).optional() });
type StoredConfig = z.infer<typeof configSchema>;

export function taskModelEndpoint(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('Model endpoint cannot contain credentials, a query or a fragment');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Model endpoint requires HTTPS, except for a local provider');
  }
  return url.toString().replace(/\/$/, '');
}

/** Only Electron main receives safeStorage; there is no plaintext fallback. */
export class TaskReviewModelConfigStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string, private readonly credentials: TaskCredentialStorage) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.pending.then(work);
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private publicConfig(config: StoredConfig): TaskModelConfig {
    return { endpoint: config.endpoint, backgroundModel: config.backgroundModel, completionModel: config.completionModel, hasApiKey: Boolean(config.encryptedApiKey) };
  }

  private async read(): Promise<StoredConfig> {
    let text: string;
    try { text = await fs.readFile(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { endpoint: 'https://api.openai.com/v1', backgroundModel: 'gpt-6.1-sol', completionModel: 'gpt-6.1-sol', grants: [] };
    }
    const config = configSchema.parse(JSON.parse(text));
    taskModelEndpoint(config.endpoint);
    return config;
  }

  get(): Promise<TaskModelConfig> {
    return this.serial(async () => this.publicConfig(await this.read()));
  }

  private async write(config: StoredConfig) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(`${this.file}.tmp`, JSON.stringify(config), { mode: 0o600 });
    await fs.rename(`${this.file}.tmp`, this.file);
  }

  /** Authorization belongs to this local profile, never to a portable task. */
  getGrant(root: string, taskId: string): Promise<TaskAgentGrant | undefined> {
    return this.serial(async () => (await this.read()).grants.find((item) => item.root === root && item.grant.taskId === taskId)?.grant);
  }

  saveGrant(root: string, grant: TaskAgentGrant): Promise<void> {
    return this.serial(async () => {
      const config = await this.read();
      config.grants = config.grants.filter((item) => item.root !== root || item.grant.taskId !== grant.taskId);
      config.grants.push({ root, grant });
      await this.write(config);
    });
  }

  revokeGrant(root: string, taskId: string): Promise<void> {
    return this.serial(async () => {
      const config = await this.read();
      config.grants = config.grants.filter((item) => item.root !== root || item.grant.taskId !== taskId);
      await this.write(config);
    });
  }

  save(input: TaskModelConfigInput): Promise<TaskModelConfig> {
    return this.serial(async () => {
      const parsed = inputSchema.parse(input);
      const previous = await this.read();
      const endpoint = taskModelEndpoint(parsed.endpoint);
      // A retained key must never silently move to a different provider.
      if (endpoint !== previous.endpoint && parsed.apiKey === undefined && previous.encryptedApiKey) throw new Error('Re-enter the API key when changing providers');
      let encryptedApiKey = previous.encryptedApiKey;
      if (parsed.apiKey !== undefined) {
        if (parsed.apiKey && !this.credentials.isEncryptionAvailable()) throw new Error('Operating-system credential encryption is unavailable');
        encryptedApiKey = parsed.apiKey ? this.credentials.encryptString(parsed.apiKey).toString('base64') : undefined;
      }
      const config: StoredConfig = { endpoint, backgroundModel: parsed.backgroundModel, completionModel: parsed.completionModel, grants: previous.grants, ...(encryptedApiKey ? { encryptedApiKey } : {}) };
      await this.write(config);
      return this.publicConfig(config);
    });
  }

  forRequest(kind: 'background' | 'completion'): Promise<{ endpoint: string; model: string; apiKey: string }> {
    return this.serial(async () => {
      const config = await this.read();
      if (!config.encryptedApiKey) throw new Error('Configure a model provider and API key first');
      if (!this.credentials.isEncryptionAvailable()) throw new Error('Operating-system credential encryption is unavailable');
      return { endpoint: config.endpoint, model: kind === 'background' ? config.backgroundModel : config.completionModel, apiKey: this.credentials.decryptString(Buffer.from(config.encryptedApiKey, 'base64')) };
    });
  }
}

import type { ElectronApplication } from 'playwright-core';

export const TASK_REVIEW_DEEPSEEK = {
  endpoint: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  credentialVariable: 'DEEPSEEK_API_KEY',
} as const;

/**
 * Explicit real-provider acceptance only. The launcher reads the user-selected
 * environment scope into the isolated Electron process. No credential travels
 * through a Playwright argument, renderer input, command line or evidence.
 * This helper does not launch an app, authorize a task or send a model request.
 */
export async function configureTaskReviewDeepSeekProfile(app: ElectronApplication) {
  if (process.env.REELTERMINAL_TASK_REVIEW_DEEPSEEK_ACCEPTANCE !== '1') {
    throw new Error('Real DeepSeek acceptance requires its explicit opt-in');
  }
  return app.evaluate(async ({ app, safeStorage }) => {
    const fs = process.getBuiltinModule('fs/promises') as typeof import('node:fs/promises');
    const path = process.getBuiltinModule('path') as typeof import('node:path');
    const runRoot = process.env.REELTERMINAL_USER_DATA_DIR;
    const userData = await fs.realpath(app.getPath('userData'));
    if (!runRoot || await fs.realpath(runRoot) !== userData) throw new Error('An isolated acceptance profile is required');
    const secret = process.env.DEEPSEEK_API_KEY;
    if (!secret || !secret.trim()) throw new Error('The selected DeepSeek environment credential is unavailable');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential encryption is unavailable in the isolated profile');
    const destination = path.join(userData, 'task-review-model.json');
    const config = {
      endpoint: 'https://api.deepseek.com',
      backgroundModel: 'deepseek-flash',
      completionModel: 'deepseek-flash',
      encryptedApiKey: safeStorage.encryptString(secret).toString('base64'),
      grants: [],
    };
    const temporary = `${destination}.deepseek-acceptance.tmp`;
    await fs.writeFile(temporary, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, destination);
    // Configuration is encrypted; future launches read that profile, not env.
    delete process.env.DEEPSEEK_API_KEY;
    return { endpoint: config.endpoint, backgroundModel: config.backgroundModel, completionModel: config.completionModel, hasApiKey: true };
  });
}

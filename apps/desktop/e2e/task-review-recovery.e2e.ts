/** Real isolated packaged IPC/UI and disk recovery; no user profile or model. */
import { open, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { launchApp } from './harness/launch';
import { createEvidence } from './harness/evidence';
import { openLauncher, openNoteTab } from './harness/task-review-shell';
import { CHANNELS } from '../src/shared/channels';

test('review recovery preserves inputs and exact decisions across real sharing denial, lost replies and restart', async () => {
  let launched = await launchApp();
  let page = launched.page;
  const evidence = createEvidence(`task-review-recovery-${Date.now()}`, page);
  page.setDefaultTimeout(15_000);
  try {
    evidence.record('entry', process.env.REELTERMINAL_E2E_APP_EXECUTABLE ?? 'checkout');
    evidence.record('application', await launched.app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() })));
    const root = path.join(launched.userDataDir, 'review', 'tasks', 'recovery-acceptance');
    await page.evaluate(() => localStorage.setItem('openreel-locale', 'zh-CN'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: /审阅工作台/ }).click();
    await page.getByTestId('review-workspace-open').click();
    await page.getByTestId('folder-task-new').click();
    const creation = page.getByRole('dialog', { name: '新建任务' });
    await creation.getByLabel('任务名称').fill('隔离恢复验收');
    await creation.getByLabel('文件夹名称').fill('recovery-acceptance');
    await creation.getByRole('button', { name: '创建', exact: true }).click();
    await page.getByTestId('task-review-workspace').waitFor();
    const authority = () => page.evaluate(root => window.reelterminal.taskReview.open(root), root);
    let state = await authority();
    state = await page.evaluate(async state => window.reelterminal.taskReview.importText({ root: state.root, taskId: state.taskId, expectedRevision: state.revision, name: 'recovery', format: 'txt', text: 'A: controlled recovery fixture\nB: remains pending to keep the feedback editor open' }), state);
    // Reload view from the persisted authority, never synthesize saved JSON.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: /审阅工作台/ }).click();
    await page.getByTestId('task-review-workspace').waitFor();
    await openLauncher(page, 'overview');
    await page.getByTestId('task-review-unit-row').filter({ hasText: 'A:' }).click();
    await openNoteTab(page);
    const note = page.getByTestId('task-review-unit-note');
    const destination = path.join(root, '.reelterminal', 'task-review.json');
    const saveStatus = page.getByTestId('task-review-save-status');
    const assertSavedDraft = async (text: string) => {
      // Autosave debounces text AND cursor changes by 600ms. Repeated authority
      // opens under vi.waitFor's default 1s deadline compete for the same root
      // lock and can expire before the UI has acknowledged a real save.
      // Observe that acknowledgement first (the existing page timeout applies),
      // then independently verify the exact persisted bytes, without hot reads.
      await saveStatus.waitFor({ state: 'hidden' });
      expect(await note.inputValue()).toBe(text);
      const current = await authority();
      const draft = current.drafts.find(entry => entry.unitId === state.units[0].id);
      expect(draft?.text).toBe(text);
      const stored = JSON.parse(await readFile(destination, 'utf8'));
      expect(stored.drafts).toEqual(current.drafts);
      evidence.record(`savedDraft-${text.length}`, { revision: current.revision, textLength: text.length, selectionStart: draft!.selectionStart, selectionEnd: draft!.selectionEnd, independentlyRead: true });
    };
    await note.fill('persistent human note');
    await saveStatus.waitFor({ state: 'visible' });
    await note.press('Home'); await note.press('Shift+ArrowRight');
    await assertSavedDraft('persistent human note');

    // Faults are attached only to this isolated process. Original handlers still
    // execute sender checks, schemas, root locks, CAS and actual atomic writes.
    await launched.app.evaluate(({ ipcMain }, { root, destination, channel }) => {
      const fs = process.getBuiltinModule('fs/promises') as typeof import('node:fs/promises');
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Function> })._invokeHandlers;
      if (!(handlers instanceof Map)) throw new Error('Isolated handler fault injection unsupported');
      const original = handlers.get(channel)!;
      const control = { mode: 'normal', queryFail: false, denyRename: false, holdDecision: false, held: false, completedDecisions: 0, notifyFail: false, notificationFailures: 0, decisions: 0, lastId: '', renameAttempts: 0 };
      (globalThis as any).p0Recovery = control;
      const rename = fs.rename.bind(fs), realpath = fs.realpath.bind(fs);
      fs.rename = async (from, to) => {
        if (String(to) === destination) {
          control.renameAttempts++;
          if (control.denyRename) throw Object.assign(new Error('controlled atomic replacement denial'), { code: 'EPERM' });
        }
        return rename(from, to);
      };
      fs.realpath = async (...args: Parameters<typeof fs.realpath>) => {
        if (control.notifyFail && String(args[0]) === root && new Error().stack?.includes('onTaskChanged')) {
          control.notificationFailures++;
          throw Object.assign(new Error('controlled post-commit notification denial'), { code: 'EPERM' });
        }
        return realpath(...args);
      };
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, envelope) => {
        if (envelope.method === 'getDecisionOutcome' && control.queryFail) throw new Error('controlled outcome query denial');
        if (envelope.method !== 'decide') return original(event, envelope);
        control.decisions++; control.lastId = envelope.input.decisionId;
        try {
          if (control.holdDecision) {
            await new Promise<void>(resolve => {
              (globalThis as any).releaseRecoveryDecision = resolve;
              control.held = true;
            });
            control.held = false;
          }
          const result = await original(event, envelope);
          if (control.mode === 'lose-reply') throw new Error('controlled response loss');
          return result;
        } finally { control.completedDecisions++; }
      });
    }, { root, destination, channel: CHANNELS.taskReview });
    const control = async (values: Record<string, unknown>) => launched.app.evaluate((_electron, values) => Object.assign((globalThis as any).p0Recovery, values), values);
    const counters = () => launched.app.evaluate(() => ({ ...(globalThis as any).p0Recovery }));
    const disk = async () => JSON.parse(await readFile(destination, 'utf8'));

    // A held native reader denies rename on Windows. POSIX permits replacing an
    // open file, so inject the same filesystem failure there, without bypassing
    // the actual store/IPC path. Do not claim native POSIX sharing denial.
    evidence.record('replacementDenial', process.platform === 'win32' ? 'native-held-reader' : 'injected-EPERM');
    const beforeBytes = await readFile(destination, 'utf8');
    const before = await authority();
    const reader = await open(destination, 'r');
    await control({ mode: 'lose-reply', queryFail: true, denyRename: process.platform !== 'win32' });
    try {
      await page.getByTestId('task-review-decide-kept').click();
      await page.getByTestId('task-review-reconcile-decision').waitFor();
      await vi.waitFor(async () => expect((await counters()).completedDecisions).toBe(1));
      expect((await counters()).renameAttempts).toBeGreaterThan(0);
      expect(await readFile(destination, 'utf8')).toBe(beforeBytes);
      expect((await authority()).revision).toBe(before.revision);
      expect((await counters()).decisions).toBe(1);
      await note.fill('newer input during recovery');
      await page.getByTestId('task-review-reconcile-decision').click();
      await vi.waitFor(async () => expect(await page.getByTestId('task-review-error').textContent()).toContain('controlled outcome query denial'));
      expect(await note.inputValue()).toBe('newer input during recovery');
      // A public programmatic write and mouse/keyboard decisions all hit the
      // same barrier. No extra native decision request reaches main.
      const blocked = await page.evaluate(async root => {
        const api = window.reelterminal.taskReview;
        const state = await api.open(root);
        try { await api.setGoal({ root, taskId: state.taskId, expectedRevision: state.revision, goal: 'must remain blocked' }); return false; }
        catch { return true; }
      }, root);
      expect(blocked).toBe(true);
      await page.getByTestId('task-review-decide-kept').click();
      await page.getByTestId('task-review-decide-kept').focus();
      await page.keyboard.press('Enter');
      expect((await counters()).decisions).toBe(1);
      expect(await readFile(destination, 'utf8')).toBe(beforeBytes);
      expect((await readdir(path.dirname(destination))).filter(name => name.endsWith('.tmp'))).toEqual([]);
      await evidence.screenshot('uncertain-rejected-input-retained');
    } finally { await reader.close(); await control({ denyRename: false }); }
    await control({ mode: 'normal', queryFail: false });
    await page.getByTestId('task-review-reconcile-decision').click();
    await vi.waitFor(async () => expect(await page.getByTestId('task-review-write-recovery').textContent()).toContain('未提交'));
    expect(await note.inputValue()).toBe('newer input during recovery');
    expect((await disk()).decisions).toHaveLength(0);
    // Once explicitly retried after release, exactly one decision is published.
    await page.getByTestId('task-review-decide-kept').click();
    await vi.waitFor(async () => expect((await authority()).decisions).toHaveLength(1));
    // Disk visibility precedes completion of notification and the IPC response.
    await vi.waitFor(async () => expect(await page.getByTestId('task-review-decide-kept').isEnabled()).toBe(true));
    let durable = await disk();
    expect(durable.decisionActions).toHaveLength(1);
    expect(durable.decisions[0].note).toBe('newer input during recovery');
    evidence.record('persistentDenialThenExplicitRetry', { originalRevision: before.revision, savedRevision: durable.revision, decisions: durable.decisions.length, actions: durable.decisionActions.length });

    // Real write followed by notification-only failure remains committed.
    await control({ notifyFail: true });
    const notification = await page.evaluate(async root => {
      const api = window.reelterminal.taskReview, state = await api.open(root), unit = state.units[0];
      return api.decide({ root, taskId: state.taskId, expectedRevision: state.revision, unitId: unit.id, sourceVersionId: unit.sourceVersionId, purpose: 'review', status: 'kept', note: 'notification warning decision' });
    }, root);
    expect(notification.decisionReceipt).toMatchObject({ outcome: 'committed', notificationFailed: true });
    expect((await counters()).notificationFailures).toBe(1);
    durable = await disk(); expect(durable.decisions).toHaveLength(2); expect(durable.decisionActions).toHaveLength(2);
    await control({ notifyFail: false });

    // UI lost-commit response: stale local revision may first need ordinary
    // source refresh after the direct transport test, never a decision replay.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: /审阅工作台/ }).click();
    await page.getByTestId('task-review-workspace').waitFor();
    await openLauncher(page, 'overview');
    await page.getByTestId('task-review-unit-row').filter({ hasText: 'A:' }).click();
    await openNoteTab(page);
    await note.fill('lost committed response');
    await saveStatus.waitFor({ state: 'visible' });
    await assertSavedDraft('lost committed response');
    const completedBefore = (await counters()).completedDecisions;
    await control({ mode: 'lose-reply', queryFail: false, holdDecision: true });
    try {
      await page.getByTestId('task-review-decide-kept').click();
      await vi.waitFor(async () => expect((await counters()).held).toBe(true));
      // The banner/button exists during ordinary in-flight saving, before IPC
      // completes. It cannot serve as a disk-commit or lost-response signal.
      await page.getByTestId('task-review-reconcile-decision').waitFor();
      const saving = await disk();
      expect(saving.decisions).toHaveLength(2); expect(saving.decisionActions).toHaveLength(2);
      const decisionId = (await counters()).lastId;
      const earlyQuery = await page.evaluate(async ({ root, decisionId }) => {
        const api = window.reelterminal.taskReview, state = await api.open(root);
        try { await api.getDecisionOutcome({ root: state.root, taskId: state.taskId, decisionId }); return 'unexpected verified outcome'; }
        catch (error) { return String(error); }
      }, { root, decisionId });
      expect(earlyQuery).toContain('仍无法确认');
      evidence.record('queryWhileDecisionHeld', { decisions: saving.decisions.length, actions: saving.decisionActions.length, remainedUnknown: true });
    } finally {
      await control({ queryFail: true, holdDecision: false });
      await launched.app.evaluate(() => (globalThis as any).releaseRecoveryDecision?.());
    }
    await vi.waitFor(async () => expect((await counters()).completedDecisions).toBe(completedBefore + 1));
    await vi.waitFor(async () => expect(await page.getByTestId('task-review-write-recovery').textContent()).toContain('结果待核对'));
    await page.getByTestId('task-review-reconcile-decision').waitFor();
    const lost = await disk(); expect(lost.decisions).toHaveLength(3); expect(lost.decisionActions).toHaveLength(3);
    await note.fill('input typed after saved reply was lost');
    await page.getByTestId('task-review-reconcile-decision').click();
    await vi.waitFor(async () => expect(await page.getByTestId('task-review-error').textContent()).toContain('controlled outcome query denial'));
    expect(await note.inputValue()).toBe('input typed after saved reply was lost');
    await control({ mode: 'normal', queryFail: false });
    await page.getByTestId('task-review-reconcile-decision').click();
    await vi.waitFor(async () => expect(await page.getByTestId('task-review-write-recovery').textContent()).toContain('无需再次提交'));
    durable = await disk();
    expect(durable.decisions).toEqual(lost.decisions); expect(durable.decisionActions).toEqual(lost.decisionActions);
    expect(await note.inputValue()).toBe('input typed after saved reply was lost');
    evidence.record('faultCounters', await counters());
    await evidence.screenshot('committed-reconciled-without-replay');

    // Real process close/reopen, with no persistent pending-intent journal.
    const savedDecisions = durable.decisions, savedActions = durable.decisionActions;
    launched = await launched.relaunch(); page = launched.page; evidence.bindPage(page);
    const reopened = await page.evaluate(root => window.reelterminal.taskReview.open(root), root);
    expect(reopened.decisions).toEqual(savedDecisions); expect(reopened.decisionActions).toEqual(savedActions);
    const reopenedDisk = await disk();
    expect(reopenedDisk.decisions).toEqual(savedDecisions); expect(reopenedDisk.decisionActions).toEqual(savedActions);
    expect(reopenedDisk.revision).toBe(reopened.revision);
    evidence.record('reopened', { revision: reopened.revision, decisions: reopened.decisions.length, actions: reopened.decisionActions.length });
    evidence.flush({ passed: true });
  } catch (error) {
    evidence.record('failureControl', await launched.app.evaluate(() => (globalThis as any).p0Recovery ?? null).catch(() => null));
    evidence.record('failureRecovery', await page.getByTestId('task-review-write-recovery').textContent().catch(() => null));
    evidence.record('failureDraft', {
      inputLength: await page.getByTestId('task-review-unit-note').inputValue().then(text => text.length, () => null),
      saveStatus: await page.getByTestId('task-review-save-status').textContent({ timeout: 1000 }).catch(() => null),
    });
    await evidence.screenshot('failure').catch(() => {});
    evidence.flush({ passed: false, failure: error instanceof Error ? error.message : String(error), rendererConsole: launched.output.rendererConsole });
    throw error;
  } finally { await launched.close(); }
});

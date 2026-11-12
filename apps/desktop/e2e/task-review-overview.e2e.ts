/** Synthetic local image review only: no user task, visual model or paid API. */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { expect, test, vi } from 'vitest';
import type { TaskReviewSnapshot } from '../src/shared/task-review';
import { selectTaskDecision } from '../src/shared/task-review-selectors';
import { launchApp, type LaunchedApp } from './harness/launch';
import { createEvidence } from './harness/evidence';
import { writeRgbaPng } from './harness/repair-acceptance-fixtures';

const NOTE = '边缘需要清理';
const snapshotAt = (page: Page, root: string): Promise<TaskReviewSnapshot> => page.evaluate(root => window.reelterminal.taskReview.open(root), root);
function distribution(snapshot: TaskReviewSnapshot) {
  const counts = { kept: 0, rework: 0, discarded: 0, pending: 0 };
  for (const unit of snapshot.units) {
    const decision = selectTaskDecision(snapshot, { unitId: unit.id, sourceVersionId: unit.sourceVersionId, purpose: 'review' });
    counts[decision?.status ?? 'pending']++;
  }
  return counts;
}

test('reviews an image grid, reuses feedback, undoes exact batches and exports retained original bytes', async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'task-review-overview-'));
  const evidence = createEvidence('task-review-overview');
  let launched: LaunchedApp | undefined;
  let taskRoot: string | undefined;
  try {
    launched = await launchApp({ runDir });
    await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    let page = launched.page;
    evidence.bindPage(page);
    await page.evaluate(() => localStorage.setItem('openreel-locale', 'zh-CN'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: /审阅工作台/ }).click();
    await page.getByTestId('review-workspace-open').click();
    await page.getByTestId('folder-task-new').click();
    const create = page.getByRole('dialog', { name: '新建任务' });
    await create.getByLabel('任务名称').fill('隔离图片总览验收');
    await create.getByLabel('文件夹名称').fill('image-overview-acceptance');
    await create.getByRole('button', { name: '创建', exact: true }).click();
    await page.getByTestId('task-review-workspace').waitFor();
    taskRoot = path.join(launched.userDataDir, 'review', 'tasks', 'image-overview-acceptance');
    const root = taskRoot;
    const originalHashes = new Map<string, string>();
    for (let number = 1; number <= 12; number++) {
      const pixels = Buffer.alloc(64 * 64 * 4);
      for (let y = 12; y < 52; y++) for (let x = 12; x < 52; x++) {
        const index = (y * 64 + x) * 4;
        pixels.set([40 + number * 10, 150, 220 - number * 8, x < 16 || y < 16 ? 128 : 255], index);
      }
      const name = `${String(number).padStart(2, '0')}.png`;
      const file = path.join(root, name);
      writeRgbaPng(file, 64, 64, pixels);
      originalHashes.set(name, createHash('sha256').update(await readFile(file)).digest('hex'));
    }
    await vi.waitFor(async () => expect((await snapshotAt(page, root)).units).toHaveLength(12), { timeout: 30000 });
    await page.getByTestId('task-review-media-overview').waitFor();
    const cards = () => page.getByTestId('task-review-media-card');
    const card = (name: string) => cards().filter({ has: page.locator(`span[title="${name}"]`) });
    await vi.waitFor(async () => expect(await cards().count()).toBe(12));
    expect((await snapshotAt(page, root)).mediaAssets ?? []).toEqual([]);
    const overview = page.getByTestId('task-review-media-overview');
    const tools = page.getByTestId('agent-spotlight-card');
    const readLayout = () => overview.evaluate(stage => {
      const bounds = stage.getBoundingClientRect();
      const grid = stage.querySelector('[data-testid="task-review-media-grid"]')!.getBoundingClientRect();
      const visibleCards = [...stage.querySelectorAll('[data-testid="task-review-media-card"]')].filter(card => {
        const box = card.getBoundingClientRect();
        return box.top >= bounds.top && box.bottom <= Math.min(bounds.bottom, innerHeight);
      }).length;
      return { viewportWidth: innerWidth, viewportHeight: innerHeight, spaceAboveGrid: grid.top - bounds.top, visibleCards, horizontalOverflow: stage.scrollWidth - stage.clientWidth };
    });
    const layout = await readLayout();
    evidence.record('overviewLayout', layout);
    expect(layout.spaceAboveGrid).toBeLessThanOrEqual(100);
    expect(layout.visibleCards).toBe(12);
    expect(await overview.locator('textarea').count()).toBe(0);
    expect(await overview.getByTestId('task-review-media-batch-rework').count()).toBe(0);
    expect(await tools.locator('textarea').count()).toBe(0);
    expect(await tools.getByTestId('spotlight-back-btn').count()).toBe(0);
    expect(await tools.getByTestId('spotlight-completion-toggle').count()).toBe(0);
    expect(await tools.locator('[data-testid^="spotlight-step-dot-"]').count()).toBe(0);
    await vi.waitFor(async () => {
      const images = cards().locator('img');
      expect(await images.count()).toBe(12);
      expect(await images.evaluateAll(nodes => nodes.every(node => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth === 64))).toBe(true);
    });
    await evidence.screenshot('compact-overview');
    await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1024, 720));
    await vi.waitFor(async () => expect((await readLayout()).viewportWidth).toBeLessThanOrEqual(1024));
    const smallLayout = await readLayout();
    evidence.record('smallOverviewLayout', smallLayout);
    expect(smallLayout.spaceAboveGrid).toBeLessThanOrEqual(100);
    expect(smallLayout.horizontalOverflow).toBeLessThanOrEqual(1);
    expect(smallLayout.visibleCards).toBeGreaterThanOrEqual(3);
    await evidence.screenshot('compact-small-window');
    await overview.hover({ position: { x: 20, y: 100 } });
    await page.mouse.wheel(0, 1000);
    await vi.waitFor(async () => expect(await overview.evaluate(stage => stage.scrollTop)).toBeGreaterThan(0));
    const scrolled = await overview.evaluate(stage => ({
      scrollTop: stage.scrollTop,
      filterTopOffset: stage.querySelector('section')!.getBoundingClientRect().top - stage.getBoundingClientRect().top,
    }));
    evidence.record('smallOverviewScroll', scrolled);
    expect(Math.abs(scrolled.filterTopOffset)).toBeLessThanOrEqual(1);
    await page.mouse.wheel(0, -2000);
    await vi.waitFor(async () => expect(await overview.evaluate(stage => stage.scrollTop)).toBe(0));
    await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await vi.waitFor(async () => expect((await readLayout()).viewportWidth).toBeGreaterThan(1500));
    const search = overview.getByRole('textbox');
    await search.fill('12.png');
    await vi.waitFor(async () => expect(await cards().count()).toBe(1));
    expect(await card('12.png').isVisible()).toBe(true);
    await search.fill('');
    await vi.waitFor(async () => expect(await cards().count()).toBe(12));

    await card('01.png').getByRole('checkbox').check();
    await card('03.png').getByRole('checkbox').click({ modifiers: ['Shift'] });
    expect(await page.getByTestId('task-review-media-selection-count').textContent()).toContain('3');
    expect(await tools.getByTestId('task-review-media-card-selection-count').textContent()).toContain('3');
    await tools.getByTestId('task-review-media-batch-rework').click();
    await tools.getByTestId('task-review-media-batch-note').fill(NOTE);
    expect(await overview.locator('textarea').count()).toBe(0);
    await evidence.screenshot('selected-rework-card');
    await tools.getByTestId('task-review-media-confirm-rework').click();
    await vi.waitFor(async () => expect(distribution(await snapshotAt(page, root))).toEqual({ kept: 0, rework: 3, discarded: 0, pending: 9 }));
    await page.getByTestId('task-review-media-filter-rework').click();
    await vi.waitFor(async () => expect(await cards().count()).toBe(3));
    await evidence.screenshot('rework-filter-and-tools');
    await vi.waitFor(async () => expect(await tools.locator('textarea').count()).toBe(0));
    await card('01.png').getByRole('checkbox').check();
    await tools.getByTestId('task-review-media-batch-rework').click();
    await tools.getByTestId('task-review-media-batch-note-reuse-last').click();
    expect(await tools.getByTestId('task-review-media-batch-note').inputValue()).toBe(NOTE);
    expect(distribution(await snapshotAt(page, root))).toEqual({ kept: 0, rework: 3, discarded: 0, pending: 9 });
    await tools.getByTestId('task-review-media-cancel-rework').click();
    await card('01.png').getByRole('checkbox').uncheck();

    await tools.getByTestId('task-review-media-undo-batch').click();
    await vi.waitFor(async () => expect(distribution(await snapshotAt(page, root))).toEqual({ kept: 0, rework: 0, discarded: 0, pending: 12 }));
    await tools.getByTestId('task-review-media-redo-batch').click();
    await vi.waitFor(async () => expect(distribution(await snapshotAt(page, root))).toEqual({ kept: 0, rework: 3, discarded: 0, pending: 9 }));
    await page.getByTestId('task-review-media-filter-pending').click();
    await card('04.png').getByRole('checkbox').check();
    expect(await tools.locator('textarea').count()).toBe(0);
    await tools.getByTestId('task-review-media-batch-discarded').click();
    await vi.waitFor(async () => expect(distribution(await snapshotAt(page, root))).toEqual({ kept: 0, rework: 3, discarded: 1, pending: 8 }));

    await card('05.png').getByTestId('task-review-media-inspect').click();
    await page.getByTestId('task-review-media-lightbox').waitFor();
    await vi.waitFor(async () => expect(await page.getByTestId('task-review-media-inspector-image').evaluate(node => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth === 64)).toBe(true));
    await page.getByTestId('task-review-media-original-pixels').click();
    expect(await page.getByTestId('task-review-media-zoom').textContent()).toBe('100%');
    await page.getByTestId('task-review-media-transparency-toggle').click();
    expect(await page.getByTestId('task-review-media-lightbox').locator('textarea').count()).toBe(0);
    await page.getByTestId('task-review-media-rework-next').click();
    await page.getByTestId('task-review-media-inspector-note-reuse-last').click();
    expect(await page.getByTestId('task-review-media-inspector-note').inputValue()).toBe(NOTE);
    expect(distribution(await snapshotAt(page, root))).toEqual({ kept: 0, rework: 3, discarded: 1, pending: 8 });
    await evidence.screenshot('lightweight-inspection');
    await page.getByTestId('task-review-media-lightbox').getByTestId('task-review-media-cancel-rework').click();
    await page.getByTestId('task-review-media-kept-next').click();
    await vi.waitFor(async () => expect(distribution(await snapshotAt(page, root))).toEqual({ kept: 1, rework: 3, discarded: 1, pending: 7 }));
    await vi.waitFor(async () => {
      const image = page.getByTestId('task-review-media-inspector-image');
      expect(await image.getAttribute('alt')).toBe('06.png');
      expect(await image.evaluate(node => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth === 64)).toBe(true);
    });
    await page.getByTestId('task-review-media-close-inspector').click();
    expect(await tools.locator('textarea').count()).toBe(0);
    await tools.getByTestId('task-review-media-keep-remaining').click();
    expect(await page.getByTestId('task-review-media-keep-confirmation').textContent()).toContain('7');
    await tools.getByTestId('task-review-media-confirm-keep-remaining').click();
    await vi.waitFor(async () => expect(distribution(await snapshotAt(page, root))).toEqual({ kept: 8, rework: 3, discarded: 1, pending: 0 }));
    await tools.getByTestId('task-review-media-undo-batch').click();
    await vi.waitFor(async () => expect(distribution(await snapshotAt(page, root))).toEqual({ kept: 1, rework: 3, discarded: 1, pending: 7 }));
    await tools.getByTestId('task-review-media-redo-batch').click();
    await vi.waitFor(async () => expect(distribution(await snapshotAt(page, root))).toEqual({ kept: 8, rework: 3, discarded: 1, pending: 0 }));
    const reviewed = await snapshotAt(page, root);
    expect(reviewed.mediaAssets ?? []).toEqual([]);
    expect(reviewed.decisions.filter(decision => decision.status === 'rework').map(decision => decision.note)).toEqual([NOTE, NOTE, NOTE]);
    expect(reviewed.decisions.filter(decision => decision.status !== 'rework').every(decision => decision.note === '')).toBe(true);
    await page.getByTestId('task-review-media-filter-all').click();
    await card('05.png').getByRole('checkbox').check();
    expect(await tools.getByTestId('task-review-media-batch-discarded').isEnabled()).toBe(true);
    expect(await tools.locator('textarea').count()).toBe(0);
    await card('05.png').getByRole('checkbox').uncheck();
    await evidence.screenshot('all-statuses-after-batch-review');

    await tools.getByTestId('task-review-media-open-export').click();
    if (await page.getByTestId('task-result-export-toggle').isVisible() && !await page.getByTestId('task-result-export-choose-destination').isVisible()) await page.getByTestId('task-result-export-toggle').click();
    const exportRows = page.getByTestId('task-result-export-file');
    await vi.waitFor(async () => expect(await exportRows.count()).toBeGreaterThan(0));
    for (const row of await exportRows.all()) await row.getByRole('checkbox').check();
    const destination = path.join(runDir, 'retained-originals');
    await mkdir(destination);
    await launched.app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, destination);
    await page.getByTestId('task-result-export-choose-destination').click();
    await page.getByTestId('task-result-export-preview-button').click();
    await page.getByTestId('task-result-export-execute-button').waitFor();
    await page.getByTestId('task-result-export-execute-button').click();
    await vi.waitFor(async () => expect((await snapshotAt(page, root)).originalExports?.at(-1)?.status).toBe('complete'), { timeout: 30000 });
    const receipt = (await snapshotAt(page, root)).originalExports!.at(-1)!;
    expect(receipt.items).toHaveLength(8);
    for (const item of receipt.items) {
      expect(item.outputKind).toBe('original');
      expect(item.allKept).toBe(true);
      const hash = createHash('sha256').update(await readFile(path.join(receipt.outputDirectory, item.relativeOutputPath))).digest('hex');
      expect(hash).toBe(originalHashes.get(path.basename(item.relativePath)));
    }
    for (const [name, hash] of originalHashes) expect(createHash('sha256').update(await readFile(path.join(root, name))).digest('hex')).toBe(hash);
    await evidence.screenshot('retained-original-export');
    evidence.record('finalDistribution', distribution(reviewed));
    evidence.record('batchSizes', reviewed.decisionBatches?.map(batch => batch.decisionIds.length));
    evidence.record('exportedCount', receipt.items.length);
    evidence.record('mediaAssetsCreatedByOverview', reviewed.mediaAssets?.length ?? 0);
    expect(launched.output.rendererConsole.filter(line => line.startsWith('[pageerror]'))).toEqual([]);
    launched = await launched.relaunch();
    page = launched.page;
    evidence.bindPage(page);
    await page.getByTestId('task-review-workspace').waitFor();
    await vi.waitFor(async () => expect(distribution(await snapshotAt(page, root))).toEqual({ kept: 8, rework: 3, discarded: 1, pending: 0 }));
    expect((await snapshotAt(page, root)).decisionBatches).toEqual(reviewed.decisionBatches);
    evidence.flush({ passed: true });
  } catch (problem) {
    evidence.record('failure', problem instanceof Error ? problem.message : String(problem));
    if (launched) await evidence.screenshot('failure').catch(() => undefined);
    evidence.flush({ passed: false });
    throw problem;
  } finally {
    await launched?.close();
  }
});

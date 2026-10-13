import { test, expect } from '../fixtures/extension';
import { openChat } from '../helpers/chat-catalog';
import { abortedStreams, catalog, installProvider, streamCount } from '../helpers/mock-llm';

test('runtime settings default to unlimited tasks and persist validated budgets', async ({
  context,
  extensionId,
}) => {
  const worker = context.serviceWorkers()[0]!;
  await worker.evaluate(() =>
    chrome.storage.local.set({ settings: { theme: 'light', locale: 'zh_CN' } }),
  );
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/index.html`);
  await expect(page.getByRole('heading', { name: 'Agent 长任务运行' })).toBeVisible();
  await expect(page.locator('#runtime-taskTimeLimitMinutes')).toHaveValue('0');
  await expect(page.locator('#runtime-taskTokenLimit')).toHaveValue('0');
  await expect(page.locator('#runtime-streamIdleTimeoutSeconds')).toHaveValue('300');
  await expect(page.locator('#runtime-toolTimeoutSeconds')).toHaveValue('60');
  await page.locator('#runtime-taskTimeLimitMinutes').fill('90');
  await page.locator('#runtime-taskTokenLimit').fill('50000');
  await page.locator('#runtime-streamIdleTimeoutSeconds').fill('600');
  await page.getByRole('button', { name: '保存运行设置' }).click();
  await expect
    .poll(() =>
      worker.evaluate(
        async () => (await chrome.storage.local.get('agent-runtime'))['agent-runtime'],
      ),
    )
    .toEqual({
      taskTimeLimitMinutes: 90,
      taskTokenLimit: 50000,
      streamIdleTimeoutSeconds: 600,
      toolTimeoutSeconds: 60,
      longToolTimeoutSeconds: 600,
    });
  await page.reload();
  await expect(page.locator('#runtime-taskTimeLimitMinutes')).toHaveValue('90');
  await expect(page.locator('#runtime-taskTokenLimit')).toHaveValue('50000');
});

test('a model idle timeout cancels the real worker request and keeps partial progress after reload', async ({
  context,
  extensionId,
}) => {
  const worker = context.serviceWorkers()[0]!;
  await installProvider(worker);
  await worker.evaluate(() =>
    chrome.storage.local.set({
      'agent-runtime': {
        taskTimeLimitMinutes: 0,
        taskTokenLimit: 0,
        streamIdleTimeoutSeconds: 1,
        toolTimeoutSeconds: 60,
        longToolTimeoutSeconds: 600,
      },
    }),
  );
  const page = await openChat(context, extensionId, 'side-panel', { cached: catalog });
  await page.locator('textarea').fill('检查空闲超时');
  await page.locator('textarea').press('Enter');
  await expect.poll(() => streamCount(worker)).toBe(1);
  await expect(page.getByTestId('message-reasoning')).toContainText('初始推理。');
  await expect(page.getByText(/Model request idle for 1s/)).toBeVisible();
  expect(await abortedStreams(worker)).toEqual([true]);
  await page.reload();
  await expect(page.locator('textarea')).toBeVisible();
  await page.getByTitle('Toggle sidebar').click();
  await page.getByRole('button', { name: '检查空闲超时', exact: true }).click();
  await expect(page.getByTestId('message-reasoning')).toContainText('初始推理。');
  expect(await streamCount(worker)).toBe(1);
});

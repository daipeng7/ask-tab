import { runAgent } from '../../chrome-extension/src/background/agents/agent-setup';
import { streamWithIdleTimeout } from '../../chrome-extension/src/background/agents/model-stream-timeout';
import { TaskBudget } from '../../chrome-extension/src/background/agents/task-budget';
import { runBrowserTabAction } from '../../chrome-extension/src/background/tools/browser-lifecycle';
import {
  bindToolExecutionOwner,
  releaseToolResources,
  registerToolCleanup,
} from '../../chrome-extension/src/background/tools/tool-lifecycle';
import {
  assertRuntimeConfig,
  defaultRuntimeConfig,
  runtimeConfigStorage,
} from '@extension/storage';
import { createAssistantMessageEventStream, streamSimple } from '@mariozechner/pi-ai';
import { Type } from '@sinclair/typebox';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '@extension/storage';
import type { AgentTool, AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, Model } from '@mariozechner/pi-ai';

vi.mock('../../chrome-extension/src/background/logging/logger-buffer', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  }),
}));
vi.mock('../../chrome-extension/src/background/ask-service/client', () => ({
  requireSession: async () => ({ token: 'jwt', userId: 'u', expiresAt: Number.MAX_SAFE_INTEGER }),
  watchSession: () => () => {},
  confirmSessionAfterModelError: vi.fn(async () => {}),
}));
vi.mock('../../chrome-extension/src/background/tools', () => ({
  getAgentTools: async () => [],
  getToolConfig: async () => ({ enabledTools: {} }),
  getImplementedToolNames: () => new Set(),
}));
vi.mock('../../chrome-extension/src/background/tools/agent-tab-group', () => ({
  beginAgentTabGroup: async () => {},
  endAgentTabGroup: () => {},
}));
vi.mock('@extension/storage', async original => {
  const actual = await original<typeof import('@extension/storage')>();
  return {
    ...actual,
    runtimeConfigStorage: { get: vi.fn(async () => actual.defaultRuntimeConfig) },
  };
});
vi.mock('@mariozechner/pi-ai', async original => ({
  ...(await original<typeof import('@mariozechner/pi-ai')>()),
  streamSimple: vi.fn(),
}));

const model: Model<'openai-completions'> = {
  id: 'test',
  name: 'Test',
  api: 'openai-completions',
  provider: 'openai',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
};
const message = (
  content: AssistantMessage['content'] = [{ type: 'text', text: 'done' }],
): AssistantMessage => ({
  role: 'assistant',
  content,
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: model.cost as never,
  },
  stopReason: content.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop',
  timestamp: Date.now(),
});
const completedStream = (value: AssistantMessage) => {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'start', partial: value });
  stream.push({ type: 'done', reason: value.stopReason as 'stop' | 'toolUse', message: value });
  return stream;
};
const run = (tools: AgentTool[] = [], onCheckpoint?: (messages: AgentMessage[]) => Promise<void>) =>
  runAgent({
    model: { id: 'test', name: 'Test', provider: 'custom', toolTimeoutSeconds: 600 },
    systemPrompt: 'Test',
    prompt: 'Work',
    tools,
    onCheckpoint,
  });
const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
const setRuntime = (config: Partial<RuntimeConfig>) =>
  vi.mocked(runtimeConfigStorage.get).mockResolvedValue({ ...defaultRuntimeConfig, ...config });

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(streamSimple).mockReset();
  setRuntime({});
});
afterEach(() => {
  vi.useRealTimers();
});

describe('long-task execution', () => {
  it('keeps an actively streaming run alive for 20 minutes, including legacy model timeout values', async () => {
    const source = createAssistantMessageEventStream();
    const value = message();
    vi.mocked(streamSimple).mockReturnValue(source);
    let settled = false;
    const pending = run().then(result => {
      settled = true;
      return result;
    });
    await flush();
    source.push({ type: 'start', partial: value });
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(240_000);
      source.push({ type: 'text_delta', contentIndex: 0, delta: '.', partial: value });
      await flush();
      expect(settled).toBe(false);
    }
    source.push({ type: 'done', reason: 'stop', message: value });
    const result = await pending;
    expect(result.error).toBeUndefined();
    expect(result.timedOut).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a request with no first event and ignores late events', async () => {
    const source = createAssistantMessageEventStream();
    let requestSignal!: AbortSignal;
    const output = streamWithIdleTimeout(model, undefined, 300, signal => {
      requestSignal = signal;
      return source;
    });
    await flush();
    await vi.advanceTimersByTimeAsync(300_000);
    const result = await output.result();
    expect(requestSignal.aborted).toBe(true);
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain('idle for 300s');
    source.push({ type: 'done', reason: 'stop', message: message() });
    expect(await output.result()).toBe(result);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resets the model idle deadline on reasoning and tool argument events', async () => {
    const source = createAssistantMessageEventStream();
    const value = message();
    const output = streamWithIdleTimeout(model, undefined, 300, () => source);
    let done = false;
    void output.result().then(() => {
      done = true;
    });
    await flush();
    await vi.advanceTimersByTimeAsync(299_000);
    source.push({ type: 'thinking_delta', contentIndex: 0, delta: 'reasoning', partial: value });
    await flush();
    await vi.advanceTimersByTimeAsync(299_000);
    expect(done).toBe(false);
    source.push({ type: 'toolcall_delta', contentIndex: 0, delta: '{}', partial: value });
    await flush();
    await vi.advanceTimersByTimeAsync(299_000);
    expect(done).toBe(false);
    source.push({ type: 'done', reason: 'stop', message: value });
    expect((await output.result()).stopReason).toBe('stop');
  });

  it('stops the underlying request immediately on user cancellation', async () => {
    const parent = new AbortController();
    let signal!: AbortSignal;
    const output = streamWithIdleTimeout(model, parent.signal, 300, child => {
      signal = child;
      return createAssistantMessageEventStream();
    });
    await flush();
    parent.abort();
    await flush();
    expect(signal.aborted).toBe(true);
    expect((await output.result()).stopReason).toBe('aborted');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('persists a timed-out tool and skipped siblings, then pauses without replaying a write', async () => {
    let toolSignal!: AbortSignal;
    const write = vi.fn(async (_id, _args, signal) => {
      toolSignal = signal;
      return new Promise<never>(() => {});
    });
    const next = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'sent' }],
      details: {},
    }));
    const tools = [
      {
        name: 'write',
        label: 'Write',
        description: 'Write',
        parameters: Type.Object({}),
        execute: write,
      },
      {
        name: 'send',
        label: 'Send',
        description: 'Send',
        parameters: Type.Object({}),
        execute: next,
      },
    ];
    vi.mocked(streamSimple).mockReturnValue(
      completedStream(
        message([
          { type: 'toolCall', id: 'w1', name: 'write', arguments: {} },
          { type: 'toolCall', id: 's1', name: 'send', arguments: {} },
        ]),
      ),
    );
    const checkpoints: AgentMessage[][] = [];
    const pending = run(tools, async messages => {
      checkpoints.push(messages);
    });
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;
    expect(toolSignal.aborted).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    expect(streamSimple).toHaveBeenCalledTimes(1);
    expect(result.error).toContain('outcome may be unknown');
    const saved = checkpoints.at(-1)!.filter(m => m.role === 'toolResult');
    expect(saved.map(m => m.toolCallId)).toEqual(['w1', 's1']);
    expect(saved[0].isError).toBe(true);
  });

  it('finishes a browser snapshot and uses its refs in a different call with the same run owner', async () => {
    const parent = new AbortController();
    const a = new AbortController();
    const b = new AbortController();
    bindToolExecutionOwner(a.signal, parent.signal);
    bindToolExecutionOwner(b.signal, parent.signal);
    const clear = vi.fn(async () => {});
    await runBrowserTabAction(
      { tabId: 781, action: 'snapshot' },
      a.signal,
      async () => 'snapshot',
      clear,
    );
    expect(
      await runBrowserTabAction(
        { tabId: 781, action: 'click', ref: 1 },
        b.signal,
        async () => 'clicked',
        clear,
      ),
    ).toBe('clicked');
    await releaseToolResources(parent.signal);
    expect(clear).toHaveBeenCalledWith(781);
  });

  it('does not hang task completion on uncooperative cleanup; deferred cleanup can still finish', async () => {
    const parent = new AbortController();
    let resolve!: () => void;
    let completed = false;
    registerToolCleanup(
      parent.signal,
      'late',
      () =>
        new Promise<void>(r => {
          resolve = () => {
            completed = true;
            r();
          };
        }),
    );
    const pending = releaseToolResources(parent.signal);
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(completed).toBe(false);
    resolve();
    await flush();
    expect(completed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('checks task time at execution boundaries, not during an actively progressing response', async () => {
    setRuntime({ taskTimeLimitMinutes: 1 });
    const source = createAssistantMessageEventStream();
    const value = message([{ type: 'toolCall', id: 'w1', name: 'write', arguments: {} }]);
    vi.mocked(streamSimple).mockReturnValue(source);
    const write = vi.fn(async () => ({ content: [], details: {} }));
    const pending = run([
      {
        name: 'write',
        label: 'Write',
        description: 'Write',
        parameters: Type.Object({}),
        execute: write,
      },
    ]);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    source.push({ type: 'done', reason: 'toolUse', message: value });
    const result = await pending;
    expect(result.budgetReason).toBe('time_budget');
    expect(write).not.toHaveBeenCalled();
  });

  it('stops before side effects when reported token usage reaches the soft budget', async () => {
    setRuntime({ taskTokenLimit: 10 });
    vi.mocked(streamSimple).mockReturnValue(
      completedStream(message([{ type: 'toolCall', id: 'w1', name: 'write', arguments: {} }])),
    );
    const write = vi.fn(async () => ({ content: [], details: {} }));
    const pending = run([
      {
        name: 'write',
        label: 'Write',
        description: 'Write',
        parameters: Type.Object({}),
        execute: write,
      },
    ]);
    const result = await pending;
    expect(result.budgetReason).toBe('token_budget');
    expect(write).not.toHaveBeenCalled();
  });

  it('does not reset a budget between attempts', () => {
    const budget = new TaskBudget({ ...defaultRuntimeConfig, taskTokenLimit: 20 });
    budget.record(message().usage);
    budget.check();
    budget.record(message().usage);
    expect(() => budget.check()).toThrow('token budget reached');
  });

  it('rejects invalid persisted/backup settings at the storage boundary', () => {
    expect(() => assertRuntimeConfig(defaultRuntimeConfig)).not.toThrow();
    expect(() => assertRuntimeConfig({ ...defaultRuntimeConfig, toolTimeoutSeconds: 0 })).toThrow();
    expect(() =>
      assertRuntimeConfig({ ...defaultRuntimeConfig, taskTimeLimitMinutes: -1 }),
    ).toThrow();
    expect(() =>
      assertRuntimeConfig({ ...defaultRuntimeConfig, streamIdleTimeoutSeconds: Infinity }),
    ).toThrow();
  });
});

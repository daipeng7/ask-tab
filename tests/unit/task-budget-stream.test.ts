import { runAgent } from '../../chrome-extension/src/background/agents/agent-setup';
import {
  handleLLMStream,
  setStreamQueueHooks,
} from '../../chrome-extension/src/background/agents/stream-handler';
import { finishModelTurn } from '@extension/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMRequestMessage } from '@extension/shared';

vi.mock('../../chrome-extension/src/background/agents/agent-setup', () => ({
  runAgent: vi.fn(),
  buildHeadlessSystemPrompt: async () => 'Test',
}));
vi.mock('../../chrome-extension/src/background/logging/logger-buffer', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  }),
}));
vi.mock('../../chrome-extension/src/background/ask-service/endpoint', () => ({
  getServiceUrl: () => 'https://ask.test',
  serviceUrlReady: async () => {},
}));
vi.mock('../../chrome-extension/src/background/context/transform', () => ({
  createTransformContext: () => ({
    transformContext: async (messages: unknown[]) => messages,
    getResult: () => ({ wasCompacted: false }),
  }),
}));
vi.mock('../../chrome-extension/src/background/memory/memory-flush', () => ({
  runMemoryFlushIfNeeded: async () => {},
}));
vi.mock('@extension/storage', async original => ({
  ...(await original<typeof import('@extension/storage')>()),
  finishModelTurn: vi.fn(async () => {}),
  getModelTranscript: async () => undefined,
  touchChat: async () => {},
  updateSessionTokens: async () => {},
}));

afterEach(() => {
  setStreamQueueHooks(undefined);
  vi.clearAllMocks();
});

describe('task budget delivery', () => {
  it.each(['time_budget', 'token_budget'] as const)(
    'persists %s progress and pauses the queued turn',
    async reason => {
      const agent = { state: { error: 'budget reached', messages: [] } };
      vi.mocked(runAgent).mockImplementationOnce(async opts => {
        opts.onTextDelta?.('Partial progress');
        opts.onToolCallEnd?.({ id: 'uncertain', name: 'write', args: {} });
        opts.onAgentEnd?.({
          agent: agent as never,
          messages: [],
          stepCount: 1,
          timedOut: reason === 'time_budget',
          budgetReason: reason,
        });
        return {
          responseText: 'Partial progress',
          parts: [],
          usage: { inputTokens: 10, outputTokens: 5 },
          agent: agent as never,
          stepCount: 1,
          timedOut: reason === 'time_budget',
          budgetReason: reason,
          error: 'budget reached',
          retryAttempts: 0,
        };
      });
      const settled = vi.fn();
      setStreamQueueHooks({ takeSteering: () => [], onSettled: settled });
      const port = {
        postMessage: vi.fn(),
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
      };
      const request: LLMRequestMessage = {
        type: 'LLM_REQUEST',
        chatId: `budget-${reason}`,
        model: { id: 'test', name: 'Test', provider: 'custom' },
        messages: [
          {
            id: 'u',
            chatId: `budget-${reason}`,
            role: 'user',
            parts: [{ type: 'text', text: 'work' }],
            createdAt: 1,
          },
        ],
        assistantMessageId: 'a',
      };
      await handleLLMStream(port as never, request);
      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'LLM_STREAM_END', finishReason: reason }),
      );
      expect(port.postMessage.mock.calls.some(([value]) => value.type === 'LLM_STREAM_ERROR')).toBe(
        false,
      );
      const persisted = vi.mocked(finishModelTurn).mock.calls[0][0];
      expect(persisted.parts).toEqual(
        expect.arrayContaining([
          { type: 'text', text: 'Partial progress' },
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('budget reached'),
          }),
          expect.objectContaining({ type: 'tool-call', state: 'output-error' }),
        ]),
      );
      expect(settled).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'stopped' }));
      expect(vi.mocked(finishModelTurn).mock.calls[0][2]).toEqual([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('previous turn was interrupted'),
        }),
      ]);
    },
  );
});

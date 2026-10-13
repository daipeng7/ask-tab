import { withAbort } from './cancellation';
import { createExecutionTimeout } from './execution-timeout';
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai';
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
} from '@mariozechner/pi-ai';

/** Idle means no provider events, including while awaiting the first event. */
const streamWithIdleTimeout = (
  model: Model<Api>,
  parent: AbortSignal | undefined,
  seconds: number,
  start: (
    signal: AbortSignal,
  ) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
): AssistantMessageEventStream => {
  const output = createAssistantMessageEventStream();
  const timeout = createExecutionTimeout(
    parent,
    seconds,
    `Model request idle for ${seconds}s with no response events. Progress saved; check the connection or increase the model idle timeout before continuing.`,
  );
  void (async () => {
    let partial: AssistantMessage | undefined;
    try {
      const source = await withAbort(timeout.signal, () => start(timeout.signal));
      const iterator = source[Symbol.asyncIterator]();
      while (true) {
        const next = await withAbort(timeout.signal, () => iterator.next());
        if (next.done) break;
        timeout.reset();
        const event = next.value;
        if ('partial' in event) partial = event.partial;
        output.push(event);
        if (event.type === 'done' || event.type === 'error') return;
      }
      output.end(await withAbort(timeout.signal, () => source.result()));
    } catch (error) {
      const message: AssistantMessage = {
        role: 'assistant',
        content: partial?.content ?? [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: partial?.usage ?? {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: parent?.aborted ? 'aborted' : 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      };
      output.push({
        type: 'error',
        reason: message.stopReason as 'aborted' | 'error',
        error: message,
      });
    } finally {
      timeout.dispose();
    }
  })();
  return output;
};

export { streamWithIdleTimeout };

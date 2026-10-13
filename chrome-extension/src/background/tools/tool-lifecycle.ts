import { createLogger } from '../logging/logger-buffer';

const resources = new WeakMap<AbortSignal, Map<unknown, () => Promise<void>>>();
const log = createLogger('tool');
const executionOwners = new WeakMap<AbortSignal, AbortSignal>();

/** A call may be cancelled independently while its browser resources belong to the run. */
export const bindToolExecutionOwner = (call: AbortSignal, run: AbortSignal): void => {
  executionOwners.set(call, getToolExecutionOwner(run));
};

export const getToolExecutionOwner = (signal: AbortSignal): AbortSignal =>
  executionOwners.get(signal) ?? signal;

/** The execution signal identifies one agent run, including tools supplied by a caller. */
export const registerToolCleanup = (
  signal: AbortSignal,
  key: unknown,
  cleanup: () => Promise<void>,
): void => {
  signal = getToolExecutionOwner(signal);
  let callbacks = resources.get(signal);
  if (!callbacks) resources.set(signal, (callbacks = new Map()));
  callbacks.set(key, cleanup);
};

export const releaseToolResources = async (signal: AbortSignal): Promise<void> => {
  const callbacks = resources.get(signal);
  resources.delete(signal);
  const cleanup = Promise.all(
    [...(callbacks?.values() ?? [])].map(async action => {
      try {
        await action();
      } catch (error) {
        log.warn('Tool cleanup failed', { error: String(error) });
      }
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cleanup,
      new Promise<void>(resolve => {
        timer = setTimeout(() => {
          log.warn('Tool cleanup still pending; it will finish in the background');
          resolve();
        }, 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

import { withAbort } from './cancellation';

/** Cancels the underlying operation and also stops waiting for uncooperative integrations. */
const createExecutionTimeout = (
  parent: AbortSignal | undefined,
  seconds: number,
  message: string,
) => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(message)), seconds * 1000);
  };
  reset();
  return {
    signal: controller.signal,
    reset,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
};

const withExecutionTimeout = async <T>(
  parent: AbortSignal | undefined,
  seconds: number,
  message: string,
  execute: (signal: AbortSignal) => PromiseLike<T> | T,
): Promise<T> => {
  const timeout = createExecutionTimeout(parent, seconds, message);
  try {
    return await withAbort(timeout.signal, () => execute(timeout.signal));
  } finally {
    timeout.dispose();
  }
};

export { createExecutionTimeout, withExecutionTimeout };

import { withExecutionTimeout } from './execution-timeout';
import { bindToolExecutionOwner } from '../tools/tool-lifecycle';
import type { RuntimeConfig } from '@extension/storage';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';

class ToolTimeoutError extends Error {
  constructor(name: string, seconds: number) {
    super(
      `Tool "${name}" timed out after ${seconds}s. Its outcome may be unknown. Inspect its effects before retrying; do not repeat a write, submission or send without verification.`,
    );
    this.name = 'ToolTimeoutError';
  }
}

/** Background research/spawn calls return immediately; long JS/custom calls need a separate limit. */
const longTools = new Set(['execute_javascript', 'deep_research']);

const executeAgentTool = async (
  tool: AgentTool,
  id: string,
  args: unknown,
  signal: AbortSignal | undefined,
  runtime: RuntimeConfig,
  onUpdate: (result: AgentToolResult<unknown>) => void,
): Promise<AgentToolResult<unknown>> => {
  const seconds = longTools.has(tool.name)
    ? runtime.longToolTimeoutSeconds
    : runtime.toolTimeoutSeconds;
  let callSignal: AbortSignal | undefined;
  try {
    return await withExecutionTimeout(signal, seconds, '', async child => {
      callSignal = child;
      if (signal) bindToolExecutionOwner(child, signal);
      return tool.execute(id, args, child, update => {
        if (!child.aborted) onUpdate(update);
      });
    });
  } catch (error) {
    signal?.throwIfAborted();
    if (callSignal?.aborted) throw new ToolTimeoutError(tool.name, seconds);
    throw error;
  }
};

export { executeAgentTool, ToolTimeoutError };

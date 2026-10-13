# Long task execution

General settings → Agent runtime controls task budgets and individual call timeouts.

| Setting | Default | Meaning |
| --- | --- | --- |
| Task time budget | 0 (unlimited) | Checked before the next model call or tool execution. A running call finishes or reaches its own timeout first. |
| Task token budget | 0 (unlimited) | Soft budget for provider-reported `totalTokens` in the main Agent loop, including cache tokens and context-overflow retries. |
| Model event idle timeout | 300 seconds | Maximum wait for the first provider event or between events. Text, reasoning and tool argument events reset it. |
| Ordinary tool timeout | 60 seconds | Deadline for one tool call. |
| Research / JavaScript timeout | 600 seconds | Deadline for `deep_research` and `execute_javascript` calls. Background research returns immediately and its subagent has its own runtime budget. |

There is no default ten-minute limit on the overall Agent loop. The legacy model
catalog field `toolTimeoutSeconds` no longer controls a task's lifetime. Runtime
budgets are captured when a task starts; model idle settings are read before each
model request. Individual tools may also have a shorter built-in timeout.

The model timeout observes pi-ai provider events, not raw SSE heartbeats. Slow
reasoning models that do not emit events may require a higher limit. Auxiliary
non-streaming requests, such as summarization, use the same configured duration
as a request deadline and propagate cancellation to the provider.

Token accounting is a soft boundary after usage is returned. It can exceed the
configured budget by a response. Auxiliary summarization and independently
spawned background agents are not charged to the parent loop's budget; this
setting is not a provider billing cap.

## Failure and continuation

- A model idle timeout cancels the request and stops the turn with a diagnostic.
- A tool timeout cancels that call, saves its uncertain outcome and skips the
  remaining calls in the batch. The turn pauses rather than replaying a possible
  write, submission or send. Inspect its effects before retrying.
- A time or token budget pauses at an execution boundary. The reason and partial
  response are persisted, and queued messages remain paused.
- User Stop remains immediate, including cancellation of background agents
  spawned by the run.
- Browser snapshot refs and debugger sessions belong to the run, even though
  each tool call has an independent cancellation signal.
- Resource cleanup waits at most five seconds for completion. Pending cleanup
  continues in the background, allowing late debugger operations to settle
  before detach. An integration that ignores cancellation can still complete
  late; the timeout does not guarantee rollback.

Completed tool results are checkpointed to IndexedDB. After interruption, send a
new message (for example, "continue the previous task, verify unfinished effects
before repeating them"). Existing recovery converts an unfinished transcript
into history and does not automatically execute its pending tool calls.

Closing Chrome or reloading the extension stops active execution. Checkpoints
support continuation after reopening; they do not keep the task running outside
the browser. Model relays can enforce their own server timeouts independently.

The local MCP bridge's external call deadlines are separate from Agent runtime
settings. This change does not alter its protocol or authentication.

## Verification

`tests/unit/long-task-runtime.test.ts` covers a simulated twenty-minute active
run, idle cancellation, independent tool deadlines, checkpointed unknown outcomes,
budget boundaries, cross-call browser ownership and deferred cleanup. It uses
fake time and provider transport mocks, not a live model service.

The design separates stream idle timeouts from tool deadlines, following the
public [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
It does not claim to reproduce undocumented Codex runtime internals.

import type { RuntimeConfig } from '@extension/storage';
import type { Usage } from '@mariozechner/pi-ai';

type BudgetReason = 'time_budget' | 'token_budget';

/** One budget per user run, shared across context-overflow retries. */
class TaskBudget {
  private startedAt = Date.now();
  private tokens = 0;
  reason?: BudgetReason;

  constructor(private config: RuntimeConfig) {}

  record(usage: Usage): void {
    this.tokens += usage.totalTokens;
  }

  check(): void {
    if (
      this.config.taskTimeLimitMinutes > 0 &&
      Date.now() - this.startedAt >= this.config.taskTimeLimitMinutes * 60_000
    ) {
      this.reason = 'time_budget';
    } else if (this.config.taskTokenLimit > 0 && this.tokens >= this.config.taskTokenLimit) {
      this.reason = 'token_budget';
    }
    if (this.reason)
      throw new Error(
        `Agent ${this.reason === 'time_budget' ? 'time' : 'token'} budget reached. Progress saved; send a message to continue.`,
      );
  }
}

export { TaskBudget };
export type { BudgetReason };

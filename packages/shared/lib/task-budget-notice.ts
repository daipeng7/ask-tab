const taskBudgetNotice = (reason: string): string | undefined => {
  if (reason !== 'time_budget' && reason !== 'token_budget') return undefined;
  return `\n\n⚠️ Agent ${reason === 'time_budget' ? 'time' : 'token'} budget reached. Progress saved. Send a message to continue; verify unfinished tool effects before retrying.`;
};

export { taskBudgetNotice };

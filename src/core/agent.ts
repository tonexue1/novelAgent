/**
 * 所有 stage 的 Agent 都实现的最小接口。
 *
 * 这是 core 与各 stage 之间的契约：core 的 REPL 只依赖这个接口，
 * 不关心具体是 Function Call、ReAct 还是后续的 Plan-Execute 等实现。
 * 每个 stage 的差异都收敛在各自 agent.ts 的循环策略里。
 */
export interface Agent {
  /** 在保留会话历史的前提下处理一次用户输入，返回最终答案文本。 */
  send(question: string): Promise<string>;
  /** 清空会话历史，开启新话题。 */
  reset(): void;
}

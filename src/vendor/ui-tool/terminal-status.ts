/**
 * 【vendor】@deepseek-ai/dsh-client-ui-tool，dsh-v0.2.2-rc.1，commit 66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db。
 * 摘录 src/client/tool/models/terminal-card-model.ts 的 parseExitStatus / terminalFailed。
 * 不要手改：函数体逐字相同。允许适配：导出 parseExitStatus；TerminalCardModel
 * 改用下列本地结构类型（只保留函数实际读取的 card 字段），不依赖官方装配层。
 */
interface TerminalCardModel {
  card: { exitCode?: number | null; signal?: string; running?: boolean }
}

export function terminalFailed(model: TerminalCardModel): boolean {
  const { exitCode, signal, running } = model.card
  return running !== true && ((exitCode !== undefined && exitCode !== 0) || signal !== undefined)
}

export function parseExitStatus(text: string): { output: string; exitCode?: number | null; signal?: string } {
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text)
  if (signal?.[1] !== undefined) return { output: text.slice(0, signal.index), signal: signal[1] }
  const exit = /\n\[exit code: (-?\d+|null)\]$/.exec(text)
  if (exit?.[1] !== undefined) return { output: text.slice(0, exit.index), exitCode: exit[1] === 'null' ? null : Number(exit[1]) }
  return { output: text, exitCode: 0 }
}

/**
 * 让无头探针/冒烟跑在**完全隔离的一次性环境**里（supervisor 会合目录 + DSH_HOME）。
 *
 * 两层隔离，各有明确的污染面：
 *
 * 1. `DSH_CHAT_SUPERVISOR_DIR` —— supervisor 会合目录。若与用户正在跑的
 *    `~/.dsh/dsh-chat-vscode/supervisors` 共用，两边会互相接入、互相清理——结论不可信，
 *    还可能把用户的后台带走。
 *
 * 2. `DSH_HOME` —— dsh 的持久化根（`dshHomePath` 的全部派生：`sessions/`、`profiles/`、
 *    `storages/`、`.credentials.yaml` …，见 deepseek-harness `bundle/base/cordis.patch.yml`
 *    的 `root: !!js dshHomePath('sessions')`）。不隔离的话，探针每次 `createSession` + 发
 *    消息都会把**真实测试会话**留在用户的会话列表里（2026-09-20 实测：`~/.dsh/sessions`
 *    的本项目工作区下积了 226 个，其中绝大多数是历次冒烟/探针留下的），还悄悄消耗用户的
 *    模型配额。指向本目录后，会话日志、归档索引、设置改动全部落进临时目录，收尾整体删除，
 *    用户环境零残留。全新 home 里 `dsh web` 会幂等地自建 profile（本地文件操作，不联网），
 *    实测 12 秒内就绪。
 *
 * 凭据：探针要发真实消息驱动真实模型，所以把用户的 `~/.dsh/.credentials.yaml` 复制进
 * 临时 home（同一用户同一台机器的用户私有临时目录，探针结束即删，风险面没有扩大）。
 * 没有这个文件时跳过——探针照常起，只是真实模型调用会失败。
 *
 * 关键：环境变量必须在**任何一次目录计算之前**设好（`supervisorRoot()` 是每次调用现读
 * `process.env`，不是模块初始化时读一次；探针里最早的一次就是构造 `SupervisorManager`；
 * `spawn` 全量继承 `process.env`，所以本进程设好即可传给 dsh 子进程）。
 * ESM 的 import 按出现顺序求值，所以探针文件的第一行必须是 import 本模块——这样它一定
 * 早于任何目录计算。
 * 父进程已指定则**沿用**（子进程会执行同一个模块，无条件另建会让父子各看各的目录）。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** 残留清扫门槛：正常探针单轮不超过几分钟，超时的目录只可能是上次异常退出留下的。 */
const STALE_MS = 6 * 60 * 60 * 1000;
/** 临时目录名前缀：既用于 mkdtemp，也是残留清扫的匹配范围。 */
const PREFIX = "dsh-chat-sup-probe-";

let dir = process.env.DSH_CHAT_SUPERVISOR_DIR?.trim() || "";
if (!dir) {
  // 只有真正新建目录的进程才做残留清扫：沿用的子进程不碰目录，并发下才安全。
  for (const entry of readdirSafe(tmpdir())) {
    if (!entry.startsWith(PREFIX)) continue;
    const candidate = join(tmpdir(), entry);
    try {
      if (Date.now() - statSync(candidate).mtimeMs < STALE_MS) continue;
      rmSync(candidate, { recursive: true, force: true });
    } catch {
      // 被还在跑的进程占着删不掉就算了——它不属于「陈旧残留」
    }
  }
  dir = mkdtempSync(join(tmpdir(), PREFIX));
  process.env.DSH_CHAT_SUPERVISOR_DIR = dir;

  // DSH_HOME 必须在第一个 dsh 子进程 spawn 之前设好；只有新建目录的进程才设，
  // 沿用的进程由父进程负责（与上面的沿用规则一致）。
  const home = join(dir, "home");
  process.env.DSH_HOME = home;
  mkdirSync(home, { recursive: true });
  const credentials = join(homedir(), ".dsh", ".credentials.yaml");
  if (existsSync(credentials)) cpSync(credentials, join(home, ".credentials.yaml"));

  // 退出兜底：把整个临时目录删掉。正常路径各探针的 finally 只负责 server.stop()；
  // dsh 子进程若仍占着文件，删除会失败——留给下一次探针启动时的残留清扫兜底。
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 删不掉就留给下次清扫
    }
  });
}
process.env.DSH_CHAT_SUPERVISOR_DIR = dir;

/** 本次探针专用的会合根目录（收尾时整个删掉，`home/` 子目录随之一起）。 */
export const PROBE_SUPERVISOR_ROOT = dir;

function readdirSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/**
 * 让 supervisor 的无头探针跑在**自己的会合目录**里（与 `sharedServerProbeEnv` 同一手法）。
 *
 * 为什么必须隔离：探针会起真实 `dsh web` 与真实 supervisor。若与用户正在跑的
 * `~/.dsh-chat/supervisors` 共用，两边会互相接入、互相清理——结论不可信，还可能把
 * 用户的后台带走。
 *
 * 关键：**环境变量必须在 `supervisorProtocol` 求值之前设好**（它在模块初始化时读一次）。
 * ESM 的 import 按出现顺序求值，所以探针文件的第一行必须是 import 本模块。
 * 父进程已指定则**沿用**（子进程会执行同一个模块，无条件另建会让父子各看各的目录）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = process.env.DSH_CHAT_SUPERVISOR_DIR?.trim() || mkdtempSync(join(tmpdir(), "dsh-chat-sup-probe-"));
process.env.DSH_CHAT_SUPERVISOR_DIR = dir;

/** 本次探针专用的会合根目录（收尾时整个删掉）。 */
export const PROBE_SUPERVISOR_ROOT = dir;

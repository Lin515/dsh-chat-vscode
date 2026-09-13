/**
 * 让 `sharedServerProbe.ts` 跑在**自己的租约目录**里（与 `sharedLeaseEnv.ts` 同一手法）。
 *
 * 为什么必须隔离：探针会起真实的 `dsh web` 并伪造多个"窗口"。若与用户正在跑的
 * VS Code 共用 `~/.dsh-chat/servers`，两边会互相接入、互相清理——测出来的结论
 * 不可信，还可能把用户的后台杀掉。
 *
 * 关键：**环境变量必须在 `processRegistry` 求值之前设好**（它在模块初始化时读一次）。
 * ESM 的 import 按出现顺序求值，所以探针文件的第一行必须是 import 本模块。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 父进程已经指定过就**沿用**，不要另建一个。
 *
 * 这一步是必须的：子进程（"窗口 B"）会执行同一个模块，如果无条件 mkdtemp，
 * 它就会把父进程经环境变量传进来的目录**覆盖**成自己的新目录——父子俩于是
 * 各看各的租约，探针永远看不到"复用"（实测踩过：B 看到空列表）。
 */
const dir = process.env.DSH_CHAT_LEASE_DIR?.trim() || mkdtempSync(join(tmpdir(), "dsh-chat-probe-"));
process.env.DSH_CHAT_LEASE_DIR = dir;

/** 本次探针专用的租约目录（收尾时整个删掉）。 */
export const PROBE_LEASE_DIR = dir;

/**
 * 让 `sharedLease.test.ts` 跑在**自己的租约目录**里。
 *
 * 为什么必须隔离：`npm test` 是并发跑的（默认 8 个），而租约目录是全局的
 * `~/.dsh-chat/servers`。共享它会有两类假结果：
 * - 别的测试（`tokenAndCleanup`）写下的租约被我们看见/删掉；
 * - **启动锁**是同一把文件锁，两个测试同时抢，谁先谁后决定成败——实测就是这么挂的
 *   （`2` 号断言拿到别人的锁，`3` 号断言于是删不掉）。
 *
 * 做法：在本模块里设 `DSH_CHAT_LEASE_DIR`，并且**让测试文件第一行 import 它**——
 * `processRegistry` 在模块求值时读这个环境变量，ESM 的 import 按出现顺序求值，
 * 所以只要它排在最前面就一定先生效。路径是 `mkdtempSync` 出来的空目录，
 * 于是本文件的所有判定都不受同时跑着的其它测试影响。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "dsh-chat-lease-test-"));
process.env.DSH_CHAT_LEASE_DIR = dir;

/** 本次测试专用的租约目录（收尾时整个删掉）。 */
export const TEST_LEASE_DIR = dir;

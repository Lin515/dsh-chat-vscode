// 夹具 CLI 的**受控观察器 / 故障注入器 / 用户日志读取闸门**（受控子进程用 `--require` 预加载）。
//
// 它属于**测试基础设施**，不是被测逻辑，也不进 esbuild 的 entries。
//
// 只记**布尔与计数证据**：不写路径、不写秘密原文、不写载荷内容。
//
// ## 观察（默认）
//
//   DSH_FIXTURE_WRITE_MARKER   被观察的秘密标记（写入内容包含它即判为敏感写）
//   DSH_FIXTURE_WRITE_TRACE    证据落点（每次状态变化重写一次）
//   DSH_FIXTURE_READ_GUARD     可选：只统计对这个路径的 readFileSync（`guardedRead` / `guardedReadCount`）
//   DSH_FIXTURE_USER_LOG_ROOT  用户日志根（默认 `<home>/.dsh`）：读其下任何路径即**拒绝**
//
// ## 注入（显式设置才生效；每条注入都记「命中」标志，先证注入生效再判结果）
//
//   DSH_FIXTURE_READ_SWAP        被交换内容的源路径（配合下面两条）
//   DSH_FIXTURE_READ_SWAP_FILE   第 `SWAP_AFTER` 次之后读该路径时改返回这份文件的字节
//   DSH_FIXTURE_READ_SWAP_AFTER  从第几次之后开始交换（默认 1）→ `swapApplied`
//   DSH_FIXTURE_FAIL_MKDIR=1     mkdirSync 直接抛错 → `mkdirFailureHit`
//   DSH_FIXTURE_FAIL_WRITE=1     非 trace 文件的 writeFileSync **先真写再抛错** → `writeFailureHit`
//                                （刻意让临时文件真的存在，才能验证失败出口的清理路径）
//   DSH_FIXTURE_FAIL_RENAME=1    renameSync 抛错 → `renameFailureHit`
//   DSH_FIXTURE_TAMPER_READBACK  读回 `.tmp-<pid>` 载荷时篡改内容（**不改磁盘上那份**）：
//                                `hash`（改 model → 读回 hash 不一致）、
//                                `scan`（往 provenance 里塞 marker → 读回扫描命中）、
//                                `structure`（structure.cells +1 → 内部一致性）、
//                                `seq-mapping`（seqMapping.count +1）、
//                                `payload-flags`（payloadReduced 置真）→ `readBackTamperHit`
//
// Node 的 ESM 具名导入（`import { writeFileSync } from "node:fs"`）只有在
// `syncBuiltinESMExports()` 之后才会看到这里打的补丁；**命中标志由被测 CLI 自己的调用置位**，
// 所以每个注入的 `*Hit=true` 本身就是「补丁在 ESM 路径上生效」的证据。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");

const marker = process.env.DSH_FIXTURE_WRITE_MARKER;
const traceFile = process.env.DSH_FIXTURE_WRITE_TRACE;
const readGuard = process.env.DSH_FIXTURE_READ_GUARD;
if (!marker || !traceFile) throw new Error("controlled fixture trace configuration missing");

/** 用户日志根：读取其下任何路径都视为越界（测试侧一律用替身根，真实 `~/.dsh` 不参与）。 */
const userLogRoot = path.resolve(
  process.env.DSH_FIXTURE_USER_LOG_ROOT || path.join(os.homedir(), ".dsh"),
);

const swapPath = process.env.DSH_FIXTURE_READ_SWAP;
const swapFile = process.env.DSH_FIXTURE_READ_SWAP_FILE;
const swapAfter = Number.parseInt(process.env.DSH_FIXTURE_READ_SWAP_AFTER ?? "1", 10);
const failMkdir = process.env.DSH_FIXTURE_FAIL_MKDIR === "1";
const failWrite = process.env.DSH_FIXTURE_FAIL_WRITE === "1";
const failRename = process.env.DSH_FIXTURE_FAIL_RENAME === "1";
const tamperReadBack = process.env.DSH_FIXTURE_TAMPER_READBACK;

const originalWrite = fs.writeFileSync;
const originalRead = fs.readFileSync;
const originalMkdir = fs.mkdirSync;
const originalRename = fs.renameSync;

const state = {
  loaded: true,
  sensitiveWriteAttempt: false,
  sensitiveWriteCompleted: false,
  guardedRead: false,
  guardedReadCount: 0,
  swapApplied: 0,
  mkdirFailureHit: false,
  writeFailureHit: false,
  renameFailureHit: false,
  readBackTamperHit: false,
  userLogReadAttempt: false,
  userLogReadRefused: false,
};
const record = () => originalWrite(traceFile, JSON.stringify(state), "utf8");
record();

/**
 * 肯定的目录包含判据（`path.relative`）：字符串前缀比较会放过同名前缀的兄弟目录
 * （`<root>` 与 `<root>-sibling`）——那正是本仓库记过的坑。
 *
 * 「在上级」必须**精确**判定：只有 `..` 本身或 `..<分隔符>` 开头才是在外；
 * 名字以两个点开头但**位于根内**的子目录（`<root>/..contained/…`）不是上级目录 ——
 * 只看 `startsWith("..")` 会把它当成外部，于是该拦的读取被静静放过。
 */
function insideUserLogs(file) {
  const target = path.resolve(String(file));
  const relativePath = path.relative(userLogRoot, target);
  const outside = relativePath === ".."
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath);
  return relativePath === "" || !outside;
}

/** 每次读盘只取一次编码参数（`readFileSync(path, "utf8")` 与 `readFileSync(path, {encoding})` 都要跟）。 */
function encodingOf(args) {
  if (typeof args[0] === "string") return args[0];
  if (args[0] !== null && typeof args[0] === "object" && typeof args[0].encoding === "string") {
    return args[0].encoding;
  }
  return undefined;
}

fs.writeFileSync = function (file, data, ...args) {
  const sensitive = String(data).includes(marker);
  if (sensitive) {
    state.sensitiveWriteAttempt = true;
    record();
  }
  const result = originalWrite.call(this, file, data, ...args);
  if (sensitive) {
    state.sensitiveWriteCompleted = true;
    record();
  }
  if (failWrite && String(file) !== traceFile) {
    // 先让写入真的落盘，再抛错：失败出口必须能清掉这份临时文件
    state.writeFailureHit = true;
    record();
    throw new Error("controlled write failure");
  }
  return result;
};

fs.mkdirSync = function (dir, ...args) {
  if (failMkdir) {
    state.mkdirFailureHit = true;
    record();
    throw new Error("controlled mkdir failure");
  }
  return originalMkdir.call(this, dir, ...args);
};

fs.renameSync = function (from, to, ...args) {
  if (failRename) {
    state.renameFailureHit = true;
    record();
    throw new Error("controlled rename failure");
  }
  return originalRename.call(this, from, to, ...args);
};

const swapReads = new Map();

fs.readFileSync = function (file, ...args) {
  const target = String(file);
  /**
   * **用户日志读取闸门**：标准 `npm test` 不得读用户会话日志。
   * 测试侧还有「来源必须落在本次受控根内」的调用前断言，这里是**运行时第二道**：
   * 先记命中，再用固定文案拒绝 ——「读到之后删掉」不等于没读过。
   */
  if (insideUserLogs(target)) {
    state.userLogReadAttempt = true;
    state.userLogReadRefused = true;
    record();
    throw new Error("controlled fixture guard: user session log read refused");
  }
  if (readGuard && target === readGuard) {
    state.guardedRead = true;
    state.guardedReadCount += 1;
    record();
  }
  if (swapPath && swapFile && target === swapPath) {
    const seen = (swapReads.get(target) ?? 0) + 1;
    swapReads.set(target, seen);
    if (seen > swapAfter) {
      state.swapApplied += 1;
      record();
      const swapped = originalRead.call(this, swapFile);
      const encoding = encodingOf(args);
      return encoding === undefined ? swapped : swapped.toString(encoding);
    }
  }
  const result = originalRead.call(this, file, ...args);
  if (tamperReadBack !== undefined && tamperReadBack !== "" && /\.tmp-\d+$/.test(target)) {
    const text = typeof result === "string" ? result : Buffer.from(result).toString("utf8");
    const parsed = JSON.parse(text);
    if (tamperReadBack === "hash") {
      parsed.model = { ...(parsed.model ?? {}), __controlledTamper: true };
    } else if (tamperReadBack === "scan") {
      parsed.provenance.redaction.rules.push(marker);
    } else if (tamperReadBack === "structure") {
      parsed.provenance.structure.cells += 1;
    } else if (tamperReadBack === "seq-mapping") {
      parsed.provenance.seqMapping.count += 1;
    } else if (tamperReadBack === "payload-flags") {
      parsed.provenance.payloadReduced = true;
    }
    state.readBackTamperHit = true;
    record();
    const encoding = encodingOf(args);
    const tampered = JSON.stringify(parsed);
    return encoding === undefined ? Buffer.from(tampered, "utf8") : tampered;
  }
  return result;
};

syncBuiltinESMExports();

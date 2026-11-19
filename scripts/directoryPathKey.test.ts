/**
 * 目录身份键（`directoryPathKey`）：宿主历史范围 / 工作区注册缓存与界面目录胶囊共用同一口径。
 *
 * 钉住四类容易出错的边界：
 *
 * 1. **文件系统根保留**：POSIX `/` 不能折成空串（否则「根目录」会被当成「没有目录」，历史
 *    误归未分组）；盘符根 `C:/` 不能裁成盘符相对值 `C:`，两者不是同一个位置；
 * 2. **POSIX 大小写有意义**：`/work/A` 与 `/work/a` 是两个目录；Windows 形态（盘符 / UNC）
 *    才忽略大小写与分隔符方向；
 * 3. **POSIX 反斜杠是文件名的一部分**：`/a\b` 与 `/a/b` 不能合并；
 * 4. `sessionList.normalizePath` 只是这个函数的别名（历史列表 / 根选择 / 注册缓存不能再各写
 *    一份，否则界面与宿主会各算各的）。
 *
 * 运行：npm test（登记在 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { directoryPathKey, sameWorkspacePath, workspacePathKey } from "../src/shared/workspacePath";
import { normalizePath } from "../src/dsh/sessionList";

console.log("directoryPathKey: 目录身份键（根 / 大小写 / 反斜杠）");

// ---------- 1. POSIX：根、尾斜杠与大小写 ----------
{
  assert.strictEqual(directoryPathKey("/"), "/", "文件系统根不能折成空串");
  assert.strictEqual(directoryPathKey("///"), "/", "多个根的尾斜杠仍是根");
  assert.strictEqual(directoryPathKey("/work/"), "/work", "普通目录去尾斜杠");
  assert.strictEqual(directoryPathKey("/work/A"), "/work/A", "POSIX 保留大小写");
  assert.notStrictEqual(directoryPathKey("/work/A"), directoryPathKey("/work/a"), "POSIX 大小写是两个身份");
  assert.strictEqual(directoryPathKey(""), "", "空串不是目录");
  assert.strictEqual(directoryPathKey(undefined), "", "undefined 折成空串");
  assert.strictEqual(directoryPathKey("relative/dir/"), "relative/dir", "相对拼写只去尾斜杠");
  assert.strictEqual(directoryPathKey("/a\\b"), "/a\\b", "POSIX 反斜杠是文件名的一部分");
  assert.notStrictEqual(directoryPathKey("/a\\b"), directoryPathKey("/a/b"), "不能把 POSIX 反斜杠换成分隔符");
}

// ---------- 2. Windows：盘符根 / 盘符相对值 / 大小写 ----------
{
  assert.strictEqual(directoryPathKey("C:/"), "c:/", "盘符根保留根斜杠");
  assert.strictEqual(directoryPathKey("C:\\"), "c:/", "反斜杠根同样保留");
  assert.notStrictEqual(directoryPathKey("C:/"), directoryPathKey("C:"), "盘符根与盘符相对值不是一个位置");
  assert.strictEqual(directoryPathKey("C:\\Work\\Demo\\"), "c:/work/demo", "分隔符与大小写都归一");
  assert.strictEqual(directoryPathKey("c:/work/demo"), directoryPathKey("C:\\WORK\\DEMO"), "同一目录的两种拼写");
  assert.strictEqual(directoryPathKey("D:"), "D:", "盘符相对值原样（不补根斜杠）");
}

// ---------- 3. UNC：share 根保留、大小写归一 ----------
{
  assert.strictEqual(directoryPathKey("\\\\server\\share"), "//server/share", "UNC share 根");
  assert.strictEqual(directoryPathKey("\\\\Server\\Share\\"), "//server/share", "UNC 尾斜杠 + 大小写");
  assert.notStrictEqual(directoryPathKey("\\\\server\\share"), "//server", "share 是根的一部分，不能裁掉");
}

// ---------- 4. 统一实现：sessionList.normalizePath 与旧 workspacePathKey 的边界 ----------
{
  assert.strictEqual(normalizePath("/work/A/"), directoryPathKey("/work/A/"), "宿主历史列表与共享函数同一口径");
  assert.strictEqual(normalizePath("C:\\A\\"), directoryPathKey("C:\\A\\"), "Windows 形态同样委托");
  // 旧 workspacePathKey 的大小写语义**刻意不动**：它不 lowercase，用于「只凭拼写能证明的同一性」。
  assert.notStrictEqual(workspacePathKey("C:/A"), workspacePathKey("C:/a"), "旧 workspacePathKey 语义不变");
  assert.strictEqual(sameWorkspacePath("C:/A", "C:\\A"), true, "旧函数仍只合并分隔符");
}

console.log("directoryPathKey: all assertions passed");

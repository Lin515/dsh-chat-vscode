/**
 * 跨平台 Workspace 路径的纯字符串判据。
 *
 * 这里是路径身份的下限：绝对形态按 POSIX / 盘符 / UNC 识别，不借 `node:path` 的
 * 平台相关行为；身份比较不转小写、不消 `.` / `..`。终端目录标签的 `.` / `..`
 * 折叠只用于展示。
 *
 * 运行：npm test（已在 esbuild.scripts.mjs 的 entries 里登记）
 */
import assert from "node:assert";
import {
  basenameWorkspacePath,
  isAbsoluteWorkspacePath,
  isWindowsStylePath,
  normalizeWorkspaceSegments,
  recordedAbsolutePath,
  relativizeToCwd,
  resolveWorkspacePath,
  sameWorkspacePath,
  workspacePathKey,
} from "../src/shared/workspacePath";

// ---------- 1. 绝对形态：POSIX / 盘符 / UNC；单反斜杠不是绝对 ----------
{
  for (const path of ["/a/b", "C:/a", "C:\\a", "\\\\server\\share\\x", "//server/share/x"]) {
    assert.strictEqual(isAbsoluteWorkspacePath(path), true, `应当按绝对路径：${path}`);
  }
  for (const path of ["a/b", "\\a\\b", "a\\b", "", "./a", "../a"]) {
    assert.strictEqual(isAbsoluteWorkspacePath(path), false, `不应按绝对路径：${path}`);
  }
  assert.strictEqual(isWindowsStylePath("C:\\a"), true);
  assert.strictEqual(isWindowsStylePath("\\\\srv\\share"), true);
  assert.strictEqual(isWindowsStylePath("/a"), false);
}
console.log("workspacePath: 绝对形态按 POSIX / 盘符 / UNC 识别，单反斜杠不算 ✓");

// ---------- 2. 拼接：只拼字符串，不规范化，不猜缺失的根 ----------
{
  assert.strictEqual(resolveWorkspacePath("C:\\work", "a.ts"), "C:\\work\\a.ts");
  assert.strictEqual(resolveWorkspacePath("C:/work", "a.ts"), "C:/work/a.ts");
  assert.strictEqual(resolveWorkspacePath("/work", "a.ts"), "/work/a.ts");
  assert.strictEqual(resolveWorkspacePath("C:\\work\\", "\\a.ts"), "C:\\work\\a.ts");
  assert.strictEqual(resolveWorkspacePath("/work", "../a.ts"), "/work/../a.ts", "`..` 留给 provider 规范化");
  assert.strictEqual(resolveWorkspacePath("D:\\work", "C:\\other\\a.ts"), "C:\\other\\a.ts");
  assert.strictEqual(resolveWorkspacePath(undefined, "a.ts"), "a.ts", "缺根时不猜绝对位置");
  assert.strictEqual(resolveWorkspacePath("", "a.ts"), "a.ts");
}
console.log("workspacePath: 相对路径只做字符串拼接（不消点、缺根不猜） ✓");

// ---------- 3. 末段、相对化、记录值 ----------
{
  assert.strictEqual(basenameWorkspacePath("C:\\a\\b.ts"), "b.ts");
  assert.strictEqual(basenameWorkspacePath("/a/b.ts"), "b.ts");
  assert.strictEqual(basenameWorkspacePath("b.ts"), "b.ts");
  assert.strictEqual(relativizeToCwd("/root/a.ts", "/root"), "a.ts");
  assert.strictEqual(relativizeToCwd("/root/a.ts", "/root/"), "a.ts");
  assert.strictEqual(relativizeToCwd("/other/a.ts", "/root"), "/other/a.ts");
  assert.strictEqual(relativizeToCwd("/root/a.ts", undefined), "/root/a.ts");

  assert.strictEqual(recordedAbsolutePath({ path: "/exec/a.ts" }, "path"), "/exec/a.ts");
  assert.strictEqual(recordedAbsolutePath({ cwd: "C:\\exec" }, "cwd"), "C:\\exec");
  // 相对 / 空串 / 非字符串 / 非对象 / 数组都不算记录值
  for (const meta of [
    { path: "relative/a.ts" },
    { path: "" },
    { path: 42 },
    null,
    [],
    "meta",
    undefined,
  ]) {
    assert.strictEqual(recordedAbsolutePath(meta, "path"), undefined);
  }
  // 官方只读字段，不额外要求自有键
  assert.strictEqual(
    recordedAbsolutePath(Object.create({ path: "/inherited/a.ts" }), "path"),
    "/inherited/a.ts",
  );
}
console.log("workspacePath: 记录值只认绝对字符串（不按当前目录补齐） ✓");

// ---------- 4. 身份比较：分隔符可合并，大小写 / 点段不可合并 ----------
{
  assert.strictEqual(workspacePathKey("C:\\A\\B\\"), "C:/A/B");
  assert.strictEqual(workspacePathKey("C:/A/B"), "C:/A/B");
  assert.strictEqual(sameWorkspacePath("C:\\A\\B", "C:/A/B"), true);
  assert.strictEqual(sameWorkspacePath("C:\\A\\B", "C:/a/b"), false, "大小写不是身份证据");
  assert.strictEqual(sameWorkspacePath("/work/A.ts", "/work/a.ts"), false);
  assert.strictEqual(sameWorkspacePath("/work/link/../a.ts", "/work/a.ts"), false, "点段不静默消解");
  // 相对拼写拿不到路径家族：反斜杠原样保留，避免把 POSIX 字面反斜杠合并掉
  assert.strictEqual(workspacePathKey("src\\a.ts"), "src\\a.ts");
  assert.strictEqual(sameWorkspacePath("src\\a.ts", "src/a.ts"), false);
}
console.log("workspacePath: 身份比较不 lowercase、不消点（POSIX 大小写保持两个身份） ✓");

// ---------- 5. 终端展示标签：折叠 `.` / `..`，UNC 根不越界 ----------
{
  assert.strictEqual(normalizeWorkspaceSegments("/a/b/../c"), "/a/c");
  assert.strictEqual(normalizeWorkspaceSegments("/a/./b"), "/a/b");
  assert.strictEqual(normalizeWorkspaceSegments("/a/../../b"), "/b", "`..` 到根就停");
  assert.strictEqual(normalizeWorkspaceSegments("C:\\a\\.\\b\\..\\c"), "C:\\a\\c");
  assert.strictEqual(normalizeWorkspaceSegments("C:\\a\\..\\..\\b"), "C:\\b");
  assert.strictEqual(normalizeWorkspaceSegments("\\\\srv\\share\\a\\..\\b"), "\\\\srv\\share\\b");
  assert.strictEqual(
    normalizeWorkspaceSegments("\\\\srv\\share\\..\\b"),
    "\\\\srv\\share\\b",
    "UNC 的 server/share 不能被 `..` 弹掉",
  );
  assert.strictEqual(normalizeWorkspaceSegments("../a/../b"), "../b", "未锚定的 `..` 保留");
  assert.strictEqual(normalizeWorkspaceSegments("a/b.ts"), "a/b.ts", "没有点段时原样返回");
}
console.log("workspacePath: 终端标签折叠点段，UNC 根不越界 ✓");

console.log("\nworkspacePath: all assertions passed");

/**
 * 文件芯片分类与打开目标：执行世界存在性 + 本机附件 source 的边界。
 *
 * 旧实现靠本机 stat + git 清单；本设计明确不再把本机同名文件 / git 清单当成
 * 执行世界证据。断言钉住新判据，以及 controller 不再走 `git.openChange` /
 * 本机 `Uri.file` 打开模型路径。
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  fileChangeKind,
  isNotFoundError,
  resolveChipPath,
  splitPathLineSuffix,
} from "../src/dsh/fileChange";

// ---------- 1. 只有明确 absent 才画删除线 ----------
{
  assert.strictEqual(fileChangeKind("present"), undefined, "present 不标记号：没有已验证的 git 映射");
  assert.strictEqual(fileChangeKind("unknown"), undefined, "unknown 不标记号（权限/离线/失效不是删除）");
  assert.strictEqual(fileChangeKind("absent"), "deleted", "Host 明确 not-found 才 deleted");
}
console.log("fileChange: 执行世界存在性三态分类 ✓");

// ---------- 2. 本机附件 source 的路径解析（与模型路径分开） ----------
{
  const win = process.platform === "win32";
  const cwd = win ? "D:\\dev\\app" : "/srv/dev/app";
  const under = (relative: string) => (win ? `${cwd}\\${relative.replace(/\//g, "\\")}` : `${cwd}/${relative}`);
  assert.strictEqual(resolveChipPath(cwd, "src/a.ts"), under("src/a.ts"));
  assert.strictEqual(resolveChipPath(undefined, "/abs/a.ts"), "/abs/a.ts");
  assert.strictEqual(resolveChipPath(undefined, "src/a.ts"), undefined, "本机 source 相对且无基准时不猜");
  assert.strictEqual(resolveChipPath(cwd, ""), undefined);
}
console.log("fileChange: 本机附件 source 路径解析 ✓");

// ---------- 3. 尾部行号拆分 ----------
{
  assert.deepStrictEqual(splitPathLineSuffix("src/a.ts:12"), { path: "src/a.ts", line: 12 });
  assert.deepStrictEqual(splitPathLineSuffix("src/a.ts:12-40"), { path: "src/a.ts", line: 12 });
  assert.deepStrictEqual(splitPathLineSuffix("src/a.ts:12:5"), { path: "src/a.ts", line: 12 });
  assert.deepStrictEqual(splitPathLineSuffix("D:\\dev\\app\\src\\a.ts:9"), {
    path: "D:\\dev\\app\\src\\a.ts",
    line: 9,
  });
  assert.strictEqual(splitPathLineSuffix("src/a.ts"), undefined);
  assert.strictEqual(splitPathLineSuffix("C:12"), undefined);
  assert.strictEqual(splitPathLineSuffix("src/a.ts:0"), undefined);
}
console.log("fileChange: 行号/盘符拆分 ✓");

// ---------- 4. 本机 FileNotFound 判据只服务附件 source ----------
{
  assert.strictEqual(isNotFoundError({ code: "FileNotFound" }), true);
  assert.strictEqual(isNotFoundError({ code: "NoPermissions" }), false);
  assert.strictEqual(isNotFoundError({ code: "Unavailable" }), false);
  assert.strictEqual(isNotFoundError(new Error("ENOENT")), false);
}
console.log("fileChange: 本机附件 stat 的 not-found 判据 ✓");

// ---------- 5. 接线：模型路径不再走本机 / git ----------
{
  const source = (path: string) => readFileSync(join(process.cwd(), "src", "dsh", path), "utf8");
  const controller = source("controller.ts");
  const remote = source("remoteFiles.ts");
  const provider = source("remoteFileSystem.ts");
  const extension = readFileSync(join(process.cwd(), "src", "extension.ts"), "utf8");

  assert.ok(/workspaceFiles\/stat/u.test(remote), "存在性/绝对路径必须走 workspaceFiles.stat");
  assert.ok(/workspaceFiles\/read/u.test(remote), "文本走 workspaceFiles.read 分页");
  assert.ok(/\/api\/file\?/u.test(remote), "字节走认证 /api/file");
  assert.ok(/workspaceFileScopeId/u.test(remote), "scope 绑定 session");

  assert.ok(/remoteFileUri\(/u.test(controller), "普通文件打开走执行世界资源 URI");
  assert.ok(!/git\.openChange/u.test(controller), "不再有未验证的本机 git 回退");
  assert.ok(!/hasWorkingChange/u.test(controller), "不再按本机 git 清单分类");
  assert.ok(!/vscode\.Uri\.file\((?:opened|stat|absolute)/u.test(controller), "模型路径不再直接 Uri.file");
  assert.ok(/vscode\.Uri\.file\(resolved\)/u.test(controller), "本机附件 source 仍允许 Uri.file（与模型路径分开）");
  assert.ok(/this\.adoptClient\(client\)/u.test(controller), "连接换代统一收口");
  assert.ok(/resolveHostFileConnection/u.test(controller), "provider 只按原连接 id 解析资源");
  assert.ok(/classifyFiles\(sessionId, paths\)/u.test(controller), "芯片分类带会话 scope");
  assert.ok(/readHostImages\(access, sessionId/u.test(controller), "正文图片按会话执行世界读取");
  assert.ok(/const defaultDir =\s*vscode\.workspace\.workspaceFolders/u.test(controller), "保存对话框默认本机目的地");

  assert.ok(/REMOTE_FILE_SCHEME/u.test(provider) && /isReadonly/u.test(extension), "只读虚拟 FS 在扩展激活期注册");
  assert.ok(/workspaceFiles\/changes/u.test(readFileSync(join(process.cwd(), "src", "dsh", "client.ts"), "utf8")), "打开中的资源订阅 change feed");
}
console.log("fileChange: controller / provider 接线（无本机 stat / git 回退）✓");

console.log("\nfileChange: all assertions passed");

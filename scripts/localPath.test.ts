/**
 * 真实文件打开的本机判据（宿主侧纯函数）。
 *
 * 这里钉的是「不能把执行世界路径当成本机路径」：Windows 只认盘符 / UNC，POSIX
 * 只认 `/` 且排除盘符；回环端点才可能算本机；字节比较必须真的逐字节。
 *
 * 运行：npm test（已在 esbuild.scripts.mjs 的 entries 里登记）
 */
import assert from "node:assert";
import {
  isLocalAbsolutePath,
  isLoopbackHostname,
  isLoopbackUrl,
  localPlatform,
  sameBytes,
} from "../src/dsh/localPath";

// ---------- 1. 平台家族 ----------
{
  assert.strictEqual(localPlatform("win32"), "win32");
  assert.strictEqual(localPlatform("darwin"), "posix");
  assert.strictEqual(localPlatform("linux"), "posix");
}
console.log("localPath: process.platform 归一到 win32 / posix ✓");

// ---------- 2. 本机绝对路径形态 ----------
{
  for (const path of ["C:/dev/a.ts", "C:\\dev\\a.ts", "\\\\server\\share\\a.ts"]) {
    assert.strictEqual(isLocalAbsolutePath(path, "win32"), true, `Windows 应认：${path}`);
  }
  for (const path of ["/work/demo/a.ts", "C:a.ts", "src/a.ts"]) {
    assert.strictEqual(isLocalAbsolutePath(path, "win32"), false, `Windows 不应认：${path}`);
  }
  for (const path of ["/work/demo/a.ts", "//server/share/a.ts"]) {
    assert.strictEqual(isLocalAbsolutePath(path, "posix"), true, `POSIX 应认：${path}`);
  }
  for (const path of ["C:/dev/a.ts", "/", "src/a.ts", "\\\\server\\share\\a.ts"]) {
    // "/" 是根目录，不是可打开的文件；形态上仍然是本机绝对路径。
    if (path === "/") continue;
    assert.strictEqual(isLocalAbsolutePath(path, "posix"), false, `POSIX 不应认：${path}`);
  }
  assert.strictEqual(isLocalAbsolutePath("/", "posix"), true);
}
console.log("localPath: 本机绝对路径形态按平台收窄（盘符 / UNC / POSIX 根） ✓");

// ---------- 3. 回环端点 ----------
{
  for (const host of ["localhost", "127.0.0.1", "127.10.20.30", "[::1]", "::1", "LOCALHOST."]) {
    assert.strictEqual(isLoopbackHostname(host), true, `应是回环：${host}`);
  }
  for (const host of ["", "example.com", "192.168.1.2", "::2"]) {
    assert.strictEqual(isLoopbackHostname(host), false, `不应是回环：${host}`);
  }
  assert.strictEqual(isLoopbackUrl("http://127.0.0.1:3904"), true);
  assert.strictEqual(isLoopbackUrl("http://[::1]:3904"), true);
  assert.strictEqual(isLoopbackUrl("https://example.com"), false);
  assert.strictEqual(isLoopbackUrl("not a url"), false);
  assert.strictEqual(isLoopbackUrl(undefined), false);
}
console.log("localPath: 只有回环端点算本机候选（远端 / 坏 URL 不算） ✓");

// ---------- 4. 字节身份 ----------
{
  const base = new Uint8Array([1, 2, 3]);
  assert.strictEqual(sameBytes(base, new Uint8Array([1, 2, 3])), true);
  assert.strictEqual(sameBytes(base, new Uint8Array([1, 2])), false);
  assert.strictEqual(sameBytes(base, new Uint8Array([1, 2, 4])), false);
  assert.strictEqual(sameBytes(new Uint8Array(), new Uint8Array()), true);
}
console.log("localPath: 本机副本与执行世界必须逐字节一致 ✓");

console.log("\nlocalPath: all assertions passed");

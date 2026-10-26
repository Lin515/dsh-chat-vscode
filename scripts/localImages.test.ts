/**
 * 正文图片：执行世界的 stat + `/api/file` 字节 → data URL。
 *
 * 这里没有本机 fs：fake transport 可以返回「与扩展宿主同形同名的另一份内容」，
 * 断言读到的始终是 Host 的字节；相对路径原样交给 Host（缺 cwd 也可以），绝对
 * 根外路径不由客户端按目录拒绝；UNC / 控制字符在客户端就拒绝。
 *
 * 张数不截断（全部处理，只限并发），单图大小由 Host 媒体路由裁决：客户端不再有
 * 16 MiB / 24 张这类本地门。
 */
import assert from "node:assert";
import {
  LOCAL_IMAGE_CONCURRENCY,
  readHostImages,
} from "../src/dsh/localImages";
import { HostFileAccess, type HostFileBytesResponse, type HostFileTransport } from "../src/dsh/remoteFiles";

class Fake implements HostFileTransport {
  readonly calls: { method: string; args: Record<string, unknown> }[] = [];
  readonly bytesCalls: string[] = [];
  activeBytes = 0;
  maxActiveBytes = 0;
  constructor(
    private readonly files: Record<string, { bytes: Uint8Array; absolutePath?: string; mediaType?: string; size?: number }>,
    private readonly fail?: (path: string) => { code: string } | undefined,
  ) {}

  async request<T>(method: string, args: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, args });
    const path = String(args.path);
    const failure = this.fail?.(path);
    if (failure) throw failure;
    const file = this.files[path];
    if (!file) throw { code: "workspace-file/not-found" };
    return {
      absolutePath: file.absolutePath ?? `/world/${path}`,
      version: "v1",
      bytes: file.size ?? file.bytes.byteLength,
    } as T;
  }

  async getBytes(path: string): Promise<HostFileBytesResponse | undefined> {
    this.bytesCalls.push(path);
    this.activeBytes += 1;
    this.maxActiveBytes = Math.max(this.maxActiveBytes, this.activeBytes);
    try {
      // 让出一拍，制造真正交错的机会（并发窗口才有观测意义）。
      await new Promise((resolve) => setImmediate(resolve));
      const absolute = decodeURIComponent(new URLSearchParams(path.split("?")[1]).get("path") ?? "");
      for (const [reference, file] of Object.entries(this.files)) {
        if ((file.absolutePath ?? `/world/${reference}`) === absolute) {
          return { bytes: file.bytes, ...(file.mediaType ? { mediaType: file.mediaType } : {}) };
        }
      }
      return undefined;
    } finally {
      this.activeBytes -= 1;
    }
  }
}

// ---------- 1. 同名但内容不同：读到的是 Host 字节 ----------
{
  const transport = new Fake({
    "out/chart.png": { bytes: new Uint8Array([9, 9, 9]), absolutePath: "/remote/out/chart.png", mediaType: "image/png" },
  });
  const access = new HostFileAccess(transport);
  const result = await readHostImages(access, "s1", ["out/chart.png"]);
  assert.ok(result.urls["out/chart.png"]?.startsWith("data:image/png;base64,"));
  assert.deepStrictEqual(result.failures, {});
  assert.deepStrictEqual(transport.calls[0]?.args, { workspaceFileScopeId: "s1", path: "out/chart.png" });
  assert.ok(transport.bytesCalls[0]?.includes(encodeURIComponent("/remote/out/chart.png")));
}
console.log("local-images: 执行世界字节（不是本机同名文件）✓");

// ---------- 2. 根外绝对路径与缺 cwd 相对路径都交给 Host ----------
{
  const transport = new Fake({
    "/etc/shots/a.png": { bytes: new Uint8Array([1]), absolutePath: "/etc/shots/a.png", mediaType: "image/png" },
    "rel.png": { bytes: new Uint8Array([2]), absolutePath: "/root/rel.png", mediaType: "image/png" },
  });
  const access = new HostFileAccess(transport);
  const result = await readHostImages(access, "s1", ["/etc/shots/a.png", "rel.png"]);
  assert.deepStrictEqual(Object.keys(result.urls).sort(), ["/etc/shots/a.png", "rel.png"]);
  assert.strictEqual(transport.calls[1]?.args.path, "rel.png", "相对路径不拼本机 cwd");
}
console.log("local-images: 根外绝对 / 缺 cwd 相对路径由 Host 裁决 ✓");

// ---------- 3. UNC / 控制字符客户端拒绝；扩展名不是授权门 ----------
{
  const transport = new Fake({});
  const access = new HostFileAccess(transport);
  const result = await readHostImages(access, "s1", [
    "\\\\host\\share\\a.png",
    "//host/share/b.png",
    "bad\u0000.png",
    "notes.txt",
  ]);
  assert.deepStrictEqual(Object.keys(result.urls), []);
  assert.strictEqual(result.failures["\\\\host\\share\\a.png"], "UNC path");
  assert.strictEqual(result.failures["//host/share/b.png"], "UNC path");
  assert.strictEqual(result.failures["bad\u0000.png"], "control character");
  assert.strictEqual(result.failures["notes.txt"], "absent", "非图片扩展名不被客户端拒绝，交给 Host；Host 没有就是 absent");
  assert.strictEqual(transport.calls.length, 1, "UNC/控制字符在发请求前就拒绝（只有 notes.txt 问了一次）");
}
console.log("local-images: UNC / 控制字符拒绝，扩展名不设白名单 ✓");

// ---------- 4. 权限错误是失败原因，不是「不存在」 ----------
{
  const access = new HostFileAccess(new Fake({}, () => ({ code: "EACCES" })));
  const result = await readHostImages(access, "s1", ["a.png"]);
  assert.deepStrictEqual(result.urls, {});
  assert.strictEqual(result.failures["a.png"], "unknown", "权限/未知错误不伪装成删除或空图");
}
console.log("local-images: 权限未知只记失败，不落 data URL ✓");

// ---------- 5. 不截断张数：30 张全部处理，只限并发 ----------
{
  const refs = Array.from({ length: 30 }, (_, index) => `shots/${index}.png`);
  const files: Record<string, { bytes: Uint8Array; mediaType: string }> = {};
  refs.forEach((reference, index) => {
    files[reference] = { bytes: new Uint8Array([index + 1]), mediaType: "image/png" };
  });
  const transport = new Fake(files);
  const access = new HostFileAccess(transport);
  const result = await readHostImages(access, "s1", refs);
  assert.strictEqual(Object.keys(result.urls).length, 30, "第 25 张及以后不能被丢弃");
  assert.strictEqual(transport.bytesCalls.length, 30);
  assert.ok(transport.maxActiveBytes <= LOCAL_IMAGE_CONCURRENCY, "并发不得超过窗口");
  assert.ok(transport.maxActiveBytes > 1, "并发窗口应真正并行，而不是串行");
}
console.log("local-images: 全部引用都读，仅限制并发 ✓");

// ---------- 6. 单图大小由 Host 裁决：stat 报大也不预拒绝 ----------
{
  const transport = new Fake({
    "huge.png": {
      // stat 报一个很大的大小，但 /api/file 只回了 1 字节：客户端不再有 16 MiB 门，
      // 真正的限额在 Host 的媒体路由（超限会是 413）。
      bytes: new Uint8Array([1]),
      size: 32 * 1024 * 1024,
      absolutePath: "/world/huge.png",
      mediaType: "image/png",
    },
  });
  const access = new HostFileAccess(transport);
  const result = await readHostImages(access, "s1", ["huge.png"]);
  assert.ok(result.urls["huge.png"]?.startsWith("data:image/png;base64,"));
  assert.deepStrictEqual(result.failures, {});
  assert.strictEqual(transport.bytesCalls.length, 1, "客户端不按 stat.bytes 预先拒绝");
}
console.log("local-images: 单图限额交给 Host 媒体路由 ✓");

console.log("\nlocal-images: all assertions passed");

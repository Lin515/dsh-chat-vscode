/**
 * 执行世界文件访问的离线断言：fake transport 扮演 Host，不启动真实 DSH。
 *
 * 钉的是这条边界的**安全/身份判据**：只有 not-found 是 absent、连接关闭后迟到结果
 * 不复活、分页必须自洽、字节只走 `/api/file` 且预算能拦住 stat 未报大小的响应、
 * 路径形态不按扩展宿主平台猜。
 */
import assert from "node:assert";
import {
  HostFileAccess,
  HostFileError,
  isExecutionWorldAbsolute,
  resolveExecutionWorldPath,
  sameExecutionPath,
  unsupportedMediaPath,
  type HostFileBytesResponse,
  type HostFileTransport,
} from "../src/dsh/remoteFiles";
import {
  decodeRemoteFileAddress,
  encodeRemoteFileAddress,
  remoteFileBasename,
} from "../src/dsh/remoteFileAddress";

type Resolver = (method: string, args: Record<string, unknown>) => unknown;

class FakeTransport implements HostFileTransport {
  readonly calls: { method: string; args: Record<string, unknown> }[] = [];
  bytesCalls: string[] = [];
  bytes: HostFileBytesResponse | undefined;
  watchHandlers:
    | {
        onFrame: (frame: unknown) => void;
        onEnd?: () => void;
        onError?: (error: unknown) => void;
      }
    | undefined;
  watchCancelled = false;
  constructor(private readonly resolve: Resolver) {}

  async request<T>(method: string, args: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, args });
    return this.resolve(method, args) as T;
  }

  async getBytes(path: string): Promise<HostFileBytesResponse | undefined> {
    this.bytesCalls.push(path);
    return this.bytes;
  }

  watchWorkspaceFile(
    _sessionId: string,
    _path: string,
    callbacks: {
      onFrame: (frame: unknown) => void;
      onEnd?: () => void;
      onError?: (error: unknown) => void;
    },
  ): { cancel(): void } {
    this.watchHandlers = callbacks;
    return { cancel: () => { this.watchCancelled = true; } };
  }
}

const stat = (absolutePath: string, bytes?: number) => ({
  absolutePath,
  version: "v1",
  ...(bytes === undefined ? {} : { bytes }),
});

// ---------- 1. stat 形状与跨平台绝对路径 ----------
{
  for (const path of ["/home/u/a.ts", "C:\\work\\a.ts", "C:/work/a.ts", "\\\\host\\share\\a.ts"]) {
    assert.strictEqual(isExecutionWorldAbsolute(path), true, `${path} 是执行世界绝对路径`);
  }
  assert.strictEqual(isExecutionWorldAbsolute("/"), true, "POSIX 根就是绝对路径（官方 startsWith('/')）");
  assert.strictEqual(isExecutionWorldAbsolute("src/a.ts"), false, "相对路径不由客户端当绝对");
  assert.strictEqual(isExecutionWorldAbsolute("C:foo"), false, "盘符相对不是绝对");
  assert.strictEqual(isExecutionWorldAbsolute(""), false);

  const transport = new FakeTransport(() => stat("C:\\work\\a.ts", 12));
  const access = new HostFileAccess(transport);
  const value = await access.stat("s1", "src/a.ts");
  assert.deepStrictEqual(value, { absolutePath: "C:\\work\\a.ts", version: "v1", bytes: 12 });
  assert.strictEqual(transport.calls[0]?.method, "workspaceFiles/stat");
  assert.deepStrictEqual(transport.calls[0]?.args, { workspaceFileScopeId: "s1", path: "src/a.ts" });

  const bad = new HostFileAccess(new FakeTransport(() => stat("relative/path")));
  await assert.rejects(
    () => bad.stat("s1", "a"),
    (error: unknown) => error instanceof HostFileError && error.reason === "unknown",
    "Host 返回非绝对路径必须整份拒绝，不能拿去拼 /api/file",
  );
}
console.log("remote-files: stat 形状与执行世界绝对路径 ✓");

// ---------- 1b. 会话创建目录的纯字符串拼接（不按本机平台猜） ----------
{
  assert.strictEqual(resolveExecutionWorldPath("/home/u/app", "src/a.ts"), "/home/u/app/src/a.ts");
  assert.strictEqual(resolveExecutionWorldPath("/home/u/app/", "src/a.ts"), "/home/u/app/src/a.ts");
  assert.strictEqual(
    resolveExecutionWorldPath("C:\\work\\app", "src\\a.ts"),
    "C:\\work\\app\\src\\a.ts",
    "Windows 创建目录沿用反斜杠",
  );
  assert.strictEqual(
    resolveExecutionWorldPath("C:/work/app", "src/a.ts"),
    "C:/work/app/src/a.ts",
    "斜杠拼写的 Windows 创建目录沿用正斜杠",
  );
  assert.strictEqual(
    resolveExecutionWorldPath("/home/u/app", "C:\\other\\a.ts"),
    "C:\\other\\a.ts",
    "绝对输入原样返回，不拼目录",
  );
  assert.strictEqual(
    resolveExecutionWorldPath(undefined, "src/a.ts"),
    undefined,
    "缺创建目录时不能声称知道绝对位置",
  );
  assert.strictEqual(resolveExecutionWorldPath(undefined, "/abs/a.ts"), "/abs/a.ts");
  assert.strictEqual(
    resolveExecutionWorldPath("/home/u/app", "../a.ts"),
    "/home/u/app/../a.ts",
    "不消点：规范化由 Host 负责",
  );
}
console.log("remote-files: 相对路径只按创建目录拼接、缺目录不猜 ✓");

// ---------- 2. 只有 not-found 是 absent ----------
{
  const notFound = new HostFileAccess(
    new FakeTransport(() => {
      throw { code: "workspace-file/not-found" };
    }),
  );
  assert.strictEqual(await notFound.classify("s1", "gone.ts"), "absent");
  for (const code of [
    "workspace-file/not-regular-file",
    "workspace-file/too-large",
    "workspace-file/not-text",
    "workspace-file/outside-workspace",
    "gateway/service-unavailable",
    "gateway/internal",
    "session/not-found",
  ]) {
    const access = new HostFileAccess(
      new FakeTransport(() => {
        throw { code };
      }),
    );
    assert.notStrictEqual(await access.classify("s1", "a.ts"), "absent", `${code} 不能等于删除`);
  }
  const denied = new HostFileAccess(
    new FakeTransport(() => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    }),
  );
  assert.strictEqual(await denied.classify("s1", "a.ts"), "unknown", "本机/传输类权限错误是 unknown");
}
console.log("remote-files: not-found 与权限/未知严格分开 ✓");

// ---------- 3. 分页：版本一致、页自洽、只按行 join 不推测末尾 ----------
{
  const pages: Record<number, unknown> = {
    1: {
      ...stat("/work/a.txt", 9),
      offset: 1,
      text: "a\r\nb",
      lines: 2,
      eof: false,
    },
    3: {
      ...stat("/work/a.txt", 9),
      offset: 3,
      text: "c😀",
      lines: 1,
      eof: true,
    },
  };
  const transport = new FakeTransport((method, args) => {
    assert.strictEqual(method, "workspaceFiles/read");
    const range = args.range as { offset: number };
    return pages[range.offset];
  });
  const access = new HostFileAccess(transport);
  const read = await access.readText("s1", "a.txt");
  assert.deepStrictEqual(read.stat, { absolutePath: "/work/a.txt", version: "v1", bytes: 9 });
  assert.strictEqual(read.text, "a\r\nb\nc😀", "页内 CRLF 保留、页间用 \\n 接；不推测原文件末尾换行");

  // 页的 offset 与请求不一致：拒绝，不把重复/漏行当完整文本
  const badOffset = new HostFileAccess(
    new FakeTransport(() => ({ ...stat("/w/a.txt"), offset: 2, text: "x", lines: 1, eof: true })),
  );
  await assert.rejects(() => badOffset.readText("s1", "a.txt"), /offset/u);

  // lines 与 text 自相矛盾：拒绝
  const badLines = new HostFileAccess(
    new FakeTransport(() => ({ ...stat("/w/a.txt"), offset: 1, text: "x\ny", lines: 1, eof: true })),
  );
  await assert.rejects(() => badLines.readText("s1", "a.txt"), /lines/u);

  // 两页之间 version 变了：拒绝拼接两版
  let page = 0;
  const changed = new HostFileAccess(
    new FakeTransport(() => {
      page += 1;
      return {
        absolutePath: "/w/a.txt",
        version: page === 1 ? "v1" : "v2",
        offset: page === 1 ? 1 : 2,
        text: "a",
        lines: 1,
        eof: page === 2,
      };
    }),
  );
  await assert.rejects(() => changed.readText("s1", "a.txt"), /changed/u);
}
console.log("remote-files: 分页自洽 / 版本一致 / 不推测末尾换行 ✓");

// ---------- 4. 媒体字节走 /api/file，预算必须拦住 stat 未报大小的响应 ----------
{
  const transport = new FakeTransport(() => ({ absolutePath: "/w/p.png", version: "v1" }));
  transport.bytes = { bytes: new Uint8Array([1, 2, 3, 4, 5]), mediaType: "image/png; charset=binary" };
  const access = new HostFileAccess(transport);
  const mediaStat = { absolutePath: "/w/p.png", version: "v1" };
  await assert.rejects(
    () => access.readBytesAt(mediaStat, "p.png", { maxBytes: 4 }),
    (error: unknown) => error instanceof HostFileError && error.reason === "too-large",
    "stat 未报 bytes 时也要按响应实际长度执行客户端预算",
  );
  const ok = await access.readBytesAt(mediaStat, "p.png", { maxBytes: 8 });
  assert.deepStrictEqual([...ok.data], [1, 2, 3, 4, 5]);
  assert.strictEqual(ok.mediaType, "image/png", "媒体类型去掉参数");
  assert.strictEqual(transport.calls.length, 0, "媒体读取不该再问 workspaceFiles/readBytes");
  assert.ok(
    transport.bytesCalls[0]?.startsWith("/api/file?path=%2Fw%2Fp.png"),
    `媒体路由必须使用 Host 返回的绝对路径，实际：${transport.bytesCalls[0]}`,
  );
  assert.ok(
    transport.bytesCalls[0]?.includes("v=v1"),
    `媒体路由要带 stat 的版本号，否则 Host 会先 302 一跳，实际：${transport.bytesCalls[0]}`,
  );
}
console.log("remote-files: 媒体字节走 api/file 且预算生效 ✓");

// ---------- 4b. 普通文件走 workspaceFiles/readBytes，窗口逐字段核对 ----------
{
  const rpcCalls: Record<string, unknown>[] = [];
  const transport = new FakeTransport((method, args) => {
    assert.strictEqual(method, "workspaceFiles/readBytes");
    rpcCalls.push(args);
    const range = args.options as { range?: { offset?: number; length?: number } };
    if (range.range) {
      return {
        absolutePath: "/w/a.bin",
        version: "v1",
        bytes: 5,
        offset: 2,
        data: new Uint8Array([3, 4, 5]),
        eof: true,
      };
    }
    return {
      absolutePath: "/w/a.bin",
      version: "v1",
      bytes: 3,
      offset: 0,
      data: new Uint8Array([1, 2, 3]),
      eof: true,
    };
  });
  const access = new HostFileAccess(transport);

  const complete = await access.readBytes("s1", "a.bin");
  assert.deepStrictEqual([...complete.data], [1, 2, 3]);
  assert.strictEqual(complete.offset, 0);
  assert.strictEqual(complete.eof, true);
  assert.deepStrictEqual(rpcCalls[0], {
    workspaceFileScopeId: "s1",
    path: "a.bin",
    options: {},
  });
  assert.strictEqual(transport.bytesCalls.length, 0, "普通文件不经过 /api/file");

  const window = await access.readBytes("s1", "a.bin", { range: { offset: 2, length: 5 } });
  assert.deepStrictEqual([...window.data], [3, 4, 5]);
  assert.deepStrictEqual(rpcCalls[1], {
    workspaceFileScopeId: "s1",
    path: "a.bin",
    options: { range: { offset: 2, length: 5 } },
  });

  const rejects = async (
    resolver: (method: string, args: Record<string, unknown>) => unknown,
    options: Record<string, unknown>,
    pattern: RegExp,
    why: string,
  ): Promise<void> => {
    const bad = new HostFileAccess(new FakeTransport(resolver));
    await assert.rejects(
      () => bad.readBytes("s1", "a.bin", options),
      (error: unknown) => error instanceof HostFileError && error.reason === "unknown" && pattern.test(error.message),
      why,
    );
  };
  const base = { absolutePath: "/w/a.bin", version: "v1", bytes: 5 };
  await rejects(
    () => ({ ...base, offset: 1, data: new Uint8Array([1]), eof: true }),
    {},
    /offset/u,
    "无 range 时 offset 必须为 0",
  );
  await rejects(
    () => ({ ...base, offset: 0, data: new Uint8Array([1, 2, 3]), eof: false }),
    {},
    /partial file|EOF/u,
    "无 range 且 eof false 不能冒充完整文件",
  );
  await rejects(
    () => ({ ...base, offset: 0, data: new Uint8Array([1]), eof: true }),
    {},
    /truncated/u,
    "无 range 时字节数必须等于 stat.bytes",
  );
  await rejects(
    () => ({ ...base, offset: 1, data: new Uint8Array([1]), eof: false }),
    { range: { offset: 2 } },
    /offset/u,
    "range 回显的 offset 必须与请求一致",
  );
  await rejects(
    () => ({ ...base, offset: 2, data: new Uint8Array([1, 2, 3, 4]), eof: true }),
    { range: { offset: 2, length: 2 } },
    /more bytes/u,
    "range 返回长度不得超过请求 length",
  );
  await rejects(
    () => ({ ...base, offset: 2, data: new Uint8Array([1]), eof: true }),
    { range: { offset: 2 } },
    /EOF/u,
    "声称 eof 时窗口末尾必须正是文件末尾",
  );
}
console.log("remote-files: 普通文件 RPC 字节、range 与 eof 逐字段核对 ✓");

// ---------- 5. 连接关闭：旧 access 不再产生结果 ----------
{
  const access = new HostFileAccess(new FakeTransport(() => stat("/w/a.ts")));
  access.close();
  await assert.rejects(
    () => access.stat("s1", "a.ts"),
    (error: unknown) => error instanceof HostFileError && error.reason === "closed",
  );
}
console.log("remote-files: 关闭连接后拒绝迟到请求 ✓");

// ---------- 6. 媒体路径的客户端拒绝条件 ----------
{
  assert.strictEqual(unsupportedMediaPath("\\\\host\\share\\a.png"), "UNC path");
  assert.strictEqual(unsupportedMediaPath("//host/share/a.png"), "UNC path");
  assert.strictEqual(unsupportedMediaPath("C:foo/a.png"), "drive-relative path");
  assert.strictEqual(unsupportedMediaPath("out/a\u0000.png"), "control character");
  assert.strictEqual(unsupportedMediaPath("/home/u/.ssh/id_rsa"), undefined, "根外绝对路径不由客户端按目录拒绝");
  assert.strictEqual(unsupportedMediaPath("../outside.png"), undefined, "相对路径交给 Host 的会话基准");
  assert.strictEqual(unsupportedMediaPath("notes.txt"), undefined, "扩展名不是媒体授权条件");
}
console.log("remote-files: UNC / 控制字符 / 盘符相对拒绝，扩展名与目录不设白名单 ✓");

// ---------- 7. 路径比较不按扩展宿主平台猜 ----------
{
  assert.strictEqual(sameExecutionPath("/a/b", "/a/b/"), true, "去掉结尾分隔符");
  assert.strictEqual(sameExecutionPath("/a\\b", "/a/b"), false, "POSIX 的反斜杠是文件名，不合并");
  assert.strictEqual(sameExecutionPath("C:\\A\\b.ts", "C:/A/b.ts"), true, "Windows 分隔符归一");
  assert.strictEqual(sameExecutionPath("C:\\A\\b.ts", "c:\\a\\B.ts"), false, "不 lowercase");
  assert.strictEqual(sameExecutionPath("/A/b", "//A/b"), false, "UNC / POSIX 不混同");
}
console.log("remote-files: 路径判据只做形态归一，不猜大小写/不消点 ✓");

// ---------- 8. 观察帧：目标校验与错误不删除 ----------
{
  const transport = new FakeTransport(() => stat("/w/a.ts"));
  const access = new HostFileAccess(transport);
  const events: string[] = [];
  access.watch("s1", "a.ts", "/w/a.ts", (event) => events.push(event.kind));
  const handlers = transport.watchHandlers;
  assert.ok(handlers, "应建立 changes 订阅");
  handlers.onFrame({ kind: "ready" });
  handlers.onFrame({ kind: "change", change: { absolutePath: "/other/a.ts", version: "v2" } });
  assert.deepStrictEqual(events, ["ready"], "别的绝对路径不能刷新这个资源");
  handlers.onFrame({ kind: "change", change: { absolutePath: "/w/a.ts", version: "v2" } });
  handlers.onError(new Error("watch failed"));
  assert.deepStrictEqual(events, ["ready", "changed", "error"], "观察失败只报 error，绝不报 absent");
}
console.log("remote-files: change feed 目标绑定 / 错误不删除 ✓");

// ---------- 9. URI 身份 ----------
{
  const a = { connectionId: "c1", sessionId: "s1", path: "/w/a.ts" };
  const token = encodeRemoteFileAddress(a);
  assert.deepStrictEqual(decodeRemoteFileAddress(token), a);
  assert.notStrictEqual(
    encodeRemoteFileAddress({ ...a, connectionId: "c2" }),
    token,
    "连接身份必须进入资源地址",
  );
  assert.notStrictEqual(
    encodeRemoteFileAddress({ ...a, sessionId: "s2" }),
    token,
    "会话身份必须进入资源地址",
  );
  assert.strictEqual(decodeRemoteFileAddress("not-base64!?"), undefined);
  assert.strictEqual(remoteFileBasename("C:\\w\\a.ts"), "a.ts");
  assert.strictEqual(remoteFileBasename("/w/a.ts"), "a.ts");
  assert.strictEqual(remoteFileBasename("/"), "file");
}
console.log("remote-files: 资源地址绑定连接+会话+路径 ✓");

assert.throws(
  () => {
    throw new HostFileError("unsupported", "x");
  },
  (error: unknown) => error instanceof HostFileError && error.existence === "unknown",
);
console.log("\nremote-files: all assertions passed");

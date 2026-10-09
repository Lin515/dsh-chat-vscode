/**
 * 会话日志解码（`scripts/sessionLog.ts`）的离线回归。
 *
 * 材料**全部自建合成**：内存里的 JSONL 文本 + `zstdCompressSync` 造的帧，落到
 * `mkdtempSync` 的临时目录；**不读任何用户会话日志**，不起 DSH、不花 token。
 *
 * 覆盖：
 * - 字节接口 `decodeSessionLogBytes` 与路径接口 `decodeSessionLog` 在
 *   **多帧 / 空 / 损坏 / 帧内部魔数 / 非法帧头**上的行为对照（同输入必得同结果）；
 * - **帧内部含魔数的合法帧必须解出全部内容**（正确契约：旧实现在这里丢内容）；
 * - **非法帧头不得被读成空内容**（正确契约：`魔数 + 垃圾` 必须 `undefined`，
 *   而不是空串或半份内容）；
 * - 追加式日志的残尾（前面已有完整帧、后面是写到一半的字节）保留已解出的完整帧；
 * - view 边界：非零 `byteOffset` 的 `Uint8Array` 只解自己那一段，**底层 buffer 里的
 *   前缀与尾部垃圾不得被读进来**（整个 buffer 的读法必须与正确结果不同，测试才有意义）；
 * - 路径接口的读盘失败照旧**抛出**（不是静默 `undefined`）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import {
  SessionLogError,
  decodeSessionLog,
  decodeSessionLogBytes,
  decodeSessionLogBytesStrict,
  parseSessionLogStrict,
} from "./sessionLog";

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;
const frame = (text: string): Buffer => zlib.zstdCompressSync(Buffer.from(text, "utf8"));
/** 压缩**任意字节**（跨帧 UTF-8 用例要把多字节码点切开，不能先转成字符串）。 */
const frame2 = (bytes: Uint8Array): Buffer => zlib.zstdCompressSync(Buffer.from(bytes));
/** 观察用的结果描述（只给形态与长度，不回显内容）。 */
const describeDecoded = (value: string | undefined): string =>
  value === undefined ? "undefined" : `text(${value.length}B)`;

const work = mkdtempSync(join(tmpdir(), "session-log-decode-"));
try {
  /** 同一份字节：字节接口与路径接口必须逐字一致。 */
  const bothAgree = (label: string, bytes: Uint8Array, expected: string | undefined): void => {
    const file = join(work, `${label}.zstd`);
    writeFileSync(file, Buffer.from(bytes));
    assert.strictEqual(decodeSessionLogBytes(bytes), expected, `${label}：字节接口结果符合预期`);
    assert.strictEqual(decodeSessionLog(file), expected, `${label}：路径接口与字节接口一致`);
    assert.strictEqual(
      decodeSessionLog(file),
      decodeSessionLogBytes(readFileSync(file)),
      `${label}：路径接口 = 读盘 + 字节接口（薄壳）`,
    );
  };

  // ---------- 1. 单帧 ----------
  {
    const text = '{"type":"session/head","seq":0}\n';
    const bytes = frame(text);
    assert.strictEqual(zlib.zstdDecompressSync(bytes).toString("utf8"), text, "注入确认：帧本身可解");
    bothAgree("single", bytes, text);
  }

  // ---------- 2. 多帧（追加式日志） ----------
  {
    const parts = ['{"seq":0}\n', '{"seq":1}\n', '{"seq":2}\n'];
    const bytes = Buffer.concat(parts.map(frame));
    bothAgree("multi", bytes, parts.join(""));
  }

  // ---------- 3. 帧内部出现魔数：**合法帧不得丢内容** ----------
  {
    /**
     * 确定性构造：把魔数写进**可压但含字面量**的载荷里，zstd 会把它们原样放进块中。
     * 搜不到就明确失败（说明 zstd 产物变了，需要新的构造），而不是让这条断言静默失效。
     *
     * 这条是**正确契约**（不是对旧实现的描述）：帧内部含魔数的合法帧必须解出全部内容。
     * 旧实现在这里返回 `undefined`（切在帧内魔数处的截断前缀被当成完整空帧，于是走过真
     * 边界）——这就是本用例要求修复的行为，不需要外部日志佐证。
     */
    let sample: { bytes: Buffer; text: string; inner: number[] } | undefined;
    for (let seed = 1; seed <= 200 && sample === undefined; seed += 1) {
      const payload = Buffer.alloc(4096);
      let x = seed >>> 0;
      for (let i = 0; i < payload.length; i += 1) {
        x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
        payload[i] = x & 0xff;
      }
      payload.writeUInt32BE(0x28b52ffd, 1000);
      payload.writeUInt32BE(0x28b52ffd, 2000);
      for (const level of [1, 3]) {
        const candidate = zlib.zstdCompressSync(payload, {
          params: { [zlib.constants.ZSTD_c_compressionLevel]: level },
        });
        const inner: number[] = [];
        for (let i = 1; i + 4 <= candidate.length; i += 1) {
          if (candidate[i] === MAGIC[0] && candidate[i + 1] === MAGIC[1]
            && candidate[i + 2] === MAGIC[2] && candidate[i + 3] === MAGIC[3]) inner.push(i);
        }
        if (inner.length > 0) {
          sample = { bytes: candidate, text: payload.toString("utf8"), inner };
          break;
        }
      }
    }
    assert.ok(sample !== undefined, "构造不出「帧内部含魔数」的样本（zstd 产物变了，需要新的构造）");
    if (sample !== undefined) {
      // 注入确认：帧里确实还有非 0 偏移的魔数（否则只测了「单帧」那条路）
      assert.ok(sample.inner.length > 0, "注入确认：帧内部确实含魔数");
      assert.strictEqual(
        zlib.zstdDecompressSync(sample.bytes).toString("utf8"),
        sample.text,
        "注入确认：这份帧本身可解",
      );
      bothAgree("inner-magic", sample.bytes, sample.text);

      /**
       * 只切到第一个内部魔数的**截断**输入：两个接口必须一致。截断文件该不该被接受属于
       * 未关闭边界（要不要为它做帧头级完整性判断），这里只钉**两接口一致**，取值打印成观察。
       */
      const truncated = sample.bytes.subarray(0, sample.inner[0]);
      const viaBytes = decodeSessionLogBytes(truncated);
      const truncatedFile = join(work, "inner-magic-truncated.zstd");
      writeFileSync(truncatedFile, Buffer.from(truncated));
      assert.strictEqual(
        decodeSessionLog(truncatedFile),
        viaBytes,
        "截断帧：路径接口与字节接口一致（该值本身只作观察，不作为契约）",
      );
      console.log(`[观察] 截断帧（切在帧内魔数处）→ ${describeDecoded(viaBytes)}`);
    }
  }

  // ---------- 4. 空 / 损坏 / 起始不是帧 ----------
  {
    bothAgree("empty-bytes", Buffer.alloc(0), undefined);
    bothAgree("not-zstd", Buffer.from("这不是 zstd 帧，只是一段普通文本。\n", "utf8"), undefined);
    // 起始处不是帧（前面有垃圾）→ 与旧实现一致：undefined
    bothAgree("leading-garbage", Buffer.concat([Buffer.from("前缀"), frame('{"seq":0}\n')]), undefined);
  }

  // ---------- 4b. 非法帧头：垃圾不得被读成「空内容」 ----------
  {
    /**
     * Node 的 `zstdDecompressSync` 会把「魔数 + 几个垃圾字节」当成一个**完整的空帧**接受
     * （实测 `info: true` 下 `bytesWritten` 等于输入长度、buffer 为 0 字节）。只按「解出来了」
     * 判断就会把垃圾读成空内容。这里钉三条**正确契约**：非法帧头 → `undefined`。
     *
     * 判据来自 zstd 帧格式规范（RFC 8878 §3.1.1.1）：Reserved_bit 必须为 0；描述符声明的
     * 可选字段与至少一个块头都要放得下。
     */
    const invalidHeaders: [string, Buffer][] = [
      // 父级独立解码矩阵里的红样本：描述符 0xff 置了保留位
      ["reserved-bit", Buffer.concat([Buffer.from([...MAGIC]), Buffer.from([0xff, 0x00, 0x00])])],
      // 只有魔数、连描述符都没有
      ["magic-only", Buffer.from([...MAGIC])],
      // 魔数 + 普通垃圾（描述符位形说明帧头远超实际长度）
      ["magic-garbage", Buffer.concat([Buffer.from([...MAGIC]), Buffer.from("垃圾", "utf8")])],
      // 描述符声称有窗口描述符，但块头放不下
      ["no-block-left", Buffer.concat([Buffer.from([...MAGIC]), Buffer.from([0x00, 0x00])])],
    ];
    for (const [label, bytes] of invalidHeaders) {
      // 注入确认：Node 原生确实会把这些字节「解出来」（否则本用例没测到那条边界）
      const native = zlib.zstdDecompressSync(bytes, { info: true }) as unknown as {
        buffer?: Buffer;
        engine?: { bytesWritten?: number };
      };
      assert.strictEqual(
        native.engine?.bytesWritten,
        bytes.length,
        `${label}：注入确认 —— Node 原生把这段垃圾当成完整帧消费掉了`,
      );
      bothAgree(`invalid-header-${label}`, bytes, undefined);
    }

    /**
     * 追加式日志的**残尾**：前面已有完整帧、后面跟一段不构成合法帧的字节（常见于写到一半
     * 中断）。契约：保留已解出的完整帧（旧容忍行为不变），**不**把它当成内容的一部分。
     */
    const validText = '{"seq":0}\n';
    for (const [label, tail] of [
      ["garbage-tail", Buffer.from("垃圾", "utf8")],
      ["reserved-bit-tail", Buffer.from([0xff, 0x00, 0x00])],
    ] as const) {
      const bytes = Buffer.concat([frame(validText), Buffer.from([...MAGIC]), tail]);
      bothAgree(`partial-append-${label}`, bytes, validText);
    }
  }

  // ---------- 5. 尾部垃圾（连魔数都没有）：保留已解出的完整帧 ----------
  {
    const text = '{"seq":"tail"}\n';
    const withGarbage = Buffer.concat([frame(text), Buffer.from("半行没写完的尾部", "utf8")]);
    bothAgree("trailing-garbage", withGarbage, text);
  }

  // ---------- 6. view 边界：非零 byteOffset + 尾部不属于 view ----------
  {
    const first = frame('{"seq":"first"}\n');
    const second = frame('{"seq":"second"}\n');
    const prefix = Buffer.from("view 之外的头部垃圾", "utf8");
    const tail = Buffer.from("view 之外的尾部垃圾", "utf8");
    const backing = new ArrayBuffer(prefix.length + first.length + second.length + tail.length);
    const all = new Uint8Array(backing);
    all.set(prefix, 0);
    all.set(first, prefix.length);
    all.set(second, prefix.length + first.length);
    all.set(tail, prefix.length + first.length + second.length);

    // 只含第一帧的 view：byteOffset 非 0、byteLength 不含后面的第二帧与尾部垃圾
    const view = new Uint8Array(backing, prefix.length, first.length);
    assert.notStrictEqual(view.byteOffset, 0, "注入确认：view 的 byteOffset 非 0");
    assert.ok(view.byteLength < all.byteLength, "注入确认：view 之外还有别的内容");
    const expected = '{"seq":"first"}\n';
    assert.strictEqual(decodeSessionLogBytes(view), expected, "只解 view 自己那一段");

    // 两种「拿底层 buffer 整个读」的错法都必须给出**不同**结果，否则这条断言抓不到它
    const wholeBuffer = new Uint8Array(backing);
    assert.notStrictEqual(decodeSessionLogBytes(wholeBuffer), expected, "整个 buffer 的读法必须被抓住（前缀垃圾）");
    const ignoreLength = new Uint8Array(backing, prefix.length);
    assert.notStrictEqual(decodeSessionLogBytes(ignoreLength), expected, "忽略 byteLength 的读法必须被抓住（多出第二帧）");
    assert.strictEqual(
      decodeSessionLogBytes(ignoreLength),
      `${expected}{"seq":"second"}\n`,
      "对照：忽略 byteLength 时确实会把 view 之外的帧一起解出来",
    );
  }

  // ---------- 7. 路径接口的读盘失败照旧抛出 ----------
  {
    const missing = join(work, "does-not-exist.zstd");
    assert.throws(() => decodeSessionLog(missing), "路径接口对不可读文件必须抛出（不静默 undefined）");
  }

  // ---------- 8. 严格入口：整份输入必须由完整合法帧构成 ----------
  {
    /**
     * 严格入口 `decodeSessionLogBytesStrict` 与宽容默认**并存**：这里钉的是「不完整输入
     * 一律拒绝、完整输入一个字节都不许丢」，宽容那条路的行为由上面 1–7 节照旧钉住。
     *
     * 判据不靠旧算术：`rawFrame` 用**原生压缩器见证过的**描述符口径手搭帧
     * （`fcsFlag` 0/1/2/3 → 1/2/4/8 字节、2 字节值是「内容大小 − 256」、`dictId` 宽度
     * 0/1/2/4、块头 3 字节 LE），再用原生 `zstdDecompressSync` 确认这份构造本身合法
     * （注入确认），最后才断言严格入口的裁决。
     */
    const u24 = (value: number): Buffer => Buffer.from([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff]);
    /** 块头：`Last_Block` bit0、`Block_Type` bit1–2、`Block_Size` bit3–23（3 字节 LE）。 */
    const blockHeader = (size: number, last: boolean, type: 0 | 1 | 2 | 3): Buffer =>
      u24((size << 3) | (type << 1) | (last ? 1 : 0));

    /** 手搭一帧。`fcsSize` 是**描述符声明**的宽度；`2` 时写「内容 − 256」。 */
    const rawFrame = (
      content: Buffer,
      fcsSize: 0 | 1 | 2 | 4 | 8,
      options: { window?: boolean; dictSize?: 0 | 1 | 2 | 4; blockType?: 0 | 1 | 3; checksum?: boolean } = {},
    ): Buffer => {
      const flag = ({ 0: 0, 1: 0, 2: 1, 4: 2, 8: 3 } as const)[fcsSize];
      const fields: Buffer[] = [];
      if (options.window === true) fields.push(Buffer.from([0x08]));
      if (options.dictSize !== undefined && options.dictSize > 0) fields.push(Buffer.alloc(options.dictSize));
      if (fcsSize > 0) {
        const fcs = Buffer.alloc(fcsSize);
        if (fcsSize === 8) fcs.writeBigUInt64LE(BigInt(content.length));
        else fcs.writeUIntLE(content.length - (fcsSize === 2 ? 256 : 0), 0, fcsSize);
        fields.push(fcs);
      }
      const dictFlag = options.dictSize === undefined ? 0 : ({ 0: 0, 1: 1, 2: 2, 4: 3 } as const)[options.dictSize];
      const blockType = options.blockType ?? 0;
      // `Block_Size` 是**块内有效载荷**的字节数（raw = 内容长度；RLE = 1）
      const payload = blockType === 1 ? Buffer.from([content[0] ?? 0]) : content;
      return Buffer.concat([
        Buffer.from([...MAGIC]),
        Buffer.from([(flag << 6) | (options.window === true ? 0 : 0x20) | dictFlag | (options.checksum === true ? 0x04 : 0)]),
        ...fields,
        blockHeader(payload.length, true, blockType),
        payload,
        options.checksum === true ? Buffer.alloc(4) : Buffer.alloc(0),
      ]);
    };

    /** 严格入口 + 行解析的结果（只给形态与错误码，不回显文本）。 */
    const strictOf = (bytes: Uint8Array): { text: string } | { code: string; detail: number } => {
      try {
        return { text: decodeSessionLogBytesStrict(bytes) };
      } catch (error) {
        assert.ok(error instanceof SessionLogError, "严格入口只抛 SessionLogError");
        return { code: error.code, detail: error.detail };
      }
    };
    const parses = (text: string): { ok: true } | { ok: false; code: string; detail: number } => {
      try {
        parseSessionLogStrict(text);
        return { ok: true };
      } catch (error) {
        assert.ok(error instanceof SessionLogError, "严格行解析只抛 SessionLogError");
        return { ok: false, code: error.code, detail: error.detail };
      }
    };

    const lineA = '{"type":"turn/start","seq":1,"time":1000,"data":{"turn":1}}\n';
    const lineB = '{"type":"turn/end","seq":2,"time":2000,"data":{"turn":1,"reason":{"kind":"completed"}}}\n';
    const text2 = lineA + lineB;
    const f1 = frame(lineA);
    const f2 = frame(lineB);

    // 8a. 完整单帧 / 多帧 / 空帧：必须全部解出，且与宽容入口逐字一致
    for (const [label, bytes] of [
      ["strict-single", f1],
      ["strict-multi", Buffer.concat([f1, f2])],
      ["strict-empty-frame", Buffer.concat([f1, frame("")])],
    ] as const) {
      const result = strictOf(bytes);
      assert.ok("text" in result, `${label}：完整输入必须通过严格入口`);
      assert.strictEqual(result.text, decodeSessionLogBytes(bytes), `${label}：严格通过时必须与宽容结果逐字一致`);
    }
    // 空帧不贡献文本，但它本身是完整帧：不得因此判失败
    assert.strictEqual((strictOf(Buffer.concat([f1, frame("")])) as { text: string }).text, lineA, "完整空帧不得改变解出的文本");
    // 零字节输入：严格口径下不是「合法的空日志」
    assert.deepStrictEqual(strictOf(Buffer.alloc(0)), { code: "emptyInput", detail: 0 }, "空输入必须被拒");

    // 8b. 不完整 / 垃圾 / 半帧：严格入口与宽容入口的**分歧**（宽容保留前缀、严格拒绝）
    const decorations: [string, Buffer][] = [
      ["garbage-tail", Buffer.concat([f1, Buffer.from("unfinished", "utf8")])],
      ["magic-tail", Buffer.concat([f1, Buffer.from([...MAGIC])])],
      ["bad-header-tail", Buffer.concat([f1, Buffer.from([...MAGIC]), Buffer.from([0xff, 0x00, 0x00])])],
      ["truncated-empty-frame", Buffer.concat([f1, frame("")]).subarray(0, f1.length + 5)],
      ["reserved-block-type", rawFrame(Buffer.from("x"), 1, { blockType: 3 })],
      ["missing-checksum", rawFrame(Buffer.from("x"), 1, { checksum: true }).subarray(0, 9)],
      ["truncated-raw-block", rawFrame(Buffer.from("payload"), 1).subarray(0, 10)],
      // 合法的非最后一块（Last_Block=0）后面直接 EOF：帧没走完，必须整体拒绝
      [
        "open-non-last-block",
        Buffer.concat([
          f1,
          Buffer.from([...MAGIC]),
          Buffer.from([0x20, 0x04]),
          blockHeader(4, false, 0),
          Buffer.from("body", "utf8"),
        ]),
      ],
      ["not-zstd", Buffer.from("这不是 zstd 帧", "utf8")],
    ];
    for (const [label, bytes] of decorations) {
      const result = strictOf(bytes);
      assert.ok(!("text" in result), `${label}：不完整输入必须被严格入口拒绝`);
      // 拒在哪一层（帧头 / 块结构 / 原生引擎 / 字节消耗）不是契约；「必须拒」才是
      assert.ok(
        ["frameHeader", "block", "engine", "frameConsumed"].includes(result.code),
        `${label}：错误码必须落在帧级范围内（实际 ${result.code}）`,
      );
    }

    // 8c. 完整性「整份输入」判据：前缀完整但整体不是帧序列 → 拒绝
    {
      const prefixOnly = Buffer.concat([f1, f2.subarray(0, f2.length - 2)]);
      assert.ok(!("text" in strictOf(prefixOnly)), "末尾半帧必须整体拒绝（不能只留完整前缀）");
      const withTrailingMagic = Buffer.concat([f1, f2, Buffer.from([...MAGIC])]);
      assert.ok(!("text" in strictOf(withTrailingMagic)), "完整帧之后又跟一个裸魔数必须拒绝");
    }

    // 8d. 原生证据：错误校验和 / 坏数据由引擎判定（不是结构自证）
    {
      const sum = zlib.zstdCompressSync(Buffer.from(lineA, "utf8"), {
        params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
      });
      assert.strictEqual(zlib.zstdDecompressSync(sum).toString("utf8"), lineA, "注入确认：带校验和的帧本身可解");
      const damaged = Buffer.from(sum);
      damaged[damaged.length - 1] ^= 0x80;
      const result = strictOf(damaged);
      assert.deepStrictEqual(result, { code: "engine", detail: 0 }, "错误校验和必须由原生引擎拒掉");
      assert.strictEqual(decodeSessionLogBytes(damaged), undefined, "宽容入口同样解不出错误校验和（既有行为）");
    }

    // 8e. 帧头字段口径：FCS 宽度 1/2/4/8、窗口描述符、dictId 0 三宽 —— 都必须是完整合法帧
    {
      const rows = [lineA, lineB, `{"type":"noise","seq":3,"time":3000,"data":{"pad":"${"填".repeat(400)}"}}\n`];
      const longText = rows.join("");
      const longBytes = Buffer.from(longText, "utf8");
      const variants: [string, Buffer][] = [
        ["fcs-1", rawFrame(Buffer.from(lineA, "utf8"), 1)],
        ["fcs-2", rawFrame(longBytes, 2)],
        ["fcs-4", rawFrame(longBytes, 4)],
        ["fcs-8", rawFrame(longBytes, 8)],
        ["window-no-fcs", rawFrame(longBytes, 0, { window: true })],
        ["dict-id-1", rawFrame(longBytes, 4, { dictSize: 1 })],
        ["dict-id-2", rawFrame(longBytes, 4, { dictSize: 2 })],
        ["dict-id-4", rawFrame(longBytes, 4, { dictSize: 4 })],
      ];
      for (const [label, bytes] of variants) {
        // 注入确认：这份手搭帧是**真能原生解出来**的（否则下面的通过没有意义）
        assert.strictEqual(zlib.zstdDecompressSync(bytes).toString("utf8"), label === "fcs-1" ? lineA : longText, `${label}：构造本身必须原生可解`);
        const result = strictOf(bytes);
        assert.ok("text" in result, `${label}：完整合法帧必须通过严格入口`);
      }
    }

    // 8f. 跨帧 UTF-8 与跨帧 JSONL：拼接全部字节后再判，合法跨帧必须通过
    {
      const multiByte = Buffer.from(`{"type":"x","seq":1,"time":1,"data":{"text":"🧭"}}\n`, "utf8");
      const cut = multiByte.indexOf(Buffer.from("🧭")) + 2; // 切在多字节码点中间
      assert.ok(cut > 1 && cut < multiByte.length, "注入确认：切点在多字节码点内部");
      const split = Buffer.concat([frame2(multiByte.subarray(0, cut)), frame2(multiByte.subarray(cut))]);
      const result = strictOf(split);
      assert.ok("text" in result, "合法跨帧多字节码点必须通过");
      assert.strictEqual(result.text, multiByte.toString("utf8"), "跨帧拼接结果与整份文本逐字一致");
      // 非法 UTF-8（0xff 不是任何 UTF-8 序列的首字节）→ 固定 utf8 码
      const corrupt = Buffer.concat([multiByte.subarray(0, cut - 2), Buffer.from([0xff]), multiByte.subarray(cut + 2)]);
      assert.deepStrictEqual(strictOf(frame2(corrupt)), { code: "utf8", detail: 0 }, "非法 UTF-8 必须被拒");
    }

    // 8f-2. **字面 U+FFFD 是合法 UTF-8**：不得与「解码器替换非法字节得到的 U+FFFD」混为一谈
    {
      /**
       * 判据必须是「对拼接后的**字节**做 fatal 解码」，不能是「解出的字符串里有没有 U+FFFD」：
       * 后者会把源里本来就合法的 U+FFFD（`EF BF BD`）一起误拒。三条对照把两种情形分开：
       * 字面 U+FFFD（单帧 / 跨帧切在码点内部）必须通过；真正的非法字节（`0xFF`）必须拒。
       */
      const literalText = `{"type":"x","seq":1,"time":1,"data":{"text":"合法字面 \uFFFD 仍是有效 Unicode"}}\n`;
      const literalBytes = Buffer.from(literalText, "utf8");
      const at = literalBytes.indexOf(Buffer.from("\uFFFD"));
      assert.ok(at > 0, "注入确认：样本里确实有字面 U+FFFD");
      assert.strictEqual(literalBytes.subarray(at, at + 3).toString("hex"), "efbfbd", "注入确认：字面 U+FFFD 的 UTF-8 就是 EF BF BD");
      const literalSingle = strictOf(frame2(literalBytes));
      assert.ok("text" in literalSingle, "字面 U+FFFD 是合法 UTF-8，必须通过");
      assert.strictEqual(literalSingle.text, literalText, "字面 U+FFFD 必须原样保留");
      // 跨帧：把 U+FFFD 的 3 字节码点切成 1+2 两帧
      const crossFrame = Buffer.concat([
        frame2(literalBytes.subarray(0, at + 1)),
        frame2(literalBytes.subarray(at + 1)),
      ]);
      const literalCross = strictOf(crossFrame);
      assert.ok("text" in literalCross, "跨帧切开的字面 U+FFFD 必须通过");
      assert.strictEqual(literalCross.text, literalText, "跨帧拼回的字面 U+FFFD 逐字一致");
      // 对照：真正的非法字节仍然拒（同一位置上换成 0xFF）
      const broken = Buffer.concat([literalBytes.subarray(0, at), Buffer.from([0xff]), literalBytes.subarray(at + 3)]);
      assert.deepStrictEqual(strictOf(frame2(broken)), { code: "utf8", detail: 0 }, "非法字节必须被拒（不因字面 U+FFFD 合法而放过）");
    }

    // 8g. 严格行解析：坏 JSON / null / 数组 / 标量统一拒绝；非 durable 对象允许；末行无换行合法
    {
      assert.deepStrictEqual(parses(text2), { ok: true }, "完整对象行必须通过");
      assert.deepStrictEqual(parses(text2.trimEnd()), { ok: true }, "最后一行无换行本身合法");
      assert.deepStrictEqual(parses(`${text2}null\n`), { ok: false, code: "jsonLine", detail: 3 }, "null 行必须给行号");
      assert.deepStrictEqual(parses(`${text2}[]\n`), { ok: false, code: "jsonLine", detail: 3 }, "数组行必须给行号");
      assert.deepStrictEqual(parses(`${text2}7\n`), { ok: false, code: "jsonLine", detail: 3 }, "标量行必须给行号");
      assert.deepStrictEqual(parses(`${lineA}{"broken":\n`), { ok: false, code: "jsonLine", detail: 2 }, "坏 JSON 必须给行号");
      assert.deepStrictEqual(parses(`${lineA}\n${lineB}`), { ok: true }, "中间空行跳过，不影响合法行");
      const parsed = parseSessionLogStrict(`${lineA}${JSON.stringify({ type: "metadata", data: { text: "非 durable" } })}\n`);
      assert.strictEqual(parsed.events.length, 1, "非 durable 元数据对象允许，但不进事件表");
      assert.strictEqual(parsed.counts["metadata"], 1, "非 durable 对象照旧计数");
      assert.strictEqual(parsed.counts["turn/start"], 1, "durable 事件计数正确");
      // 事件 type 不可信：`__proto__` 不得改原型（计数用无原型对象）
      const polluted = parseSessionLogStrict('{"__proto__":{"polluted":true}}\n');
      assert.strictEqual((Object.getPrototypeOf(polluted.counts) as unknown), null, "计数表必须无原型");
      assert.strictEqual(({} as { polluted?: boolean }).polluted, undefined, "不得污染 Object.prototype");
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("sessionLog: 字节/路径接口解码断言全部通过（含严格入口）");

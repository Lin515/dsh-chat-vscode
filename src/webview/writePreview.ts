/** write 参数的只读文本投影；不补 JSON、不读盘、不改变原始参数。
 * 累计快照可重放/替换，追加时只扫描新增字符；前缀验证和消费者整段文本渲染仍为 O(n)/帧。
 */
export interface WritePreview {
  text: string;
  /** 整份参数是完整 JSON，而非文件已经写入。 */
  complete: boolean;
}

type Frame = { kind: "object" | "array"; phase: "keyOrEnd" | "key" | "colon" | "value" | "valueOrEnd" | "commaOrEnd"; key?: string };
type StringToken = { kind: "string"; key: boolean; content: boolean; text: string; escape: boolean; unicode?: string; high: string };
type ScalarToken = { kind: "scalar"; text: string };
const escapes: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const whitespace = (c: string) => c === " " || c === "\t" || c === "\r" || c === "\n";

/** 一个工具行一份缓存；身份、工具名或非追加参数变化自动清空，不在全局留账本。 */
export class WritePreviewReader {
  private identity = "";
  private name = "";
  private input = "";
  private stack: Frame[] = [];
  private token?: StringToken | ScalarToken;
  private started = false;
  private done = false;
  private invalid = false;
  private seenContent = false;
  private found = false;
  private text = "";

  update(identity: string, name: string, input = ""): WritePreview | undefined {
    if (this.identity !== identity || this.name !== name || !input.startsWith(this.input)) {
      this.identity = identity;
      this.name = name;
      this.input = "";
      this.stack = [];
      this.token = undefined;
      this.started = this.done = this.invalid = this.seenContent = this.found = false;
      this.text = "";
    }
    if (name !== "write") {
      this.input = input;
      return undefined;
    }
    for (let i = this.input.length; i < input.length && !this.invalid; i++) this.consume(input[i]);
    this.input = input;
    return this.found && !this.invalid ? { text: this.text, complete: this.done } : undefined;
  }

  private valueStarted(): void {
    const frame = this.stack.at(-1);
    if (!frame || (frame.phase !== "value" && frame.phase !== "valueOrEnd")) {
      this.invalid = true;
    } else frame.phase = "commaOrEnd";
  }

  private decoded(token: StringToken, c: string): void {
    if (!token.key && !token.content) return;
    // 暂扣尚不确定是否组成代理对的高代理，避免 chunk 边界出现替换字符闪烁。
    const unit = c.charCodeAt(0);
    let part = token.high;
    token.high = "";
    if (unit >= 0xd800 && unit <= 0xdbff) token.high = c;
    else part += c;
    if (token.key) token.text += part;
    if (token.content) this.text += part;
  }

  private consume(c: string): void {
    const token = this.token;
    if (token?.kind === "string") {
      if (token.unicode !== undefined) {
        if (!/^[0-9a-fA-F]$/.test(c)) { this.invalid = true; return; }
        token.unicode += c;
        if (token.unicode.length === 4) {
          this.decoded(token, String.fromCharCode(parseInt(token.unicode, 16)));
          token.unicode = undefined;
        }
      } else if (token.escape) {
        token.escape = false;
        if (c === "u") token.unicode = "";
        else if (Object.hasOwn(escapes, c)) this.decoded(token, escapes[c]);
        else this.invalid = true;
      } else if (c === "\\") token.escape = true;
      else if (c === '"') {
        if (token.content) this.text += token.high;
        if (token.key) {
          const frame = this.stack.at(-1)!;
          frame.key = token.text + token.high;
          frame.phase = "colon";
          if (this.stack.length === 1 && frame.key === "content") {
            if (this.seenContent) this.invalid = true;
            this.seenContent = true;
          }
        }
        this.token = undefined;
      } else if (c.charCodeAt(0) < 0x20) this.invalid = true;
      else this.decoded(token, c);
      return;
    }
    if (token?.kind === "scalar") {
      if (whitespace(c) || c === "," || c === "]" || c === "}") {
        if (!/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/.test(token.text)) {
          this.invalid = true;
          return;
        }
        this.token = undefined;
        this.consume(c);
      } else token.text += c;
      return;
    }
    if (whitespace(c)) return;
    if (this.done) { this.invalid = true; return; }
    if (!this.started) {
      this.started = true;
      if (c !== "{") { this.invalid = true; return; }
      this.stack.push({ kind: "object", phase: "keyOrEnd" });
      return;
    }
    const frame = this.stack.at(-1)!;
    if (c === '"') {
      const key = frame.kind === "object" && (frame.phase === "keyOrEnd" || frame.phase === "key");
      const content = !key && this.stack.length === 1 && frame.key === "content" && frame.phase === "value";
      if (!key) this.valueStarted();
      if (content && !this.invalid) this.found = true;
      this.token = { kind: "string", key, content, text: "", escape: false, high: "" };
    } else if (c === ":" && frame.kind === "object" && frame.phase === "colon") frame.phase = "value";
    else if (c === "," && frame.phase === "commaOrEnd") frame.phase = frame.kind === "object" ? "key" : "value";
    else if ((c === "}" && frame.kind === "object" && (frame.phase === "keyOrEnd" || frame.phase === "commaOrEnd")) ||
      (c === "]" && frame.kind === "array" && (frame.phase === "valueOrEnd" || frame.phase === "commaOrEnd"))) {
      this.stack.pop();
      this.done = this.stack.length === 0;
    } else if (c === "{" || c === "[") {
      this.valueStarted();
      // 异常深的参数安全降级成原始参数，避免不可信输入无限增加语法栈。
      if (this.stack.length >= 128) this.invalid = true;
      else this.stack.push({ kind: c === "{" ? "object" : "array", phase: c === "{" ? "keyOrEnd" : "valueOrEnd" });
    } else if (c === "-" || /^[0-9tfn]$/.test(c)) {
      this.valueStarted();
      this.token = { kind: "scalar", text: c };
    } else this.invalid = true;
  }
}

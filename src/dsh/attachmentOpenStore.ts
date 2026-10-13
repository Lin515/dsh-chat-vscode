/**
 * 「附件内容身份 → 本地那个文件」的**持久化口径**（`ExtensionContext.globalState`）。
 *
 * 概念与解析链在 `dsh/attachmentOpen.ts` 与 `controller.openAttachment`，这里只管
 * 「存哪儿、怎么存」。
 *
 * ## 为什么必须落盘
 *
 * 这条对应关系说的是「同一份内容，用户磁盘上那个原件在哪」。而 durable 消息里**只有内容
 * 摘要**（`FileAttachmentRef` 只有 `attachmentId / name / bytes`，见 `docs/dsh-server-api.md`
 * 的「附件引用」），图片还能拿句柄回服务端换字节，**文件没有那条路**。所以只活在内存里
 * 的后果就是：重开 VS Code（重载窗口、装完扩展、宿主崩溃重启）之后，历史消息里的文件
 * 附件点开只剩一句「没有可打开的本地内容」——而用户的文件明明还在原处。
 *
 * ## 一条附件一把键，不写整份集合
 *
 * Memento 是**整份写**，且不跨窗口实时同步（同 `unreadStore.ts` 的取舍）：把整张表塞进
 * 一把键，另一个窗口的写入就会把这边的整份表覆盖掉。一条一把键时，窗口只写自己刚记的
 * 那一条，最坏的后果是「另一枚附件的记录旧了一点」，而不是整张表消失。
 *
 * ## 原文件与临时副本分开记
 *
 * 两条通道的落点性质不同：路径通道记的是**用户自己那个文件**，字节通道（拖放 / 粘贴）
 * 记的是本扩展落的**临时副本**（见 `attachmentOpen.ts`）。两者都能用来打开（`copy` 也是
 * 一份真实文件），但只有原文件那条能当「文件路径」展示给用户——把临时目录里的副本路径
 * 当原文件显示，只会让人以为自己的文件跑到系统临时目录里去了。
 *
 * ## 淘汰按写入时间，条数上限与内存索引同量级
 *
 * Memento 不给插入顺序，只能 `keys()` 扫前缀，所以值里带写入时刻，越界时丢最旧的那些。
 * 丢一条的后果只是「这枚文件附件要重新上传才会再记得路径」，不丢用户数据，也不影响
 * 临时副本本身（副本在磁盘上，路径由内容摘要决定，删索引不删文件）。
 *
 * 模块刻意**不 import vscode**：口径要能在 `npm test` 里直接跑，`vscode.Memento` 结构上
 * 满足这里的 `AttachmentTargetStorage`。
 */

/** 一条附件的键前缀；后缀就是 durable 内容身份（`sha256:…`）。 */
export const ATTACHMENT_TARGET_KEY_PREFIX = "attachmentTarget:";

/** 条数上限：与 `AttachmentOpenIndex` 的默认上限同值，两边的取舍一样（见文件头）。 */
export const ATTACHMENT_TARGET_LIMIT = 256;

/** 只用到这三个方法，`vscode.Memento` 结构上满足。 */
export interface AttachmentTargetStorage {
  keys(): readonly string[];
  get<T>(key: string, fallback?: T): T | undefined;
  update(key: string, value: unknown): unknown;
}

/** 一条记录：本地那个文件在哪，以及它是不是**本扩展落的临时副本**。 */
export interface AttachmentTarget {
  path: string;
  /** 真 = 我们自己落的副本（拖放 / 粘贴的字节），不是用户磁盘上那个原文件。 */
  copy: boolean;
}

const keyOf = (id: string): string => `${ATTACHMENT_TARGET_KEY_PREFIX}${id}`;

/** 落盘形状：`copy` 只在为真时写出去（旧记录没有这个字段 = 原文件，见下）。 */
interface StoredEntry {
  path: string;
  copy: boolean;
  at: number;
}

/**
 * 只认形状完整的那一条：路径必须是非空字符串。
 *
 * `copy` 缺省按**原文件**算：这条记录里最要紧的是「能不能打开」，而展示层只需要多一层
 * 「是不是原文件」的判据——旧版本 / 别处写下的记录按原文件解释，最坏是悬停多显示一个
 * 临时目录路径，比丢掉一条本来能打开的原文件记录轻。
 */
function readEntry(value: unknown): StoredEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { path?: unknown; copy?: unknown; at?: unknown };
  if (typeof record.path !== "string" || !record.path) return undefined;
  return {
    path: record.path,
    copy: record.copy === true,
    at: typeof record.at === "number" ? record.at : 0,
  };
}

/** 扫出全部记录，按写入时刻从旧到新。 */
function collect(storage: AttachmentTargetStorage): { id: string; entry: StoredEntry }[] {
  const entries: { id: string; entry: StoredEntry }[] = [];
  for (const key of storage.keys()) {
    if (!key.startsWith(ATTACHMENT_TARGET_KEY_PREFIX)) continue;
    const id = key.slice(ATTACHMENT_TARGET_KEY_PREFIX.length);
    if (!id) continue;
    const entry = readEntry(storage.get<unknown>(key));
    if (!entry) continue;
    entries.push({ id, entry });
  }
  return entries.sort((a, b) => a.entry.at - b.entry.at);
}

/**
 * 读一条：这条内容身份以前是在哪个文件上打开的。
 *
 * 打开时**仍然要确认文件还在**（`controller.tryOpenAttachmentPath` 会 stat）：这里只负责
 * 「还记得这个路径」，不保证它还指得到东西——用户可能把原文件删了、移了，那是另一回事。
 */
export function readAttachmentTarget(
  storage: AttachmentTargetStorage,
  id: string,
): AttachmentTarget | undefined {
  if (!id) return undefined;
  const entry = readEntry(storage.get<unknown>(keyOf(id)));
  return entry ? { path: entry.path, copy: entry.copy } : undefined;
}

/**
 * 读一条**原文件**路径（临时副本不算）。
 *
 * 界面上的用途只有一处：附件芯片的悬停提示显示「这个文件在哪」。单击打开用的是
 * `readAttachmentTarget`——副本也能打开，展示却不该把它当成用户的文件。
 */
export function readOriginalTarget(storage: AttachmentTargetStorage, id: string): string | undefined {
  const target = readAttachmentTarget(storage, id);
  return target && !target.copy ? target.path : undefined;
}

/**
 * 记一条（同一身份重复记就是覆盖：后一次打开见到的那个文件更可信）。
 *
 * 写完顺手淘汰到上限之内——这是唯一的清理路径，不在别处扫表。
 */
export function writeAttachmentTarget(
  storage: AttachmentTargetStorage,
  id: string,
  target: AttachmentTarget,
  at: number = Date.now(),
): void {
  if (!id || !target.path) return;
  void storage.update(keyOf(id), { path: target.path, copy: target.copy, at } satisfies StoredEntry);
  const entries = collect(storage);
  if (entries.length <= ATTACHMENT_TARGET_LIMIT) return;
  for (const { id: stale } of entries.slice(0, entries.length - ATTACHMENT_TARGET_LIMIT)) {
    void storage.update(keyOf(stale), undefined);
  }
}

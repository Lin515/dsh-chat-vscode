/**
 * 「生成完毕未读」的**持久化口径**（`ExtensionContext.globalState`）。
 *
 * 概念与判据在 `controller` 里（离开标记 → 收尾兑现），这里只管「存哪儿、怎么存」。
 *
 * ## 一个会话一把键，不写整份集合
 *
 * 早期把整份 id 数组塞进**一把键**（`unreadSessionIds`）。那在单窗口下没问题，多窗口下
 * 必然出事：窗口各自保留一份内存副本，而 Memento 是**整份写**，且 VS Code **不跨窗口
 * 实时同步**。于是 A 窗口把某条会话读掉（写回不含它的数组）、B 窗口之后因为别的会话
 * 变化又把**自己那份含它的数组**写回去——清掉的蓝标题就此复活（用户报的「残留」）。
 *
 * 改成一个会话一把键（`unread:<会话 id>`，值 `true`）之后，窗口**只会写它自己刚改过的
 * 那一条**，不会替别的会话表态，整份覆写这条通道也就没有了。读全量靠 `keys()` 扫前缀
 * （条目数 = 未读会话数，很小）。
 *
 * ## 清掉 = 删键
 *
 * Memento 是 JSON 过的：值为 `undefined` 的键会被整条丢掉（见 `windowState.ts` 的同款
 * 说明），所以 `update(key, undefined)` 就是删除。读的时候仍按「值必须是 `true`」判，
 * 免得上一次写盘没把键摘干净时凭空多出一条未读。
 *
 * ## 旧集合一次性作废
 *
 * 2026-09-24 改过一次判据（`5d43b4f`：由「观察到某条会话从运行中落到结束、且没人在看」
 * 改成「离开时它正在生成」）。旧规则会把**别处跑起来、本窗口从没打开过**的会话也点亮，
 * 所以旧集合里每一条都无法用新规则解释——留着就是一条永远清不掉的蓝标题（只有把那条
 * 会话亲手打开一次才会清）。因此启动时把旧键整份丢掉：宁可少亮一次，也不留假蓝。
 *
 * 模块刻意**不 import vscode**：口径要能在 `npm test` 里直接跑，`vscode.Memento`
 * 结构上满足这里的 `UnreadStorage`。
 */

/** 一条未读会话的键前缀；后缀就是会话 id。 */
export const UNREAD_KEY_PREFIX = "unread:";

/**
 * 旧口径的键：整份 id 数组。只用于启动时清理，任何写入都不再碰它。
 * 名字保留成字面量——它描述的是**当年写下的那个键**，不能跟着常量重命名。
 */
export const LEGACY_UNREAD_KEY = "unreadSessionIds";

/** 只用到这三个方法，`vscode.Memento` 结构上满足。 */
export interface UnreadStorage {
  keys(): readonly string[];
  get<T>(key: string, fallback?: T): T | undefined;
  update(key: string, value: unknown): unknown;
}

/** 键与值两处都必须是「未读」才算数（见文件头的「清掉 = 删键」）。 */
const keyOf = (sessionId: string): string => `${UNREAD_KEY_PREFIX}${sessionId}`;

/** 读全量：扫出所有 `unread:` 键，返回其中的会话 id 集合。 */
export function loadUnreadSessionIds(storage: UnreadStorage): Set<string> {
  const ids = new Set<string>();
  for (const key of storage.keys()) {
    if (!key.startsWith(UNREAD_KEY_PREFIX)) continue;
    const sessionId = key.slice(UNREAD_KEY_PREFIX.length);
    if (!sessionId) continue;
    if (storage.get(key) !== true) continue;
    ids.add(sessionId);
  }
  return ids;
}

/**
 * 丢掉旧口径的整份集合（见文件头）。只在启动时调一次；旧键不存在时什么都不做。
 */
export function dropLegacyUnreadState(storage: UnreadStorage): void {
  if (!storage.keys().includes(LEGACY_UNREAD_KEY)) return;
  void storage.update(LEGACY_UNREAD_KEY, undefined);
}

/** 记 / 清一条未读：只动这一个会话的键（清 = 写 `undefined`）。 */
export function writeUnreadSession(
  storage: UnreadStorage,
  sessionId: string,
  unread: boolean,
): void {
  void storage.update(keyOf(sessionId), unread ? true : undefined);
}

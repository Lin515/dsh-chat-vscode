/**
 * `session/follow` 请求体的离线断言（零网络、零 token）。
 *
 * 为什么要单独钉：0.2.2-alpha.2 把 follow 改成**默认只读**——不传 `activate` 就不会再
 * 把准备好的会话恢复成活 Agent，而这件事在界面上没有任何报错，只表现成「打开的会话停在
 * 只读历史、后台不恢复」。旧服务端（≤ 0.2.1-rc.3）没有这个字段，网关对 `request` 内的
 * 未知字段是剥离，所以同一个请求体两代通用；这里同时钉住「不能为了兼容旧版而删掉它」。
 *
 * 另外两项是长期口径：`assistantStream` 必须是字面量 `true`（写 `false` 会被整条拒绝），
 * 跟随窗口固定 60 条（翻历史走 `session/page`）。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { sessionFollowRequest } from "../src/dsh/client";

const session = sessionFollowRequest({ kind: "session", sessionId: "session-1" });
assert.deepStrictEqual(session, {
  address: { kind: "session", sessionId: "session-1" },
  activate: true,
  maxMessages: 60,
  assistantStream: true,
}, "普通会话的 follow 请求体：地址 + 显式激活 + 跟随窗口 + 逐 token 开关");
assert.strictEqual(session.activate, true, "0.2.2-alpha.2 起必须显式请求激活（旧服务端会剥离这个字段）");

const child = sessionFollowRequest({
  kind: "subagent",
  parentSessionId: "parent-1",
  childSessionId: "child-1",
  mode: "one-shot",
});
assert.deepStrictEqual(child, {
  address: {
    kind: "subagent",
    parentSessionId: "parent-1",
    childSessionId: "child-1",
    mode: "one-shot",
  },
  activate: true,
  maxMessages: 60,
  assistantStream: true,
}, "子代理地址原样透传（mode 是宿主鉴权的一部分），激活字段照发、由服务端忽略");

console.log("session-follow: 请求体带显式激活、跟随窗口与逐 token 开关 ✓");

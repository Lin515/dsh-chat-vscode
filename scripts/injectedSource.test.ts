/**
 * 上下文注入条目的 `source` 解析（官方 `ContextBody` 的按 form 分派）。
 *
 * 钉的是**形状判据**：官方每个谓词都是「全有或全无」——任一条目缺字段就返回 null，
 * 整条退回不透明呈现（正文 + 原样字段）。半截列表比没有列表更容易误导人，
 * 所以这里逐条把「认不出就不填」也断言上。
 *
 * 例外是 `parseRecalledSessionRefs`（正文里的 `@标题` 靠它认成会话引用）：它照官方
 * `sessionRecallLabels` 的口径**逐条跳过**坏条目——好的那条不该被旁边一条坏的连累。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import {
  MAX_CATALOG_ENTRIES,
  parseCatalogEntries,
  parseInstructionChanges,
  parseRecalledSessionRefs,
  parseRecalledSessions,
  parseRelaySender,
  parseSnapshotSections,
} from "../src/shared/injectedSource";

// ---------- instructions ----------
{
  const ok = parseInstructionChanges({
    changes: [
      { path: "AGENTS.md", action: "set" },
      { path: "CLAUDE.md", action: "remove" },
      { path: "docs/x.md", action: "replace" },
    ],
  });
  assert.deepStrictEqual(
    ok,
    [
      { path: "AGENTS.md", action: "set" },
      { path: "CLAUDE.md", action: "remove" },
      { path: "docs/x.md", action: "replace" },
    ],
    "三条合法变更都要解析出来",
  );
  assert.strictEqual(parseInstructionChanges({}), undefined, "没有 changes → 认不出");
  assert.strictEqual(
    parseInstructionChanges({ changes: [{ path: "a.md", action: "rename" }] }),
    undefined,
    "action 不在 set/replace/remove 里 → 整项认不出（官方只认这三种）",
  );
  assert.strictEqual(
    parseInstructionChanges({ changes: [{ action: "set" }] }),
    undefined,
    "缺 path → 认不出",
  );
  assert.strictEqual(
    parseInstructionChanges({ changes: [{ path: "a.md", action: "set" }, { path: "" }] }),
    undefined,
    "**一条坏就整项不填**：不能只显示前一半（官方同为全有或全无）",
  );
}

// ---------- catalog ----------
{
  const entries = parseCatalogEntries({
    entries: [{ name: "modsearch", description: "查文档" }],
  });
  assert.deepStrictEqual(entries, [{ name: "modsearch", description: "查文档" }]);
  assert.strictEqual(parseCatalogEntries({ entries: [{ name: "x" }] }), undefined, "缺 description");
  assert.deepStrictEqual(
    parseCatalogEntries({ entries: [] }),
    [],
    "空数组是**合法**形状（返回空列表，由渲染层决定不画）——与「认不出」（undefined）区分开",
  );
  assert.strictEqual(
    MAX_CATALOG_ENTRIES,
    200,
    "展示上限与官方一致（官方 MAX_ENTRIES = 200）",
  );
}

// ---------- snapshot ----------
{
  assert.deepStrictEqual(parseSnapshotSections({ sections: [{ name: "沙箱", text: "read-only" }] }), [
    { name: "沙箱", text: "read-only" },
  ]);
  assert.strictEqual(parseSnapshotSections({ sections: [{ name: "x" }] }), undefined, "缺 text");
  assert.strictEqual(parseSnapshotSections({ sections: "nope" }), undefined, "不是数组 → 认不出");
}

// ---------- relay ----------
{
  assert.strictEqual(parseRelaySender({ senderSessionId: "s-42" }), "s-42");
  assert.strictEqual(parseRelaySender({ senderSessionId: "" }), undefined, "空串等于没有");
  assert.strictEqual(parseRelaySender({}), undefined);
}

// ---------- recall ----------
{
  const refs = parseRecalledSessions({
    references: [{ label: "上次的排查", retainedMessages: 8, omittedMessages: 42, truncated: true }],
  });
  assert.deepStrictEqual(refs, [
    { label: "上次的排查", retainedMessages: 8, omittedMessages: 42, truncated: true },
  ]);
  assert.strictEqual(
    parseRecalledSessions({ references: [{ label: "x", retainedMessages: 1, omittedMessages: 0 }] }),
    undefined,
    "缺 truncated（布尔）→ 认不出；不能默认成 false 蒙一个",
  );
  assert.strictEqual(
    parseRecalledSessions({ references: [{ label: "x", retainedMessages: "1", omittedMessages: 0, truncated: false }] }),
    undefined,
    "数字字段是字符串 → 认不出",
  );
}

// ---------- 跨会话引用的「标题 ↔ 会话 id」（正文里的 `@标题` 靠它认成会话） ----------
{
  // 真实落盘形态（会话日志里的 `user/message`）：id 与标题都在召回事件的 references 里
  assert.deepStrictEqual(
    parseRecalledSessionRefs({
      kind: "session-reference",
      form: "recall",
      version: 1,
      references: [{
        sessionId: "session-10263ccf",
        label: "轨迹四项收口与逐块渲染交接",
        retainedMessages: 97,
        omittedMessages: 0,
        truncated: false,
      }],
    }),
    [{ label: "轨迹四项收口与逐块渲染交接", sessionId: "session-10263ccf" }],
    "只取正文挂接要用的两样（完整度那几项是卡片的事）",
  );

  // 与卡片那份读法不同：这里**逐条跳过**认不出的条目（官方 `sessionRecallLabels` 同口径），
  // 一条好的不能因为旁边一条坏了就整项丢掉
  assert.deepStrictEqual(
    parseRecalledSessionRefs({
      kind: "session-reference",
      references: [{ sessionId: "s1" }, { label: "好的", sessionId: "s2" }, "nope", null],
    }),
    [{ label: "好的", sessionId: "s2" }],
    "缺标题 / 不是对象的条目跳过，好的照旧留下",
  );
  assert.deepStrictEqual(
    parseRecalledSessionRefs({ kind: "session-reference", references: [{ label: "没有 id 的旧形态" }] }),
    [{ label: "没有 id 的旧形态" }],
    "标题在、id 不在：保留标题（界面折成 @标题 显示，只是不可点）",
  );

  // 只认 `kind: "session-reference"`：记忆类插件也有 `form: "recall"`，那是另一回事
  assert.strictEqual(
    parseRecalledSessionRefs({
      kind: "plugin:openviking-memory",
      plugin: "openviking-memory",
      form: "recall",
      references: [{ label: "某个会话", sessionId: "s1" }],
    }),
    undefined,
    "`form: recall` 但 kind 不是跨会话引用 → 一个都不挂",
  );
  assert.strictEqual(
    parseRecalledSessionRefs({ kind: "session-reference", references: [] }),
    undefined,
    "一条可用的都没有 → 认不出（界面照旧按形状显示）",
  );
  assert.strictEqual(
    parseRecalledSessionRefs({ kind: "session-reference", references: "nope" }),
    undefined,
    "references 不是数组 → 认不出",
  );
}

// ---------- 防御：非对象 / null 一律认不出 ----------
{
  for (const value of [undefined, null, 42, "str", [], true]) {
    assert.strictEqual(parseInstructionChanges(value), undefined);
    assert.strictEqual(parseCatalogEntries(value), undefined);
    assert.strictEqual(parseSnapshotSections(value), undefined);
    assert.strictEqual(parseRelaySender(value), undefined);
    assert.strictEqual(parseRecalledSessions(value), undefined);
    assert.strictEqual(parseRecalledSessionRefs(value), undefined);
  }
}

console.log("injectedSource: 按 form 解析 source（全有或全无） ✓");
console.log("\ninjectedSource: all assertions passed");

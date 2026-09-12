/**
 * 上下文注入条目的 `source` 解析（官方 `ContextBody` 的按 form 分派）。
 *
 * 钉的是**形状判据**：官方每个谓词都是「全有或全无」——任一条目缺字段就返回 null，
 * 整条退回不透明呈现（正文 + 原样字段）。半截列表比没有列表更容易误导人，
 * 所以这里逐条把「认不出就不填」也断言上。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import {
  MAX_CATALOG_ENTRIES,
  parseCatalogEntries,
  parseInstructionChanges,
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

// ---------- 防御：非对象 / null 一律认不出 ----------
{
  for (const value of [undefined, null, 42, "str", [], true]) {
    assert.strictEqual(parseInstructionChanges(value), undefined);
    assert.strictEqual(parseCatalogEntries(value), undefined);
    assert.strictEqual(parseSnapshotSections(value), undefined);
    assert.strictEqual(parseRelaySender(value), undefined);
    assert.strictEqual(parseRecalledSessions(value), undefined);
  }
}

console.log("injectedSource: 按 form 解析 source（全有或全无） ✓");
console.log("\ninjectedSource: all assertions passed");

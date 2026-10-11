/**
 * 离线验证官方权限图标，不连接 DSH、不发送模型请求。
 * 指纹取自官方 dsh-v0.2.1-alpha.2 的 PermissionIcon.tsx，
 * 提交 d743267388641bc76f17c45ce8b4c231aed1d32c；覆盖路径和全部逐路径属性。
 * 固定指纹让回归不依赖本机上游 checkout，也避免用被测源码生成预期值。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  IconPermissionReadOnly,
  IconPermissionWorkspaceWrite,
  IconPermissionFullAccess,
  IconPermissionAutoReview,
} from "../src/webview/icons";

const cases = [
  { id: "read-only", icon: IconPermissionReadOnly, hash: "c683db61b6438047a00553110467e44e32b6b0f2e91a2d858ab9200d0db699de", count: 2 },
  { id: "workspace-write", icon: IconPermissionWorkspaceWrite, hash: "c9e60315667e2ec33ece3aeafe4be479409c6a55b7363fa8025b4c99f9868025", count: 5 },
  { id: "danger-full-access", icon: IconPermissionFullAccess, hash: "29f29ae1c93e9d18451af4b3ecbd731138b9793f14c13d73a8d8cbbd921c9189", count: 3 },
  { id: "auto", icon: IconPermissionAutoReview, hash: "d8f52c3d6685d6caf9197f7971d239089b95d6d9f9645a4352c3e5fae303ada2", count: 2 },
];

for (const { id, icon, hash, count } of cases) {
  const markup = renderToStaticMarkup(createElement(icon));
  const root = markup.split(">")[0];
  assert.match(root, /viewBox="0 0 16 16"/, id);
  assert.match(root, /fill="none"/, id);
  assert.match(root, /stroke-width="1"/, id);
  assert.match(root, /aria-hidden="true"/, id);
  assert.match(root, /focusable="false"/, id);
  assert.match(root, /width:calc\(16 \* var\(--dp\)\)/, id);
  assert.match(root, /height:calc\(16 \* var\(--dp\)\)/, id);
  // 不得继承本地 24×24 图标壳的描边、圆端点和圆连接。
  assert.doesNotMatch(root, /\sstroke=|stroke-linecap=|stroke-linejoin=/, id);
  const paths = [...markup.matchAll(/<path\s+([^>]+)>/g)].map(([, attrs]) =>
    [...attrs.matchAll(/([\w-]+)="([^"]*)"/g)]
      .map(([, key, value]) => [key, value])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  assert.equal(paths.length, count, id);
  assert.equal(createHash("sha256").update(JSON.stringify(paths)).digest("hex"), hash, id);
  const scaled = renderToStaticMarkup(createElement(icon, { size: 20, className: "permission-test" }));
  assert.match(scaled, /width:calc\(20 \* var\(--dp\)\)/, id);
  assert.match(scaled, /height:calc\(20 \* var\(--dp\)\)/, id);
  assert.match(scaled, /class="permission-test"/, id);
}

// 同一档位的 icon 节点供工具栏与菜单共用；不允许接回旧自绘图标。
const composer = readFileSync("src/webview/components/Composer.tsx", "utf8");
assert.doesNotMatch(composer, /IconShield/);
assert.match(composer, /id: "read-only"[^\n]+icon: <IconPermissionReadOnly size=\{16\}/);
assert.match(composer, /id: "workspace-write",[\s\S]*?icon: <IconPermissionWorkspaceWrite size=\{16\}/);
assert.match(composer, /id: "danger-full-access",[\s\S]*?icon: <IconPermissionFullAccess size=\{16\}/);
assert.match(composer, /id: AUTO_REVIEW_PRESET,[\s\S]*?icon: <IconPermissionAutoReview size=\{16\}/);
assert.match(composer, /\{currentPermission\.icon\}/);
assert.match(composer, /className="popover-item-icon">\{item\.icon\}/);
console.log("[permission-icons] 四档官方路径与属性、Regular 描边、尺寸和档位接线通过");

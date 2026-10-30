/**
 * 悬停提示里的**平台修饰键标签**。
 *
 * - 打开可编辑真实文件：macOS 是 `Option`，Windows / Linux 是 `Alt`；
 * - HTML 浏览器等原有 Ctrl/Cmd 动作：macOS 是 `Cmd`，其余是 `Ctrl`。
 *
 * 只服务**文案**，不参与点击判据：点击一律看 `event.altKey` / `event.ctrlKey` /
 * `event.metaKey`（见 `fileLinks.ts` 的 `realFileRequested`）。分开的理由是两者来源
 * 不同——按哪个键由用户所在这台机器决定，而 webview 的 `navigator` 正是跑在用户侧
 * 的那一份；执行世界 / 扩展宿主可能是另一台机器。
 *
 * 纯函数、无 DOM：断言见 `scripts/linkHovers.test.ts`。
 */
export type ModifierLabel = "Cmd" | "Ctrl";
export type AltLabel = "Option" | "Alt";

/**
 * 当前 webview 的平台字符串。
 *
 * `navigator.platform` 在 VS Code 的 Electron 里是 `MacIntel` / `Win32` /
 * `Linux x86_64` 一类；`navigator.userAgentData.platform` 与 `navigator.userAgent`
 * 作为兜底（某些环境不给 platform）。Node（离线测试 / SSR）没有 `navigator`，给空串。
 */
function platformText(): string {
  if (typeof navigator === "undefined") return "";
  const nav = navigator as Navigator & {
    readonly userAgentData?: { readonly platform?: string };
  };
  return [nav.userAgentData?.platform, nav.platform, nav.userAgent].filter(Boolean).join(" ");
}

/**
 * 按平台字符串判定 Ctrl/Cmd 标签。
 *
 * 只认 `Mac` 这一档，其余一律 Ctrl——Linux 与 Windows 都用 Ctrl。
 */
export function modifierLabelFor(platform: string | undefined): ModifierLabel {
  return /mac/i.test(platform ?? "") ? "Cmd" : "Ctrl";
}

/** 当前 webview 的 Ctrl/Cmd 标签。 */
export function modifierLabel(): ModifierLabel {
  return modifierLabelFor(platformText());
}

/**
 * 按平台字符串判定 Alt 标签。
 *
 * macOS 键盘上这个键印的是 `Option`（同一物理键）；提示写 Option 更不容易让人
 * 去按一个不存在的 Alt 键。其余平台仍写 Alt。
 */
export function altLabelFor(platform: string | undefined): AltLabel {
  return /mac/i.test(platform ?? "") ? "Option" : "Alt";
}

/** 当前 webview 的 Alt 标签。 */
export function altLabel(): AltLabel {
  return altLabelFor(platformText());
}

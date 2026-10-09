/**
 * 底部工具栏「按优先级 + **实测宽度**」决定这一帧显示哪些元素。
 *
 * ## 为什么不写死阈值
 *
 * 工具栏每一项的宽度都由**文案**决定，而文案的长度会变：
 * 权限名中英文差近一倍（「工作区写入」/ "Workspace Write"）、模型名长短不一、
 * tps 与上下文数字的位数会变，用户还能调字号（`dshChat.fontSize`）。
 * 所以「< 260px 就藏 tps」这类阈值必然是错的——换个语言或换个模型就错位：
 * 要么明明装得下却提前藏了，要么装不下还硬塞、把模型名挤成省略号。
 *
 * 这里的做法是**量出来**而不是猜出来：界面把每个候选档位渲染进一个不可见的
 * 测量层里（`Composer` 的 `.composer-measure`），用 `getBoundingClientRect()`
 * 读出各自的实际宽度，再按本文件的优先级表分配。窗口宽度、文案长度、字号、
 * 语言全都自动被这一步吃掉，源码里没有一个「多少像素该藏谁」的常数。
 *
 * ## 优先级表（用户 2026-09-14 口径，2026-09-22 补「同档内从左至右」与预设标签，
 *    2026-10-06 按用户口径把上下文圆环提为最高优先级，
 *    2026-10-10 补上下文容量右侧的缓存命中率，同日再按用户口径把它改成**独立元素**）
 *
 * - P0 **始终显示**：上下文占用圆环（最高优先级）、权限按钮（只有图标）、模型切换按钮、
 *   发送按钮（`pinned`，装不下也留）；
 * - P1 次优先：思考强度（模型右侧）、附件、tps；
 * - P2 最低：权限按钮的文字说明、agent 预设标签、上下文圆环右侧的精确数值、
 *   缓存命中率（**P2 末位，全场最低**——它是唯一「可有可无的附加读数」）、
 *   模型胶囊的 `提供商/模型名` 全格式档。
 *
 * **同一档内部按元素在工具栏里的左右次序定优先级**（用户 2026-09-22 口径）：
 * 越靠左越先保住。P1 本来就是这个次序写的；P2 的几项则分别落在左端（权限文字）、
 * 中段（预设标签）、右端（上下文数值 → 数值右边的命中率），所以最后回来的那一项是
 * **左右次序上最右**的缓存命中率，而不是先加进来的预设标签。改元素位置就是改这一档的
 * 内部次序，`scripts/toolbarFit.test.ts` 会拿 Composer 的渲染次序对照本表。
 * 模型全格式档（rank 10）是这条规则的例外：它是 P0 那枚模型胶囊的**升级档**，
 * 位置在最左端而 rank 必须大于同槽位的第一档，所以排在 P2 靠后的位置。
 * P0 同理是例外：圆环虽然在右半区，但「始终显示」是用户口径定的最高优先级，
 * P0 内部的 rank 次序不代表左右位置。
 *
 * 「始终显示」只针对**圆圈图标本身**：同槽位的数值档（环右侧的精确数值）仍留在 P2，
 * 按原来的低优先级回来。`context` 槽位必须按 rank 递增（先环、后环+数值）、
 * `permission` 同理（先图标、后图标+文字）——算法是「按 rank 从低到高逐档升级」，
 * 档位不递增就再也升不上去。
 *
 * 缓存命中率**不与上下文数值逗号连写**（用户 2026-10-10 第二条口径）：它自成一个槽位
 * `cache`，位置仍在容量数值右边，写法是 `98.7% HIT`（中英文同一份）。于是这两项各自
 * 进退：宽度不够时先掉命中率，容量数值仍留着。
 */

/** 工具栏里一个「槽位」的一个候选档位。 */
export interface ToolbarVariant {
  /** 槽位名（= 视觉位置）。同一槽位的多个档位互斥，最多只会选中一个。 */
  slot: string;
  /** 档位名（`icon` / `label` / `ring` / `text` / `full`），用来在节点表里取节点。 */
  level: string;
  /** 全局优先级，越小越先保住。 */
  rank: number;
  /** 实测宽度（px）。0 表示这一档在 DOM 里量不到（例如没有数据）。 */
  width: number;
  /** 保底档位：无论多窄都显示（用户口径的 P0）。 */
  pinned?: boolean;
}

/**
 * 优先级表。**改行为就是改这张表**，其余代码只是照着它渲染与测量。
 *
 * 表里同时给出 `slot` 与 `level`：界面按 `槽位:档位` 去节点表里取节点，
 * 取不到（没有思考档位、没有 tps、没有上下文数据…）就不参与这一帧的分配。
 */
export const BAR_ORDER: readonly {
  slot: string;
  level: string;
  rank: number;
  pinned?: boolean;
}[] = [
  // P0 —— 始终显示（用户 2026-10-06 口径：上下文圆环提为最高优先级）
  { slot: "context", level: "ring", rank: 0, pinned: true },
  { slot: "permission", level: "icon", rank: 1, pinned: true },
  { slot: "model", level: "full", rank: 2, pinned: true },
  { slot: "send", level: "full", rank: 3, pinned: true },
  // P1 —— 次优先
  { slot: "effort", level: "full", rank: 4 },
  { slot: "attach", level: "full", rank: 5 },
  { slot: "tps", level: "full", rank: 6 },
  // P2 —— 最低（三项都是「把已有信息写详细一点」或纯文字，故排在最后；
  //        档内次序 = 左右次序：左端的权限文字 → 中段的预设标签 → 右端的上下文数值）
  { slot: "permission", level: "label", rank: 7 },
  { slot: "preset", level: "full", rank: 8 },
  // 数值档留在 P2（用户 2026-10-06 口径）：「始终显示」只指圆环本身，
  // 环右侧的精确数值仍按原来的低优先级回来。
  { slot: "context", level: "text", rank: 9 },
  // P2 末位（用户口径）：模型胶囊的升级档——`提供商/模型名` 全格式。宽度充裕时
  // 才从裸模型名（rank 2 的 pinned 档）升上来；它是 model 槽位的第二档，rank 必须
  // 大于同槽位的第一档（算法按 rank 逐档升级，不递增就升不上去）。
  { slot: "model", level: "provider", rank: 10 },
  // **全场最低优先级**（用户 2026-10-10 口径）：上下文容量数值右侧的缓存命中率
  // （`98.7% HIT`，中英文同一份写法）。它是**独立槽位**——同日第二条口径明确要求
  // 「不要和上下文放一起用逗号隔开」，所以不再去替换 `context` 的数值档，而是紧跟在
  // 数值右边自己占一格；rank 仍必须排最后：命中率是锦上添花的信息，宽度不够时
  // 第一个让位（容量数值留在原位）。
  { slot: "cache", level: "full", rank: 11 },
];

/**
 * 按优先级挑出这一帧显示的档位：**优先级表的一个前缀**。
 *
 * 也就是说：一旦某一档装不下，排在它后面的档位这一帧也一概不显示。
 * 这不是偷懒，而是「优先级」这三个字的字面含义——
 * 若允许跳过装不下的高档去装低档（贪心填充），就会出现
 * 「附件按钮显示了、优先级更高的思考强度却没有」这种与口径相反的画面，
 * 而且拖宽侧栏时元素会**此起彼伏**（宽一点点：附件进来、上下文环被挤出去；
 * 再宽一点：上下文环又回来）——实测在 242~330px 之间会来回跳三次。
 * 前缀规则下宽度只增不减时元素只进不出，拖动过程干净。
 *
 * 代价是「装不下 A 档时不会拿 B 档去填那块空隙」，即可能出现一段空白；
 * 这是为了口径一致刻意接受的。
 *
 * @param variants 全部候选档位（宽度来自实测；缺数据的档位不要传进来）
 * @param available 工具栏的可用宽度（内容盒：已扣掉左右内边距）
 * @param gap 相邻元素之间的间距（读 `.composer-bar` 的 computed `column-gap`）
 * @returns 槽位名 → 选中的档位。**始终包含全部 `pinned` 档位**。
 */
export function pickVariants(
  variants: readonly ToolbarVariant[],
  available: number,
  gap: number,
): Map<string, ToolbarVariant> {
  // 宽度向上取整再求和：浏览器给的是小数（高 DPI 下常见 .34 这种尾数），
  // 与整数可用宽度直接比大小，会在临界点上因半像素来回横跳。
  const widthOf = (variant: ToolbarVariant) => Math.ceil(variant.width);
  const ordered = [...variants].sort((a, b) => a.rank - b.rank);

  const chosen = new Map<string, ToolbarVariant>();
  let used = 0;
  /** 装下一档后的总占宽：换档只花差价，新开一个槽位还要多一个间距。 */
  const after = (variant: ToolbarVariant) => {
    const current = chosen.get(variant.slot);
    return used - (current ? widthOf(current) : -gap) + widthOf(variant);
  };

  // P0 先无条件落位（用户口径：始终要显示），后面的档位在这份基数上排队
  for (const variant of ordered) {
    if (!variant.pinned) continue;
    used = after(variant);
    chosen.set(variant.slot, variant);
  }
  for (const variant of ordered) {
    if (variant.pinned) continue;
    const size = after(variant);
    // 装不下就到此为止：这个槽位保持上一档，后面的档位这一帧全部放弃
    if (size > available) break;
    used = size;
    chosen.set(variant.slot, variant);
  }
  return chosen;
}

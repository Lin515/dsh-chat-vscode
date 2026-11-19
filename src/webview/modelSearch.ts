/**
 * 模型弹层里的搜索：把目录按搜索词过滤成「还看得见的那几组模型」。
 *
 * 规则只有一条，但必须写死在一处：行不行由**模型名 / 模型 id / 提供商名 / 提供商 id**
 * 共同决定，不区分大小写，多个词必须**同时**命中（`deepseek v4` 能搜到
 * `DeepSeek-V4-Pro`，`deepseek zzz` 搜不到）。搜到提供商名时它下面的模型整组留下——
 * 用户打的是「DeepSeek」，想看的显然是这一家的全部模型，不是名字里恰好带这串字的个别行。
 *
 * 过滤**保持目录原有次序**：分组顺序与组内顺序都不动，键盘导航（见 `pickerFocus.ts`）的
 * 扁平序号因此仍与画面从上到下同序，高亮与选中不会错位。分不出内容的组整个丢掉，
 * 不留下只有标题的空组。
 *
 * 这一层是纯函数、不带 React：空目录、空搜索词、只有空白的搜索词都在这里收口，
 * 组件只负责把结果画出来（见 `Composer.tsx` 的模型弹层）。
 */

import type { ModelOptionView, ProviderGroupView } from "../shared/chat";

/**
 * 弹层里一个可导航的模型条目：模型 + 它所属的提供商身份。
 *
 * 分组标题只占视觉、不占号，键盘导航要的是扁平序号，所以弹层与 `Composer` 都按这份
 * 扁平表数号（键仍是 `提供商:模型`）。
 */
export interface ModelRow {
  provider: string;
  providerName: string;
  model: ModelOptionView;
}

/**
 * 搜索词切成「必须同时命中的词」：去首尾空白、转小写、按空白切分。
 *
 * 只切空白，不切标点：模型名里常见 `-` / `.` / `/`（`deepseek-v4.1-flash`），把标点
 * 也当分隔符会让「搜 `v4.1`」与「搜 `v4 1`」变成两件事，反而搜不准。空词直接丢掉，
 * 于是「只有空格」等于没搜索。
 */
export function modelQueryTokens(query: string): string[] {
  return query
    .toLocaleLowerCase()
    .split(/\s+/u)
    .filter((token) => token.length > 0);
}

/** 一行的可搜索面：提供商的两层身份 + 模型的两层身份。 */
function modelHaystack(group: ProviderGroupView, model: ModelOptionView): string {
  return `${group.name}\n${group.id}\n${model.name}\n${model.id}`.toLocaleLowerCase();
}

/**
 * 按搜索词过滤目录；没有有效搜索词时**原样**返回目录。
 *
 * 原样返回（不是复制一份）是刻意的：空搜索是最常见的状态，没必要每次渲染都造一份
 * 结构相同的新数组。
 */
export function filterModelGroups(
  groups: readonly ProviderGroupView[],
  query: string,
): readonly ProviderGroupView[] {
  const tokens = modelQueryTokens(query);
  if (tokens.length === 0) return groups;

  const kept: ProviderGroupView[] = [];
  for (const group of groups) {
    const models = group.models.filter((model) => {
      const haystack = modelHaystack(group, model);
      return tokens.every((token) => haystack.includes(token));
    });
    // 一个都没留下的组整组丢掉：只剩分组标题的空壳比没有更让人以为目录坏了
    if (models.length > 0) kept.push({ id: group.id, name: group.name, models });
  }
  return kept;
}

/** 把（过滤后的）分组拍平成可导航条目：顺序就是画面上的顺序。 */
export function modelRows(groups: readonly ProviderGroupView[]): ModelRow[] {
  const rows: ModelRow[] = [];
  for (const group of groups) {
    for (const model of group.models) {
      rows.push({ provider: group.id, providerName: group.name, model });
    }
  }
  return rows;
}

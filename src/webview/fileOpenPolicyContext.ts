/**
 * 文件链接单击策略的 React 接线。
 *
 * 判据、默认值与「要不要提示 Alt」都在 `fileLinks.ts` 的纯函数里；这里只把宿主
 * 下发的策略放进一棵 React 树，让 Markdown 正文与已发出的 `@` 引用共用同一份。
 *
 * 缺省值刻意是「单击只读副本」：没有 Provider 的离线渲染（测试、预览夹具）与
 * 配置关闭时行为一致，不会因为漏挂 Provider 就悄悄改成真实文件。
 */
import { createContext, useContext } from "react";
import { DEFAULT_FILE_OPEN_POLICY, type FileOpenPolicy } from "./fileLinks";

/** 当前树生效的文件链接策略。 */
export const FileOpenPolicyContext = createContext<FileOpenPolicy>(DEFAULT_FILE_OPEN_POLICY);

/** 读取当前树的文件链接策略。 */
export function useFileOpenPolicy(): FileOpenPolicy {
  return useContext(FileOpenPolicyContext);
}

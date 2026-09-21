/**
 * 附件模型：与官方客户端对齐的两种表示。
 *
 * **改自 v0.4.x 的「内联正文」**：早期版本把文件内容读进 prompt（上限 512KB），
 * 官方从不这么做，代价是实打实的：
 * - token 成本高（一个源文件就吃掉几千 token，用户还以为只是「提了一下这个文件」）；
 * - 二进制读不到（只能给路径，等于白加）；
 * - `@path` 的语义消失——系统提示段告诉模型「这是用户显式引用的工作区路径，
 *   需要内容就用 read 工具读」，内联正文把这条约定抹掉了；
 * - 队列「取回重新编辑」退化（原文里混着几百行文件内容）。
 *
 * 官方两条路：
 * 1. **`@path` 引用**（`dsh-client-ui-reference`）：只把路径 token 发出去，
 *    目录以结尾 `/` 标记（`@dir/`）；
 * 2. **文件上传**（`dsh-client-file-upload`）：拖入/选中的文件逐字节上传，
 *    拿回 `receiptId`，随 prompt 作为 `{type:'file', receiptId}` 发出；模型看到的是
 *    「已上传的句柄 + 只读副本路径」。
 *
 * 本模块只放**纯逻辑**（路径 → mention 文本、分类），网络与文件 IO 在控制器。
 */
import { formatFileMention } from "../shared/mentions";

/**
 * 生成 `@` 引用的**模型可见文本**（官方 `formatFileMention`）。
 *
 * 实现在 `shared/mentions.ts`——界面在 `@` 候选里选中文件时直接用同一个函数
 * 把 token 插进输入框（纯路径引用），两边必须逐字一致，所以规则只有一份。
 *
 * **引用只活在一个地方：正文**。早先还有一个"引用芯片"（附件列表里的一条，
 * 发送时由 `composeWithReferences` 拼到正文之前），那条线自 `@` 改成写正文 token
 * 之后就没有生产方了，2026-09-21 连同 `composeWithReferences` 一起删掉——
 * 目录也走 `@dir/` 文本（见 controller 的 `addDirectoryReference`）。
 */
export { formatFileMention };

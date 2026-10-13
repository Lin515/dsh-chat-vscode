# 消息、工具与交付显示

修改 durable 消息、工具行、产物卡片、Markdown 路径或文案登记前读本文。线格式见[服务端契约](<dsh-server-api.md>)，提交与乐观回显见[发送设计](<design-draft.md>)，图片读取见[安全边界](<design-security.md>)。

## 用户消息与引用身份

用户正文、图片和文件块均须保留，不能按文本是否非空过滤整条消息或内容块。durable `user/message.data` 就是消息本体，不包 message；它与 system/message、tool/result 的包装不同。

会话引用进入模型前变成快照，durable 正文折成 `@标题`，会话 id 由紧随的 session-reference 召回事件补回，按 seq - 1 关联用户消息。复制与提问预览使用可读标题，不能把会话引用误判成路径；补全 token 规则见[引用设计](<design-mentions.md>)。

## 交付文件与工具产物

`present` 申报与 write / edit 派生的本轮产物有独立显示入口，图片经受限本地读取显示。工具产物、命令流程节点与模型正文是不同来源，不能用“正文里已经提到”代替产物登记。

成功第一方变更调用由 `produced.ts` 派生本轮文件，命令节点与交付卡片分别保持各自身份；文件去重不能吞掉独立交付入口。

## 工具状态与事件消费

- 中止轮次必须结算在飞工具，避免永久显示运行中。结果找不到调用时保留孤立结果卡片，不静默丢弃；max-tokens 收尾已有单独提示。
- 活性与工具种类分开：有 tone 不代表应遮掉工具图标，未知子代理活性不画确定状态点。
- 每个工具展开内容各持自己的 ref，diff、划选与回顶不能共用最后一个节点。
- 已知但不渲染的事件列入显式白名单，未知事件才告警。类型登记、实际消费与有意忽略分别维护，不能用白名单掩盖应消费状态。
- 会话快照 / patch 字段和 JSON 清空规则见[投影设计](<design-projections.md>)，不用本地另一份字段表修补显示。

## Windows 路径链接

CommonMark 把反斜杠加 ASCII 标点视为转义，会吞掉 Windows 绝对路径中点目录等分隔符。`linkDestinations.ts` 在 tokenizer 层保留原目标，将 Windows 绝对路径中的反斜杠编码为 `%5C`，由 fileLinks / imageRef 解码；这是刻意偏离官方同类解析行为的修复。

只修行内链接与图片的目标，不改链接标签、裸路径文本、参考式定义或非 Windows 目标；括号配平等分歧保持默认解析。保住 UNC 文本不等于允许访问远端，宿主准入仍拒绝 UNC。Markdown 渲染正确与文件 / 图片可安全打开是两个边界。

## 文案登记完整性

工具标题、宿主 `@key` 标记与中英词典须双向完整。参数文案用登记函数，不能拼接句子，也不能用宽泛类型断言与裸 id 回退掩盖缺项。

`resolveText()` 仅翻译标记，模型与服务端原文不翻译；原生通知、VS Code 清单与 webview 词典各遵守[双语约定](<../AGENTS.md>)。用户可见语义提示须中英同时登记，未知或未验证状态不能显示为确定成功。

## 回归入口

produced、commandNode、references、thinkingStream、unknownEvent、markdown、i18n 与 styles 覆盖对应链路；本地图片另见 localImages / imageHydrate。离线断言固定确定事实，不能将无异常、预览可见或文案完整推广为系统剪贴板、安装端 IPC 或全部事件时序已验证。

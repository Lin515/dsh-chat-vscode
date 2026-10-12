# 技术文档导航

内部文档使用中文；面向用户的安装与功能说明见[项目 README](<../README.md>)，协作、验证与安全约定见[AGENTS](<../AGENTS.md>)。

## 契约与审计

| 文档 | 读它的时机 |
|---|---|
| [DSH API 参考](<dsh-server-api.md>) | 修改协议载荷；正文是 0.1.5-rc.1 摘录，先读「后续版本的契约变更」，再核对目标版本产物 |
| [版本兼容](<dsh-compat.md>) | 核对当前基准、发布渠道、消费面、兼容分支与移除期限 |
| [审计摘要](<audit-summary.md>) | 检查已修复问题对应的不变量、安全边界与真实缺口 |
| [输入、队列与附件审计](<audit-input-queue-attachments.md>) | 修改发送、队列取回、停止续发与附件还原 |
| [投影与面板审计](<audit-projections-panels.md>) | 修改目录、权限、模型、子代理、任务或空壳恢复 |

## 设计规格

| 文档 | 范围 |
|---|---|
| [后台与连接](<design-supervisor.md>) | supervisor 生命周期、启动许可、粘性选路、认证与停止 |
| [附件与引用](<design-attachments.md>) | 接入矩阵、上传租约、平台限制与官方差异 |
| [发送与草稿](<design-draft.md>) | 乐观回显、状态归属、durable 交接与失败处理 |
| [输入工具栏](<design-composer.md>) | 实测宽度、优先级前缀、节点观察与权限弹层 |
| [右键菜单](<design-context-menu.md>) | 事件接管、判定矩阵、图片复制与保存 |
| [轨迹面板](<design-trajectory.md>) | 第二次事件折叠、请求时序、交互、受控验证与未确认边界 |

## 架构决策（ADR）

| 决策 | 核心理由 |
|---|---|
| [投影值存储](<adr/0001-projection-value-store.md>) | 防止较旧 seq 回退已提交投影 |
| [引用候选分两帧](<adr/0002-mention-candidates-two-frames.md>) | 慢会话检索不阻塞文件候选 |
| [未读离开标记](<adr/0003-unread-leave-marker.md>) | 区分后台生成完成与用户已经读过 |
| [设计像素与缩放](<adr/0004-ui-scale-design-pixels.md>) | CSS 与 JavaScript 几何共用倍率，不混 zoom 坐标 |
| [已解析引用抑制补全](<adr/0005-mention-block-already-references.md>) | 宿主判断整块是否已能引用，浏览入口仍可展开 |

文档记录当前规则及其证据边界，不替代源码和断言。历史观察不当作稳定契约；未实现或未验证的项目明确保留。源码导航从[src](<../src/README.md>)进入，工具与离线测试从[scripts](<../scripts/README.md>)进入。

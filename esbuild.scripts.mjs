import esbuild from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";

/**
 * 开发期脚本的打包（冒烟测试、诊断探针、环境修复）。
 *
 * 产物放在 `build/` 而不是 `dist/`：`dist/` 是随 vsix 发布的内容，
 * 测试与诊断脚本不该混进去。
 *
 * 打包前先清掉旧的 `*.mjs`：`npm test` 用 `build/*.test.mjs` 通配来发现断言，
 * 删掉的测试若留下旧产物会被继续执行，看起来像「测试还在跑但改了没生效」。
 *
 * `ws` 是 CJS 且会动态 require Node 内置模块，ESM 产物需要补一个 require。
 *
 * `alias.vscode`：`subagentSwitch.test.ts` 要驱动**真的** ChatController，而它
 * `import * as vscode from "vscode"`——离线没有这个模块。alias 把它指到
 * `scripts/vscodeTestStub.ts`（只覆盖那条场景用到的面）；不 import vscode 的
 * 条目完全不受影响。
 */
const banner = {
  js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
};

mkdirSync("build", { recursive: true });
for (const name of readdirSync("build")) {
  if (name.endsWith(".mjs")) rmSync(`build/${name}`, { force: true });
}
/**
 * 只清掉**本脚本自己**写的那一份来源见证：不能泛删 `build/*.json`（别的工具可能也在这里放文件）。
 * 见证与 `build/*.mjs` 同生命周期 —— 它见证的是「这次构建实际折进去的源码字节」，
 * 留着上一轮的旧见证比没有更糟。
 */
const WITNESS_FILES = ["build/trajectory-fixture-build.witness.json"];
for (const file of WITNESS_FILES) rmSync(file, { force: true });

/**
 * 记录型 `onLoad`：esbuild 请求加载 `declared` 时，把那份字节读出来算 sha256、
 * 再**原样交回** esbuild。
 *
 * 语义与不装插件时逐字相同（内容不改写），区别只是这次加载被记了下来 —— 于是见证文件里的
 * `derive.sha256` 是**真的进了 bundle 的字节**，不是事后补的声明。夹具提取 CLI 的回归据此
 * 断言「折入的 derive 字节 = 磁盘当前源码 = CLI 写出的登记」。
 */
function recordDeclaredSource(declared, recorded) {
  const filter = new RegExp(`[\\\\/]${declared.split("/").join("[\\\\/]")}$`);
  return {
    name: "record-declared-source-bytes",
    setup(build) {
      build.onLoad({ filter }, (args) => {
        const raw = readFileSync(args.path);
        recorded.source = {
          file: relative(process.cwd(), args.path).replace(/\\/g, "/"),
          sha256: createHash("sha256").update(raw).digest("hex"),
          bytes: raw.length,
        };
        return { contents: raw.toString("utf8"), loader: "ts", resolveDir: dirname(args.path) };
      });
    },
  };
}

/** 需要「实际折入字节」见证的入口（目前只有夹具提取 CLI）。 */
const sourceWitnesses = {
  "build/trajectory-fixture-build.mjs": {
    entry: "scripts/trajectoryFixtureBuild.ts",
    declared: "src/dsh/trajectory.ts",
    witness: WITNESS_FILES[0],
  },
};

const entries = {
  "build/smoke.mjs": "scripts/smoke.ts",
  "build/model-switch.mjs": "scripts/modelSwitch.ts",
  "build/dump-settings.mjs": "scripts/dumpSettings.ts",
  "build/panels-probe.mjs": "scripts/panelsProbe.ts",
  "build/probe.mjs": "scripts/probe.ts",
  "build/set-default-model.mjs": "scripts/setDefaultModel.ts",
  "build/queue-esc-e2e.mjs": "scripts/queueEscE2E.ts",
  "build/queue-continue-probe.mjs": "scripts/queueContinueProbe.ts",
  "build/queue-order-probe.mjs": "scripts/queueOrderProbe.ts",
  "build/queue-log-inspect.mjs": "scripts/queueLogInspect.ts",
  "build/command-e2e.mjs": "scripts/commandE2E.ts",
  "build/pressure-probe.mjs": "scripts/pressureProbe.ts",
  "build/cookie-survives-restart.mjs": "scripts/cookieSurvivesRestart.ts",
  "build/parse-tool-result.test.mjs": "scripts/parseToolResult.test.ts",
  "build/markdown.test.mjs": "scripts/markdown.test.ts",
  "build/local-images.test.mjs": "scripts/localImages.test.ts",
  "build/image-render.test.mjs": "scripts/imageRender.test.ts",
  "build/image-hydrate.test.mjs": "scripts/imageHydrate.test.ts",
  "build/image-attachments.test.mjs": "scripts/imageAttachments.test.ts",
  "build/turn-process.test.mjs": "scripts/turnProcess.test.ts",
  "build/injected-source.test.mjs": "scripts/injectedSource.test.ts",
  "build/pending-interaction.test.mjs": "scripts/pendingInteraction.test.ts",
  "build/interaction-sync.test.mjs": "scripts/interactionSync.test.ts",
  "build/pending-interactions.test.mjs": "scripts/pendingInteractions.test.ts",
  "build/diff.test.mjs": "scripts/diff.test.ts",
  "build/attachments.test.mjs": "scripts/attachments.test.ts",
  // 粘贴图片的会话内编号名（图N / imageN）：必须登记，否则 npm test 静默不跑
  "build/pasted-image-names.test.mjs": "scripts/pastedImageNames.test.ts",
  // 图片头部宽高解析（服务端像素/单边准入要在接入时预检）：必须登记，否则 npm test 静默不跑
  "build/image-size.test.mjs": "scripts/imageSize.test.ts",
  // 附件草稿的归属与上传生命周期（账本 module + 真 ChatController 的受控 Promise 上传链）：必须登记，否则 npm test 静默不跑
  "build/attachment-lifecycle.test.mjs": "scripts/attachmentLifecycle.test.ts",
  // 「单击打开附件」的本地落点（叶子名清洗 / 临时副本落盘 / 内容身份索引）：必须登记，否则 npm test 静默不跑
  "build/attachment-open.test.mjs": "scripts/attachmentOpen.test.ts",
  "build/clipboard-paths.test.mjs": "scripts/clipboardPaths.test.ts",
  "build/queue-view.test.mjs": "scripts/queueView.test.ts",
  "build/job-view.test.mjs": "scripts/jobView.test.ts",
  // 自动化任务（schedule）：线格式收窄 / 频率文本 / 运行时间编辑 / 接线与样式
  "build/schedule.test.mjs": "scripts/schedule.test.ts",
  "build/session-cookie.test.mjs": "scripts/sessionCookie.test.ts",
  "build/tool-view.test.mjs": "scripts/toolView.test.ts",
  "build/tool-card.test.mjs": "scripts/toolCard.test.ts",
  "build/thinking-stream.test.mjs": "scripts/thinkingStream.test.ts",
  "build/injected.test.mjs": "scripts/injected.test.ts",
  "build/node-open.test.mjs": "scripts/nodeOpen.test.ts",
  "build/unknown-event.test.mjs": "scripts/unknownEvent.test.ts",
  "build/changes-card.test.mjs": "scripts/changesCard.test.ts",
  // 本轮快照对比（/api/changes.diff → VS Code diff）：hunk 拼两侧文本与卡片坐标接线
  "build/changes-diff.test.mjs": "scripts/changesDiff.test.ts",
  "build/todo-collapse.test.mjs": "scripts/todoCollapse.test.ts",
  "build/tail-rows-probe.mjs": "scripts/tailRowsProbe.ts",
  "build/projections.test.mjs": "scripts/projections.test.ts",
  "build/produced.test.mjs": "scripts/produced.test.ts",
  "build/command-node.test.mjs": "scripts/commandNode.test.ts",
  "build/references.test.mjs": "scripts/references.test.ts",
  "build/tool-meta.test.mjs": "scripts/toolMeta.test.ts",
  "build/preview-fixture.test.mjs": "scripts/previewFixture.test.ts",
  "build/i18n.test.mjs": "scripts/i18n.test.ts",
  "build/occupancy.test.mjs": "scripts/occupancy.test.ts",
  "build/invariants.test.mjs": "scripts/invariants.test.ts",
  "build/wire.test.mjs": "scripts/wire.test.ts",
  "build/turn-files.test.mjs": "scripts/turnFiles.test.ts",
  "build/file-change.test.mjs": "scripts/fileChange.test.ts",
  "build/styles.test.mjs": "scripts/styles.test.ts",
  "build/toolbar-fit.test.mjs": "scripts/toolbarFit.test.ts",
  "build/permission-icons.test.mjs": "scripts/permissionIcons.test.ts",
  "build/cache-hit.test.mjs": "scripts/cacheHit.test.ts",
  "build/read-range.test.mjs": "scripts/readRange.test.ts",
  "build/segment.test.mjs": "scripts/segment.test.ts",
  "build/picker-focus.test.mjs": "scripts/pickerFocus.test.ts",
  "build/path-insert.test.mjs": "scripts/pathInsert.test.ts",
  "build/context-menu.test.mjs": "scripts/contextMenu.test.ts",
  "build/image-files.test.mjs": "scripts/imageFiles.test.ts",
  "build/path-display.test.mjs": "scripts/pathDisplay.test.ts",
  "build/file-links.test.mjs": "scripts/fileLinks.test.ts",
  // 链接悬停标题与 HTML 文件的浏览器打开（修饰键判据 / 白名单 / 两端接线）：必须登记
  "build/link-hovers.test.mjs": "scripts/linkHovers.test.ts",
  "build/system-prompt-probe.mjs": "scripts/systemPromptProbe.ts",
  "build/effort-probe.mjs": "scripts/effortProbe.ts",
  "build/read-range-probe.mjs": "scripts/readRangeProbe.ts",
  "build/plan-command-probe.mjs": "scripts/planCommandProbe.ts",
  "build/goal-session-probe.mjs": "scripts/goalSessionProbe.ts",
  "build/session-log-scan.mjs": "scripts/sessionLogScan.ts",
  "build/session-log.test.mjs": "scripts/sessionLog.test.ts",
  "build/session-list-probe.mjs": "scripts/sessionListProbe.ts",
  "build/session-list.test.mjs": "scripts/sessionList.test.ts",
  // 历史列表按窗口当前会话 cwd 隔离（无文件夹时多会话各有 cwd）：驱真控制器 + stub（必须登记，否则 npm test 静默不跑）
  "build/session-list-scope.test.mjs": "scripts/sessionListScope.test.ts",
  // 历史列表的多选（可选判据 / 选择集跟随列表 / 全选翻转）：必须登记，否则 npm test 静默不跑
  "build/session-selection.test.mjs": "scripts/sessionSelection.test.ts",
  "build/process-registry.test.mjs": "scripts/processRegistry.test.ts",
  "build/config-changes.test.mjs": "scripts/configChanges.test.ts",
  "build/footnotes.test.mjs": "scripts/footnotes.test.ts",
  "build/question-flow.test.mjs": "scripts/questionFlow.test.ts",
  // 问卷半填草稿的内存表：切会话恢复、按会话隔离、上限淘汰（必须登记，否则静默不跑）
  "build/question-draft.test.mjs": "scripts/questionDraft.test.ts",
  "build/tool-question.test.mjs": "scripts/toolQuestion.test.ts",
  "build/localized-text.test.mjs": "scripts/localizedText.test.ts",
  "build/plan-review.test.mjs": "scripts/planReview.test.ts",
  "build/question-render.test.mjs": "scripts/questionRender.test.ts",
  "build/mention-nav.test.mjs": "scripts/mentionNav.test.ts",
  "build/mention-candidates.test.mjs": "scripts/mentionCandidates.test.ts",
  // 「光标所在的 @ 块已经能引用到内容就不弹」这条口径的宿主侧判据（真控制器 + 真盘临时目录）
  "build/mention-resolve.test.mjs": "scripts/mentionResolve.test.ts",
  "build/mention-links.test.mjs": "scripts/mentionLinks.test.ts",
  "build/mention-links-ui.test.mjs": "scripts/mentionLinksUi.test.ts",
  "build/selection.test.mjs": "scripts/selection.test.ts",
  "build/workspace-probe.mjs": "scripts/workspaceProbe.ts",
  "build/history-replay.test.mjs": "scripts/historyReplay.test.ts",
  "build/render-order-probe.mjs": "scripts/renderOrderProbe.ts",
  "build/render-order.test.mjs": "scripts/renderOrder.test.ts",
  // 用户消息落位：本轮提问 vs 生成中插话的分界（next-step 的本次领取）：必须登记，否则 npm test 静默不跑
  "build/steering-placement.test.mjs": "scripts/steeringPlacement.test.ts",
  "build/live-order-probe.mjs": "scripts/liveOrderProbe.ts",
  "build/page-loop-probe.mjs": "scripts/pageLoopProbe.ts",
  "build/rail-jump-probe.mjs": "scripts/railJumpProbe.ts",
  "build/config-reload-probe.mjs": "scripts/configReloadProbe.ts",
  "build/window-state.test.mjs": "scripts/windowState.test.ts",
  "build/panel-title.test.mjs": "scripts/panelTitle.test.ts",
  "build/host-log.test.mjs": "scripts/hostLog.test.ts",
  "build/supervisor-protocol.test.mjs": "scripts/supervisorProtocol.test.ts",
  "build/supervisor-errors.test.mjs": "scripts/supervisorErrors.test.ts",
  "build/supervisor-policy.test.mjs": "scripts/supervisorPolicy.test.ts",
  "build/connect-target.test.mjs": "scripts/connectTarget.test.ts",
  // 桌面端内置服务的发现与接入（认人 / 找口 / 四个解析器 / 四种结论 / 拉起等就绪）：必须登记
  "build/desktop-attach.test.mjs": "scripts/desktopAttach.test.ts",
  // 顶栏「打开 DSH 桌面端」的宿主接线（desktopConnected 判据 / 动作 / 失败通知）：必须登记
  "build/desktop-open.test.mjs": "scripts/desktopOpen.test.ts",
  // 自铸浏览器会话凭据（名字向量 / 票格式与签名 / 有效期 / 密钥扫描）：必须登记
  "build/browser-session.test.mjs": "scripts/browserSession.test.ts",
  "build/connection-stop.test.mjs": "scripts/connectionStop.test.ts",
  // 连接尝试的账本与收场：驱真控制器 + 假客户端 / 假服务端（必须登记，否则 npm test 静默不跑）
  "build/connection-attempts.test.mjs": "scripts/connectionAttempts.test.ts",
  "build/auto-connect-config.test.mjs": "scripts/autoConnectConfig.test.ts",
  // 自动连接只在扩展启动时做一次：驱真控制器（假服务端/假客户端）+ 真 socket 假守护进程
  // （必须登记，否则 npm test 静默不跑）
  "build/auto-connect-once.test.mjs": "scripts/autoConnectOnce.test.ts",
  "build/supervisor-no-respawn.test.mjs": "scripts/supervisorNoRespawn.test.ts",
  "build/connect-snapshot.test.mjs": "scripts/connectSnapshot.test.ts",
  "build/connect-view.test.mjs": "scripts/connectView.test.ts",
  "build/session-view.test.mjs": "scripts/sessionView.test.ts",
  "build/auto-scroll.test.mjs": "scripts/autoScroll.test.ts",
  // 阅读定位端口（一次阅读动作：先放跟随再落位 / 延期取历史 / 300 帧跟踪 / 过期作废）：必须登记，否则 npm test 静默不跑
  "build/reading-placement.test.mjs": "scripts/readingPlacement.test.ts",
  "build/find.test.mjs": "scripts/find.test.ts",
  "build/client-dispose.test.mjs": "scripts/clientDispose.test.ts",
  "build/pinger.mjs": "scripts/pinger.ts",
  "build/supervisor-reload-probe.mjs": "scripts/supervisorReloadProbe.ts",
  "build/supervisor-idle-probe.mjs": "scripts/supervisorIdleProbe.ts",
  "build/supervisor-scenarios-probe.mjs": "scripts/supervisorScenariosProbe.ts",
  "build/supervisor-manager-probe.mjs": "scripts/supervisorManagerProbe.ts",
  "build/supervisor-child-exit-probe.mjs": "scripts/supervisorChildExitProbe.ts",
  "build/supervisor-error-bridge-probe.mjs": "scripts/supervisorErrorBridgeProbe.ts",
  "build/auth-chain-probe.mjs": "scripts/authChainProbe.ts",
  "build/jobs-order.test.mjs": "scripts/jobsOrder.test.ts",
  "build/jobs-kill.test.mjs": "scripts/jobsKill.test.ts",
  "build/job-observe.test.mjs": "scripts/jobObserve.test.ts",
  "build/queue-order.test.mjs": "scripts/queueOrder.test.ts",
  "build/queue-hover.test.mjs": "scripts/queueHover.test.ts",
  // 队列「取回重新编辑」的回填链路（真 ChatController + vscode stub；必须登记，否则 npm test 静默不跑）
  "build/queue-restore.test.mjs": "scripts/queueRestore.test.ts",
  "build/trajectory.test.mjs": "scripts/trajectory.test.ts",
  "build/trajectory-vendor.test.mjs": "scripts/trajectoryVendor.test.ts",
  // M01 源锁：`src/vendor/**/*.ts` 的内容锁 + 双向登记 + 来源自洽（必须登记，否则 npm test 静默不跑）
  "build/vendor-source-lock.test.mjs": "scripts/vendorSourceLock.test.ts",
  "build/trajectory-display.test.mjs": "scripts/trajectoryDisplay.test.ts",
  "build/trajectory-pre.test.mjs": "scripts/trajectoryPre.test.ts",
  // 轨迹 schema 回补（窗口没带进 request/header → 按需往前补页）：必须登记，否则 npm test 静默不跑
  "build/trajectory-schema-backfill.test.mjs": "scripts/trajectorySchemaBackfill.test.ts",
  "build/trajectory-prompt-diff.test.mjs": "scripts/trajectoryPromptDiff.test.ts",
  "build/inspect-call.test.mjs": "scripts/inspectCall.test.ts",
  "build/trajectory-virtual.test.mjs": "scripts/trajectoryVirtual.test.ts",
  "build/trajectory-ledger-rows.test.mjs": "scripts/trajectoryLedgerRows.test.ts",
  "build/trajectory-interaction.test.mjs": "scripts/trajectoryInteraction.test.ts",
  "build/trajectory-probe-cli.test.mjs": "scripts/trajectoryProbeCli.test.ts",
  "build/trajectory-align-probe.mjs": "scripts/trajectoryAlignProbe.ts",
  "build/trajectory-gap-probe.mjs": "scripts/trajectoryGapProbe.ts",
  "build/trajectory-probe-facts.test.mjs": "scripts/trajectoryProbeFacts.test.ts",
  "build/trajectory-shape-probe.mjs": "scripts/trajectoryShapeProbe.ts",
  "build/trajectory-fold-probe.mjs": "scripts/trajectoryFoldProbe.ts",
  "build/turn-rail.test.mjs": "scripts/turnRail.test.ts",
  "build/manifest.test.mjs": "scripts/manifest.test.ts",
  "build/projection-store.test.mjs": "scripts/projectionStore.test.ts",
  "build/projection-ingest.test.mjs": "scripts/projectionIngest.test.ts",
  "build/projection-seq-probe.mjs": "scripts/projectionSeqProbe.ts",
  "build/activity.test.mjs": "scripts/activity.test.ts",
  "build/subagent-panel.test.mjs": "scripts/subagentPanel.test.ts",
  "build/session-dir.test.mjs": "scripts/sessionDir.test.ts",
  "build/session-status.test.mjs": "scripts/sessionStatus.test.ts",
  // 会话活动时间（api-session/activity）的解码：子代理目录排序的实时来路，必须登记
  "build/session-activity.test.mjs": "scripts/sessionActivity.test.ts",
  "build/preset-display.test.mjs": "scripts/presetDisplay.test.ts",
  "build/preset-match.test.mjs": "scripts/presetMatch.test.ts",
  "build/composer-draft.test.mjs": "scripts/composerDraft.test.ts",
  "build/composer-mention.test.mjs": "scripts/composerMention.test.ts",
  "build/composer-session-draft.test.mjs": "scripts/composerSessionDraft.test.ts",
  // 发送手势（按钮按住 Ctrl / Cmd 的文字与点击手势）：真渲染 + 真事件链，必须登记
  "build/composer-send.test.mjs": "scripts/composerSend.test.ts",
  // ESC 归属链（菜单>原图、轨迹聚焦不停止生成、生命周期）：手写事件链驱动真处理器，必须登记
  "build/escape-owner.test.mjs": "scripts/escapeOwner.test.ts",
  "build/editor-column.test.mjs": "scripts/editorColumn.test.ts",
  "build/pending-echo.test.mjs": "scripts/pendingEcho.test.ts",
  // 收件箱回执的纯数学（位次平移 / 水位单调 / 取消与领取的分野）：判定「服务端受理了却没落盘」，必须登记
  "build/submission-receipts.test.mjs": "scripts/submissionReceipts.test.ts",
  "build/dsh-contract.test.mjs": "scripts/dshContract.test.ts",
  "build/subagent-switch.test.mjs": "scripts/subagentSwitch.test.ts",
  // 子代理树的组装与界面计数（多层嵌套 / 第 1 层与顶层会话同级 / 环截断）：必须登记，否则 npm test 静默不跑
  "build/subagent-tree.test.mjs": "scripts/subagentTree.test.ts",
  "build/subagent-row-state.test.mjs": "scripts/subagentRowState.test.ts",
  // 子代理目录的显示顺序（判定时间：用户消息与一轮收尾取新）：驱真 ChatController + stub，必须登记
  "build/subagent-order.test.mjs": "scripts/subagentOrder.test.ts",
  // 子代理显示名：目录行缺 label 时默认显示会话标题（workflow 派发的子代理），必须登记
  "build/subagent-title.test.mjs": "scripts/subagentTitle.test.ts",
  "build/unread-marker.test.mjs": "scripts/unreadMarker.test.ts",
  // 报错会话的状态口径（单流失败重开 / 提交失败不许覆盖 durable 证据）：驱真 ChatController + stub（必须登记，否则 npm test 静默不跑）
  "build/error-session-status.test.mjs": "scripts/errorSessionStatus.test.ts",
  // 附件接入的会话门（无会话整批拒收 / 按原因提示）：必须登记，否则 npm test 静默不跑
  "build/attach-intake-gate.test.mjs": "scripts/attachIntakeGate.test.ts",
  "build/empty-composer.test.mjs": "scripts/emptyComposer.test.ts",
  "build/file-ref-listing.test.mjs": "scripts/fileRefListing.test.ts",
  // 本地 FS 访问层（有界等待 / 全局未完成操作上限 / 信任门）：必须登记，否则 npm test 静默不跑
  "build/local-access.test.mjs": "scripts/localAccess.test.ts",
  "build/blank-session-reuse.test.mjs": "scripts/blankSessionReuse.test.ts",
  // 空壳记着的预设被删掉（接回时指名认领 + 退回部署默认）：必须登记，否则 npm test 静默不跑
  "build/blank-preset-adopt.test.mjs": "scripts/blankPresetAdopt.test.ts",
  "build/blank-restore-race.test.mjs": "scripts/blankRestoreRace.test.ts",
  // 「停在空壳上点「+」完全 no-op」与空壳按窗口独占（真 ChatController + 假服务端）：
  // 必须登记，否则 npm test 静默不跑
  "build/blank-session-noop.test.mjs": "scripts/blankSessionNoop.test.ts",
  "build/workspace-dir-repick.test.mjs": "scripts/workspaceDirRepick.test.ts",
  // 通知队列（合并 / 确认 / 重发水位 / 容量）与宿主接线（多视图镜像、执行目录 live-only）：
  // 驱真 ChatController + stub，必须登记，否则 npm test 静默不跑
  "build/notification-queue.test.mjs": "scripts/notificationQueue.test.ts",
  // 通知界面接线（reducer 镜像、ack 上报、命令路由、ESC/抽屉）：必须登记
  "build/notifications-view.test.mjs": "scripts/notificationsView.test.ts",
  // 通知的宿主接线（多视图镜像 / ack / 重绑 / 无窗口命令 / 复制失败归属 / 删除清水位）：
  // 驱真 ChatController + stub，必须登记
  "build/notifications-controller.test.mjs": "scripts/notificationsController.test.ts",
  "build/dsh-compat.mjs": "scripts/dshCompat.ts",
  // S02 夹具提取 / 离线校验：两个 CLI 与它们的离线回归（回归必须登记，否则 npm test 静默不跑）
  "build/trajectory-fixture-build.mjs": "scripts/trajectoryFixtureBuild.ts",
  "build/trajectory-fixture-verify.mjs": "scripts/trajectoryFixtureVerify.ts",
  "build/trajectory-fixture.test.mjs": "scripts/tests/trajectory/fixture.test.ts",
  "build/trajectory-fixture-build.test.mjs": "scripts/tests/trajectory/fixtureBuild.test.ts",
  "build/trajectory-fixture-verify.test.mjs": "scripts/tests/trajectory/fixtureVerify.test.ts",
  // M06 完整载荷整链路：OS 入口（薄壳）+ 离线回归。
  // 入口指向 `trajectoryPayloadBenchCli.ts` —— 核心 `trajectoryPayloadBench.ts` 是**无顶层
  // 副作用的纯模块**，测试直接 import 它；不要给核心模块单独建 CLI 条目（bundle 里
  // `import.meta.url === argv[1]` 与 `import.meta.main` 都会在测试里恒真，CLI 会抢跑）。
  "build/trajectory-payload-bench.mjs": "scripts/trajectoryPayloadBenchCli.ts",
  "build/trajectory-payload-bench.test.mjs": "scripts/trajectoryPayloadBench.test.ts",

};

await Promise.all(
  Object.entries(entries).map(async ([outfile, entryPoints]) => {
    const witness = sourceWitnesses[outfile];
    const recorded = { source: null };
    await esbuild.build({
      entryPoints: [entryPoints],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      logLevel: "info",
      banner,
      alias: { vscode: "./scripts/vscodeTestStub.ts" },
      // 断言脚本里也有渲染断言（`scripts/questionRender.test.ts` 用
      // `react-dom/server` 真渲染问卷卡）：与 webview 那份产物同一个转换器，
      // 否则 TSX 会退回经典转换、要求一个不存在的 React 全局变量。
      jsx: "automatic",
      ...(witness === undefined ? {} : { plugins: [recordDeclaredSource(witness.declared, recorded)] }),
    });
    if (witness !== undefined) {
      // 见证写在**构建成功之后**：失败时不留下半份见证（那会让「折入字节」看起来已验证过）
      writeFileSync(witness.witness, `${JSON.stringify({
        generatedBy: "esbuild.scripts.mjs",
        entry: witness.entry,
        outfile,
        derive: recorded.source,
        bundleSha256: createHash("sha256").update(readFileSync(outfile)).digest("hex"),
      }, null, 2)}\n`, "utf8");
    }
  }),
);




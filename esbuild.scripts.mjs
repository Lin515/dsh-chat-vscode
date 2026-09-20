import esbuild from "esbuild";
import { mkdirSync, readdirSync, rmSync } from "node:fs";

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
 */
const banner = {
  js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
};

mkdirSync("build", { recursive: true });
for (const name of readdirSync("build")) {
  if (name.endsWith(".mjs")) rmSync(`build/${name}`, { force: true });
}

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
  "build/image-attachments.test.mjs": "scripts/imageAttachments.test.ts",
  "build/turn-process.test.mjs": "scripts/turnProcess.test.ts",
  "build/injected-source.test.mjs": "scripts/injectedSource.test.ts",
  "build/pending-interaction.test.mjs": "scripts/pendingInteraction.test.ts",
  "build/interaction-sync.test.mjs": "scripts/interactionSync.test.ts",
  "build/pending-interactions.test.mjs": "scripts/pendingInteractions.test.ts",
  "build/diff.test.mjs": "scripts/diff.test.ts",
  "build/attachments.test.mjs": "scripts/attachments.test.ts",
  "build/queue-view.test.mjs": "scripts/queueView.test.ts",
  "build/session-cookie.test.mjs": "scripts/sessionCookie.test.ts",
  "build/tool-view.test.mjs": "scripts/toolView.test.ts",
  "build/tool-card.test.mjs": "scripts/toolCard.test.ts",
  "build/thinking-stream.test.mjs": "scripts/thinkingStream.test.ts",
  "build/injected.test.mjs": "scripts/injected.test.ts",
  "build/unknown-event.test.mjs": "scripts/unknownEvent.test.ts",
  "build/changes-card.test.mjs": "scripts/changesCard.test.ts",
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
  "build/read-range.test.mjs": "scripts/readRange.test.ts",
  "build/segment.test.mjs": "scripts/segment.test.ts",
  "build/path-insert.test.mjs": "scripts/pathInsert.test.ts",
  "build/path-display.test.mjs": "scripts/pathDisplay.test.ts",
  "build/system-prompt-probe.mjs": "scripts/systemPromptProbe.ts",
  "build/effort-probe.mjs": "scripts/effortProbe.ts",
  "build/read-range-probe.mjs": "scripts/readRangeProbe.ts",
  "build/plan-command-probe.mjs": "scripts/planCommandProbe.ts",
  "build/goal-session-probe.mjs": "scripts/goalSessionProbe.ts",
  "build/session-log-scan.mjs": "scripts/sessionLogScan.ts",
  "build/session-list-probe.mjs": "scripts/sessionListProbe.ts",
  "build/session-list.test.mjs": "scripts/sessionList.test.ts",
  "build/process-registry.test.mjs": "scripts/processRegistry.test.ts",
  "build/config-changes.test.mjs": "scripts/configChanges.test.ts",
  "build/footnotes.test.mjs": "scripts/footnotes.test.ts",
  "build/question-flow.test.mjs": "scripts/questionFlow.test.ts",
  "build/plan-review.test.mjs": "scripts/planReview.test.ts",
  "build/question-render.test.mjs": "scripts/questionRender.test.ts",
  "build/mention-nav.test.mjs": "scripts/mentionNav.test.ts",
  "build/selection.test.mjs": "scripts/selection.test.ts",
  "build/workspace-probe.mjs": "scripts/workspaceProbe.ts",
  "build/history-replay.test.mjs": "scripts/historyReplay.test.ts",
  "build/render-order-probe.mjs": "scripts/renderOrderProbe.ts",
  "build/render-order.test.mjs": "scripts/renderOrder.test.ts",
  "build/live-order-probe.mjs": "scripts/liveOrderProbe.ts",
  "build/page-loop-probe.mjs": "scripts/pageLoopProbe.ts",
  "build/rail-jump-probe.mjs": "scripts/railJumpProbe.ts",
  "build/config-reload-probe.mjs": "scripts/configReloadProbe.ts",
  "build/window-state.test.mjs": "scripts/windowState.test.ts",
  "build/host-log.test.mjs": "scripts/hostLog.test.ts",
  "build/supervisor-protocol.test.mjs": "scripts/supervisorProtocol.test.ts",
  "build/supervisor-errors.test.mjs": "scripts/supervisorErrors.test.ts",
  "build/supervisor-policy.test.mjs": "scripts/supervisorPolicy.test.ts",
  "build/connect-target.test.mjs": "scripts/connectTarget.test.ts",
  "build/connection-stop.test.mjs": "scripts/connectionStop.test.ts",
  "build/auto-connect-config.test.mjs": "scripts/autoConnectConfig.test.ts",
  "build/connect-snapshot.test.mjs": "scripts/connectSnapshot.test.ts",
  "build/connect-view.test.mjs": "scripts/connectView.test.ts",
  "build/session-view.test.mjs": "scripts/sessionView.test.ts",
  "build/auto-scroll.test.mjs": "scripts/autoScroll.test.ts",
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
  "build/queue-order.test.mjs": "scripts/queueOrder.test.ts",
  "build/trajectory.test.mjs": "scripts/trajectory.test.ts",
  "build/turn-rail.test.mjs": "scripts/turnRail.test.ts",
  "build/manifest.test.mjs": "scripts/manifest.test.ts",
  "build/projection-store.test.mjs": "scripts/projectionStore.test.ts",
  "build/projection-ingest.test.mjs": "scripts/projectionIngest.test.ts",
  "build/projection-seq-probe.mjs": "scripts/projectionSeqProbe.ts",
  "build/activity.test.mjs": "scripts/activity.test.ts",
  "build/subagent-panel.test.mjs": "scripts/subagentPanel.test.ts",

};

await Promise.all(
  Object.entries(entries).map(([outfile, entryPoints]) =>
    esbuild.build({
      entryPoints: [entryPoints],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      logLevel: "info",
      banner,
      // 断言脚本里也有渲染断言（`scripts/questionRender.test.ts` 用
      // `react-dom/server` 真渲染问卷卡）：与 webview 那份产物同一个转换器，
      // 否则 TSX 会退回经典转换、要求一个不存在的 React 全局变量。
      jsx: "automatic",
    }),
  ),
);




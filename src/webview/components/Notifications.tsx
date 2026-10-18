import type { NotificationView } from "../../shared/chat";
import { post } from "../bridge";
import { ESC_LAYER, useEscapeLayer } from "../escapeOwner";
import { IconClose } from "../icons";
import { formatNotificationTime, notificationLevelClass, notificationList, topNotification } from "../notifications";
import { resolveText, useLocale, useTexts } from "../texts";

/**
 * 消息通知的顶部常驻条与通知抽屉（见 `docs/design-notifications.md`）。
 *
 * 两处都只**画**宿主给的镜像：不在本地增删 / 合并，也不改 `count`。确认把当时渲染出来的
 * `id` 与 `count` 一起回给宿主（迟到的一次点击不该吞掉它之后又发生的那次，见
 * `dsh/notificationQueue.ts`）。
 */

/** 确认一条：`count` 必须是**这次渲染出来的**那个数。 */
function acknowledge(notification: NotificationView): void {
  post({ type: "acknowledgeNotification", id: notification.id, count: notification.count });
}

/**
 * 顶部常驻通知条。
 *
 * 只展示**最近发生的未确认**那一条（`notifications.ts` 的判据），没有未确认时
 * **整个不渲染**——不占空间、不留空壳。它不自动消失（没有计时器），也不用 ✕ 当确认：
 * 确认是一颗写明的按钮，展开历史是另一颗。
 *
 * 新通知不自动弹开抽屉、不抢输入焦点（这里既没有 focus 调用，也没有自动开抽屉）。
 * 正文可能是几 KB 的异常栈或一条长路径，所以文本区给限高并内部滚动（样式见
 * `styles/app.css` 的 `.notice-bar`）——两颗按钮必须一直在可达位置，不能被正文挤掉。
 */
export function NotificationBar({
  notifications,
  sessionId,
  onOpenHistory,
}: {
  notifications: NotificationView[] | undefined;
  sessionId: string | undefined;
  onOpenHistory: () => void;
}) {
  const texts = useTexts();
  const top = topNotification(notifications, sessionId);
  if (!top) return null;
  return (
    <div className="notice-bar" role="status" aria-live="polite">
      <span className={notificationLevelClass(top.level)}>{resolveText(top.text, texts)}</span>
      {/* 顶部只在**重复发生**时报次数（次数是次要信息，正文才是这一条要说的） */}
      {top.count > 1 ? <span className="notice-count">{texts.notificationCount(top.count)}</span> : null}
      <span className="spacer" />
      <button type="button" className="btn notice-ack" onClick={() => acknowledge(top)}>
        {texts.notificationAcknowledge}
      </button>
      <button type="button" className="btn btn-ghost notice-history" onClick={onOpenHistory}>
        {texts.notificationHistory}
      </button>
    </div>
  );
}

/**
 * 通知抽屉：按最近发生顺序列出当前会话与共享的通知，逐条标出确认状态。
 *
 * 每条给全时间（含日期）、发生次数（1 也显示）、归属会话 ID（共享显示「共享」）与逐条
 * 确认；没有「一键全确认」。关闭 / ESC 只收起抽屉（`useEscapeLayer` 的抽屉层），
 * **不确认**任何一条、也不停生成——抽屉顶掉会话页之后兜底的「停止生成」本来就不存在
 * （`isConversationForeground` 只认 none）。队列为空（或全部确认）时仍有空态可看：
 * 这条抽屉是「DSH: 查看消息通知」命令的唯一落点。
 */
export function NotificationsPanel({
  notifications,
  sessionId,
  onClose,
}: {
  notifications: NotificationView[] | undefined;
  sessionId: string | undefined;
  onClose: () => void;
}) {
  const texts = useTexts();
  const locale = useLocale();
  // 抽屉一挂上就是开着（App 只在面板为 notifications 时渲染它），ESC 归它
  useEscapeLayer(ESC_LAYER.drawer, true, onClose);
  const items = notificationList(notifications, sessionId);

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer" role="dialog" aria-label={texts.notifications}>
        <div className="drawer-head">
          <span>{texts.notifications}</span>
          <span className="spacer" style={{ flex: 1 }} />
          <button className="icon-btn" title={texts.close} onClick={onClose}>
            <IconClose size={14} />
          </button>
        </div>
        <div className="drawer-body">
          {items.length === 0 ? (
            <div className="popover-empty">{texts.notificationsEmpty}</div>
          ) : (
            items.map((notification) => (
              <div
                key={notification.id}
                className={`notice-item${notification.acknowledged ? " is-acked" : ""}`}
              >
                <div className="notice-item-main">
                  <span className={notificationLevelClass(notification.level)}>
                    {resolveText(notification.text, texts)}
                  </span>
                  <span className="notice-meta">
                    <span className="notice-status">
                      {notification.acknowledged
                        ? texts.notificationsAcknowledged
                        : texts.notificationsUnacknowledged}
                    </span>
                    <span
                      className="notice-time"
                      // 首次发生时刻放进 title：不必为它多占一行（最近发生已经写在外面）
                      title={texts.notificationFirstAt(
                        formatNotificationTime(notification.firstAt, locale),
                      )}
                    >
                      {formatNotificationTime(notification.lastAt, locale)}
                    </span>
                    {/* 历史里的次数**1 也显示**：这一列是「发生过几次」的读数，不是强调 */}
                    <span className="notice-count">{texts.notificationCount(notification.count)}</span>
                    <span
                      className="notice-session"
                      title={notification.sessionId ?? texts.notificationShared}
                    >
                      <span className="notice-session-label">{texts.notificationSession}</span>
                      {/* 完整会话 ID（**不截断**）：窄侧栏里靠 overflow-wrap 折行 */}
                      <span className="notice-session-id">
                        {notification.sessionId ?? texts.notificationShared}
                      </span>
                    </span>
                  </span>
                </div>
                {notification.acknowledged ? null : (
                  <button
                    type="button"
                    className="btn notice-ack"
                    onClick={() => acknowledge(notification)}
                  >
                    {texts.notificationAcknowledge}
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

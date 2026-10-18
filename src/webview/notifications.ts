import type { NotificationView } from "../shared/chat";

/**
 * 消息通知的**展示口径**：顶部取哪一条、抽屉怎么分组、级别怎么落到已有的
 * `.notice` 修饰类上。
 *
 * 队列本体是宿主权威的一份（`src/dsh/notificationQueue.ts`），界面拿到的是按窗口
 * 过滤好的**镜像**。这里只做「读」——排序 / 筛选 / 分组都是纯函数，界面**不增删合并**
 * 任何一条，确认也走宿主的 `acknowledgeNotification` 帧（见
 * `components/Notifications.tsx`）。
 */

/**
 * 级别 → 文案类。
 *
 * 复用消息正文 `.notice` 那一套（红 / 黄 / 绿），绿色是 `notice-info`：
 * `--info` 是思考鲸鱼的专属蓝，**不能**拿它当「绿色重要变化」——`docs/design-notifications.md`
 * 的 info 档指的就是绿色（执行目录改变这类）。
 */
export function notificationLevelClass(level: NotificationView["level"]): string {
  if (level === "error") return "notice notice-error";
  if (level === "warn") return "notice notice-warn";
  return "notice notice-info";
}

/**
 * 这个视图看得见的那一份：当前会话的通知 + 共享通知（没有绑定会话时只有共享）。
 *
 * 宿主的镜像本就按窗口绑定的会话滤过一次，这里再滤一遍是**防御**：直连夹具或旧宿主
 * 把整队列推过来时，别的会话的通知不该出现在当前视图里。它只做筛选，不改任何一条的
 * 内容与次数——那不是「本地增删」。
 */
export function visibleNotifications(
  notifications: NotificationView[] | undefined,
  sessionId: string | undefined,
): NotificationView[] {
  if (!notifications?.length) return [];
  return notifications.filter(
    (notification) => notification.sessionId === undefined || notification.sessionId === sessionId,
  );
}

/**
 * 顶部那一枚：可见范围内**最近发生**的未确认通知。
 *
 * 并列（同一毫秒）时取列表里靠前的那一条——镜像的顺序本身就是宿主按最近发生排好的
 * （`notificationQueue.visible` 的排序），所以「谁在前」已经是权威的最近口径。
 */
export function topNotification(
  notifications: NotificationView[] | undefined,
  sessionId: string | undefined,
): NotificationView | undefined {
  let best: NotificationView | undefined;
  for (const notification of visibleNotifications(notifications, sessionId)) {
    if (notification.acknowledged) continue;
    if (!best || notification.lastAt > best.lastAt) best = notification;
  }
  return best;
}

/**
 * 抽屉要渲染的那一份：与顶部同一份可见范围、**保持宿主的最近发生顺序**。
 *
 * 刻意**不**按「未确认在前 / 已确认在后」重排：整体顺序就是最近发生顺序，重排会把一条
 * 很旧的未确认顶到一条刚确认的前面，「最近发生」在两个地方讲两个故事。是否已确认是
 * 每条的**状态**（抽屉里逐条标出），不是分区。
 */
export function notificationList(
  notifications: NotificationView[] | undefined,
  sessionId: string | undefined,
): NotificationView[] {
  return visibleNotifications(notifications, sessionId);
}

/**
 * 通知时间的展示：本地化的**日期 + 时间**。
 *
 * 抽屉里的历史会跨天，只给时分会看不出是哪一天（同一时刻的今天与三天前长得一样）；
 * 具体到分就够（通知不是秒级事件），也短得能在窄侧栏里换行。
 *
 * @param locale 宿主下发的语言（`state.locale`，如 `zh-cn`）；坏串 / 缺失时退回运行时默认。
 */
export function formatNotificationTime(at: number, locale: string | undefined): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    // 语言标识非法（RangeError）：退回运行时默认语言，不因为一个坏串丢掉时间
    return new Intl.DateTimeFormat(undefined, options).format(date);
  }
}

import type { SVGProps } from "react";

/**
 * Line icons in the same visual family Continue uses (heroicons outline, MIT):
 * 24×24 viewBox, 1.6 stroke, round caps, no fill, inheriting currentColor.
 * Sizing is left to CSS so icons stay crisp at 12/14/16px.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 14, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconPlus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const IconHistory = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
    <path d="M12 8v4.5l3 1.8" />
  </Icon>
);

export const IconOpenInEditor = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 4h6v6" />
    <path d="M20 4l-8.5 8.5" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Icon>
);

/**
 * 齿轮。早先那版用手写的超长弧形路径，锚点算错后在 14px 下会糊成一团
 * （看起来像「花掉的螺丝」），这里改成规则的 8 齿几何路径。
 */
export const IconSettings = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10.6 3.2a1.4 1.4 0 0 1 1.4-1.2h0a1.4 1.4 0 0 1 1.4 1.2l.2 1.5a1.2 1.2 0 0 0 1.8.75l1.3-.75a1.4 1.4 0 0 1 1.75.45l0 0a1.4 1.4 0 0 1-.2 1.8l-1.15 1a1.2 1.2 0 0 0 0 1.8l1.15 1a1.4 1.4 0 0 1 .2 1.8l0 0a1.4 1.4 0 0 1-1.75.45l-1.3-.75a1.2 1.2 0 0 0-1.8.75l-.2 1.5a1.4 1.4 0 0 1-1.4 1.2h0a1.4 1.4 0 0 1-1.4-1.2l-.2-1.5a1.2 1.2 0 0 0-1.8-.75l-1.3.75a1.4 1.4 0 0 1-1.75-.45l0 0a1.4 1.4 0 0 1 .2-1.8l1.15-1a1.2 1.2 0 0 0 0-1.8l-1.15-1a1.4 1.4 0 0 1-.2-1.8l0 0a1.4 1.4 0 0 1 1.75-.45l1.3.75a1.2 1.2 0 0 0 1.8-.75z" />
    <circle cx="12" cy="12" r="2.6" />
  </Icon>
);

/** 权限盾牌：三种模式共用外形，靠内部记号区分（WebUI 未提供专用图标）。 */
export const IconShield = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3l7 2.5v6c0 4.2-2.9 7.9-7 9.5-4.1-1.6-7-5.3-7-9.5v-6z" />
  </Icon>
);

export const IconShieldCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3l7 2.5v6c0 4.2-2.9 7.9-7 9.5-4.1-1.6-7-5.3-7-9.5v-6z" />
    <path d="M9 12l2.2 2.2L15.5 10" />
  </Icon>
);

export const IconShieldFilled = (p: IconProps) => (
  <Icon {...p}>
    <path
      d="M12 3l7 2.5v6c0 4.2-2.9 7.9-7 9.5-4.1-1.6-7-5.3-7-9.5v-6z"
      fill="currentColor"
    />
  </Icon>
);

/** 子代理（一个主节点分出两个分支）。 */
export const IconAgents = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="4.5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="19" r="2" />
    <path d="M12 6.5v4M6 17v-3.5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2V17" />
  </Icon>
);

/** 后台任务（终端里的清单）。 */
export const IconJobs = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 9h6M7 13h10M7 17h4" />
  </Icon>
);

export const IconSlash = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15 4l-6 16" />
  </Icon>
);

export const IconChevronLeft = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15 5l-7 7 7 7" />
  </Icon>
);

/** 撤销/重置。小尺寸下用单条回绕箭头比「垃圾桶＋叉」清晰得多。 */
export const IconUndo = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 9h9.5a5.5 5.5 0 0 1 0 11H8" />
    <path d="M7.5 5.5L4 9l3.5 3.5" />
  </Icon>
);

export const IconStop = (p: IconProps) => (
  <Icon {...p}>
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  </Icon>
);

export const IconSend = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 12h16" />
    <path d="M13 5l7 7-7 7" />
  </Icon>
);

export const IconCopy = (p: IconProps) => (
  <Icon {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </Icon>
);

export const IconChevronRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 5l7 7-7 7" />
  </Icon>
);

export const IconChevronDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 9l7 7 7-7" />
  </Icon>
);

export const IconSparkles = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z" />
    <path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z" />
  </Icon>
);

export const IconChat = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 15a2 2 0 0 1-2 2H8l-4 3.5V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
  </Icon>
);

export const IconImage = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="9.5" r="1.5" />
    <path d="M4 17l4.5-4.5a2 2 0 0 1 2.8 0L20 21" />
  </Icon>
);

export const IconAt = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M16 8v5a3 3 0 0 0 5.1 2.1A9 9 0 1 0 17.6 20" />
  </Icon>
);

export const IconBulb = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 18h6" />
    <path d="M10 21h4" />
    <path d="M12 3a6 6 0 0 0-3.5 10.9c.4.3.5.7.5 1.1v1h6v-1c0-.4.1-.8.5-1.1A6 6 0 0 0 12 3z" />
  </Icon>
);

export const IconFile = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </Icon>
);

export const IconFolder = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L11.4 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Icon>
);

export const IconCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 13l4.5 4.5L19 7" />
  </Icon>
);

export const IconClose = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

export const IconAlert = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10.3 4.3L2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4M12 17h.01" />
  </Icon>
);

export const IconQuestion = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.4v.3" />
    <path d="M12 17h.01" />
  </Icon>
);

export const IconTerminal = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 9l3 3-3 3M13 15h4" />
  </Icon>
);

export const IconPencil = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16z" />
    <path d="M14 6l4 4" />
  </Icon>
);

export const IconSearch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="6" />
    <path d="M20 20l-4.5-4.5" />
  </Icon>
);

export const IconList = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 6h12M8 12h12M8 18h12" />
    <path d="M4 6h.01M4 12h.01M4 18h.01" />
  </Icon>
);

export const IconRead = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5z" />
    <path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H19v3H6.5" />
  </Icon>
);

export const IconWrite = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3v12" />
    <path d="M7.5 10.5L12 15l4.5-4.5" />
    <path d="M4 17.5V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.5" />
  </Icon>
);

export const IconGlobe = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3c2.5 2.5 3.8 5.6 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.6-3.8-9S9.5 5.5 12 3z" />
  </Icon>
);

/** 归档盒（heroicons archive-box outline）：从工作区列表移出会话。 */
export const IconArchive = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.75 7.5a3 3 0 0 1 3-3h10.5a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H6.75a3 3 0 0 1-3-3z" />
    <path d="M3.75 7.5h16.5" />
    <path d="M9.5 11.5h5" />
  </Icon>
);

export const IconTrash = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h16" />
    <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
  </Icon>
);

export const IconBrain = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5.5A3 3 0 0 0 6.2 6.8 3 3 0 0 0 4 9.6a3 3 0 0 0 .9 5.2A3 2.5 0 0 0 9 19a3 3 0 0 0 3-1.6z" />
    <path d="M12 5.5A3 3 0 0 1 17.8 6.8 3 3 0 0 1 20 9.6a3 3 0 0 1-.9 5.2A3 2.5 0 0 1 15 19a3 3 0 0 1-3-1.6z" />
  </Icon>
);

export const IconPlug = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 3v5M15 3v5" />
    <path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6z" />
    <path d="M12 17v4" />
  </Icon>
);

export const IconExternal = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 4h6v6" />
    <path d="M20 4l-8 8" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Icon>
);

export const IconRefresh = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 12a8 8 0 1 1-2.3-5.6" />
    <path d="M20 4v5h-5" />
  </Icon>
);

/** 轨迹：一条曲线串起三个节点（本会话全部工具调用的时间线）。 */
export const IconTrajectory = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="5" cy="19" r="2" />
    <circle cx="12" cy="9" r="2" />
    <circle cx="19" cy="5" r="2" />
    <path d="M6.5 17.5L10.5 10.5M13.5 7.8L17.2 6" />
  </Icon>
);

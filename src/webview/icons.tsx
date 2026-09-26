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

/** 目标条的目标字形（靶心）。 */
export const IconTarget = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="3.2" />
  </Icon>
);

/** 暂停目标（两根竖条）。 */
export const IconPause = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9.5 5v14M14.5 5v14" />
  </Icon>
);

/** 恢复目标（播放三角）。 */
export const IconPlay = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 5.5v13l10-6.5z" />
  </Icon>
);

/**
 * agent 预设（三个节点两两相连）。
 *
 * 形状与官方 `IconAgentPresetOutline16` 同义：预设就是「一个会话组装了哪些插件」，
 * 那三个节点是组装里的角色。本仓库的图标是描边家族，所以按 24 视窗重画，不搬它的
 * 填充路径。
 */
export const IconAgentPreset = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="5.2" r="2.2" />
    <circle cx="6" cy="18" r="2.2" />
    <circle cx="18" cy="18" r="2.2" />
    <path d="M10.8 7.1 7.2 15.8M13.2 7.1l3.6 8.7M8.2 18h7.6" />
  </Icon>
);

/** 代码类工具（`run_code`）。 */
export const IconCode = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 7.5 4.5 12 9 16.5M15 7.5 19.5 12 15 16.5" />
  </Icon>
);

/**
 * 分支：主线**自上而下**（左侧竖干），支线从主干**向右**分出去、再自上而下
 * 落到自己的端点。
 *
 * 旧版是三个圆点 + 一段没接到主干的弧：弧线悬在半空、也没有明确的「分出方向」，
 * 15px 下看不出哪条是分支（用户 2026-09-14 口径：分支方向应当是自上而下或
 * 从左至右）。现在按 git 分支图的读法画：竖干两端各一个端点圆，支线从竖干
 * 中部向右拐出、再向下接到右边的端点圆。
 */
export const IconBranch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="7" cy="5" r="2.2" />
    <circle cx="7" cy="19" r="2.2" />
    <circle cx="17.5" cy="19" r="2.2" />
    <path d="M7 7.2v9.6" />
    <path d="M7 12h6.5a4 4 0 0 1 4 4v0.8" />
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

/**
 * 权限盾牌（Auto review 档）：同一个盾牌外形 + 内部的「审查之眼」。
 *
 * 官方 `ui-permission-presets` 的档位表只给三档配了图形（`permissionGlyphs`），
 * Auto 那一档**没有图标**；而本扩展工具栏的最小档位是「只有盾牌图标」，缺图标
 * 时那枚胶囊会变成空的、权限列表里那一行也会比别的行少一截。所以按既有口径
 * （三种模式共用外形、靠内部记号区分）自补一个可辨识的记号。
 */
export const IconShieldReview = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3l7 2.5v6c0 4.2-2.9 7.9-7 9.5-4.1-1.6-7-5.3-7-9.5v-6z" />
    <path d="M8.4 11.4c1-1.3 2.2-2 3.6-2s2.6.7 3.6 2c-1 1.3-2.2 2-3.6 2s-2.6-.7-3.6-2z" />
    <circle cx="12" cy="11.4" r="0.9" />
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

/**
 * 扳手（Feather `tool`，MIT）：未知类工具节点（`others` 变体）的兜底图标。
 * 单条闭合路径、规整圆弧，13px 下与齿轮同标准——糊不成团。
 */
export const IconWrench = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.92 6.92a2.12 2.12 0 0 1-3-3l6.92-6.92a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </Icon>
);

export const IconChat = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 15a2 2 0 0 1-2 2H8l-4 3.5V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
  </Icon>
);

export const IconFile = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </Icon>
);

/** 回形针：通用附件入口（图片与普通文件同一个按钮）。 */
export const IconAttach = (p: IconProps) => (
  <Icon {...p}>
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
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

/**
 * 地球：顶部「在浏览器中打开」用的图标（VS Code 自己的 Simple Browser 也是地球）。
 *
 * 这里**必须**与「在编辑器中打开」的 `IconOpenInEditor` 区分开。两者原先都是
 * 「方框 + 右上角箭头」——本图标旁边的 `IconExternal` 就是那个形状（文件链接行在用），
 * 与 `IconOpenInEditor` 只差斜线长短（8.5 vs 8），15px 下完全分不出来（用户 2026-09-15
 * 报的：两颗按钮看起来一模一样）。地球的圆 + 赤道 + 经线在任何尺寸下都不会与
 * 方框类图标混淆。
 */
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

/** 时钟：轮尾「用时 X」胶囊的图标（官方 `IconClockOutline16` 同义）。 */
export const IconClock = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8v4.5l3 1.5" />
  </Icon>
);

/** 钥匙：外部服务器的访问令牌入口（heroicons 24/outline `key`）。 */
export const IconKey = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15.75 5.25C17.4069 5.25 18.75 6.59315 18.75 8.25M21.75 8.25C21.75 11.5637 19.0637 14.25 15.75 14.25C15.3993 14.25 15.0555 14.2199 14.7213 14.1622C14.1583 14.0649 13.562 14.188 13.158 14.592L10.5 17.25H8.25V19.5H6V21.75H2.25V18.932C2.25 18.3352 2.48705 17.7629 2.90901 17.341L9.408 10.842C9.81202 10.438 9.93512 9.84172 9.83785 9.2787C9.7801 8.94446 9.75 8.60074 9.75 8.25C9.75 4.93629 12.4363 2.25 15.75 2.25C19.0637 2.25 21.75 4.93629 21.75 8.25Z" />
  </Icon>
);

/**
 * 轨迹：一条从起点绕到终点的路径（两端各一个端点圆，中间一段 S 形折线）。
 *
 * 旧版是三个圆点 + 两小段连线，15px 下只剩三个点、既不像路径也不说明「做过什么」；
 * 现在按「路线」的读法画：起点 → 折过去 → 终点，一眼能读出「这次会话走过的路」，
 * 与相邻的历史（时钟回绕）与分支（git 分叉）也不撞形状。
 */
export const IconTrajectory = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="5.5" cy="18.5" r="2.6" />
    <circle cx="18.5" cy="5.5" r="2.6" />
    <path d="M8.1 18.5h8.4a3.25 3.25 0 0 0 0-6.5H7.5a3.25 3.25 0 0 1 0-6.5h8.4" />
  </Icon>
);

/**
 * 扩展签名图标（media/icon.svg，填充涂鸦，50×50 viewBox）：
 * 用作「思考」图标，思考中由 .icon-glow 点亮发光。
 */
export const IconDsh = (p: IconProps) => (
  <svg
    width={p.size ?? 14}
    height={p.size ?? 14}
    viewBox="0 0 50 50"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z" fillRule="nonzero" />
  </svg>
);

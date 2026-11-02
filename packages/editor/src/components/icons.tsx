import type { ReactNode, Ref } from "react";

/** Original 16 px stroke icons; currentColor, no external icon set. */
const paths = {
  new: (
    <>
      <path d="M4 1.5h5.5L13 5v9.5H4z" />
      <path d="M9.5 1.5V5H13M8.5 8v4M6.5 10h4" />
    </>
  ),
  open: (
    <>
      <path d="M1.5 4V13h11l2-6H4l-2.5 6" />
      <path d="M1.5 4V2.5h4l1.5 1.5h5V7" />
    </>
  ),
  save: (
    <>
      <path d="M8 2v8M4.5 6.5 8 10l3.5-3.5" />
      <path d="M2 11v3h12v-3" />
    </>
  ),
  archive: (
    <>
      <path d="M2 4.5 8 2l6 2.5v7L8 14l-6-2.5z" />
      <path d="M2 4.5 8 7l6-2.5M8 7v7" />
    </>
  ),
  export: (
    <>
      <path d="M8 10V2M4.5 5.5 8 2l3.5 3.5" />
      <path d="M5 8H2.5v6h11V8H11" />
    </>
  ),
  undo: <path d="M5.5 3 2.5 6l3 3M2.5 6H10a3.5 3.5 0 0 1 0 7H7" />,
  redo: <path d="m10.5 3 3 3-3 3M13.5 6H6a3.5 3.5 0 0 0 0 7h3" />,
  history: (
    <>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" />
      <path d="M2 2.5v2.5h2.5M8 5v3l2 1.5" />
    </>
  ),
  eye: (
    <>
      <path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  play: <path d="M5 3v10l8-5z" />,
  presenter: (
    <>
      <rect x="1.5" y="2.5" width="9" height="7" rx="1" />
      <path d="M4 12.5h4M6 9.5v3M12.5 4.5v6M14.5 6.5v2" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  copy: (
    <>
      <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" />
      <path d="M3 10.5H2.5v-8h8V3" />
    </>
  ),
  trash: (
    <>
      <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4" />
      <path d="M6.7 6.5v4.5M9.3 6.5v4.5" />
    </>
  ),
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  frame: (
    <>
      <rect x="3.5" y="3.5" width="9" height="9" />
      <path d="M1 3.5h1.5M13.5 3.5H15M1 12.5h1.5M13.5 12.5H15M3.5 1v1.5M12.5 1v1.5M3.5 13.5V15M12.5 13.5V15" />
    </>
  ),
  "align-left": <path d="M2 1.5v13M4.5 4h9M4.5 8h5.5M4.5 12h7.5" />,
  "align-center": <path d="M8 1.5v13M3.5 4h9M5 8h6M4 12h8" />,
  "align-right": <path d="M14 1.5v13M2.5 4h9M6 8h5.5M4 12h7.5" />,
  "align-top": <path d="M1.5 2h13M4 4.5v9M8 4.5V10M12 4.5V12" />,
  "align-middle": <path d="M1.5 8h13M4 3.5v9M8 5v6M12 4v8" />,
  "align-bottom": <path d="M1.5 14h13M4 2.5v9M8 6v5.5M12 4v7.5" />,
  "distribute-h": (
    <>
      <path d="M1.5 2v12M14.5 2v12" />
      <rect x="5.5" y="4.5" width="5" height="7" rx="1" />
    </>
  ),
  "distribute-v": (
    <>
      <path d="M2 1.5h12M2 14.5h12" />
      <rect x="4.5" y="5.5" width="7" height="5" rx="1" />
    </>
  ),
  forward: (
    <>
      <path d="M8 2 2 5l6 3 6-3z" />
      <path d="m2 8 6 3 6-3" opacity=".45" />
    </>
  ),
  backward: (
    <>
      <path d="m2 5 6 3 6-3" opacity=".45" />
      <path d="m2 8 6 3 6-3-6-3z" />
    </>
  ),
  front: (
    <>
      <path d="M8 1.5 2 4.5l6 3 6-3z" />
      <path d="m2 7.5 6 3 6-3M2 10.5l6 3 6-3" opacity=".45" />
    </>
  ),
  back: (
    <>
      <path d="m2 4.5 6 3 6-3M2 7.5l6 3 6-3" opacity=".45" />
      <path d="m2 10.5 6 3 6-3-6-3z" />
    </>
  ),
  grid: (
    <path d="M1.5 5.5h13M1.5 10.5h13M5.5 1.5v13M10.5 1.5v13M1.5 1.5h13v13h-13z" />
  ),
  "select-all": (
    <>
      <path d="M2 4.5V2h2.5M11.5 2H14v2.5M14 11.5V14h-2.5M4.5 14H2v-2.5" />
      <rect x="5" y="5" width="6" height="6" />
    </>
  ),
  deselect: (
    <>
      <path d="M2 4.5V2h2.5M11.5 2H14v2.5M14 11.5V14h-2.5M4.5 14H2v-2.5" />
      <path d="m5.5 5.5 5 5M10.5 5.5l-5 5" />
    </>
  ),
  up: <path d="M8 13V3M4 7l4-4 4 4" />,
  down: <path d="M8 3v10M4 9l4 4 4-4" />,
  "text-start": <path d="M2 3.5h12M2 6.5h8M2 9.5h12M2 12.5h7" />,
  "text-center": <path d="M2 3.5h12M4 6.5h8M2 9.5h12M4.5 12.5h7" />,
  "text-end": <path d="M2 3.5h12M6 6.5h8M2 9.5h12M7 12.5h7" />,
  "text-justify": <path d="M2 3.5h12M2 6.5h12M2 9.5h12M2 12.5h12" />,
  "v-start": <path d="M2 2h12M5 5h6M5 8h6" />,
  "v-center": <path d="M5 6.5h6M5 9.5h6M2 2h12M2 14h12" opacity="1" />,
  "v-end": <path d="M2 14h12M5 8h6M5 11h6" />,
  warning: (
    <>
      <path d="M8 1.8 14.8 14H1.2z" />
      <path d="M8 6.5v3.5M8 11.8v.4" />
    </>
  ),
  layers: (
    <>
      <path d="M8 2 2 5l6 3 6-3z" />
      <path d="m2 8 6 3 6-3M2 11l6 3 6-3" />
    </>
  ),
  "chevron-down": <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />,
  "chevron-left": <path d="m10 3.5-4.5 4.5 4.5 4.5" />,
  "chevron-right": <path d="m6 3.5 4.5 4.5L6 12.5" />,
  "arrow-left": <path d="M13 8H3M7 4 3 8l4 4" />,
  "arrow-right": <path d="M3 8h10M9 4l4 4-4 4" />,
  pause: <path d="M5.5 3.5v9M10.5 3.5v9" />,
  "zoom-out": <path d="M3.5 8h9" />,
  reset: (
    <>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" />
      <path d="M2 2.5v2.5h2.5" />
    </>
  ),
  link: (
    <path d="M6.5 9.5 9.5 6.5M7 4.5l1.3-1.3a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2M9 11.5l-1.3 1.3a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8" />
  ),
  device: (
    <>
      <rect x="2.5" y="3" width="11" height="8" rx="1.5" />
      <path d="M5.5 13.5h5" />
    </>
  ),
  "type-text": <path d="M3 3.5h10M8 3.5v9" />,
  "type-markdown": <path d="M2 12V4l3 4 3-4v8M11.5 4v7.5M9.5 9.5l2 2 2-2" />,
  "type-html": <path d="M5 4 1.5 8 5 12M11 4l3.5 4-3.5 4" />,
  "type-svg": <path d="M2.5 12.5C5 12.5 4 3.5 8 3.5s3 9 5.5 9" />,
  "type-latex": <path d="M12 3.5H4l4 4.5-4 4.5h8" />,
  "type-image": (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="m2 11 3.5-3.5 3 3 2-2L14 12" />
      <circle cx="10.5" cy="6" r="1" />
    </>
  ),
  "type-audio": (
    <path d="M2.5 6.5v3h2.5l3.5 3v-9L5 6.5zM11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4" />
  ),
  "type-video": (
    <>
      <rect x="1.5" y="4.5" width="9" height="7" rx="1.5" />
      <path d="m10.5 7 4-2v6l-4-2" />
    </>
  ),
  "type-embed": (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M1.5 5.5h13M6 8.5 4.5 10 6 11.5M10 8.5l1.5 1.5-1.5 1.5" />
    </>
  ),
  "type-plugin": (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
      <path d="M8 5.5v5M5.5 8h5" />
    </>
  ),
} satisfies Record<string, ReactNode>;
export type IconName = keyof typeof paths;
/** Product mark: three planes in depth. Decorative. */
export function BrandMark() {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 20 20"
      width="20"
      height="20"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="7" y="2" width="11" height="8" rx="2" opacity=".3" />
      <rect x="4.5" y="5.5" width="11" height="8" rx="2" opacity=".6" />
      <rect x="2" y="9" width="11" height="8" rx="2" />
    </svg>
  );
}
export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
/**
 * Icon-only button: the accessible name is the label, shown as a tooltip on
 * hover and keyboard focus. tabIndex keeps it in WebKit's Tab order.
 */
export function IconButton({
  icon,
  label,
  onClick,
  pressed,
  disabled = false,
  shortcut,
  className = "",
  tip = "bottom",
  ref,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  shortcut?: string;
  className?: string;
  tip?: "bottom" | "top" | "left";
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type="button"
      tabIndex={0}
      className={`icon-button ${className}`}
      aria-label={label}
      data-tip={shortcut ? `${label} · ${shortcut}` : label}
      data-tip-side={tip}
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  );
}

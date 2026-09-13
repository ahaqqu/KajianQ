/**
 * The logo tile: an 8-pointed star (rub el hizb) emblem on the theme's
 * primary tile — dark green in light mode, gold in dark mode. Pure SVG, no
 * external asset; sizes follow the reference treatments (header, avatar,
 * empty state).
 */
const SIZES = {
  sm: "size-7 rounded-lg",
  md: "size-10 rounded-xl",
  lg: "size-14 rounded-2xl",
} as const;

export function LogoTile({ size }: { size: keyof typeof SIZES }) {
  return (
    <div
      className={`flex shrink-0 items-center justify-center bg-primary text-primary-foreground ${SIZES[size]}`}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="size-[60%]"
        aria-hidden="true"
      >
        <rect x="6.2" y="6.2" width="11.6" height="11.6" />
        <rect x="6.2" y="6.2" width="11.6" height="11.6" transform="rotate(45 12 12)" />
        <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      </svg>
    </div>
  );
}

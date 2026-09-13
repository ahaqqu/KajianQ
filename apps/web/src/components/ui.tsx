import type { ComponentProps, ReactNode } from "react";

/** Minimal shadcn-like primitives (owned source), themed by the design tokens. */
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-2xl border border-border bg-card p-4 text-card-foreground ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * The reference's mono-uppercase label primitive (thermo-review B1): one
 * treatment — mono, uppercase, 0.2em tracking, muted — so the label voice
 * cannot drift per call site. Callers override only size/color via className.
 */
export function MonoLabel({
  children,
  className = "",
  ...rest
}: { children: ReactNode; className?: string } & ComponentProps<"p">) {
  return (
    <p
      className={`font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground ${className}`}
      {...rest}
    >
      {children}
    </p>
  );
}

export function CardLabel({ children }: { children: ReactNode }) {
  return <MonoLabel>{children}</MonoLabel>;
}

const LOGO_SIZES = {
  sm: "size-7 rounded-lg",
  md: "size-10 rounded-xl",
  lg: "size-14 rounded-2xl",
} as const;

/**
 * The logo tile: an 8-pointed star (rub el hizb) emblem on the theme's
 * primary tile — dark green in light mode, gold in dark mode. Pure SVG, no
 * external asset; sizes follow the reference treatments (header, avatar,
 * empty state).
 */
export function LogoTile({ size }: { size: keyof typeof LOGO_SIZES }) {
  return (
    <div
      className={`flex shrink-0 items-center justify-center bg-primary text-primary-foreground ${LOGO_SIZES[size]}`}
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

import type { ComponentProps, ReactNode } from "react";

// Re-exported so `AppHeader` (capped at 5 imports by `agentic-limits`) can
// reach the shared nav views without a sixth import; the implementation lives
// in the leaf `lib/routes` beside the nav list it derives from (thermo-review C3).
export { NavLinks } from "../lib/routes";
// Same cap arrangement for the collection page's "Ask about this source"
// affordance (#175): the link lives in the `lib/` leaf, beside the route tree
// it targets.
export { AskAboutLink } from "../lib/collection-ask";

/** Minimal shadcn-like primitives (owned source), themed by the design tokens. */
export function Card({
  children,
  className = "",
  ...rest
}: { children: ReactNode; className?: string } & ComponentProps<"div">) {
  return (
    <div
      className={`rounded-2xl border border-border bg-card p-4 text-card-foreground ${className}`}
      {...rest}
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

/**
 * The static pages' shared heading (About, Collection): the reference's
 * serif-italic h1 over a muted intro paragraph, in the app's single-column
 * voice. Owned here so both pages cannot drift apart.
 */
export function PageIntro({ title, intro }: { title: string; intro: string }) {
  return (
    <div className="space-y-2">
      <h1 className="font-serif text-3xl font-semibold italic">{title}</h1>
      <p className="text-sm leading-relaxed text-muted-foreground">{intro}</p>
    </div>
  );
}

/**
 * The Available/Planned distinction (mandatory on the collection page): a
 * filled primary pill for an ingested, citable source, and a dashed outline in
 * muted tones for registered-but-not-ingested work. Both are mono uppercase so
 * the pair reads as one system and neither can be mistaken for the other.
 */
export function StatusBadge({ status, label }: { status: "available" | "planned"; label: string }) {
  const tone =
    status === "available"
      ? "border border-primary bg-primary text-primary-foreground"
      : "border border-dashed border-border text-muted-foreground";
  return (
    <span
      data-testid="collection-status"
      data-status={status}
      className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] ${tone}`}
    >
      {label}
    </span>
  );
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

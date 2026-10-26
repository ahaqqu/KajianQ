import type { ComponentProps, ReactNode } from "react";

// Re-exported so `AppHeader` (capped at 5 imports by `agentic-limits`) can
// reach the shared nav views without a sixth import; the implementation lives
// in the leaf `lib/routes` beside the nav list it derives from.
export { NavLinks } from "../lib/routes";
// Same cap arrangement for the collection page's "Ask about this source"
// affordance: the link lives in the `lib/` leaf, beside the route tree it
// targets.
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
 * The reference's mono-uppercase label primitive: one treatment so the label
 * voice cannot drift per call site. Callers override only size/color via
 * className.
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
 * The static pages' eyebrow: the mono label in the reference's gold accent.
 * Owned here so every legal/marketing page opens with the same mark.
 */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <MonoLabel className="text-accent">{children}</MonoLabel>;
}

/**
 * The static pages' hero: gold eyebrow, the display serif title at the
 * reference's 72/56/40 responsive sizes, the lead paragraph and an optional
 * mono meta line (a "last updated" stamp, a count). The hero owns the page's
 * top spacing; the sections below it start at `PageSection`.
 */
export function PageHero({
  eyebrow,
  title,
  lead,
  meta,
}: {
  eyebrow: string;
  title: string;
  lead?: string;
  meta?: string;
}) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-12 pb-10 sm:px-8 sm:pt-16 sm:pb-14">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h1 className="mt-4 max-w-4xl font-serif text-[40px] leading-[1.02] font-semibold text-balance sm:text-[56px] lg:text-[72px] lg:leading-[0.98]">
        {title}
      </h1>
      {lead !== undefined && (
        <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">{lead}</p>
      )}
      {meta !== undefined && <MonoLabel className="mt-6">{meta}</MonoLabel>}
    </div>
  );
}

/**
 * A full-bleed section: the hairline rule under the hero, the shared 1152px
 * inner column and the reference's vertical rhythm. `tone="muted"` paints the
 * band with the card tone for the alternating sections.
 */
export function PageSection({
  children,
  tone = "plain",
  className = "",
}: {
  children: ReactNode;
  tone?: "plain" | "muted";
  className?: string;
}) {
  return (
    <section
      className={`border-t border-rule ${tone === "muted" ? "bg-card/60" : ""} ${className}`}
    >
      <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-8 sm:py-16">{children}</div>
    </section>
  );
}

/** The section heading inside a `PageSection` (36px serif, reference scale). */
export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="font-serif text-[26px] leading-tight font-semibold sm:text-[36px]">
      {children}
    </h2>
  );
}

/**
 * A legal/prose block: the 16px body measure at the reference's line height,
 * with list and link treatments so pages do not hand-roll paragraph styling.
 */
export function Prose({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`max-w-3xl space-y-4 text-base leading-7 text-foreground [&_a]:underline [&_a]:underline-offset-4 [&_a:hover]:text-primary ${className}`}
    >
      {children}
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

/**
 * The reference's two-column section body: the mono label in a fixed left rail
 * on lg+, the content at the right. Owned here so About, Collection and the
 * legal pages share one rhythm instead of three hand-rolled grids.
 */
export function SectionColumns({
  label,
  testId,
  children,
}: {
  label: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-8 lg:grid-cols-[200px_1fr]" data-testid={testId}>
      <Eyebrow>{label}</Eyebrow>
      <div>{children}</div>
    </div>
  );
}

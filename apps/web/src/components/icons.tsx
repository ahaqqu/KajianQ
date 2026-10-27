/**
 * The app's stroke icon set: one visual weight (1.6px stroke, 24px viewBox)
 * shared by the header, the drawers and the static pages, so an icon cannot
 * drift in weight per call site. Every icon is decorative — the labelled
 * control around it carries the accessible name.
 */
type IconProps = { className?: string };

const BASE = "size-4";

export function BurgerIcon({ className = BASE }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className={className}
      aria-hidden="true"
    >
      <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
    </svg>
  );
}

export function CloseIcon({ className = BASE }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className={className}
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  );
}

export function MoonIcon({ className = BASE }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SunIcon({ className = BASE }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path
        d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The language mark (文A): the reference's globe-free translation glyph. */
export function TranslateIcon({ className = BASE }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M3.5 6.5h8M7.5 4v2.5c0 3.4-1.6 6-4 7.5m1.5-4c.7 2.6 2.4 4.6 4.9 5.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12.5 20l4.2-10 4.3 10M14 16.4h5.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function BookIcon({ className = BASE }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M12 6.5C10.4 5.2 8.4 4.6 5.5 4.6v12.2c2.9 0 4.9.6 6.5 1.9 1.6-1.3 3.6-1.9 6.5-1.9V4.6c-2.9 0-4.9.6-6.5 1.9Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12 6.5v12.2" strokeLinecap="round" />
    </svg>
  );
}

export function ChevronIcon({ className = BASE }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className={className}
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function NewChatIcon({ className = BASE }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M20 11.5A7.5 7.5 0 0 1 8.6 18L4 19.5 5.5 15A7.5 7.5 0 1 1 20 11.5Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function HistoryIcon({ className = BASE }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 4.5V10H9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12 7.5V12l3.2 1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function DownloadIcon({ className = BASE }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 4v10m0 0 4-4m-4 4-4-4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 18h14" strokeLinecap="round" />
    </svg>
  );
}

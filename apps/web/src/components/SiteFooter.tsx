import { Link } from "@tanstack/react-router";
import { t, type Locale } from "../lib/i18n";
import { LogoTile } from "./ui";

/**
 * The site footer, on every page that is not the chat (the chat keeps the
 * reference's compact composer band instead): the AI-use disclaimer at the
 * left and the full route set at the right, including the two legal pages and
 * the CCPA "Do Not Sell or Share" anchor. The links derive from the route
 * paths, so a page cannot exist without a footer entry.
 */
export function SiteFooter({ locale }: { locale: Locale }) {
  return (
    <footer className="border-t border-rule">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <div className="flex items-center gap-3">
          <LogoTile size="sm" />
          <p className="text-sm text-muted-foreground">{t(locale, "footerDisclaimer")}</p>
        </div>
        <nav aria-label={t(locale, "footerNavLabel")}>
          <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
            <FooterLink to="/" label={t(locale, "navChat")} />
            <FooterLink to="/collection" label={t(locale, "navCollection")} />
            <FooterLink to="/about" label={t(locale, "navAbout")} />
            <FooterLink to="/faq" label={t(locale, "navFaq")} />
            <FooterLink to="/privacy" label={t(locale, "footerPrivacy")} />
            <FooterLink to="/terms" label={t(locale, "footerTerms")} />
            <FooterLink to="/privacy" hash="do-not-sell" label={t(locale, "footerDoNotSell")} />
          </ul>
        </nav>
      </div>
    </footer>
  );
}

function FooterLink({ to, label, hash }: { to: string; label: string; hash?: string }) {
  return (
    <li>
      <Link
        to={to}
        {...(hash === undefined ? {} : { hash })}
        {...(hash === undefined ? {} : { activeOptions: { includeHash: true } })}
        className="underline-offset-4 hover:text-foreground hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {label}
      </Link>
    </li>
  );
}

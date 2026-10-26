import { Link } from "@tanstack/react-router";
import { FAQ_ITEMS, FAQ_PAGE } from "../lib/faq";
import { t, type Locale } from "../lib/i18n";
import { PageShell } from "./PageShell";
import { PageHero, PageSection } from "./ui";

/**
 * The FAQ route: the reference's plain-answer list — one `<details>` per
 * question so the browser owns the disclosure semantics and keyboard access.
 * The content module (`lib/faq.ts`) states only behaviour the product already
 * has; the footer links continue to the register and the legal pages.
 */
export function FaqPage({ locale }: { locale: Locale }) {
  return (
    <PageShell>
      <PageHero
        eyebrow={FAQ_PAGE.eyebrow[locale]}
        title={FAQ_PAGE.title[locale]}
        lead={FAQ_PAGE.lead[locale]}
      />

      <PageSection>
        <div className="mx-auto max-w-3xl">
          {FAQ_ITEMS.map((item) => (
            <details key={item.id} className="group border-b border-rule py-5">
              <summary className="flex cursor-pointer list-none items-start justify-between gap-4 font-serif text-xl leading-snug font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-2xl">
                <span>{item.question[locale]}</span>
                <span
                  aria-hidden="true"
                  className="mt-1 shrink-0 font-mono text-base text-accent group-open:hidden"
                >
                  +
                </span>
                <span
                  aria-hidden="true"
                  className="mt-1 hidden shrink-0 font-mono text-base text-accent group-open:inline"
                >
                  −
                </span>
              </summary>
              <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">
                {item.answer[locale]}
              </p>
            </details>
          ))}

          <nav
            aria-label={t(locale, "footerNavLabel")}
            className="mt-10 flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted-foreground"
          >
            <Link to="/about" className="underline underline-offset-4 hover:text-foreground">
              {t(locale, "navAbout")}
            </Link>
            <Link to="/privacy" className="underline underline-offset-4 hover:text-foreground">
              {t(locale, "footerPrivacy")}
            </Link>
            <Link to="/terms" className="underline underline-offset-4 hover:text-foreground">
              {t(locale, "footerTerms")}
            </Link>
          </nav>
        </div>
      </PageSection>
    </PageShell>
  );
}

import type { Locale } from "../lib/i18n";
import { TERMS, TERMS_PAGE, TERMS_UPDATED } from "../lib/terms";
import { PageShell } from "./PageShell";
import { PageHero, PageSection } from "./ui";

/**
 * The `/terms` route: the reference's definition-list legal page — section
 * titles in the left column, prose in the right, one hairline rule per
 * section. The copy module states only what the product actually promises, and
 * the contact line names the operator's real public channel.
 */
export function TermsPage({ locale }: { locale: Locale }) {
  const updated = new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(TERMS_UPDATED);

  return (
    <PageShell>
      <PageHero
        eyebrow={TERMS_PAGE.eyebrow[locale]}
        title={TERMS_PAGE.title[locale]}
        lead={TERMS_PAGE.lead[locale]}
        meta={`${TERMS_PAGE.updatedLabel[locale]} · ${updated}`}
      />

      <PageSection>
        <div className="mx-auto max-w-4xl">
          {TERMS.map((section) => (
            <section
              key={section.id}
              className="grid gap-3 border-b border-rule py-8 first:pt-0 sm:grid-cols-[220px_1fr] sm:gap-8"
            >
              <h2 className="font-serif text-xl leading-snug font-semibold sm:text-2xl">
                {section.title[locale]}
              </h2>
              <div className="space-y-4 text-base leading-7 text-muted-foreground">
                {section.paragraphs.map((paragraph) => (
                  <p key={paragraph.en}>{paragraph[locale]}</p>
                ))}
              </div>
            </section>
          ))}
          <p className="pt-8 text-sm text-muted-foreground">{TERMS_PAGE.contact[locale]}</p>
        </div>
      </PageSection>
    </PageShell>
  );
}

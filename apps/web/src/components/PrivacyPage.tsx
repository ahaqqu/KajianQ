import { PRIVACY_PAGE } from "../lib/privacy-page";
import type { Locale } from "../lib/i18n";
import { PageShell } from "./PageShell";
import { PrivacyNotice } from "./PrivacyNotice";
import { Eyebrow, PageHero, PageSection, SectionTitle } from "./ui";

/**
 * The `/privacy` route: the Art. 13 disclosure in the reference's legal-page
 * layout. The factual register (controller, processors, retention, erasure,
 * storage) is rendered by `PrivacyNotice` from `lib/privacy-notice.ts`; this
 * page adds the hero, the statutory rights list and the CCPA anchor. Nothing
 * here restates a value the register owns.
 */
export function PrivacyPage({ locale }: { locale: Locale }) {
  const updated = new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(
    PRIVACY_PAGE.updated,
  );

  return (
    <PageShell>
      <PageHero
        eyebrow={PRIVACY_PAGE.eyebrow[locale]}
        title={PRIVACY_PAGE.title[locale]}
        lead={PRIVACY_PAGE.lead[locale]}
        meta={`${PRIVACY_PAGE.updatedLabel[locale]} · ${updated}`}
      />

      <PageSection>
        <div className="mx-auto max-w-4xl">
          <PrivacyNotice locale={locale} />
        </div>
      </PageSection>

      <PageSection tone="muted">
        <div className="grid gap-8 lg:grid-cols-[200px_1fr]">
          <Eyebrow>{PRIVACY_PAGE.rightsTitle[locale]}</Eyebrow>
          <div>
            <p className="max-w-3xl text-base leading-7 text-muted-foreground">
              {PRIVACY_PAGE.rightsLead[locale]}
            </p>
            <dl className="mt-8 grid gap-6 sm:grid-cols-2">
              {PRIVACY_PAGE.rights.map((right) => (
                <div key={right.title.en} className="border-t border-rule pt-3">
                  <dt className="font-serif text-lg font-semibold">{right.title[locale]}</dt>
                  <dd className="mt-1 text-sm leading-6 text-muted-foreground">
                    {right.body[locale]}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </PageSection>

      <PageSection>
        <div id="do-not-sell" className="grid scroll-mt-24 gap-8 lg:grid-cols-[200px_1fr]">
          <Eyebrow>CCPA · CPRA</Eyebrow>
          <div>
            <SectionTitle>{PRIVACY_PAGE.doNotSell.title[locale]}</SectionTitle>
            <p className="mt-4 max-w-3xl text-base leading-7 text-muted-foreground">
              {PRIVACY_PAGE.doNotSell.body[locale]}
            </p>
          </div>
        </div>
      </PageSection>
    </PageShell>
  );
}

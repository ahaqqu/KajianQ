import { Link } from "@tanstack/react-router";
import { ABOUT_COPY } from "../lib/about-copy";
import { t, type Locale } from "../lib/i18n";
import { PageShell } from "./PageShell";
import { MonoLabel, PageHero, PageSection, SectionColumns, SectionTitle } from "./ui";

/**
 * The About page: the product's story in the reference's editorial layout —
 * a display hero, then three full-bleed sections (purpose, working principles,
 * privacy by default) over hairline rules. The privacy *register* lives on
 * `/privacy`; this page only states the posture and links to the notice, so
 * the Art. 30 disclosure has one home.
 */
export function AboutPage({ locale }: { locale: Locale }) {
  const principles = [
    { title: "aboutPrincipleSourceTitle", body: "aboutPrincipleSourceBody" },
    { title: "aboutPrincipleDifferenceTitle", body: "aboutPrincipleDifferenceBody" },
    { title: "aboutPrincipleThresholdTitle", body: "aboutPrincipleThresholdBody" },
  ] as const;

  return (
    <PageShell>
      <PageHero
        eyebrow={ABOUT_COPY.eyebrow[locale]}
        title={ABOUT_COPY.title[locale]}
        lead={t(locale, "aboutIntro")}
      />

      <PageSection tone="muted">
        <SectionColumns label={t(locale, "aboutMissionLabel")} testId="about-mission">
          <SectionTitle>{ABOUT_COPY.purposeTitle[locale]}</SectionTitle>
          <p className="mt-4 max-w-3xl text-base leading-7">{t(locale, "aboutMissionBody")}</p>
        </SectionColumns>
      </PageSection>

      <PageSection>
        <SectionColumns label={t(locale, "aboutPrinciplesLabel")} testId="about-principles">
          <SectionTitle>{ABOUT_COPY.principlesTitle[locale]}</SectionTitle>
          <div className="mt-8 grid gap-8 sm:grid-cols-3">
            {principles.map(({ title, body }, index) => (
              <article key={title} className="border-t border-rule pt-4">
                <MonoLabel className="text-accent">{String(index + 1).padStart(2, "0")}</MonoLabel>
                <h3 className="mt-3 font-serif text-xl font-semibold italic sm:text-2xl">
                  {t(locale, title)}
                </h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{t(locale, body)}</p>
              </article>
            ))}
          </div>
        </SectionColumns>
      </PageSection>

      <PageSection tone="muted">
        <SectionColumns label={t(locale, "aboutPrivacyLabel")} testId="about-privacy-summary">
          <SectionTitle>{ABOUT_COPY.privacyTitle[locale]}</SectionTitle>
          <p className="mt-4 max-w-3xl text-base leading-7">{t(locale, "aboutPrivacyBody")}</p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              to="/privacy"
              className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t(locale, "privacyCta")}
            </Link>
            <Link
              to="/collection"
              className="rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-card-foreground hover:bg-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t(locale, "aboutCtaCollection")}
            </Link>
          </div>
        </SectionColumns>
      </PageSection>
    </PageShell>
  );
}

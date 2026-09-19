import { Link } from "@tanstack/react-router";
import { t, type Locale } from "../lib/i18n";
import { PageShell } from "./PageShell";
import { Card, MonoLabel, PageIntro } from "./ui";

/**
 * The About page (#about route): what KajianQ is, the mission (orientation, not
 * authority), three working principles, and the privacy posture — all from the
 * product's real facts (SPECS §1/§2.1, ADR-0017), never the reference mockup's
 * branding. Copy is externalized per locale; the page carries no data of its
 * own.
 */
export function AboutPage({ locale }: { locale: Locale }) {
  const principles = [
    { title: "aboutPrincipleSourceTitle", body: "aboutPrincipleSourceBody" },
    { title: "aboutPrincipleDifferenceTitle", body: "aboutPrincipleDifferenceBody" },
    { title: "aboutPrincipleThresholdTitle", body: "aboutPrincipleThresholdBody" },
  ] as const;

  return (
    <PageShell>
      <PageIntro title={t(locale, "aboutTitle")} intro={t(locale, "aboutIntro")} />

      <section className="space-y-2" data-testid="about-mission">
        <MonoLabel>{t(locale, "aboutMissionLabel")}</MonoLabel>
        <p className="text-sm leading-relaxed">{t(locale, "aboutMissionBody")}</p>
      </section>

      <section className="space-y-3" data-testid="about-principles">
        <MonoLabel>{t(locale, "aboutPrinciplesLabel")}</MonoLabel>
        <div className="grid gap-3 sm:grid-cols-3">
          {principles.map(({ title, body }) => (
            <Card key={title} className="space-y-2">
              <h2 className="font-serif text-lg font-semibold italic">{t(locale, title)}</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">{t(locale, body)}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="space-y-2" data-testid="about-privacy">
        <MonoLabel>{t(locale, "aboutPrivacyLabel")}</MonoLabel>
        <p className="text-sm leading-relaxed">{t(locale, "aboutPrivacyBody")}</p>
      </section>

      <div className="flex flex-wrap gap-3 pt-2">
        <Link
          to="/"
          className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t(locale, "aboutCtaChat")}
        </Link>
        <Link
          to="/collection"
          className="rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-card-foreground hover:bg-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t(locale, "aboutCtaCollection")}
        </Link>
      </div>
    </PageShell>
  );
}

import { t, type Locale, type MessageKey } from "../lib/i18n";
import {
  CONTROLLER,
  ERASURE,
  REGISTER_RULE,
  REGISTER_SOURCE,
  REGISTER_TRANSITION_NOTE,
  RETENTION,
  SUB_PROCESSORS,
  type ProcessorStatus,
  type ProcessorTier,
  type ProcessorVerdict,
  type RetentionStatus,
} from "../lib/privacy-notice";
import { Card, MonoLabel } from "./ui";

/**
 * The `/about` privacy notice (#179, GDPR-C): the Art. 13(1)(e) disclosure —
 * who processes a visitor's data, how long it is kept, and how to erase it —
 * rendered from the typed register in `lib/privacy-notice.ts`, which mirrors
 * ADR-0043 decisions 3 and 4 and the Art. 30 record. The prose is never
 * hardcoded here: a register edit is what changes the notice.
 *
 * Two honesty rules the markup carries: a row's status is always visible (the
 * netcup destination reads "Planned" until #181 makes it true, so the notice
 * is never false today), and a retention row not yet enforced by code shows
 * its registered ticket instead of claiming to be live.
 *
 * Lives in `components/` rather than inline in `AboutPage` so the page stays
 * inside the agentic-limits import cap.
 */

const STATUS_LABELS: Record<ProcessorStatus, MessageKey> = {
  current: "aboutPrivacyStatusCurrent",
  transition: "aboutPrivacyStatusTransition",
  planned: "aboutPrivacyStatusPlanned",
  "no-serving-role": "aboutPrivacyStatusNoServingRole",
};

/**
 * Status tone: the destination and the plain rows read as ordinary outline,
 * and a row in use today is emphasized. Colour alone never carries the
 * distinction — the label and the `data-status` attribute do (axe).
 */
const STATUS_TONE: Record<ProcessorStatus, string> = {
  current: "border border-primary text-foreground",
  transition: "border border-dashed border-border text-muted-foreground",
  planned: "border border-solid border-border bg-secondary text-foreground",
  "no-serving-role": "border border-border text-muted-foreground",
};

const TIER_LABELS: Record<ProcessorTier, MessageKey> = {
  paid: "aboutPrivacyTierPaid",
  free: "aboutPrivacyTierFree",
};

const VERDICT_LABELS: Record<ProcessorVerdict, MessageKey> = {
  permitted: "aboutPrivacyVerdictPermitted",
  "not-for-personal-data": "aboutPrivacyVerdictNotForPersonalData",
};

const RETENTION_STATUS_LABELS: Record<RetentionStatus, MessageKey> = {
  current: "aboutPrivacyStatusCurrent",
  planned: "aboutPrivacyStatusPlanned",
};

export function PrivacyNotice({ locale }: { locale: Locale }) {
  return (
    <section className="space-y-4" data-testid="about-privacy">
      <MonoLabel>{t(locale, "aboutPrivacyLabel")}</MonoLabel>
      <p className="text-sm leading-relaxed">{t(locale, "aboutPrivacyBody")}</p>

      <Card className="space-y-2" data-testid="about-privacy-controller">
        <MonoLabel>{t(locale, "aboutPrivacyControllerLabel")}</MonoLabel>
        <p className="text-sm font-medium">{CONTROLLER.name}</p>
        <p className="text-sm leading-relaxed text-muted-foreground">{CONTROLLER.body[locale]}</p>
      </Card>

      <div className="space-y-3" data-testid="about-privacy-processors">
        <div className="space-y-1">
          <MonoLabel>{t(locale, "aboutPrivacyProcessorsLabel")}</MonoLabel>
          <p className="text-sm leading-relaxed text-muted-foreground">{REGISTER_RULE[locale]}</p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {REGISTER_TRANSITION_NOTE[locale]}
          </p>
        </div>
        {SUB_PROCESSORS.map((processor) => (
          <Card
            key={processor.id}
            className="space-y-2"
            data-testid="about-privacy-processor"
            data-status={processor.status}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-serif text-base font-semibold italic">{processor.name}</h3>
              <span
                data-testid="about-privacy-processor-status"
                data-status={processor.status}
                className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] ${STATUS_TONE[processor.status]}`}
              >
                {t(locale, STATUS_LABELS[processor.status])}
              </span>
            </div>
            <dl className="space-y-1 text-sm leading-relaxed">
              <div>
                <dt className="inline font-medium">{t(locale, "aboutPrivacyRoleLabel")}: </dt>
                <dd className="inline text-muted-foreground">{processor.role[locale]}</dd>
              </div>
              <div>
                <dt className="inline font-medium">{t(locale, "aboutPrivacyDataLabel")}: </dt>
                <dd className="inline text-muted-foreground">{processor.personalData[locale]}</dd>
              </div>
            </dl>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              {t(locale, TIER_LABELS[processor.tier])} ·{" "}
              {t(locale, VERDICT_LABELS[processor.verdict])}
            </p>
            {processor.note && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {processor.note[locale]}
              </p>
            )}
          </Card>
        ))}
        <p className="text-xs leading-relaxed text-muted-foreground">{REGISTER_SOURCE[locale]}</p>
      </div>

      <div className="space-y-3" data-testid="about-privacy-retention">
        <MonoLabel>{t(locale, "aboutPrivacyRetentionLabel")}</MonoLabel>
        {RETENTION.map((item) => (
          <Card
            key={item.id}
            className="space-y-1"
            data-testid="about-privacy-retention-row"
            data-status={item.status}
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <h3 className="font-serif text-sm font-semibold italic">{item.what[locale]}</h3>
              <span
                data-testid="about-privacy-retention-status"
                data-status={item.status}
                className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground"
              >
                {item.status === "planned" && item.planRef
                  ? `${t(locale, "aboutPrivacyPlannedPrefix")} · ${item.planRef}`
                  : t(locale, RETENTION_STATUS_LABELS[item.status])}
              </span>
            </div>
            <p className="text-sm leading-relaxed">{item.window[locale]}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {item.enforcedBy[locale]}
            </p>
          </Card>
        ))}
      </div>

      <Card className="space-y-2" data-testid="about-privacy-erasure">
        <MonoLabel>{t(locale, "aboutPrivacyErasureLabel")}</MonoLabel>
        <p className="text-sm leading-relaxed">{ERASURE.what[locale]}</p>
        <p className="font-mono text-xs">
          {ERASURE.method} {ERASURE.path}
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground">{ERASURE.noUiNote[locale]}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{ERASURE.localNote[locale]}</p>
      </Card>
    </section>
  );
}

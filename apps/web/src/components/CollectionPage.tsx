import { useState } from "react";
import {
  COLLECTION_CATEGORIES,
  COLLECTION_ENTRIES,
  byStatus,
  filterByCategory,
  type CollectionCategory,
  type CollectionEntry,
  type CollectionFilter,
} from "../lib/collections";
import { t, type Locale, type MessageKey } from "../lib/i18n";
import { PageShell } from "./PageShell";
import { AskAboutLink, MonoLabel, PageHero, PageSection, StatusBadge } from "./ui";

/**
 * The Collection page: the register of sources KajianQ can draw on, in the
 * reference's numbered-list layout — a display hero, the category chips, and
 * two visibly distinct groups (Available: ingested and citable today; Planned:
 * registered work) whose rows carry the era, the title, the author, the
 * description and the per-entry ask link.
 *
 * The content is the typed data module `lib/collections.ts`, which mirrors
 * `NOTICES/DATASETS.md` + `SPECS.md` §4.1/§4.2 + the registered issues; the
 * markdown register is not read at runtime. A planned entry is never implied to
 * be available: it keeps its dashed badge and its plan reference.
 */

const CATEGORY_LABELS: Record<CollectionCategory, MessageKey> = {
  scripture: "collectionFilterScripture",
  hadith: "collectionFilterHadith",
  tafsir: "collectionFilterTafsir",
  kitab: "collectionFilterKitab",
  theology: "collectionFilterTheology",
  spirituality: "collectionFilterSpirituality",
  terminology: "collectionFilterTerminology",
};

export function CollectionPage({ locale }: { locale: Locale }) {
  const [filter, setFilter] = useState<CollectionFilter>("all");
  const entries = filterByCategory(COLLECTION_ENTRIES, filter);
  const available = byStatus(entries, "available");
  const planned = byStatus(entries, "planned");

  return (
    <PageShell>
      <PageHero
        eyebrow={t(locale, "collectionEyebrow")}
        title={t(locale, "collectionTitle")}
        lead={t(locale, "collectionIntro")}
      />

      <PageSection>
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label={t(locale, "collectionFilterGroup")}
        >
          <FilterTab
            locale={locale}
            labelKey="collectionFilterAll"
            active={filter === "all"}
            onClick={() => setFilter("all")}
          />
          {COLLECTION_CATEGORIES.map((category) => (
            <FilterTab
              key={category}
              locale={locale}
              labelKey={CATEGORY_LABELS[category]}
              active={filter === category}
              onClick={() => setFilter(category)}
            />
          ))}
        </div>

        <CollectionSection
          locale={locale}
          testId="collection-section-available"
          heading={t(locale, "collectionAvailableSection")}
          empty={t(locale, "collectionEmpty")}
          entries={available}
        />
        <CollectionSection
          locale={locale}
          testId="collection-section-planned"
          heading={t(locale, "collectionPlannedSection")}
          empty={t(locale, "collectionEmpty")}
          entries={planned}
        />
      </PageSection>
    </PageShell>
  );
}

/**
 * One filter tab. Typed over a `MessageKey`, not a plain string: the compiler
 * forces every label through the i18n dictionary, so a future caller cannot
 * pass a bare literal that silently bypasses externalization.
 */
function FilterTab({
  locale,
  labelKey,
  active,
  onClick,
}: {
  locale: Locale;
  labelKey: MessageKey;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="collection-filter"
      data-filter-active={active}
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-full border px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.15em] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-muted-foreground hover:bg-secondary hover:text-foreground"
      }`}
    >
      {t(locale, labelKey)}
    </button>
  );
}

function CollectionSection({
  locale,
  heading,
  empty,
  entries,
  testId,
}: {
  locale: Locale;
  heading: string;
  empty: string;
  entries: readonly CollectionEntry[];
  testId: string;
}) {
  return (
    <section className="mt-10" data-testid={testId}>
      <div className="flex items-center gap-3">
        <MonoLabel className="text-[11px]">{heading}</MonoLabel>
        <span className="h-px flex-1 bg-rule" />
        <span className="font-mono text-[11px] text-muted-foreground">{entries.length}</span>
      </div>
      {entries.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul>
          {entries.map((entry, index) => (
            <li key={entry.id}>
              <EntryRow locale={locale} entry={entry} index={index} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One register row: number, era/category, title, author, description, action. */
function EntryRow({
  locale,
  entry,
  index,
}: {
  locale: Locale;
  entry: CollectionEntry;
  index: number;
}) {
  return (
    <article
      data-testid="collection-entry"
      data-status={entry.status}
      className="grid gap-3 border-t border-rule py-6 sm:grid-cols-[48px_minmax(0,1.05fr)_minmax(0,1fr)_auto] sm:items-start sm:gap-6"
    >
      <span className="font-mono text-xs text-muted-foreground">
        {String(index + 1).padStart(2, "0")}
      </span>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <MonoLabel className="text-accent">
            {t(locale, CATEGORY_LABELS[entry.category])}
          </MonoLabel>
          <MonoLabel>{entry.century[locale]}</MonoLabel>
          <StatusBadge
            status={entry.status}
            label={t(
              locale,
              entry.status === "available" ? "collectionAvailableLabel" : "collectionPlannedLabel",
            )}
          />
        </div>
        <h2 className="mt-2 font-serif text-2xl leading-tight font-semibold">
          {entry.title[locale]}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{entry.author[locale]}</p>
      </div>

      <div className="min-w-0 space-y-2">
        <p className="text-sm leading-6 text-muted-foreground">{entry.description[locale]}</p>
        {entry.status === "available" && entry.attribution !== undefined && (
          <MonoLabel className="normal-case tracking-normal">
            {t(locale, "collectionAttributionLabel")}: {entry.attribution[locale]}
          </MonoLabel>
        )}
        {entry.status === "planned" && entry.planRef !== undefined && (
          <p className="font-mono text-[11px] text-muted-foreground">
            {t(locale, "collectionPlannedPrefix")} · {entry.planRef}
          </p>
        )}
      </div>

      {/* Available entries get the ask affordance — a typed Link into the chat
          with this entry's own question as the `q` param (pre-fill only; ADR-0040
          keeps the chat contract untouched). Planned entries never carry it. */}
      <div className="sm:justify-self-end">
        {entry.status === "available" && entry.ask !== undefined && (
          <AskAboutLink label={t(locale, "collectionAskAbout")} question={entry.ask[locale]} />
        )}
      </div>
    </article>
  );
}

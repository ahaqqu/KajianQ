import { useState } from "react";
import { t, type Locale, type MessageKey } from "../lib/i18n";
import {
  COLLECTION_CATEGORIES,
  COLLECTION_ENTRIES,
  byStatus,
  filterByCategory,
  type CollectionCategory,
  type CollectionEntry,
  type CollectionFilter,
} from "../lib/collections";
import { PageShell } from "./PageShell";
import { Card, MonoLabel, PageIntro, StatusBadge } from "./ui";

/**
 * The Collection page (#collection route): the register of sources KajianQ can
 * draw on, in two visibly distinct groups — Available (ingested, citable today)
 * and Planned (registered work) — with working category tabs. The content is
 * the typed data module `lib/collections.ts`, which mirrors
 * `NOTICES/DATASETS.md` + `SPECS.md` §4.1/§4.2 + the registered issues; the
 * markdown register is not read at runtime. A planned entry is never implied to
 * be available.
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
      <PageIntro title={t(locale, "collectionTitle")} intro={t(locale, "collectionIntro")} />

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
    </PageShell>
  );
}

/**
 * One filter tab. Typed over a `MessageKey` (thermo-review B1), not a plain
 * string: the compiler now forces every label through the i18n dictionary, so
 * a future caller cannot pass a bare literal that silently bypasses externalization.
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
      className={`rounded-full border px-3 py-1 font-mono text-[11px] uppercase tracking-[0.15em] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
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
    <section className="space-y-3" data-testid={testId}>
      <div className="flex items-center gap-3">
        <MonoLabel className="text-[11px]">{heading}</MonoLabel>
        <span className="h-px flex-1 bg-rule" />
        <span className="font-mono text-[11px] text-muted-foreground">{entries.length}</span>
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-3">
          {entries.map((entry) => (
            <li key={entry.id}>
              <EntryCard locale={locale} entry={entry} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EntryCard({ locale, entry }: { locale: Locale; entry: CollectionEntry }) {
  return (
    <Card data-testid="collection-entry" data-status={entry.status} className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-serif text-lg font-semibold italic">{entry.title[locale]}</h2>
          <p className="text-sm text-muted-foreground">{entry.author[locale]}</p>
        </div>
        <StatusBadge
          status={entry.status}
          label={t(
            locale,
            entry.status === "available" ? "collectionAvailableLabel" : "collectionPlannedLabel",
          )}
        />
      </div>
      <MonoLabel>{entry.century[locale]}</MonoLabel>
      <p className="text-sm leading-relaxed text-card-foreground">{entry.description[locale]}</p>
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
    </Card>
  );
}

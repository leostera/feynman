import { Badge, Tabs, Text } from "@cloudflare/kumo";
import { createContext, useContext, useState, type ReactNode } from "react";
import { anchorUrl, exists, href, parsePath, resolveAnchor, spanLabel, type Anchor, type ClaimStatus, type Index, type Kind, type Provenance } from "./model";

const IndexContext = createContext<Index | null>(null);
export const IndexProvider = IndexContext.Provider;

export function useIndex(): Index {
  const index = useContext(IndexContext);
  if (!index) throw new Error("useIndex outside IndexProvider");
  return index;
}

// Status and provenance vocabulary.

const STATUS: Record<ClaimStatus, { label: string; variant: "success" | "warning" | "error" | "info" }> = {
  supported: { label: "Supported", variant: "success" },
  "partially-supported": { label: "Partially supported", variant: "warning" },
  contradicted: { label: "Contradicted", variant: "error" },
  unverified: { label: "Unverified", variant: "info" },
};

export const STATUS_ORDER: ClaimStatus[] = ["contradicted", "partially-supported", "unverified", "supported"];

export function StatusBadge({ status }: { status: ClaimStatus }) {
  return <Badge variant={STATUS[status].variant}>{STATUS[status].label}</Badge>;
}

export function statusLabel(status: ClaimStatus): string {
  return STATUS[status].label;
}

const PROVENANCE: Record<Provenance, { label: string; variant: "blue" | "orange" | "neutral"; description: string }> = {
  "first-party": { label: "First-party", variant: "blue", description: "Implemented in this repository" },
  "third-party": { label: "Third-party", variant: "orange", description: "External software or service" },
  ambient: { label: "Ambient", variant: "neutral", description: "Provided by the platform or environment" },
};

export function ProvenanceBadge({ provenance }: { provenance: Provenance }) {
  const { label, variant, description } = PROVENANCE[provenance];
  return (
    <span title={description}>
      <Badge variant={variant}>{label}</Badge>
    </span>
  );
}

export function provenanceDescription(provenance: Provenance): string {
  return PROVENANCE[provenance].description;
}

// Links.

export function Link({ to, children, className = "" }: { to: string; children: ReactNode; className?: string }) {
  return (
    <a href={to} className={`text-kumo-link underline-offset-2 hover:underline ${className}`}>
      {children}
    </a>
  );
}

/** Link to a model element of a known kind. Unknown ids render as text. */
export function IdRef({ kind, id }: { kind: Kind; id: string }) {
  const index = useIndex();
  return exists(index, { kind, id }) ? <Link to={href(kind, id)}>{id}</Link> : <span>{id}</span>;
}

export function IdRefs({ kind, ids }: { kind: Kind; ids: string[] }) {
  return (
    <span className="inline-flex flex-wrap gap-x-3 gap-y-1">
      {ids.map((id) => (
        <IdRef key={id} kind={kind} id={id} />
      ))}
    </span>
  );
}

/** Link to an element named by path (`flows/pi-recovery`), labelled by its id. */
export function PathRef({ path }: { path: string }) {
  const ref = parsePath(path);
  return ref ? <IdRef kind={ref.kind} id={ref.id} /> : <span>{path}</span>;
}

export function PathRefs({ paths }: { paths: string[] }) {
  return (
    <span className="inline-flex flex-wrap gap-x-3 gap-y-1">
      {paths.map((path) => (
        <PathRef key={path} path={path} />
      ))}
    </span>
  );
}

/** A single anchor as an inline source link. */
export function AnchorLink({ anchor, children }: { anchor: Anchor; children?: ReactNode }) {
  const index = useIndex();
  const url = anchorUrl(index.model.meta.source, anchor);
  const { file, span } = resolveAnchor(anchor);
  const lines = spanLabel(span);
  const label = children ?? (
    <>
      {file}
      {lines && <span className="text-kumo-subtle">:{lines}</span>}
    </>
  );
  const title = lines ? `${file}:${lines}` : file;
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" title={title} className="underline-offset-2 hover:text-kumo-link hover:underline">
      {label}
    </a>
  ) : (
    <span title={title}>{label}</span>
  );
}

// Page structure.

export interface PageSection {
  id: string;
  title: string;
  count?: number;
  content: ReactNode;
}

/**
 * A page: a header, then its sections. With more than one titled section, the
 * sections become tabs along the top and one is shown at a time; untitled
 * sections (a diagram, say) are always shown.
 */
export function Page({
  title,
  badges,
  summary,
  facts,
  sections,
}: {
  title: string;
  badges?: ReactNode;
  summary?: ReactNode;
  facts?: [string, ReactNode][];
  sections: PageSection[];
}) {
  const visible = sections.filter((section) => section.content !== null);
  const titled = visible.filter((section) => section.title);
  const tabbed = titled.length > 1;
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const active = titled.find((section) => section.id === selected)?.id ?? titled[0]?.id;
  const shown = tabbed ? visible.filter((section) => !section.title || section.id === active) : visible;
  return (
    <div className="mx-auto w-full max-w-[1200px] px-8 py-6">
      <header className="flex flex-col gap-3 pb-5">
        {badges && <div className="flex flex-wrap items-center gap-2">{badges}</div>}
        <h1 className="text-2xl font-semibold tracking-tight text-balance text-kumo-default">{title}</h1>
        {summary && <p className="max-w-[70ch] text-base leading-relaxed text-kumo-strong">{summary}</p>}
        {facts && facts.length > 0 && <Facts rows={facts} />}
      </header>
      {tabbed && (
        <div className="mb-5">
          <Tabs
            variant="underline"
            value={active}
            onValueChange={(value) => setSelected(value as string)}
            tabs={titled.map((section) => ({
              value: section.id,
              label: section.count === undefined ? section.title : `${section.title} ${section.count}`,
            }))}
          />
        </div>
      )}
      <div className="flex flex-col gap-6">
        {shown.map((section) => (
          <section key={section.id} id={section.id}>
            {section.title && !tabbed && (
              <h2 className="mb-3 flex items-baseline gap-2 text-base font-semibold text-kumo-default">
                {section.title}
                {section.count !== undefined && <span className="text-sm font-normal text-kumo-subtle tabular-nums">{section.count}</span>}
              </h2>
            )}
            {section.content}
          </section>
        ))}
      </div>
    </div>
  );
}

export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm leading-normal">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-kumo-subtle">{label}</dt>
          <dd className="text-kumo-default">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <Text variant="secondary">{children}</Text>;
}

// Content blocks.

export function Anchors({ anchors }: { anchors: Anchor[] }) {
  const index = useIndex();
  return (
    <ul className="flex flex-col gap-1.5">
      {anchors.map((anchor) => {
        const { file, symbol, span } = resolveAnchor(anchor);
        const lines = spanLabel(span);
        const url = anchorUrl(index.model.meta.source, anchor);
        const key = typeof anchor === "string" ? anchor : JSON.stringify(anchor);
        const label = (
          <>
            {file}
            {lines && <span className="text-kumo-subtle">:{lines}</span>}
            {symbol && <span className="text-kumo-subtle">#{symbol}</span>}
          </>
        );
        return (
          <li key={key} className="font-mono text-[13px] text-kumo-strong">
            {url ? (
              <a href={url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:text-kumo-link hover:underline">
                {label}
              </a>
            ) : (
              label
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function Chips({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <Badge key={item} variant="neutral">
          {item}
        </Badge>
      ))}
    </div>
  );
}

export function Code({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <code key={item} className="rounded bg-kumo-recessed px-1.5 py-0.5 font-mono text-xs text-kumo-strong">
          {item}
        </code>
      ))}
    </div>
  );
}

export function Share({ lines, total }: { lines: number; total: number }) {
  const percent = total > 0 ? (lines / total) * 100 : 0;
  return (
    <div className="flex items-center gap-3 whitespace-nowrap">
      <div
        role="meter"
        aria-label="Share of repository code"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-kumo-recessed"
      >
        <div className="h-full rounded-full bg-kumo-brand" style={{ width: `${Math.max(percent, 1)}%` }} />
      </div>
      <span className="text-sm text-kumo-strong tabular-nums">
        {percent < 1 ? "<1" : percent.toFixed(0)}%
        <span className="ml-2 text-kumo-subtle">{lines.toLocaleString()} lines</span>
      </span>
    </div>
  );
}

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of units) if (Math.abs(seconds) >= size) return format.format(-Math.round(seconds / size), unit);
  return "just now";
}

import { Badge, TableOfContents, Text } from "@cloudflare/kumo";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { anchorUrl, href, type ClaimStatus, type Index, type Provenance } from "./model";

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

/** Link to any model element by id, resolving its kind. Unknown ids render as text. */
export function IdRef({ id }: { id: string }) {
  const index = useIndex();
  const kind = index.kindOf.get(id);
  return kind ? <Link to={href(kind, id)}>{id}</Link> : <span>{id}</span>;
}

export function IdRefs({ ids }: { ids: string[] }) {
  return (
    <span className="inline-flex flex-wrap gap-x-3 gap-y-1">
      {ids.map((id) => (
        <IdRef key={id} id={id} />
      ))}
    </span>
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
 * A page: a header, then sections. Pages with more than one section get an
 * "On this page" rail on the right that tracks the section in view.
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
  const active = useActiveSection(visible.map((section) => section.id));
  return (
    <div className="mx-auto flex w-full max-w-[1200px] gap-10 px-8 py-8">
      <article className="min-w-0 flex-1 rounded-xl bg-kumo-base px-8 py-7 shadow-sm ring ring-kumo-hairline">
        <header className="flex flex-col gap-3 border-b border-kumo-hairline pb-6">
          {badges && <div className="flex flex-wrap items-center gap-2">{badges}</div>}
          <h1 className="text-2xl font-semibold tracking-tight text-balance text-kumo-default">{title}</h1>
          {summary && <p className="max-w-[62ch] text-base leading-relaxed text-kumo-strong">{summary}</p>}
          {facts && facts.length > 0 && <Facts rows={facts} />}
        </header>
        <div className="flex flex-col">
          {visible.map((section) => (
            <section key={section.id} id={section.id} className="scroll-mt-6 border-b border-kumo-hairline py-6 last:border-b-0 last:pb-0">
              <h2 className="mb-4 flex items-baseline gap-2 text-base font-semibold text-kumo-default">
                {section.title}
                {section.count !== undefined && (
                  <span className="text-sm font-normal text-kumo-subtle tabular-nums">{section.count}</span>
                )}
              </h2>
              {section.content}
            </section>
          ))}
        </div>
      </article>
      {visible.length > 1 && (
        <aside className="sticky top-8 hidden w-52 shrink-0 self-start xl:block">
          <TableOfContents>
            <TableOfContents.Title>On this page</TableOfContents.Title>
            <TableOfContents.List>
              {visible.map((section) => (
                <TableOfContents.Item
                  key={section.id}
                  active={active === section.id}
                  render={<a href={`#${section.id}`} onClick={(event) => scrollToSection(event, section.id)} />}
                >
                  <span className="flex w-full justify-between gap-2">
                    {section.title}
                    {section.count !== undefined && <span className="text-kumo-subtle tabular-nums">{section.count}</span>}
                  </span>
                </TableOfContents.Item>
              ))}
            </TableOfContents.List>
          </TableOfContents>
        </aside>
      )}
    </div>
  );
}

/** Section links scroll within the page without replacing the route in the fragment. */
function scrollToSection(event: React.MouseEvent, id: string) {
  event.preventDefault();
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function useActiveSection(ids: string[]): string | undefined {
  const [active, setActive] = useState<string | undefined>(ids[0]);
  const key = ids.join(",");
  useEffect(() => {
    const root = document.getElementById("main");
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting).map((entry) => entry.target.id);
        if (visible.length > 0) setActive(ids.find((id) => visible.includes(id)));
      },
      { root, rootMargin: "0px 0px -60% 0px" },
    );
    for (const id of ids) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return active;
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

export function Anchors({ anchors }: { anchors: string[] }) {
  const index = useIndex();
  return (
    <ul className="flex flex-col gap-1.5">
      {anchors.map((anchor) => {
        const [path, symbol] = anchor.split("#");
        const url = anchorUrl(index.model.meta.source, anchor);
        const label = (
          <>
            {path}
            {symbol && <span className="text-kumo-subtle">#{symbol}</span>}
          </>
        );
        return (
          <li key={anchor} className="font-mono text-[13px] text-kumo-strong">
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

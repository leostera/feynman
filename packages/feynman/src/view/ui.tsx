// Pieces every page uses: the loaded specs, sources with their code and call trees,
// state as a tree, and the detail of one event.
import { Badge, cn } from "@cloudflare/kumo";
import { ArrowSquareOutIcon, CaretDownIcon, CaretRightIcon, CodeIcon } from "@phosphor-icons/react";
import { createContext, useContext, useState, type CSSProperties, type ReactNode } from "react";
import type { Event, Spec, World } from "../spec/index.ts";
import type { Playground } from "../play/index.ts";
import type { Bundle, CallNode, CodeToken, SpecEntry } from "./data";
import { labelOf, messageName, short, asJson, sourceUrl, stepTitle } from "./format";

export interface Loaded {
  entry: SpecEntry;
  spec: Spec | null;
  base: Spec | null;
  /** How the spec is shown, from its playground file; null for the defaults. */
  playground: Playground | null;
}

interface Explorer {
  bundle: Bundle;
  loaded: Loaded;
}

const ExplorerContext = createContext<Explorer | null>(null);
export const ExplorerProvider = ExplorerContext.Provider;

export function useExplorer(): Explorer & { spec: Spec; playground: Playground | null } {
  const value = useContext(ExplorerContext);
  if (!value?.loaded.spec) throw new Error("no spec loaded");
  return { ...value, spec: value.loaded.spec, playground: value.loaded.playground };
}

/** Steps of a spec by `Actor.key`, for descriptions and sources. */
export function stepInfo(spec: Spec, actor: string, key: string) {
  const info = spec.actors.find((a) => a.name === actor);
  return info?.actions[key] ?? info?.transitions[key];
}

// Sources ------------------------------------------------------------------------------------------

export const STATUS_BADGE = {
  fresh: null,
  new: null,
  stale: <Badge variant="warning">changed since locked</Badge>,
  missing: <Badge variant="error">not found</Badge>,
} as const;

/** The sources of a step: each opens to its code and the calls below it. */
export function Sources({ sources }: { sources: string[] }) {
  if (!sources.length) return null;
  return (
    <div className="flex flex-col gap-1">
      {sources.map((source) => (
        <SourceRow key={source} source={source} />
      ))}
    </div>
  );
}

function SourceRow({ source }: { source: string }) {
  const { bundle, loaded } = useExplorer();
  const [open, setOpen] = useState(false);
  const entry = loaded.entry.sources[source];
  const calls = loaded.entry.calls[source];
  const path = source.split(/[#:]/)[0];
  const url = entry?.url ?? sourceUrl(bundle.repository.fileUrl, path, entry?.start, entry?.end);
  return (
    <div className="rounded-md ring-1 ring-kumo-hairline">
      <div className="flex items-center gap-1.5 px-2 py-1">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <CaretDownIcon size={12} className="shrink-0 text-kumo-subtle" /> : <CaretRightIcon size={12} className="shrink-0 text-kumo-subtle" />}
          <CodeIcon size={14} className="shrink-0 text-kumo-subtle" />
          <span className="truncate font-mono text-xs" title={source}>
            {source}
          </span>
        </button>
        {entry && STATUS_BADGE[entry.status]}
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className="text-kumo-subtle hover:text-kumo-link" aria-label="Open in the code host">
            <ArrowSquareOutIcon size={14} />
          </a>
        )}
      </div>
      {open && (
        <div className="border-t border-kumo-hairline">
          {entry?.status === "missing" && <p className="px-3 py-2 text-xs text-kumo-danger">{entry.reason}</p>}
          {entry?.text && <CodeExcerpt text={entry.text} start={entry.start ?? 1} highlighted={entry.lines} />}
          {calls && (
            <div className="border-t border-kumo-hairline px-2 py-2">
              <p className="mb-1 px-1 text-[11px] font-medium text-kumo-subtle">Calls</p>
              <CallTree node={calls} depth={0} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Code with line numbers; coloured when the CLI highlighted it (`highlighted`, one token list
 * per line). `marked` lines (by their number in the file) stand out: where the code calls on.
 */
export function CodeExcerpt({ text, start, highlighted, marked }: { text: string; start: number; highlighted?: CodeToken[][]; marked?: Set<number> }) {
  const lines = text.split("\n");
  const shown = lines.slice(0, 80);
  return (
    <pre className="feynman-code max-h-80 overflow-auto bg-kumo-recessed px-0 py-2 font-mono text-[11px] leading-[1.55]">
      {shown.map((line, i) => (
        <div key={i} className={cn("flex", marked?.has(start + i) && "bg-kumo-brand/10 shadow-[inset_2px_0_0_var(--color-kumo-brand)]")}>
          <span className={cn("w-10 shrink-0 select-none pr-3 text-right text-kumo-inactive", marked?.has(start + i) && "text-kumo-brand")}>{start + i}</span>
          <span className="whitespace-pre pr-3">
            {highlighted?.[i]
              ? highlighted[i].map((token, j) => (
                  <span key={j} style={{ "--shiki-light": token.c, "--shiki-dark": token.d } as CSSProperties}>
                    {token.t}
                  </span>
                ))
              : line}
          </span>
        </div>
      ))}
      {lines.length > shown.length && <div className="pl-10 text-kumo-subtle">… {lines.length - shown.length} more lines</div>}
    </pre>
  );
}

function CallTree({ node, depth }: { node: CallNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const { bundle } = useExplorer();
  const url = node.file ? sourceUrl(bundle.repository.fileUrl, node.file, node.line) : null;
  const name = node.label.replace(/\(.*$/s, "");
  return (
    <div>
      <div className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-kumo-tint">
        {node.children.length ? (
          <button type="button" onClick={() => setOpen(!open)} className="text-kumo-subtle" aria-label={open ? "Collapse" : "Expand"}>
            {open ? <CaretDownIcon size={11} /> : <CaretRightIcon size={11} />}
          </button>
        ) : (
          <span className="w-[11px]" />
        )}
        <span className={cn("font-mono text-[11px]", node.external && "text-kumo-subtle")}>{name}</span>
        {node.file && (
          <a href={url ?? undefined} target="_blank" rel="noreferrer" className="ml-auto truncate pl-2 font-mono text-[10px] text-kumo-subtle hover:text-kumo-link">
            {node.file}
            {node.line ? `:${node.line}` : ""}
          </a>
        )}
      </div>
      {open && node.children.length > 0 && (
        <div className="ml-[7px] border-l border-kumo-hairline pl-2">
          {node.children.map((child, i) => (
            <CallTree key={i} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// State ----------------------------------------------------------------------------------------------

/** A value as an indented tree; `changed` paths are marked. */
export function StateTree({ value, changed = new Set<string>(), path = "" }: { value: unknown; changed?: Set<string>; path?: string }) {
  if (value === null || typeof value !== "object") return <span className="font-mono text-xs">{short(value, 64)}</span>;
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
  if (!entries.length) return <span className="font-mono text-xs text-kumo-subtle">{Array.isArray(value) ? "[]" : "{}"}</span>;
  return (
    <div className="flex flex-col">
      {entries.map(([key, v]) => {
        const at = path ? (Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`) : key;
        const isChanged = [...changed].some((c) => c === at || c.startsWith(`${at}.`) || c.startsWith(`${at}[`));
        const leaf = v === null || typeof v !== "object" || (Array.isArray(v) ? !v.length : !Object.keys(v).length);
        return (
          <div key={key} className={cn("rounded px-1", isChanged && "bg-kumo-warning/15")}>
            <span className="font-mono text-xs text-kumo-subtle">{key}: </span>
            {leaf ? (
              <StateTree value={v} />
            ) : (
              <div className="ml-3">
                <StateTree value={v} changed={changed} path={at} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Details for the selected actor(s) in the playground's Timeline pane. */
export function EntityDetails({ ids, world }: { ids: string[]; world: World }) {
  const { spec } = useExplorer();
  const instances = ids.map((id) => world.instances.find((i) => i.id === id)).filter((i): i is NonNullable<typeof i> => Boolean(i));
  if (!instances.length) return <p className="px-3 py-4 text-xs text-kumo-subtle">Select an entity in the playground to see its details.</p>;
  return (
    <div className="flex flex-col gap-5 p-3">
      {instances.map((instance) => {
        const actor = spec.actors.find((a) => a.name === instance.actor)!;
        return (
          <section key={instance.id} className="flex flex-col gap-3">
            <div>
              <h3 className="text-sm font-semibold">{instance.label}</h3>
              <p className="text-xs text-kumo-subtle">{actor.description ?? `${actor.name}, in ${actor.zone}`}</p>
            </div>
            <section>
              <h4 className="mb-1 text-[11px] font-medium text-kumo-subtle">State</h4>
              <StateTree value={instance.state} />
            </section>
            {Object.values(actor.actions).length > 0 && (
              <section className="flex flex-col gap-2">
                <h4 className="text-[11px] font-medium text-kumo-subtle">Actions</h4>
                {Object.values(actor.actions).map((action) => (
                  <div key={action.key} className="flex flex-col gap-1">
                    <p className="text-xs"><span className="font-medium">{action.label}</span> <span className="text-kumo-subtle">{action.description}</span></p>
                    <Sources sources={action.sources} />
                  </div>
                ))}
              </section>
            )}
            {Object.values(actor.transitions).length > 0 && (
              <section className="flex flex-col gap-1.5">
                <h4 className="text-[11px] font-medium text-kumo-subtle">What it does by itself</h4>
                {Object.values(actor.transitions).map((transition) => (
                  <div key={transition.key} className="flex flex-col gap-1">
                    <p className="text-xs">
                      <span className="font-medium">{transition.message ? `On ${messageName(spec, transition.message)}` : transition.key}</span>{" "}
                      <span className="text-kumo-subtle">{transition.description}</span>
                    </p>
                    <Sources sources={transition.sources} />
                  </div>
                ))}
              </section>
            )}
          </section>
        );
      })}
    </div>
  );
}

// Events -------------------------------------------------------------------------------------------

/** One event in words; `folded` keeps its changes, messages and code behind a disclosure. */
export function EventDetail({ event, world, compare, folded }: { event: Event; world?: World; compare?: Event; folded?: boolean }) {
  const { spec } = useExplorer();
  const before = compare ? new Map(compare.changes.map((c) => [`${c.instance}:${c.path}`, c.after])) : null;
  const head = (
    <div>
      <p className="text-sm font-medium">
        {labelOf(world, event.instance)} · {stepTitle(spec, event)}
      </p>
      <p className="text-[13px] text-kumo-subtle">
        {event.description}
      </p>
    </div>
  );
  const body = (
    <div className="flex flex-col gap-3">
      {event.error && <p className="rounded-md bg-kumo-danger/10 px-2 py-1.5 text-xs text-kumo-danger">Spec error: {event.error}</p>}
      {event.violations.map((v) => (
        <p key={v} className="rounded-md bg-kumo-danger/10 px-2 py-1.5 text-xs text-kumo-danger">
          Breaks “{spec.properties.find((p) => p.id === v)?.description ?? v}”
        </p>
      ))}
      {event.notes.length > 0 && (
        <ul className="text-xs">
          {event.notes.map((n, i) => (
            <li key={i}>“{n}”</li>
          ))}
        </ul>
      )}
      {event.kind !== "spawn" && event.changes.length > 0 && (
        <Section title="Changed">
          {event.changes.map((c, i) => {
            const was = before?.get(`${c.instance}:${c.path}`);
            const differs = before && JSON.stringify(was, asJson) !== JSON.stringify(c.after, asJson);
            return (
              <div key={i} className="font-mono text-[11px]">
                <span className="text-kumo-subtle">{labelOf(world, c.instance)}.</span>
                {c.path || "state"}: <span className="text-kumo-subtle">{short(c.before)}</span> → {short(c.after)}
                {differs && <span className="ml-1 text-kumo-warning">(was → {short(was)})</span>}
              </div>
            );
          })}
        </Section>
      )}
      {(event.sent.length > 0 || event.started.length > 0 || event.cancelled.length > 0) && (
        <Section title="Sent">
          {event.sent.map((s) => (
            <div key={s.id} className="font-mono text-[11px]">
              → {labelOf(world, s.to)}: {messageName(spec, s.message)} <span className="text-kumo-subtle">{short(s.payload, 60)}</span>
            </div>
          ))}
          {event.started.map((t) => (
            <div key={t.timer} className="font-mono text-[11px] text-kumo-subtle">
              ⏱ {t.timer} set
            </div>
          ))}
          {event.cancelled.map((t) => (
            <div key={t} className="font-mono text-[11px] text-kumo-subtle">
              ⏱ {t} cancelled
            </div>
          ))}
        </Section>
      )}
      {event.sources.length > 0 && (
        <Section title="Code">
          <Sources sources={event.sources} />
        </Section>
      )}
    </div>
  );
  if (!folded)
    return (
      <div className="flex flex-col gap-3">
        {head}
        {body}
      </div>
    );
  return (
    <div className="flex flex-col gap-2">
      {head}
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-[12px] text-kumo-subtle hover:text-kumo-default [&::-webkit-details-marker]:hidden">
          <CaretRightIcon size={12} className="transition-transform duration-150 group-open:rotate-90" />
          {event.sources.length ? "What changed, what it sent, and the code" : "What changed and what it sent (no code yet)"}
        </summary>
        <div className="pt-2">{body}</div>
      </details>
    </div>
  );
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-medium text-kumo-subtle">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

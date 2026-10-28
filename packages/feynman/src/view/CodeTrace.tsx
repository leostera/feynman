// The Code view: the whole timeline as a trace through the code we own. Each event shows what
// crossed a boundary (the message it received, the messages it sent), then each source the step
// declares as a collapsible snippet, with the calls below it that land in our own code. Calls
// into libraries and the runtime are left out. The call trees are static (calldiff), not a
// recording of what ran.
import { cn } from "@cloudflare/kumo";
import { ArrowSquareOutIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Event, World } from "../spec/index.ts";
import { functionId, type CallNode } from "./data";
import { labelOf, messageName, short, asJson, sourceUrl, stepTitle } from "./format";
import { highlightJson } from "./highlight";
import type { Session } from "./session";
import { CodeExcerpt, STATUS_BADGE, useExplorer } from "./ui";

export function CodeTrace({ session, focus, cursor, onPreview, onPick }: { session: Session; focus: number; cursor: number | null; onPreview: (index: number | null) => void; onPick: (index: number) => void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector(`[data-step="${focus}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focus]);
  const events = session.steps.flatMap(({ event, world }, index) => (event ? [{ event, world, index }] : []));
  if (!events.length) return <p className="px-4 py-6 text-xs text-kumo-subtle">Nothing has happened yet. Add someone, or pick a scenario, to trace its code.</p>;
  return (
    <div ref={list} className="flex flex-col gap-2 px-2 pb-3" onMouseLeave={() => onPreview(null)}>
      <p className="px-2 text-[11px] text-kumo-subtle">Calls are found statically in the code each step names, not recorded as it ran.</p>
      {events.map(({ event, world, index }) => (
        <EventTrace key={index} n={index + 1} event={event} world={world} active={focus === index} later={cursor !== null && index > cursor} onEnter={() => onPreview(index)} onPick={() => onPick(index)} />
      ))}
    </div>
  );
}

function EventTrace({ n, event, world, active, later, onEnter, onPick }: { n: number; event: Event; world: World; active: boolean; later: boolean; onEnter: () => void; onPick: () => void }) {
  const { spec } = useExplorer();
  const received = event.kind === "deliver" && event.message ? { name: messageName(spec, event.message), from: event.from ? labelOf(world, event.from) : null, payload: event.payload } : null;
  return (
    // The whole card travels to its moment; its own controls (toggles, links) keep their clicks.
    <section
      data-step={n - 1}
      onMouseEnter={onEnter}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("button, a")) onPick();
      }}
      className={cn("cursor-pointer rounded-xl px-3 py-2.5 ring-1 ring-transparent hover:ring-kumo-line", active && "bg-kumo-tint ring-kumo-line", later && "opacity-45")}
    >
      <button type="button" onClick={onPick} className="flex w-full items-baseline gap-2 text-left" title="Travel to this moment">
        <span className="font-mono text-[11px] tabular-nums text-kumo-subtle">#{n}</span>
        <span className="min-w-0 flex-1 text-[13px] font-medium">
          {labelOf(world, event.instance)} <span className="text-kumo-subtle">·</span> {event.text ?? stepTitle(spec, event)}
        </span>
      </button>
      <div className="mt-2 flex flex-col gap-1.5 pl-6">
        {event.kind === "action" && event.inputs && Object.keys(event.inputs).length > 0 && <Boundary arrow="⇢" label="with inputs" payload={event.inputs} />}
        {received && <Boundary arrow="←" label={`${received.name}${received.from ? ` from ${received.from}` : ""}`} payload={received.payload} />}
        {event.sent.map((sent) => (
          <Boundary key={sent.id} arrow="→" label={`${messageName(spec, sent.message)} to ${labelOf(world, sent.to)}`} payload={sent.payload} />
        ))}
        {event.error && <p className="rounded-md bg-kumo-danger/10 px-2 py-1 text-xs text-kumo-danger">Spec error: {event.error}</p>}
        {event.sources.length ? event.sources.map((source) => <Frame key={source} source={source} />) : <p className="text-xs italic text-kumo-subtle">No code linked to this step yet.</p>}
      </div>
    </section>
  );
}

/**
 * What crossed into or out of the step (a message, or an action's inputs), with the shape of what
 * it carried on one line; a structured value opens to the whole of it, pretty-printed.
 */
function Boundary({ arrow, label, payload }: { arrow: string; label: string; payload: unknown }) {
  const [open, setOpen] = useState(false);
  const structured = payload !== null && typeof payload === "object";
  const head = (
    <>
      <span className="text-kumo-subtle">{arrow}</span>
      <span className="shrink-0 font-medium">{label}</span>
      {payload !== undefined && !open && <span className="min-w-0 truncate text-kumo-subtle">{short(payload, 120)}</span>}
    </>
  );
  if (!structured) return <div className="flex min-w-0 items-baseline gap-1.5 pl-[15px] font-mono text-[11px]">{head}</div>;
  return (
    <div className="font-mono text-[11px]">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full min-w-0 items-baseline gap-1.5 rounded text-left hover:bg-kumo-tint">
        <CaretRightIcon size={10} className={cn("shrink-0 self-center text-kumo-subtle transition-transform duration-150", open && "rotate-90")} />
        {head}
      </button>
      {open && <pre className="mt-1 ml-[15px] max-h-80 overflow-auto rounded-md bg-kumo-recessed px-3 py-2 leading-[1.55] ring-1 ring-kumo-hairline"><Json value={payload} /></pre>}
    </div>
  );
}

/** One source the step names: its snippet, collapsed, and the calls below it in our own code. */
function Frame({ source }: { source: string }) {
  const { bundle, loaded } = useExplorer();
  const [open, setOpen] = useState(false);
  const entry = loaded.entry.sources[source];
  const calls = loaded.entry.calls[source];
  const path = source.split(/[#:]/)[0];
  const url = entry?.url ?? sourceUrl(bundle.repository.fileUrl, path, entry?.start, entry?.end);
  const owned = calls ? flatCalls(calls) : [];
  // The lines of this source where it calls into our own code.
  const marked = new Set((calls?.children ?? []).filter((c) => !c.external && c.file === path && c.line).map((c) => c.line!));
  return (
    <div className="overflow-hidden rounded-lg bg-kumo-elevated ring-1 ring-kumo-hairline">
      <div className="flex items-center gap-1.5 px-2 py-1">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => setOpen(!open)} aria-expanded={open} disabled={!entry?.text}>
          <CaretRightIcon size={11} className={cn("shrink-0 text-kumo-subtle transition-transform duration-150", open && "rotate-90", !entry?.text && "opacity-0")} />
          <Located name={source.includes("#") ? source.slice(source.indexOf("#") + 1) : null} file={path} line={entry?.start} />
        </button>
        {entry && STATUS_BADGE[entry.status]}
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className="text-kumo-subtle hover:text-kumo-link" aria-label="Open in the code host">
            <ArrowSquareOutIcon size={13} />
          </a>
        )}
      </div>
      {entry?.status === "missing" && <p className="border-t border-kumo-hairline px-3 py-1.5 text-xs text-kumo-danger">{entry.reason}</p>}
      {open && entry?.text && (
        <div className="border-t border-kumo-hairline">
          <CodeExcerpt text={entry.text} start={entry.start ?? 1} highlighted={entry.lines} marked={marked} />
        </div>
      )}
      {owned.length > 0 && (
        <div className="border-t border-kumo-hairline px-1 py-1">
          {owned.map((call) => (
            <Call key={call.id} call={call} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A value pretty-printed as JSON, highlighted by Shiki like the code snippets. */
function Json({ value }: { value: unknown }) {
  const text = JSON.stringify(value, asJson, 2) ?? String(value);
  const lines = useMemo(() => highlightJson(text), [text]);
  return (
    <code className="feynman-code">
      {lines.map((line, i) => (
        <div key={i}>
          {line.map((token, j) => (
            <span key={j} style={{ "--shiki-light": token.c, "--shiki-dark": token.d } as CSSProperties}>
              {token.t}
            </span>
          ))}
        </div>
      ))}
    </code>
  );
}

/**
 * A function by what it means first (`Class.method`), then the file it is in, by its base name;
 * the full path is a hover away. Without a name (a line range), the file leads.
 */
function Located({ name, file, line }: { name: string | null; file: string | null; line?: number }) {
  const base = file?.split("/").at(-1);
  const at = base ? `${base}${line ? `:${line}` : ""}` : null;
  return (
    <span className="flex min-w-0 items-baseline gap-1.5 font-mono text-[11px]" title={file ? `${file}${line ? `:${line}` : ""}` : undefined}>
      <span className="min-w-0 truncate font-medium">{name ?? at}</span>
      {name && at && <span className="shrink-0 text-[10px] text-kumo-subtle">{at}</span>}
    </span>
  );
}

/** A function the source reaches in our own code, once, however many places call it. */
interface ReachedFunction {
  /** Where it is defined (`functionId`), or, without a definition, its name. */
  id: string;
  name: string;
  def: CallNode["def"];
  /** Where it is first called from, when its definition is unknown. */
  callSite: { file: string; line?: number } | null;
  /** The lines of its own code where it calls into ours, from every place it was reached. */
  marked: Set<number>;
}

/** One function, on its own line; opening it shows its code, with the lines that call onwards marked. */
function Call({ call }: { call: ReachedFunction }) {
  const { bundle, loaded } = useExplorer();
  const [open, setOpen] = useState(false);
  const code = call.def ? loaded.entry.functions?.[functionId(call.def)] : undefined;
  const where = call.def ?? (call.callSite ? { file: call.callSite.file, line: call.callSite.line } : null);
  const url = code?.url ?? (where ? sourceUrl(bundle.repository.fileUrl, where.file, where.line) : null);
  return (
    <div>
      <div className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 font-mono text-[11px] hover:bg-kumo-tint">
        <button type="button" onClick={() => setOpen(!open)} disabled={!code} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:cursor-default" title={code ? (open ? "Hide its code" : "Show its code") : "Its code was not found"}>
          <CaretRightIcon size={10} className={cn("shrink-0 text-kumo-subtle transition-transform duration-150", open && "rotate-90", !code && "opacity-0")} />
          <Located name={call.name} file={where?.file ?? null} line={where?.line} />
        </button>
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className="shrink-0 text-kumo-subtle hover:text-kumo-link" aria-label="Open in the code host">
            <ArrowSquareOutIcon size={12} />
          </a>
        )}
      </div>
      {open && code && (
        <div className="my-1 ml-4 overflow-hidden rounded-md ring-1 ring-kumo-hairline">
          <CodeExcerpt text={code.text} start={code.start} highlighted={code.lines} marked={call.marked} />
        </div>
      )}
    </div>
  );
}

/**
 * The functions a source reaches in code we own (calldiff resolved the call), as one flat list
 * in the order they are first reached, depth first. A function reached from several places is
 * listed once, by where it is defined; its marked lines gather every place it calls onwards.
 */
function flatCalls(root: CallNode): ReachedFunction[] {
  const byId = new Map<string, ReachedFunction>();
  const visit = (node: CallNode) => {
    for (const child of node.children) {
      if (child.external || !child.file) continue;
      const name = child.key ?? child.label.replace(/\(.*$/s, "");
      const id = child.def ? functionId(child.def) : name;
      let fn = byId.get(id);
      if (!fn) {
        fn = { id, name, def: child.def, callSite: child.def ? null : { file: child.file, line: child.line }, marked: new Set() };
        byId.set(id, fn);
      }
      for (const grandchild of child.children) {
        if (!grandchild.external && child.def && grandchild.file === child.def.file && grandchild.line) fn.marked.add(grandchild.line);
      }
      visit(child);
    }
  };
  visit(root);
  return [...byId.values()];
}

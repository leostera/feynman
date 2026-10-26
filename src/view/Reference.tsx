// Reference: everything the spec declares, by actor, with the code each step stands for.
import { Badge } from "@cloudflare/kumo";
import { messageName } from "./format";
import { actorLinks } from "./layout";
import { Section, Sources, useExplorer } from "./ui";

export function Reference() {
  const { spec } = useExplorer();
  const senders = (message: string) => spec.actors.filter((a) => [...Object.values(a.actions), ...Object.values(a.transitions)].some((s) => s.sends.includes(message))).map((a) => a.name);
  const handlers = (message: string) => spec.actors.filter((a) => a.transitions[message]).map((a) => a.name);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-8 px-8 py-8">
        <div>
          <h1 className="text-lg font-semibold">{spec.name}</h1>
          {spec.description && <p className="text-sm text-kumo-subtle">{spec.description}</p>}
          <p className="mt-1 text-xs text-kumo-subtle">
            {spec.actors.length} actors in {spec.zones.length} zones, {Object.keys(spec.messages).length} messages, {actorLinks(spec).length} links between actors.
          </p>
        </div>
        {spec.actors.map((actor) => (
          <section key={actor.name} id={`actor-${actor.name}`} className="flex flex-col gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-base font-semibold">
                {actor.name}
                <Badge variant="neutral">{actor.zone}</Badge>
                {actor.singleton && <Badge variant="outline">one</Badge>}
              </h2>
              {actor.description && <p className="text-sm text-kumo-subtle">{actor.description}</p>}
              {actor.durable.length > 0 && <p className="text-xs text-kumo-subtle">Survives a restart: {actor.durable.join(", ")}.</p>}
            </div>
            {Object.values(actor.actions).map((a) => (
              <div key={a.key} className="flex flex-col gap-1.5 rounded-lg px-4 py-3 ring-1 ring-kumo-hairline">
                <p className="text-sm">
                  <span className="font-medium">{a.label}</span> <span className="text-kumo-subtle">{a.description}</span>
                </p>
                {Object.keys(a.inputs).length > 0 && (
                  <p className="font-mono text-[11px] text-kumo-subtle">
                    takes {Object.entries(a.inputs).map(([n, i]) => `${n}: ${i.type === "choice" ? i.values?.join(" | ") : i.type}`).join(", ")}
                  </p>
                )}
                <Effects sends={a.sends} starts={a.starts} />
                <Sources sources={a.sources} />
              </div>
            ))}
            {Object.values(actor.transitions).map((t) => (
              <div key={t.key} className="flex flex-col gap-1.5 rounded-lg bg-kumo-base px-4 py-3 ring-1 ring-kumo-hairline">
                <p className="text-sm">
                  <span className="font-medium">{t.message ? `On ${messageName(spec, t.message)}` : t.key}</span> <span className="text-kumo-subtle">{t.description}</span>
                </p>
                <Effects sends={t.sends} starts={t.starts} />
                <Sources sources={t.sources} />
              </div>
            ))}
          </section>
        ))}
        <Section title="Messages">
          <table className="w-full text-sm">
            <tbody>
              {Object.values(spec.messages).map((m) => (
                <tr key={m.key} className="border-b border-kumo-hairline">
                  <td className="py-1.5 pr-4 font-medium">{m.name}</td>
                  <td className="py-1.5 pr-4 text-kumo-subtle">
                    {senders(m.key).join(", ") || "nobody"} → {handlers(m.key).join(", ") || "nobody"}
                  </td>
                  <td className="py-1.5 text-right text-xs text-kumo-subtle">
                    {m.over ?? ""} {m.tone !== "request" && <Badge variant="neutral">{m.tone}</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
        {spec.limits.length > 0 && (
          <Section title="Limits">
            {spec.limits.map((l) => (
              <div key={l.name} className="flex flex-col gap-1">
                <p className="text-sm">
                  <span className="font-medium">{l.name}</span>: {l.unit ? `${l.value} ${l.unit}` : l.value}
                </p>
                <Sources sources={l.sources} />
              </div>
            ))}
          </Section>
        )}
        {spec.invariants.length > 0 && (
          <Section title="Invariants">
            {spec.invariants.map((i) => (
              <p key={i.id} className="text-sm">
                <span className="font-medium">{i.description}</span>{" "}
                <span className="font-mono text-[11px] text-kumo-subtle">
                  {i.kind} · {i.id}
                </span>
              </p>
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}

function Effects({ sends, starts }: { sends: string[]; starts: string[] }) {
  const { spec } = useExplorer();
  if (!sends.length && !starts.length) return null;
  return (
    <p className="text-xs text-kumo-subtle">
      {sends.length > 0 && <>sends {sends.map((s) => messageName(spec, s)).join(", ")}</>}
      {sends.length > 0 && starts.length > 0 && "; "}
      {starts.length > 0 && <>starts {starts.join(", ")}</>}
    </p>
  );
}

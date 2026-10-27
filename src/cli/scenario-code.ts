// A counterexample as scenario code: paste it into the spec and the bug is a flow anyone can
// replay, step through in the playground, and keep as a regression once it is fixed.
import type { Counterexample, PropertyBroken } from "../check/index.ts";
import type { Event, Spec, World } from "../spec/index.ts";

/** `defineScenario` source replaying the property's counterexample event by event. */
export function scenarioCode(spec: Spec, property: PropertyBroken): string {
  const { counterexample: ce, loop } = property;
  const names = new Names();
  const body: string[] = [];
  if (ce.from) body.push(`// Starts where the scenario "${ce.from}" ends: copy its steps here first.`);
  else body.push(...setup(spec, ce.initial, names));
  ce.events.forEach((event, i) => body.push(line(event, i === 0 ? ce.initial : ce.worlds[i - 1], ce.choices[i], names)));
  if (loop?.events.length) body.push(`// From here this repeats forever, and it never gets there:`, ...loop.events.map((event, i) => line(event, i === 0 ? loop.initial : loop.worlds[i - 1], loop.choices[i], names)));
  else if (loop) body.push(`// From here nothing fair can happen: it stays here forever, and never gets there.`);
  body.push(`// ${property.id} is broken here: ${property.description}`);
  return [
    `spec.defineScenario({`,
    `  name: ${JSON.stringify(`${property.id} is broken`)},`,
    `  description: ${JSON.stringify(property.description)},`,
    `  run(s) {`,
    ...body.map((l) => `    ${l}`),
    `  },`,
    `});`,
  ].join("\n");
}

/** Every instance the checker started with: singletons by `the`, the rest spawned as it labelled them. */
function setup(spec: Spec, initial: World, names: Names): string[] {
  return initial.instances.map((instance) => {
    const actor = spec.actors.find((a) => a.name === instance.actor);
    const name = names.add(instance.id, instance.label);
    const handle = actorVariable(instance.actor);
    return actor?.singleton ? `const ${name} = s.the(${handle});` : `const ${name} = s.spawn(${handle}, ${JSON.stringify(instance.label)});`;
  });
}

function line(event: Event, before: World, choice: Counterexample["choices"][number], names: Names): string {
  const who = names.of(event.instance, before);
  const json = (v: unknown) => JSON.stringify(v);
  switch (event.kind) {
    case "action":
      return `s.act(${who}, ${json(event.key)}${event.inputs && Object.keys(event.inputs).length ? `, ${json(event.inputs)}` : ""});`;
    case "deliver":
    case "lose": {
      const message = event.key.replace(/^message:/, "");
      const call = event.kind === "deliver" ? "deliver" : "drop";
      return `s.${call}(${who}, ${json(message)}${needsPayload(before, choice, event) ? `, ${json(event.payload)}` : ""});${event.from ? ` // from ${names.of(event.from, before)}` : ""}`;
    }
    case "timer":
      return `s.fire(${who}, ${json(event.key)});`;
    case "guard":
      return `s.step(${who}, ${json(event.key)});`;
    case "restart":
      return `s.restart(${who});`;
    case "spawn":
      return `// ${event.description}`;
  }
}

/** Whether naming the message picks another one in flight than the one taken: then its payload picks it. */
function needsPayload(before: World, choice: Counterexample["choices"][number], event: Event): boolean {
  if (choice.kind !== "fire" && choice.kind !== "lose") return false;
  const oldest = before.pending.filter((p) => p.kind === "deliver" && p.to === event.instance && p.message === event.key).sort((a, b) => a.id - b.id)[0];
  return oldest?.id !== choice.pending;
}

/** Words that cannot name a variable. */
const RESERVED = new Set(
  "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await".split(" "),
);

function words(text: string): string[] {
  return text.split(/[^A-Za-z0-9]+/).filter(Boolean);
}

/** The variable a spec most likely keeps an actor in: its name in PascalCase ("Lock server" is LockServer). */
export function actorVariable(name: string): string {
  const id = words(name).map((w) => w[0].toUpperCase() + w.slice(1)).join("") || "Actor";
  return /^[0-9]/.test(id) ? `_${id}` : id;
}

/** Variable names for instances: their labels in camelCase, unique. */
class Names {
  private byId = new Map<string, string>();
  private used = new Set<string>(["s", "spec"]);

  add(id: string, label: string): string {
    let base = words(label).map((w, i) => (i === 0 ? w[0].toLowerCase() + w.slice(1) : w[0].toUpperCase() + w.slice(1))).join("") || "instance";
    if (/^[0-9]/.test(base) || RESERVED.has(base)) base = `_${base}`;
    let name = base;
    for (let n = 2; this.used.has(name); n++) name = `${base}${n}`;
    this.used.add(name);
    this.byId.set(id, name);
    return name;
  }

  /** The variable for an instance, or an expression finding one that appeared on the way. */
  of(id: string, world: World): string {
    const name = this.byId.get(id);
    if (name) return name;
    const instance = world.instances.find((i) => i.id === id);
    return instance ? `s.all(${actorVariable(instance.actor)}).find((i) => i.label === ${JSON.stringify(instance.label)})!` : JSON.stringify(id);
  }
}

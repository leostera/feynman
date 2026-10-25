// The three phases of an extraction, and what each one still lacks.
//
//   1. actors  Survey the whole repository and map its actors (things with a runtime
//              identity, starting from the system's users), who talks to whom
//              (`talksTo`), and the components (code, with footprints) inside them.
//   2. flows   Work through groups of connected actors one at a time, reading the
//              code of their components in full and writing the behaviours that run
//              through them.
//   3. depth   Make flows, protocols, invariants, claims, and limits precise.
//
// Everything here is a pure function of the model and the unread files, so the
// current group and the remaining gaps are recomputed whenever the agent stops.
import { anchoredFiles, type Actor, type Component, type Model } from "@feynman/model";

export type Phase = 1 | 2 | 3;

export const PHASE_NAMES: Record<Phase, string> = { 1: "actors", 2: "flows", 3: "depth" };

/** Roughly how much unread code one group asks for (bytes; ~40k tokens). */
export const GROUP_BUDGET = 160_000;

const isFirstParty = (actor: Actor) => actor.provenance === "first-party";

/** Components running in `actor`. */
const componentsOf = (model: Model, actor: Actor): Component[] => model.components.filter((component) => component.actors?.includes(actor.id));

/** The code of an actor: the footprints of the components that run in it. */
const footprintOf = (model: Model, actor: Actor): string[] => componentsOf(model, actor).flatMap((component) => component.footprint?.paths ?? []);

/** Whether `file` lies under a footprint path (a directory, a file, or "."). */
export function owns(paths: string[], file: string): boolean {
  return paths.some((path) => {
    const prefix = path.replace(/^\.\/?/, "").replace(/\/$/, "");
    return prefix === "" || file === prefix || file.startsWith(`${prefix}/`);
  });
}

/** Undirected connections between actors, from talksTo, hosts, protocols, and flow steps. */
export function connections(model: Model): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>(model.actors.map((actor) => [actor.id, new Set<string>()]));
  const link = (a?: string, b?: string) => {
    if (!a || !b || a === b || !graph.has(a) || !graph.has(b)) return;
    graph.get(a)!.add(b);
    graph.get(b)!.add(a);
  };
  for (const actor of model.actors) for (const other of [...(actor.talksTo ?? []), ...(actor.host ? [actor.host] : [])]) link(actor.id, other);
  for (const protocol of model.protocols) for (const client of protocol.clients ?? []) link(protocol.server, client);
  for (const flow of model.flows) for (const step of flow.steps ?? []) link(step.actor, step.target);
  return graph;
}

/**
 * Where the actor map says more than the system: connections between two external
 * actors (how Pi talks to git is not this system's behaviour), people reaching a
 * hosted actor without its host, and external actors nothing first-party touches.
 * Checked in every phase, since flows can add connections too.
 */
export function scopeGaps(model: Model): string[] {
  const gaps: string[] = [];
  const byId = new Map(model.actors.map((actor) => [actor.id, actor]));
  const inside = (actor?: Actor) => actor !== undefined && (isFirstParty(actor) || actor.kind === "person");
  const graph = connections(model);
  const reported = new Set<string>();
  for (const [a, others] of graph) {
    for (const b of others) {
      const key = [a, b].sort().join(" ↔ ");
      if (reported.has(key) || inside(byId.get(a)) || inside(byId.get(b))) continue;
      reported.add(key);
      gaps.push(`${key}: neither is first-party or a person, so how they talk is not this system's behaviour; drop the connection (talksTo, flow steps, protocols)`);
    }
  }
  for (const person of model.actors.filter((actor) => actor.kind === "person")) {
    for (const id of person.talksTo ?? []) {
      const host = byId.get(id)?.host;
      if (host && host !== person.id) gaps.push(`actors/${person.id} talks to ${id}, which runs inside ${host}; people reach it through its host, so talk to ${host} instead`);
    }
  }
  for (const actor of model.actors) {
    if (inside(actor)) continue;
    const touched = [...(graph.get(actor.id) ?? [])].some((id) => isFirstParty(byId.get(id)!) || byId.get(id)!.host === actor.id);
    if (!touched) gaps.push(`actors/${actor.id} connects to nothing this repository ships; remove it`);
  }
  return gaps;
}

/** What phase 1 still lacks before the actor map is usable. */
export function actorGaps(model: Model): string[] {
  const gaps: string[] = [];
  if (!model.meta.summary?.trim()) gaps.push("meta.json has no summary of what the system is and does");
  if (!model.actors.some(isFirstParty)) gaps.push("no first-party actor yet");
  if (model.actors.length < 2) gaps.push("a system interacts with something: add the people, services, and programs it talks to as actors");
  const graph = connections(model);
  if (model.actors.length >= 2) {
    for (const actor of model.actors) if (graph.get(actor.id)!.size === 0) gaps.push(`actors/${actor.id} talks to no other actor; fill talksTo`);
  }
  if (model.actors.length && !model.actors.some((actor) => actor.kind === "person" || !isFirstParty(actor))) {
    gaps.push("no actor uses the system: who or what starts its behaviours (a person, another program, a client)?");
  }
  for (const actor of model.actors.filter(isFirstParty)) {
    if (!componentsOf(model, actor).length) gaps.push(`actors/${actor.id} is first-party, but no component runs in it; add components with footprints`);
  }
  if (!model.journeys.length) gaps.push("no journeys yet: what jobs does the system do for the people or programs that use it? Write each as journeys/<id>.json");
  return [...gaps, ...scopeGaps(model)];
}

export interface Group {
  /** First-party actors whose unread code this group covers; empty for files outside every footprint. */
  actors: string[];
  /** Components running in those actors. */
  components: string[];
  /** Other actors they talk to, for context. */
  neighbours: string[];
  /** Unread files, within the budget when possible. */
  files: string[];
  bytes: number;
  /** Unread files left beyond this group. */
  remaining: number;
}

/**
 * The next group of connected actors to read: the first first-party actor (by id)
 * with unread files, plus the first-party actors it talks to, while their unread
 * files fit the budget. A large actor is split across several groups. When every
 * footprint is read, the files outside all footprints form the last group.
 */
export function nextGroup(model: Model, unread: string[], sizes: Map<string, number>, budget = GROUP_BUDGET): Group | null {
  if (!unread.length) return null;
  const actors = model.actors.filter(isFirstParty).sort((a, b) => a.id.localeCompare(b.id));
  const unreadOf = (actor: Actor) => unread.filter((file) => owns(footprintOf(model, actor), file));
  const size = (files: string[]) => files.reduce((n, file) => n + (sizes.get(file) ?? 0), 0);
  const graph = connections(model);

  const seed = actors.find((actor) => unreadOf(actor).length);
  if (!seed) return fit([], [], unread);

  const members = [seed.id];
  let files = unreadOf(seed);
  const neighbours = [...(graph.get(seed.id) ?? [])].sort();
  for (const id of neighbours) {
    const actor = actors.find((candidate) => candidate.id === id);
    if (!actor) continue;
    const extra = unreadOf(actor).filter((file) => !files.includes(file));
    if (!extra.length || size(files) + size(extra) > budget) continue;
    members.push(id);
    files = [...files, ...extra];
  }
  return fit(members, neighbours.filter((id) => !members.includes(id)), files);

  function fit(members: string[], neighbours: string[], candidates: string[]): Group {
    const files: string[] = [];
    let bytes = 0;
    for (const file of [...candidates].sort()) {
      const n = sizes.get(file) ?? 0;
      if (files.length && bytes + n > budget) break;
      files.push(file);
      bytes += n;
    }
    const components = model.components.filter((component) => component.actors?.some((id) => members.includes(id))).map((component) => component.id).sort();
    return { actors: members, components, neighbours, files, bytes, remaining: unread.length - files.length };
  }
}

/** Files no component's footprint covers. */
export function unowned(model: Model, files: string[]): string[] {
  const paths = model.components.flatMap((component) => component.footprint?.paths ?? []);
  return files.filter((file) => !owns(paths, file));
}

/**
 * Where the story from user value down to code is broken: journeys that set off no
 * flow, flows that serve no journey (directly or through a flow that calls them), and
 * steps in first-party actors without the function that does them.
 */
export function journeyGaps(model: Model): string[] {
  const gaps: string[] = [];
  const served = new Set(model.journeys.flatMap((journey) => journey.stages.flatMap((stage) => stage.flows ?? [])));
  for (const journey of model.journeys) {
    if (!journey.stages.some((stage) => stage.flows?.length)) gaps.push(`journeys/${journey.id} sets off no flow; list the flows each stage sets off`);
  }
  // Flows reached from a journey, following sub-flow refs.
  const reached = new Set<string>();
  const visit = (id: string) => {
    if (reached.has(id)) return;
    reached.add(id);
    for (const step of model.flows.find((flow) => flow.id === id)?.steps ?? []) if (step.ref) visit(step.ref);
  };
  served.forEach(visit);
  const firstParty = new Set(model.actors.filter(isFirstParty).map((actor) => actor.id));
  for (const flow of model.flows) {
    if (model.journeys.length && !reached.has(flow.id)) gaps.push(`flows/${flow.id} serves no journey; add it to the stage it implements, or call it from a flow that does`);
    flow.steps.forEach((step, i) => {
      if (firstParty.has(step.actor) && !step.anchor) gaps.push(`flows/${flow.id} step ${i + 1} (${step.actor}) has no anchor; name the function that does it, as path#symbol`);
    });
  }
  return gaps;
}

/** Test files, by the usual conventions: test directories and `.test.`/`.spec.`/`_test.` names. */
export function isTestFile(file: string): boolean {
  return /(^|\/)(tests?|specs?|__tests__|testing)\//i.test(file) || /[._-](test|spec)s?\.[a-z0-9]+$/i.test(file) || /(^|\/)test_[^/]+$/i.test(file);
}

/**
 * Where the model is still thin; phase 3 ends when this is empty. `files` are the
 * files the extraction covers, to tell whether the tests among them were used.
 */
export function depthGaps(model: Model, files: string[] = []): string[] {
  const gaps: string[] = scopeGaps(model);
  const tests = files.filter(isTestFile);
  if (tests.length) {
    const cited = new Set([...anchoredFiles(model.invariants), ...anchoredFiles(model.claims), ...anchoredFiles(model.limits)]);
    if (!tests.some((file) => cited.has(file))) {
      gaps.push(`${tests.length} test files check behaviour, but no invariant, claim, or limit cites one: record what they check (invariant tests, claim evidence)`);
    }
  }
  const graph = connections(model);
  const inFlows = new Set<string>();
  const shown = new Set<string>();
  const pair = (a: string, b: string) => [a, b].sort().join(" ↔ ");

  for (const flow of model.flows) {
    const involved = new Set<string>();
    for (const step of flow.steps ?? []) {
      if (step.actor) involved.add(step.actor);
      if (step.target) involved.add(step.target);
      if (step.actor && step.target && step.actor !== step.target) shown.add(pair(step.actor, step.target));
    }
    for (const id of involved) inFlows.add(id);
    if (involved.size < 2) gaps.push(`flows/${flow.id} involves only ${[...involved].join("") || "no actor"}; name each step's target`);
  }
  for (const protocol of model.protocols) {
    if (!protocol.server || !protocol.clients?.length) gaps.push(`protocols/${protocol.id} does not name its server and clients`);
    for (const client of protocol.clients ?? []) if (protocol.server) shown.add(pair(protocol.server, client));
    if (!protocol.messages?.length) gaps.push(`protocols/${protocol.id} lists no messages`);
  }
  for (const actor of model.actors) {
    if (isFirstParty(actor) && !inFlows.has(actor.id)) gaps.push(`actors/${actor.id} takes part in no flow`);
  }
  const reported = new Set<string>();
  const byId = new Map(model.actors.map((actor) => [actor.id, actor]));
  const inScope = (id: string) => isFirstParty(byId.get(id)!) || byId.get(id)!.kind === "person";
  for (const [a, others] of graph) {
    for (const b of others) {
      const key = pair(a, b);
      // Pairs of external actors are reported by scopeGaps, to be dropped rather than explained.
      if (shown.has(key) || reported.has(key) || (!inScope(a) && !inScope(b))) continue;
      reported.add(key);
      gaps.push(`${key} talk, but no flow step or protocol shows how`);
    }
  }
  gaps.push(...journeyGaps(model));
  for (const invariant of model.invariants) {
    const traced = (invariant.enforcedAt ?? []).some((path) => path.frames.length >= 2);
    if (invariant.enforcement.includes("runtime") && !traced) {
      gaps.push(`invariants/${invariant.id} is enforced at runtime; trace the call path from its trigger to the check (enforcedAt frames)`);
    }
  }
  return gaps;
}

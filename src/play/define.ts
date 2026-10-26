// A playground file says how a spec is shown, and nothing else: which actors read as one
// thing, how a node, a token or a link is drawn, and what panel opens beside a node. Render
// functions receive typed state and can act on the model the way the playground's own
// controls do. The spec stays the model; the checker never loads this file.
import type { ReactNode } from "react";
import type { Actor, ActionsOf, Appearance, GroupInfo, Icon, InputsOf, Mood, Shape, Spec, StateOf, Token, WorldView } from "../spec/index.ts";

export interface Self {
  id: string;
  label: string;
}

/** Run an action of this instance: `act("pair")`, `act("run", { host, command })`. */
export type Act<A> = <K extends keyof ActionsOf<A> & string>(
  key: K,
  ...inputs: keyof ActionsOf<A>[K] extends never ? [] : [InputsOf<ActionsOf<A>[K]>]
) => void;

/** What a render function for an instance receives. */
export interface NodeProps<A = Actor<unknown, {}>> {
  instance: Self;
  state: Readonly<StateOf<A>>;
  /** The look the spec gives it, to build on. */
  look: Appearance;
  world: WorldView;
  /** Simulated time now, in milliseconds. */
  clock: number;
  /** False while looking at the past: acting does nothing then. */
  live: boolean;
  act: Act<A>;
}

/** One instance inside a group node. */
export interface Member {
  instance: Self;
  actor: string;
  state: unknown;
  look: Appearance;
}

/** What a render function for a group receives: its members, and the world to read them in. */
export interface GroupProps {
  /** The node's name: the group's, or the shared part of its members' labels ("Studio"). */
  label: string;
  members: Member[];
  /** Its members' looks, merged: their rows and tokens, the most telling mood. */
  look: Appearance;
  world: WorldView;
  clock: number;
  live: boolean;
  /** The member of an actor, typed: `member(Manager).state.pairings`. */
  member<A extends Actor<any, any>>(actor: A): { instance: Self; state: Readonly<StateOf<A>>; look: Appearance } | undefined;
  /** Run an action of one member. */
  act(instance: string, key: string, inputs?: Record<string, unknown>): void;
}

export interface TokenProps {
  token: Token;
  holder: Self;
  clock: number;
}

export interface LinkStyle {
  style?: "solid" | "dashed" | "dotted";
  /** Dashes that move from the one holding the link, as data would. */
  flowing?: boolean;
  /** "owner": the colour of whose it is; or a mood. */
  color?: "owner" | Mood;
}

/** Room a custom node takes on the map, in pixels. */
export interface Size {
  w: number;
  h: number;
}

export interface ActorPresentation<A = any> {
  /** Replaces how the node is drawn; the playground still handles clicks and drops on it. */
  node?: (props: NodeProps<A>) => ReactNode;
  /** Opens beside the node while it returns something: a terminal, a Settings pane. */
  panel?: (props: NodeProps<A>) => ReactNode;
  size?: Size;
}

export interface GroupPresentation {
  render?: (props: GroupProps) => ReactNode;
  panel?: (props: GroupProps) => ReactNode;
  size?: Size;
  /** A few words under the name while closed: "1 code waiting". */
  status?: (props: GroupProps) => string | null;
}

export interface Playground {
  readonly kind: "feynman.playground";
  /** The spec's name, so the view pairs them. */
  spec: string;
  /** Groups the playground adds, or redefines (same name as the spec's). */
  groups: GroupInfo[];
  group: Record<string, GroupPresentation>;
  actor: Record<string, ActorPresentation>;
  token: Record<string, (props: TokenProps) => ReactNode>;
  link: Record<string, LinkStyle>;
}

type Actors = Actor<any, any>[] | Record<string, Actor<any, any>>;

interface GroupOptions extends GroupPresentation {
  icon?: Icon;
  shape?: Shape;
  description?: string;
  collapsed?: boolean;
  names?: string[];
}

export interface PlayBuilder {
  /**
   * Show actors as one node: a list of singletons (the relay), or a record of other actors
   * grouped by label (`{ app: App, daemon: Axod }`: "Studio app" and "Studio daemon" are one
   * "Studio"). Without actors, it styles the spec's group of that name.
   */
  group(name: string, actors: Actors, options?: GroupOptions): void;
  group(name: string, options: GroupOptions): void;
  actor<A extends Actor<any, any>>(actor: A, presentation: ActorPresentation<A>): void;
  /** How a token of this kind is drawn, such as a ticket with a countdown. */
  token(kind: string, render: (props: TokenProps) => ReactNode): void;
  link(kind: string, style: LinkStyle): void;
}

function isActors(value: unknown): value is Actors {
  if (Array.isArray(value)) return true;
  if (!value || typeof value !== "object") return false;
  const values = Object.values(value);
  return values.length > 0 && values.every((v) => v && typeof v === "object" && "transitions" in v && "name" in v);
}

export function definePlayground<S extends Spec>(spec: S, body: (play: PlayBuilder) => void): Playground {
  const out: Playground = { kind: "feynman.playground", spec: spec.name, groups: [], group: {}, actor: {}, token: {}, link: {} };
  const known = (actor: Actor<any, any>) => {
    if (!spec.actors.some((a) => a.name === actor.name)) throw new Error(`The playground names ${actor.name}, which is not an actor of ${spec.name}`);
  };
  const builder: PlayBuilder = {
    group(name: string, second: Actors | GroupOptions, third?: GroupOptions) {
      const actors = isActors(second) ? second : null;
      const options = (actors ? third : (second as GroupOptions)) ?? {};
      const { render, panel, size, status, ...info } = options;
      out.group[name] = { render, panel, size, status };
      const existing = spec.groups.find((g) => g.name === name);
      if (!actors) {
        if (!existing) throw new Error(`The playground styles group "${name}", which ${spec.name} does not define; pass its actors`);
        if (Object.keys(info).length) out.groups.push({ ...existing, ...info });
        return;
      }
      const members = Array.isArray(actors) ? actors.map((a) => ({ actor: a.name, suffix: null })) : Object.entries(actors).map(([suffix, a]) => ({ actor: a.name, suffix }));
      (Array.isArray(actors) ? actors : Object.values(actors)).forEach(known);
      out.groups.push({ name, description: info.description, icon: info.icon, shape: info.shape, collapsed: info.collapsed ?? true, names: info.names, members });
    },
    actor(actor, presentation) {
      known(actor);
      out.actor[actor.name] = presentation;
    },
    token(kind, render) {
      out.token[kind] = render;
    },
    link(kind, style) {
      out.link[kind] = style;
    },
  };
  body(builder);
  return out;
}

/** Whether a module's default export is a playground. */
export function isPlayground(value: unknown): value is Playground {
  return Boolean(value && typeof value === "object" && (value as Playground).kind === "feynman.playground");
}

/** The spec's groups with the playground's added or redefined. */
export function groupsOf(spec: Spec, playground: Playground | null): GroupInfo[] {
  const extra = playground?.groups ?? [];
  return [...spec.groups.filter((g) => !extra.some((x) => x.name === g.name)), ...extra];
}

// Which steps are fair (RFD0006), by an identity that is the same in every world they are possible in.
import { actorNamed, type Fairness, type Spec, type World } from "../spec/index.ts";
import { nameHash, pendingText } from "./keys.ts";
import type { FairId } from "./liveness.ts";
import type { Choice } from "./steps.ts";

/**
 * A step's fairness (RFD0006): its identity, the same wherever it is possible, and how fair it
 * is. Deliveries, timers and guards are weakly fair unless their transition says otherwise;
 * actions are never fair.
 */
export function fairness(spec: Spec, world: World, choice: Choice): { id: FairId; kind: Fairness } | undefined {
  if (choice.kind === "act") return undefined;
  let name: string;
  let key: string;
  let instance: string;
  if (choice.kind === "guard") {
    name = `g|${choice.instance}|${choice.key}`;
    key = choice.key;
    instance = choice.instance;
  } else {
    const pending = world.pending.find((p) => p.id === choice.pending)!;
    // A delivery is fair to the step that takes it: the same message to an unfair step is another step.
    name = pending.kind === "deliver" ? `d|${choice.step}|${pendingText(pending)}` : `t|${pending.to}|${pending.timer}`;
    key = choice.step;
    instance = pending.to;
  }
  const actor = world.instances.find((i) => i.id === instance)?.actor;
  const fair = actor ? actorNamed(spec, actor).transitions[key]?.fair : undefined;
  if (fair === false) return undefined;
  return { id: nameHash(name), kind: fair ?? "weak" };
}

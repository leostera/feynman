// tlaplus/Examples' DiningPhilosophers (MIT), translated one to one: the TLA+ variables are
// one actor's state, and each philosopher's three actions are guarded steps, each fair on its
// own (as in DiningPhilosophers.tla's StrongSpec and WeakSpec here).
//
// Expected, as TLC finds: under strong fairness everyone eats again and again; under weak
// fairness someone always eats again, but each philosopher can starve: a neighbour keeps
// taking the fork they need whenever it is free.
import { defineActor, defineProperty, defineSpec, defineZone } from "../../src/spec/index.ts";

const N = 5;
const P = Array.from({ length: N }, (_, i) => i + 1);
const left = (p: number) => p;
const right = (p: number) => (p % N) + 1;

type Table = { philosophers: Record<number, Set<number>>; forks: Set<number> };

export function diningPhilosophers(fair: "weak" | "strong") {
  const zone = defineZone({ name: "Table" });
  const holds = (s: Table, p: number, fork: number) => s.philosophers[p].size === 1 && s.philosophers[p].has(fork);
  const steps = P.flatMap((p) => [
    [`takeLeft${p}`, {
      description: `Philosopher ${p} takes the left fork.`,
      fair,
      // Odd philosophers take the left fork first, even ones second.
      when: (s: Table) => (p % 2 !== 0 || holds(s, p, right(p))) && s.forks.has(left(p)),
      run: (s: Table) => void (s.forks.delete(left(p)), s.philosophers[p].add(left(p))),
    }],
    [`takeRight${p}`, {
      description: `Philosopher ${p} takes the right fork.`,
      fair,
      when: (s: Table) => (p % 2 !== 1 || holds(s, p, left(p))) && s.forks.has(right(p)),
      run: (s: Table) => void (s.forks.delete(right(p)), s.philosophers[p].add(right(p))),
    }],
    [`release${p}`, {
      description: `Philosopher ${p} puts both forks down.`,
      fair,
      when: (s: Table) => s.philosophers[p].size === 2,
      run: (s: Table) => void (s.forks.add(left(p)), s.forks.add(right(p)), (s.philosophers[p] = new Set())),
    }],
  ] as const);
  const Table = defineActor({
    name: "Table",
    singleton: true,
    zone,
    initialState: (): Table => ({ philosophers: Object.fromEntries(P.map((p) => [p, new Set<number>()])), forks: new Set(P) }),
    transitions: Object.fromEntries(steps),
  });

  const noLivelock = defineProperty("noLivelock", { description: "Someone eats, again and again.", infinitelyOften: (w) => P.some((p) => w.the(Table).state.philosophers[p].size === 2) });
  const noStarvation = P.map((p) => defineProperty(`noStarvation${p}`, { description: `Philosopher ${p} eats, again and again.`, infinitelyOften: (w) => w.the(Table).state.philosophers[p].size === 2 }));

  return defineSpec({
    name: `Dining philosophers (tlaplus/Examples, ${fair} fairness)`,
    actors: [Table],
    properties: [noLivelock, ...noStarvation],
  });
}

# 19. A counter in two places

> *How do two copies of a number agree, when both change and the network is unreliable?*

A post's like counter is replicated in two regions, so each region answers fast and keeps
working when the other is unreachable. People like the post in both at once. Both copies must
end up showing every like, and never more. This chapter gets there in four steps, and the
answer has a name: a CRDT, a conflict-free replicated data type.

## Step 1: keep the bigger number

([`specs/19-counters/1-the-bigger-number.ts`](specs/19-counters/1-the-bigger-number.ts))

Each replica counts a like, and tells the other its new count. The other keeps whichever is
bigger. That handles messages arriving late, or out of order.

```ts
const Replica = defineActor({
  name: "Replica",
  description: "A copy of the like counter, in one region.",
  zone: regions,
  // `value` is what this replica shows. `liked` counts the likes made here: the truth the
  // properties compare against, not something the code keeps.
  initialState: () => ({ value: 0, liked: 0 }),
  // …
  actions: {
    like: {
      with: [atMost(1)],
      label: "Like",
      description: "Someone in this region likes the post.",
      sends: [Count],
      run(state, _inputs, ctx) {
        state.liked += 1;
        state.value += 1;
        for (const other of ctx.all(Replica)) if (other.id !== ctx.id) ctx.send(other, Count, { value: state.value });
      },
    },
  },
  transitions: {
    count: {
      on: Count,
      description: "Keeps the bigger of its count and the other's.",
      run: (state, msg) => void (state.value = Math.max(state.value, msg.value)),
    },
  },
});
```

Look at `liked`. The code has no such field. It's there for the properties: the number of likes
actually made, to compare what each replica shows against. A spec may keep **ghost state** like
this, as long as no step decides anything by it.

```ts
/** Every like made anywhere. */
const totalLikes = (w: WorldView) => w.all(Replica).reduce((n, r) => n + r.state.liked, 0);

const neverOvercounts = defineProperty("neverOvercounts", {
  description: "No replica shows more likes than were made.",
  always: (w) => w.all(Replica).every((r) => r.state.value <= totalLikes(w)),
});

const everyLikeCounts = defineProperty("everyLikeCounts", {
  description: "Every replica eventually shows every like.",
  leadsTo: {
    whenever: (w) => w.all(Replica).some((r) => r.state.value < totalLikes(w)),
    then: (w) => w.all(Replica).every((r) => r.state.value === totalLikes(w)),
  },
});
```

(`WorldView` is the type of the world properties see, for helpers like `totalLikes`.)

```text
  ✓ neverOvercounts  No replica shows more likes than were made.
  ✗ everyLikeCounts  Every replica eventually shows every like.
    shortest counterexample, 4 event(s), needs no faults, from the setup of scenario "A like in Europe":
       1  Europe (Replica)  like
          value: 0 → 1
          → America: count {"value":1}
       2  America (Replica)  like
          value: 0 → 1
          → Europe: count {"value":1}
       3  America (Replica)  count  {"value":1}  from Europe
       4  Europe (Replica)  count  {"value":1}  from America
    then nothing fair can happen: it stays there forever, and never holds
```

*Two people like the post at once, one in each region. Each replica goes to 1 and tells the
other "1". Each keeps the bigger of 1 and 1.* Two likes, and both replicas say 1, forever. A
count can't tell "my like" from "your like".

## Step 2: send the like

Send the like itself, and let the other add one
([`specs/19-counters/2-send-the-like.ts`](specs/19-counters/2-send-the-like.ts)). The network can
lose a message, or deliver it twice:

```ts
    liked: {
      on: Liked,
      description: "Adds the other region's like.",
      run: (state) => void (state.value += 1),
    },
    likedLost: lose(Liked, { spend: faults }),
    likedTwice: duplicate(Liked, { spend: faults }),
```

On a perfect network, it works:

```sh
feynman check specs/19-counters/2-send-the-like.ts --set faults=0
```

```text
  ✓ neverOvercounts  No replica shows more likes than were made.
  ✓ everyLikeCounts  Every replica eventually shows every like.
```

With one fault, both properties break:

```text
  ✗ neverOvercounts  No replica shows more likes than were made.
    shortest counterexample, 4 event(s), needs 1 fault(s), from the setup of scenario "A like in Europe":
       1  Europe (Replica)  like
          value: 0 → 1
       2  America (Replica)  one more like → likedTwice  {}  from Europe
       3  America (Replica)  one more like  {}  from Europe
          value: 0 → 1
       4  America (Replica)  one more like  {}  from Europe
          value: 1 → 2
          ✗ breaks neverOvercounts
  ✗ everyLikeCounts  Every replica eventually shows every like.
    shortest counterexample, 2 event(s), needs 1 fault(s), from the end of scenario "A like in Europe"
```

A repeated "+1" counts twice, and a lost one never counts. The receiver can't tell a repeat
from a second like, and can't ask for a lost one, because it doesn't know it exists.

Step 1 survived repeats but lost concurrent likes. Step 2 keeps concurrent likes but breaks on
repeats. What we want is a message that's safe to apply twice *and* keeps everyone's likes apart.

## Step 3: count each replica separately

Each replica keeps a count *for every replica*: its own likes, and the most it has heard of each
other's. It shows the sum. It sends the whole table, and merging keeps the bigger number for
each replica ([`specs/19-counters/3-a-g-counter.ts`](specs/19-counters/3-a-g-counter.ts)):

```ts
// What a replica knows: how many likes each replica has counted, by replica id.
const Counts = defineMessage("Counts", { counts: recordOf(Number) }, { name: "counts" });
```

```ts
  // `counts` holds, for every replica, the most likes this one knows it has counted. What it
  // shows is their sum. …
  initialState: () => ({ counts: {} as Record<string, number>, liked: 0 }),
  actions: {
    like: {
      // …
      run(state, _inputs, ctx) {
        state.liked += 1;
        state.counts[ctx.id] = (state.counts[ctx.id] ?? 0) + 1;
        for (const other of ctx.all(Replica)) if (other.id !== ctx.id) ctx.send(other, Counts, { counts: { ...state.counts } });
      },
    },
  },
  transitions: {
    counts: {
      on: Counts,
      description: "Merges the other's counts: for each replica, keeps the bigger number.",
      run(state, msg) {
        for (const [id, n] of Object.entries(msg.counts)) state.counts[id] = Math.max(state.counts[id] ?? 0, n);
      },
    },
```

Only Europe ever raises Europe's entry, so the biggest number heard for Europe is always
Europe's latest. Merging is *idempotent* (twice is the same as once), *commutative* (the order
doesn't matter), and *associative* (how you group merges doesn't matter). Repeats, reordering
and delays can't change the result. That's what makes this a **G-counter**, the simplest CRDT.

```text
  ✓ neverOvercounts  No replica shows more likes than were made.
  ✗ everyLikeCounts  Every replica eventually shows every like.
    shortest counterexample, 2 event(s), needs 1 fault(s), from the end of scenario "A like in Europe":
       1  America (Replica)  like
          counts["replica-america"]: — → 1
          → Europe: counts {"counts":{"replica-europe":1,"replica-america":1}}
       2  Europe (Replica)  counts → countsLost  {"counts":{"replica-europe":1,"replica-america":1}}  from America
    then nothing fair can happen: it stays there forever, and never holds
```

A repeated message is harmless now. A lost one still loses the like: nobody sends that table
again.

## Step 4: say it again

Since a merge is safe to repeat, a replica can just keep sending what it knows. Every few
seconds, whether or not anything changed: this is called *anti-entropy*, or *gossip*
([`specs/19-counters/4-gossip.ts`](specs/19-counters/4-gossip.ts)):

```ts
// The same, as a call in a loop: one at a time, answered, and sent again whatever happens.
const Sync = defineCall("Sync", { counts: recordOf(Number) }, { name: "sync" });
const Synced = defineMessage("Synced", {}, { tone: "reply" });
```

```ts
    gossip: {
      description: "Every few seconds, sends what it knows to the other replicas, whether or not anything changed.",
      after: "5 seconds",
      sends: [Sync],
      run(state, _, ctx) {
        for (const other of ctx.all(Replica)) if (other.id !== ctx.id) ctx.send(other, Sync, { counts: { ...state.counts } });
      },
    },
    sync: {
      on: Sync,
      description: "Merges the other's counts, as for a like, and answers.",
      sends: [Synced],
      run(state, msg, ctx) {
        for (const [id, n] of Object.entries(msg.counts)) state.counts[id] = Math.max(state.counts[id] ?? 0, n);
        ctx.reply(Synced, {});
      },
    },
    synced: { on: Synced, description: "Waits a few seconds, and gossips again.", starts: ["gossip"], run: (_s, _m, ctx) => ctx.start("gossip") },
    syncFailed: { on: failed(Sync), description: "The sync failed: waits a few seconds, and gossips again.", starts: ["gossip"], run: (_s, _m, ctx) => ctx.start("gossip") },
```

Why a call, answered before the next round? Our first version restarted the timer as soon as
it fired. Syncs piled up in flight, every pile was a new state, and the check couldn't finish
at depth 14 (chapter 12). Real gossip loops behave like this one anyway: one round at a time.

```text
Like counter: explored 1,075 states (1 of each actor, and from the end of 1 scenario(s) and the setup of 1, depth 14, faults=1) in 611ms
  ✓ neverOvercounts  No replica shows more likes than were made.
  ✓ everyLikeCounts  Every replica eventually shows every like.
```

The gossip never stops, so the world is never quiet. The spec's `finalState` says what "done"
means instead:

```ts
  finalState: { description: "Every replica shows every like; gossip goes on forever.", when: (w) => w.all(Replica).every((r) => shown(r.state) === totalLikes(w)) },
```

## What the steps teach

| Step | Message | Survives repeats | Survives loss | Keeps concurrent likes |
| --- | --- | --- | --- | --- |
| 1 | my count | yes | no | **no** |
| 2 | +1 | **no** | no | yes |
| 3 | everyone's counts | yes | no | yes |
| 4 | everyone's counts, again and again | yes | yes | yes |

The pattern is general. Make state that only grows in a known order (a *lattice*), make merge
idempotent, commutative and associative, and then delivery can be as sloppy as it likes, as long
as it eventually happens. Sets that only grow, maximum timestamps, and per-replica counters are
all built this way.

## What we left out

- **Unlikes.** A G-counter only grows. A counter that also shrinks is two G-counters, one for
  likes and one for unlikes, and shows the difference: a PN-counter (exercise 2).
- **Replicas joining and leaving.** Each replica's entry lives forever. Real systems need a
  way to retire them.
- **More than two replicas.** Gossip with three gets interesting: a like can reach the third
  replica by way of the second.

## Exercises

1. In step 3, add a `crash` that forgets `counts`. What breaks? What if it keeps `counts` but
   not its own entry?
2. Add an `unlike` action and turn the G-counter into a PN-counter. Write a property that the
   shown value is never negative. Does it hold? Should it?
3. Run step 4 with three replicas (a third in the setup). How many states? Does any verdict
   change?
4. `packages/feynman/examples/lww-register.ts` is a last-writer-wins register. Read it, and
   find which column of the table above it fails.

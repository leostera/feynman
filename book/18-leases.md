# 18. Leases and fencing tokens

> *If only one worker may write at a time, is a lock enough?*

Two copies of a job run for safety, and only one should write the report at a time. The usual
answer is a lock service. This chapter starts from a plain lock and, in five steps, arrives at
the answer Martin Kleppmann gave in *How to do distributed locking*: a lock alone never makes
writes safe. The storage has to help.

## Step 1: a lock

([`specs/18-leases/1-a-lock.ts`](specs/18-leases/1-a-lock.ts))

The lock service hands the lock to one worker at a time, and counts its grants:

```ts
const LockService = defineActor({
  name: "Lock service",
  description: "Hands the lock to one worker at a time.",
  zone: infra,
  singleton: true,
  // `token` counts the grants: the n-th worker to get the lock gets token n.
  initialState: () => ({ holder: null as string | null, token: 0 }),
  transitions: {
    acquire: {
      on: Acquire,
      description: "Grants the lock if it is free; otherwise says it is busy.",
      sends: [Granted, Busy],
      run(state, _msg, ctx) {
        if (state.holder !== null) return ctx.reply(Busy, {});
        state.holder = ctx.from.id;
        state.token += 1;
        ctx.reply(Granted, { token: state.token });
      },
    },
    release: {
      on: Release,
      description: "Frees the lock, if the sender holds it.",
      run(state, _msg, ctx) {
        if (state.holder === ctx.from.id) state.holder = null;
      },
    },
  },
});
```

A worker takes the lock, writes, and lets go:

```ts
    work: {
      description: "Writes the report, and lets go of the lock.",
      when: (s) => s.job === "holding",
      sends: [Write, Release],
      run(state, _, ctx) {
        ctx.send(ctx.the(Storage), Write, { token: state.token });
        ctx.send(ctx.the(LockService), Release, {});
        state.job = "done";
      },
    },
```

Storage records the token of every write it accepts, so the property can say what "one at a
time" means in terms of what storage sees: writes arrive in the order the lock was granted.

```ts
const noStaleWrites = defineProperty("noStaleWrites", {
  description: "Storage never accepts a write from an older lock holder after a newer one's.",
  always: (w) => w.the(Storage).state.writes.every((token, i, all) => i === 0 || all[i - 1]! <= token),
});

const lockIsFreed = defineProperty("lockIsFreed", {
  description: "Whoever holds the lock, it is eventually free again.",
  leadsTo: {
    whenever: (w) => w.the(LockService).state.holder !== null,
    then: (w) => w.the(LockService).state.holder === null,
  },
});
```

```text
  ✗ noStaleWrites  Storage never accepts a write from an older lock holder after a newer one's.
    shortest counterexample, 11 event(s), needs no faults, from the setup of scenario "Both start at once":
       3  Lock service (Lock service)  acquire the lock  {}  from Worker A
          holder: null → "worker-worker-a"
       4  Worker A (Worker)  granted  {"token":1}  from Lock service
       5  Worker A (Worker)  work
       6  Lock service (Lock service)  release the lock  {}  from Worker A
          holder: "worker-worker-a" → null
       7  Lock service (Lock service)  acquire the lock  {}  from Worker B
       8  Worker B (Worker)  granted  {"token":2}  from Lock service
       9  Worker B (Worker)  work
      10  Storage (Storage)  write the report  {"token":2}  from Worker B
          writes: [] → [2]
      11  Storage (Storage)  write the report  {"token":1}  from Worker A
          writes: [2] → [2,1]
          ✗ breaks noStaleWrites
  ✗ lockIsFreed  Whoever holds the lock, it is eventually free again.
    shortest counterexample, 4 event(s), needs 1 fault(s)
```

Two bugs, and the first needs no faults. *A sends its write and its release together. The
release arrives first, B takes the lock and writes, and A's write lands after B's.* The lock was
held by one worker at a time, as promised, and the writes still overlapped. A lock protects
the *lock*. What it's meant to protect is somewhere else.

## Step 2: wait for the write

Let go only once the write has landed
([`specs/18-leases/2-wait-for-the-write.ts`](specs/18-leases/2-wait-for-the-write.ts)):

```ts
    work: {
      description: "Writes the report.",
      when: (s) => s.job === "holding",
      sends: [Write],
      run(state, _, ctx) {
        ctx.send(ctx.the(Storage), Write, { token: state.token });
        state.job = "writing";
      },
    },
    written: {
      on: Written,
      description: "The report is written: lets go of the lock.",
      sends: [Release],
      run(state, _msg, ctx) {
        ctx.send(ctx.the(LockService), Release, {});
        state.job = "done";
      },
    },
```

```text
  ✓ noStaleWrites  Storage never accepts a write from an older lock holder after a newer one's.
  ✗ lockIsFreed  Whoever holds the lock, it is eventually free again.
    shortest counterexample, 4 event(s), needs 1 fault(s):
       1  Worker (Worker)  start
       2  Lock service (Lock service)  acquire the lock  {}  from Worker
       3  Worker (Worker)  granted  {"token":1}  from Lock service
       4  Worker (Worker)  crash
    then nothing fair can happen: it stays there forever, and never holds
```

Writes are safe now. But a worker that crashes holding the lock holds it forever. Nobody else
will ever write the report.

## Step 3: a lease

A lock that can be held forever isn't usable, so lock services hand out **leases**: the lock
is yours for 30 seconds, then it's free again, whether you're done or not
([`specs/18-leases/3-a-lease.ts`](specs/18-leases/3-a-lease.ts)):

```ts
    acquire: {
      on: Acquire,
      description: "Grants the lock for 30 seconds if it is free; otherwise says it is busy.",
      sends: [Granted, Busy],
      starts: ["expire"],
      run(state, _msg, ctx) {
        if (state.holder !== null) return ctx.reply(Busy, {});
        state.holder = ctx.from.id;
        state.token += 1;
        ctx.reply(Granted, { token: state.token });
        ctx.start("expire");
      },
    },
    // …
    expire: {
      description: "The lease runs out: the lock is free again, whoever had it.",
      after: "30 seconds",
      run: (state) => void (state.holder = null),
    },
```

```text
  ✗ noStaleWrites  Storage never accepts a write from an older lock holder after a newer one's.
    shortest counterexample, 11 event(s), needs no faults, from the setup of scenario "Both start at once":
       4  Worker A (Worker)  granted  {"token":1}  from Lock service
       5  Worker A (Worker)  work
       6  Lock service (Lock service)  expire
          holder: "worker-worker-a" → null
       7  Lock service (Lock service)  acquire the lock  {}  from Worker B
       8  Worker B (Worker)  granted  {"token":2}  from Lock service
       9  Worker B (Worker)  work
      10  Storage (Storage)  write the report  {"token":2}  from Worker B
          writes: [] → [2]
      11  Storage (Storage)  write the report  {"token":1}  from Worker A
          writes: [2] → [2,1]
          ✗ breaks noStaleWrites
```

(`lockIsFreed` holds now, at `--depth 30`.)

Step 1's story is back, with an expiry where the early release was. *A's write is on its way
when its lease runs out. B takes the lock and writes, and A's write lands after.*

Is that realistic? Thirty seconds is a long time for a write. But Feynman has no clock
(chapter 7): the expiry can fire at any moment, because in the real system nothing bounds how
long A takes. A garbage-collection pause, a swapped-out process, a network retry, a VM
migration: each has stopped real processes for longer than any lease.

## Step 4: check before writing

The natural fix: before writing, ask whether the lease is still yours
([`specs/18-leases/4-check-first.ts`](specs/18-leases/4-check-first.ts)):

```ts
    work: {
      description: "Before writing, makes sure the lease has not run out.",
      when: (s) => s.job === "holding",
      sends: [Check],
      run(state, _, ctx) {
        ctx.send(ctx.the(LockService), Check, {});
        state.job = "checking";
      },
    },
    stillYours: {
      on: StillYours,
      description: "The lease is still good: writes the report.",
      sends: [Write],
      run(state, _msg, ctx) {
        ctx.send(ctx.the(Storage), Write, { token: state.token });
        state.job = "writing";
      },
    },
```

```sh
feynman check specs/18-leases/4-check-first.ts --depth 40 --only noStaleWrites
```

```text
  ✗ noStaleWrites  Storage never accepts a write from an older lock holder after a newer one's.
    shortest counterexample, 15 event(s), needs no faults, from the setup of scenario "Both start at once"; a shorter one, 8 event(s), needs 1 fault(s):
       5  Worker A (Worker)  work
       6  Lock service (Lock service)  is the lock still mine?  {}  from Worker A
       7  Worker A (Worker)  still yours  {}  from Lock service
          The lease is still good: writes the report.
       8  Lock service (Lock service)  expire
          holder: "worker-worker-a" → null
       9  Lock service (Lock service)  acquire the lock  {}  from Worker B
      10  Worker B (Worker)  granted  {"token":2}  from Lock service
      11  Worker B (Worker)  work
      12  Lock service (Lock service)  is the lock still mine?  {}  from Worker B
      13  Worker B (Worker)  still yours  {}  from Lock service
      14  Storage (Storage)  write the report  {"token":2}  from Worker B
          writes: [] → [2]
      15  Storage (Storage)  write the report  {"token":1}  from Worker A
          writes: [2] → [2,1]
          ✗ breaks noStaleWrites
```

Four events longer, and the same story. *The answer is "still yours". Then the lease runs out
while A's write is on its way.* Any check is a check of the past. Between the answer and the
write there's always a gap, and the lease can run out in it. Checking more often makes the gap
smaller. It never closes it.

That's what this step is for: it's the fix most people reach for first, and the checker shows
why it doesn't work in one run.

## Step 5: fencing tokens

The worker can't know whether its lease is still good when its write lands. The storage can,
if each write carries the token of the lease it was made under. Tokens only grow, so storage
refuses any write older than one it has already accepted
([`specs/18-leases/5-fencing.ts`](specs/18-leases/5-fencing.ts), from step 3, without the check):

```ts
const fencing = defineRule("fencing", { description: "Storage refuses a write whose token is older than one it has accepted." });
```

```ts
  // The token of each write it accepted, in order, and the newest token it has seen.
  initialState: () => ({ writes: [] as number[], newest: 0 }),
  transitions: {
    write: {
      on: Write,
      description: "Writes the report, unless a newer lock holder has written, and says so either way.",
      sends: [Written],
      run(state, msg, ctx) {
        if (fencing.on && msg.token < state.newest) return ctx.reply(Written, {}, "refused: an older token");
        state.newest = msg.token;
        state.writes.push(msg.token);
        ctx.reply(Written, {});
      },
    },
  },
```

```sh
feynman check specs/18-leases/5-fencing.ts --depth 30
```

```text
Report job: explored 20,193 states (…, depth 30, faults=1) in 477ms
  ✓ noStaleWrites  Storage never accepts a write from an older lock holder after a newer one's.
  ✓ lockIsFreed  Whoever holds the lock, it is eventually free again.
  rules
    ✓ fencing  needed: without it, noStaleWrites breaks (11 events)
```

The token was in the spec since step 1, and nobody used it. The lock service always knew the
order of its grants. The fix was to let storage see it.

## What the lease is for, then

With fencing, the lease isn't what keeps writes safe. Storage is. The lease makes it *likely*
that only one worker is working, so little work is wasted, and it frees the lock after a
crash. Safety comes from the storage refusing stale writes. Liveness comes from the lease
expiring. Every design that mixes the two up has step 3's bug.

And fencing needs storage that can refuse: a database with a conditional write
(`UPDATE … WHERE token <= $1`), an object store with preconditions, a service you can change.
When storage can't, no lock makes the writes safe. Make the write idempotent instead, as in
chapter 17.

## Exercises

1. In step 5, give the lock service a `crash` that forgets `token`. What breaks? What must the
   lock service keep on disk?
2. Fencing compares tokens with `<`. What if it used `<=`? What if storage accepted a write
   only when `token === newest + 1`?
3. Two reports, two locks: model a worker that needs both. When can two workers deadlock? Does
   the lease help?
4. Step 4's checker output mentions "a shorter one, 8 event(s), needs 1 fault(s)". Find it
   with `--set faults=1` and `--only noStaleWrites`. What's the fault, and is it a different
   story?

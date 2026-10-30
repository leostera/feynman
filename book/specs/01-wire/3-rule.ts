// Chapter 1, step 3: the fix, kept as a rule of the design.
//
// Expected: both properties hold, and `atomicDebit` is needed: without it, `noOverdrafts`
// breaks in 8 events with no faults, from the setup of "Two at once".
import { atMost, defineActor, defineMessage, defineProperty, defineRule, defineScenario, defineSpec, defineZone, oneOf } from "@leostera/feynman";

const ACCOUNTS = ["alice", "bob"] as const;
type Account = (typeof ACCOUNTS)[number];
const OPENING_BALANCE = 5;
const TOTAL = OPENING_BALANCE * ACCOUNTS.length;

/** The other account: a transfer always goes from one to the other, never to itself. */
const payee = (from: Account): Account => (from === "alice" ? "bob" : "alice");
const covers = (balance: number, amount: number) => balance >= amount;

// Payloads name accounts by their schema, so a message about any other account is refused
// when it is sent, and every handler receives an `Account`.
const account = oneOf(...ACCOUNTS);
const Read = defineMessage("Read", { account });
const Balance = defineMessage("Balance", { balance: Number }, { tone: "reply" });
const Debit = defineMessage("Debit", { account, amount: Number });
const Debited = defineMessage("Debited", {}, { tone: "reply" });
const Refused = defineMessage("Refused", {}, { tone: "refused" });
const Credit = defineMessage("Credit", { account, amount: Number });

const app = defineZone({ name: "App", description: "workers handling transfers" });
const storage = defineZone({ name: "Storage", description: "the ledger" });

// The fix, named: the ledger checks the balance in the same step that takes the money.
const atomicDebit = defineRule("atomicDebit", { description: "The ledger refuses a debit the balance does not cover." });

const Ledger = defineActor({
  name: "Ledger",
  description: "The database that holds every account's balance.",
  zone: storage,
  singleton: true,
  initialState: () => ({ balances: { alice: OPENING_BALANCE, bob: OPENING_BALANCE } as Record<Account, number> }),
  display: {
    icon: "database",
    status: (s) => ACCOUNTS.map((a) => `${a} ${s.balances[a]}`).join(", "),
    mood: (s) => (ACCOUNTS.every((a) => s.balances[a] >= 0) ? "ok" : "bad"),
  },
  transitions: {
    read: {
      on: Read,
      description: "Answers with the account's balance.",
      sends: [Balance],
      run: (state, msg, ctx) => ctx.reply(Balance, { balance: state.balances[msg.account] }),
    },
    debit: {
      on: Debit,
      description: "Takes the amount out of the account.",
      sends: [Debited, Refused],
      run(state, msg, ctx) {
        if (atomicDebit.on && !covers(state.balances[msg.account], msg.amount)) return ctx.reply(Refused, {});
        state.balances[msg.account] -= msg.amount;
        ctx.reply(Debited, {});
      },
    },
    credit: {
      on: Credit,
      description: "Puts the amount into the account.",
      run: (state, msg) => void (state.balances[msg.account] += msg.amount),
    },
  },
});

interface Transfer {
  from: Account;
  to: Account;
  amount: number;
}

/** Where a worker is in its transfer: each stage waits for one answer from the ledger. */
type Stage = { kind: "idle" } | { kind: "reading"; transfer: Transfer } | { kind: "debiting"; transfer: Transfer };

/**
 * The stage a step expects, or a spec error: the ledger answers only what a worker asked, so
 * an answer in any other stage means the model is wrong, and the checker should say so.
 */
function expectStage<K extends Stage["kind"]>(stage: Stage, kind: K): Extract<Stage, { kind: K }> {
  if (stage.kind !== kind) throw new Error(`a worker ${stage.kind} got an answer meant for one ${kind}`);
  return stage as Extract<Stage, { kind: K }>;
}

const Wire = defineActor({
  name: "Wire",
  description: "A worker that handles one transfer at a time.",
  zone: app,
  symmetric: true,
  initialState: () => ({ stage: { kind: "idle" } as Stage }),
  display: {
    icon: "server",
    status: (s) => (s.stage.kind === "idle" ? "idle" : `${s.stage.kind} ${s.stage.transfer.amount} from ${s.stage.transfer.from}`),
    mood: (s) => (s.stage.kind === "idle" ? "off" : "busy"),
  },
  actions: {
    transfer: {
      with: [atMost(1)],
      label: "Transfer",
      description: "Starts a transfer by reading the balance of the account it comes from.",
      when: (s) => s.stage.kind === "idle",
      inputs: { from: account, amount: oneOf(3, 5) },
      sends: [Read],
      run(state, { from, amount }, ctx) {
        state.stage = { kind: "reading", transfer: { from, to: payee(from), amount } };
        ctx.send(ctx.the(Ledger), Read, { account: from });
      },
    },
  },
  transitions: {
    balance: {
      on: Balance,
      description: "Debits the account if the balance covers the amount; otherwise gives up.",
      sends: [Debit],
      run(state, msg, ctx) {
        const { transfer } = expectStage(state.stage, "reading");
        if (!covers(msg.balance, transfer.amount)) return void (state.stage = { kind: "idle" });
        state.stage = { kind: "debiting", transfer };
        ctx.reply(Debit, { account: transfer.from, amount: transfer.amount });
      },
    },
    debited: {
      on: Debited,
      description: "Credits the other account; the transfer is done.",
      sends: [Credit],
      run(state, _msg, ctx) {
        const { transfer } = expectStage(state.stage, "debiting");
        ctx.send(ctx.the(Ledger), Credit, { account: transfer.to, amount: transfer.amount });
        state.stage = { kind: "idle" };
      },
    },
    refused: {
      on: Refused,
      description: "The ledger refused the debit; gives up.",
      run(state) {
        expectStage(state.stage, "debiting");
        state.stage = { kind: "idle" };
      },
    },
  },
});

const noOverdrafts = defineProperty("noOverdrafts", {
  description: "No account goes below zero.",
  always: (w) => ACCOUNTS.every((a) => w.the(Ledger).state.balances[a] >= 0),
  needs: [atomicDebit],
});

const moneyIsKept = defineProperty("moneyIsKept", {
  description: "Once nothing is in flight, the accounts hold what they opened with.",
  always: (w) => !w.quiet || ACCOUNTS.reduce((sum, a) => sum + w.the(Ledger).state.balances[a], 0) === TOTAL,
});

const oneTransfer = defineScenario("One transfer", {
  description: "Alice sends Bob 3: she has 2 left, and he has 8.",
  run(s) {
    const wire = s.spawn(Wire, "Wire 1");
    s.act(wire, "transfer", { from: "alice", amount: 3 });
    s.settle();
  },
});

const twoAtOnce = defineScenario("Two at once", {
  description: "Two workers each move 3 out of Alice's 5: both read 5, and the ledger refuses the second debit.",
  setup(w) {
    w.spawn(Wire, "Wire 1");
    w.spawn(Wire, "Wire 2");
  },
  run(s) {
    for (const wire of s.all(Wire)) s.act(wire, "transfer", { from: "alice", amount: 3 });
    s.settle();
  },
});

export default defineSpec({
  name: "Wire transfers",
  description: "Moving money between two accounts, one worker per transfer.",
  actors: [Ledger, Wire],
  properties: [noOverdrafts, moneyIsKept],
  scenarios: [oneTransfer, twoAtOnce],
});

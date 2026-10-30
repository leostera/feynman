import { atMost, budget, crash, defineActor, defineLimit, defineMessage, defineProperty, defineScenario, defineSpec, defineZone, input, lose, oneOf } from "../../../src/spec/index.ts";

/** Faults on one path: lost messages and crashes (RFD0012). `--set faults=2` raises it. */
const faults = budget("faults", 1);

const NewCode = defineMessage("NewCode", { account: String }, { name: "new pairing code", over: "https" });
const Code = defineMessage("Code", { code: String }, { name: "pairing code", over: "https", tone: "reply" });
const Redeem = defineMessage("Redeem", { code: String, host: String, credential: String }, { over: "https" });
const Redeemed = defineMessage("Redeemed", { account: String }, { over: "https", tone: "reply" });
const Refused = defineMessage("Refused", { status: oneOf(403, 404) }, { tone: "refused" });

const devices = defineZone({ name: "People's devices" });
const cloudflare = defineZone({ name: "Cloudflare" });
const macs = defineZone({ name: "Macs" });

const Relay = defineActor({
  name: "Axo relay",
  zone: cloudflare,
  singleton: true,
  initialState: () => ({
    codes: {} as Record<string, { account: string; used: boolean }>,
    hosts: {} as Record<string, { account: string; verifier: string }>,
  }),
  transitions: {
    newCode: {
      on: NewCode,
      description: "The relay issues a one-time pairing code for the account.",
      sources: [
        "packages/axo-api-worker/src/routes/pairing.ts#createPairing",
        "packages/axo-api-worker/src/auth/pairing.ts:31-58",
      ],
      sends: [Code],
      run(state, msg, ctx) {
        const code = ctx.fresh("code");
        state.codes[ctx.hash(code)] = { account: msg.account, used: false };
        ctx.reply(Code, { code });
      },
    },
    redeem: {
      on: Redeem,
      description: "The relay checks the code and, if it is valid, remembers the Mac.",
      sources: [
        "packages/axo-api-worker/src/routes/pairing.ts#redeemPairing",
        "packages/axo-api-worker/src/auth/pairing.ts#redeem",
        "packages/axo-api-worker/src/auth/account-manager.ts:120-164",
      ],
      sends: [Redeemed, Refused],
      run(state, msg, ctx) {
        const code = state.codes[ctx.hash(msg.code)];
        if (!code || code.used) {
          return ctx.reply(Refused, { status: 404 }, "The code is unknown or used.");
        }
        code.used = true;
        state.hosts[msg.host] = { account: code.account, verifier: ctx.hash(msg.credential) };
        ctx.reply(Redeemed, { account: code.account });
      },
    },
    newCodeLost: lose(NewCode, { spend: faults }),
    redeemLost: lose(Redeem, { spend: faults }),
  },
});

const Person = defineActor({
  name: "Person",
  zone: devices,
  initialState: (ctx) => ({ account: `acct-${ctx.label}`, codes: [] as string[] }),
  actions: {
    pairHost: {
      with: [atMost(2)],
      label: "Pair a host",
      description: "Ask the relay for a pairing code to type on a Mac.",
      sources: ["apps/web/src/settings/pair.tsx#createCode"],
      sends: [NewCode],
      run(state, _inputs, ctx) {
        ctx.send(ctx.the(Relay), NewCode, { account: state.account });
      },
    },
  },
  transitions: {
    code: {
      on: Code,
      description: "The code appears on screen.",
      sources: ["apps/web/src/settings/pair.tsx#showCode"],
      run: (state, msg) => void state.codes.push(msg.code),
    },
    codeLost: lose(Code, { spend: faults }),
    crash: crash({ spend: faults }),
  },
});

const Mac = defineActor({
  name: "Mac",
  zone: macs,
  symmetric: true,
  initialState: () => ({
    link: { account: null as string | null, pending: null as string | null },
    code: null as string | null,
    keychain: [] as string[],
  }),
  actions: {
    link: {
      with: [atMost(2)],
      label: "Paste a pairing code",
      description: "Link this Mac to the account that issued the code.",
      inputs: {
        code: input(String, {
          examples: (world) => [...world.all(Person).flatMap((p) => p.state.codes), "never-issued"],
        }),
      },
      sources: ["apps/macos/RemoteAccess.swift#link", "crates/axod/src/rpc/relay.rs#link"],
      sends: [Redeem],
      starts: ["redeemTimeout"],
      run(state, { code }, ctx) {
        const credential = ctx.fresh("cred");
        state.link.pending = credential;
        state.code = code;
        state.keychain.push(credential);
        ctx.send(ctx.the(Relay), Redeem, { code, host: ctx.id, credential });
        ctx.start("redeemTimeout");
      },
    },
  },
  transitions: {
    redeemed: {
      on: Redeemed,
      description: "The Mac is now linked to the account.",
      sources: ["crates/axo-relay/src/pairing.rs#finish"],
      run(state, msg, ctx) {
        state.link = { account: msg.account, pending: null };
        ctx.cancel("redeemTimeout");
      },
    },
    refused: {
      on: Refused,
      description: "The relay refused the code; the Mac stays unlinked.",
      sources: ["crates/axo-relay/src/pairing.rs#refused"],
      run(state, _msg, ctx) {
        state.link.pending = null;
        ctx.cancel("redeemTimeout");
      },
    },
    redeemTimeout: {
      description: "No answer in time; the Mac sends the same redemption again.",
      after: "5 seconds",
      sources: ["crates/axo-relay/src/pairing.rs#retry"],
      sends: [Redeem],
      starts: ["redeemTimeout"],
      run(state, _, ctx) {
        if (state.link.pending && state.code) {
          ctx.send(ctx.the(Relay), Redeem, { code: state.code, host: ctx.id, credential: state.link.pending });
          ctx.start("redeemTimeout");
        }
      },
    },
    redeemedLost: lose(Redeemed, { spend: faults }),
    refusedLost: lose(Refused, { spend: faults }),
    crash: crash({ spend: faults }),
  },
});

const relayNeverStoresSecrets = defineProperty("relayNeverStoresSecrets", {
  description: "The relay never stores a secret, only hashes of it.",
  always: (world) =>
    world.all(Relay).every((relay) => Object.values(relay.state.hosts).every((host) => host.verifier.startsWith("hash:"))),
});

const macWithValidCodeLinks = defineProperty("macWithValidCodeLinks", {
  description: "A Mac given a code that was really issued ends up linked.",
  leadsTo: {
    whenever: (world) =>
      world.all(Mac).some((mac) => mac.state.link.pending !== null && world.all(Person).some((p) => p.state.codes.includes(mac.state.code ?? ""))),
    then: (world) => world.all(Mac).every((mac) => mac.state.link.account !== null),
  },
});

const codeRedeemedOnce = defineProperty("codeRedeemedOnce", {
  description: "A pairing code is never redeemed twice.",
  // More successful redemptions than codes issued means some code worked twice.
  never: (trace) => trace.count((event) => event.is(Relay, "redeem") && event.replied(Redeemed)) > trace.count((event) => event.is(Relay, "newCode") && event.replied(Code)),
});

const linkAMac = defineScenario("Link a Mac", {
  run(s) {
    const alice = s.spawn(Person, "Alice");
    const studio = s.spawn(Mac, "Studio");
    s.act(alice, "pairHost");
    s.settle();
    s.act(studio, "link", { code: alice.state.codes[0] });
    s.settle();
  },
});

export default defineSpec({
  name: "Remote access",
  actors: [Relay, Person, Mac],
  limits: [
    defineLimit({
      name: "Pairing code lifetime",
      value: 10,
      unit: "minutes",
      sources: ["packages/axo-api-worker/src/auth/pairing.ts#CODE_TTL"],
    }),
  ],
  properties: [
    relayNeverStoresSecrets,
    macWithValidCodeLinks,
    codeRedeemedOnce,
  ],
  scenarios: [linkAMac],
});

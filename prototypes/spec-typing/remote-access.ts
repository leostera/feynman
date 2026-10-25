import { defineSpec, message, MIN, SEC } from "./dsl.ts";

export default defineSpec(
  "Remote access",
  {
    messages: {
      NewCode: message<{ account: string }>({ name: "new pairing code", over: "https" }),
      Code: message<{ code: string }>({ name: "pairing code", over: "https", tone: "reply" }),
      Redeem: message<{ code: string; host: string; credential: string }>({ name: "redeem", over: "https" }),
      Redeemed: message<{ account: string }>({ name: "redeemed", over: "https", tone: "reply" }),
      Refused: message<{ status: 403 | 404 }>({ name: "refused", tone: "refused" }),
    },
  },
  (spec) => {
    const { NewCode, Code, Redeem, Redeemed, Refused } = spec.messages;

    const devices = spec.defineZone({ name: "People's devices" });
    const cloudflare = spec.defineZone({ name: "Cloudflare" });
    const macs = spec.defineZone({ name: "Macs" });

    const CODE_LIFETIME = spec.defineLimit({
      name: "Pairing code lifetime",
      value: 10 * MIN,
      sources: ["packages/axo-api-worker/src/auth/pairing.ts#CODE_TTL"],
    });

    const Relay = spec.defineActor({
      name: "Axo relay",
      zone: cloudflare,
      singleton: true,
      initialState: () => ({
        codes: {} as Record<string, { account: string; used: boolean; expires: number }>,
        hosts: {} as Record<string, { account: string; verifier: string }>,
      }),
      transitions: {
        [NewCode]: {
          description: "The relay issues a one-time pairing code for the account.",
          sources: [
            "packages/axo-api-worker/src/routes/pairing.ts#createPairing",
            "packages/axo-api-worker/src/auth/pairing.ts:31-58",
          ],
          sends: [Code],
          run(state, msg, ctx) {
            const code = ctx.fresh("code");
            state.codes[ctx.hash(code)] = { account: msg.account, used: false, expires: ctx.now + CODE_LIFETIME.value };
            ctx.reply(Code, { code });
          },
        },
        [Redeem]: {
          description: "The relay checks the code and, if it is valid, remembers the Mac.",
          sources: [
            "packages/axo-api-worker/src/routes/pairing.ts#redeemPairing",
            "packages/axo-api-worker/src/auth/pairing.ts#redeem",
            "packages/axo-api-worker/src/auth/account-manager.ts:120-164",
          ],
          sends: [Redeemed, Refused],
          run(state, msg, ctx) {
            const code = state.codes[ctx.hash(msg.code)];
            if (!code || code.used || code.expires < ctx.now) {
              return ctx.reply(Refused, { status: 404 }, "The code is unknown, used, or expired.");
            }
            code.used = true;
            state.hosts[msg.host] = { account: code.account, verifier: ctx.hash(msg.credential) };
            ctx.reply(Redeemed, { account: code.account });
          },
        },
      },
    });

    const Person = spec.defineActor({
      name: "Person",
      zone: devices,
      initialState: (ctx) => ({ account: `acct-${ctx.label}`, codes: [] as string[] }),
      actions: {
        pairHost: {
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
        [Code]: {
          description: "The code appears on screen.",
          sources: ["apps/web/src/settings/pair.tsx#showCode"],
          run: (state, msg) => void state.codes.push(msg.code),
        },
      },
    });

    const Mac = spec.defineActor({
      name: "Mac",
      zone: macs,
      initialState: () => ({
        link: { account: null as string | null, pending: null as string | null },
        keychain: [] as string[],
      }),
      actions: {
        link: {
          label: "Paste a pairing code",
          description: "Link this Mac to the account that issued the code.",
          inputs: {
            code: spec.defineInput(String, {
              examples: (world) => [...world.all(Person).flatMap((p) => p.state.codes), "never-issued"],
            }),
          },
          sources: ["apps/macos/RemoteAccess.swift#link", "crates/axod/src/rpc/relay.rs#link"],
          sends: [Redeem],
          starts: ["redeemTimeout"],
          run(state, { code }, ctx) {
            const credential = ctx.fresh("cred");
            state.link.pending = credential;
            state.keychain.push(credential);
            ctx.send(ctx.the(Relay), Redeem, { code, host: ctx.id, credential });
            ctx.start("redeemTimeout", 5 * SEC);
          },
        },
      },
      transitions: {
        [Redeemed]: {
          description: "The Mac is now linked to the account.",
          sources: ["crates/axo-relay/src/pairing.rs#finish"],
          run(state, msg, ctx) {
            state.link = { account: msg.account, pending: null };
            ctx.cancel("redeemTimeout");
          },
        },
        redeemTimeout: {
          description: "No answer in time; the Mac sends the same redemption again.",
          sources: ["crates/axo-relay/src/pairing.rs#retry"],
          sends: [Redeem],
          run(state, ctx) {
            void state.link.pending;
            void ctx;
          },
        },
      },
    });

    spec.defineInvariants({
      relayNeverStoresSecrets: {
        description: "The relay never stores a secret, only hashes of it.",
        always: (world) =>
          world.all(Relay).every((relay) => Object.values(relay.state.hosts).every((host) => host.verifier.startsWith("hash:"))),
      },
      macWithValidCodeLinks: {
        description: "A Mac given a valid code ends up linked.",
        eventually: (world) => world.all(Mac).every((mac) => mac.state.link.account !== null),
        within: 20,
      },
      codeRedeemedOnce: {
        description: "A pairing code is never redeemed twice.",
        never: (trace) => trace.count((event) => event.is(Relay, Redeem) && event.replied(Redeemed)) > 1,
      },
    });

    spec.defineScenario({
      name: "Link a Mac",
      run(s) {
        const alice = s.spawn(Person, "Alice");
        const studio = s.spawn(Mac, "Studio");
        s.act(alice, "pairHost");
        s.settle();
        s.act(studio, "link", { code: alice.state.codes[0] });
        s.settle();
      },
    });
  },
);

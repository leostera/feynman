// Write skew: two doctors on call, each allowed to go off if the other stays.
//
// The rule is that someone is always on call. A doctor who wants to go off asks the roster
// how many are on call and, if it is two, tells the roster they are leaving. Each check is
// right when it is made; two checks made before either leave are both right, and both
// doctors leave. The fix: the roster checks and removes in one step ("leave if someone else
// stays"), so the second doctor is told to stay.
//
// Expected, with two doctors: buggy breaks `covered` in 8 steps without faults (both ask,
// both checks answer two, both are told so, both leave); fixed holds, with a fault too, but
// gets stuck if an answer is lost: the doctor waits for it forever (5 steps).
import { defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone } from "@leostera/feynman";

const Check = defineMessage("Check");
const Count = defineMessage("Count", { onCall: Number }, { tone: "reply" });
const Leave = defineMessage("Leave");
const LeaveIfCovered = defineMessage("LeaveIfCovered");
const Left = defineMessage("Left", {}, { tone: "reply" });
const Stay = defineMessage("Stay", {}, { tone: "refused" });

export function writeSkew(variant: "buggy" | "fixed") {
  const doctors = defineZone({ name: "Doctors", place: { column: 0, region: false } });
  const zone = defineZone({ name: "Hospital", description: "someone must always be on call", place: { column: 1 } });

  const Roster = defineActor({
    name: "Roster",
    zone,
    singleton: true,
    initialState: () => ({ onCall: 2 }),
    display: { icon: "sheet", status: (s) => `${s.onCall} on call`, mood: (s) => (s.onCall >= 1 ? "ok" : "bad") },
    transitions: {
      check: { on: Check, description: "Says how many are on call.", sends: [Count], run: (state, _msg, ctx) => ctx.reply(Count, { onCall: state.onCall }) },
      leave: { on: Leave, description: "Takes a doctor off call.", run: (state) => void (state.onCall -= 1) },
      leaveIfCovered: {
        on: LeaveIfCovered,
        description: "Takes a doctor off call only if another stays, in one step.",
        sends: [Left, Stay],
        run(state, _msg, ctx) {
          if (state.onCall < 2) return ctx.reply(Stay, {});
          state.onCall -= 1;
          ctx.reply(Left, {});
        },
      },
    },
  });

  const Doctor = defineActor({
    name: "Doctor",
    zone: doctors,
    symmetric: true,
    initialState: () => ({ phase: "on" as "on" | "asking" | "off" }),
    display: {
      icon: "person",
      names: ["Meredith", "Cristina"],
      status: (s) => ({ on: "on call", asking: "asking to go off", off: "off call" })[s.phase],
      mood: (s) => ({ on: "ok", asking: "busy", off: "off" })[s.phase] as "ok" | "busy" | "off",
    },
    actions: {
      goOff: {
        label: "Go off call",
        description: "Asks to go off call.",
        when: (state) => state.phase === "on",
        sends: [Check, LeaveIfCovered],
        run(state, _inputs, ctx) {
          state.phase = "asking";
          ctx.send(ctx.the(Roster), variant === "buggy" ? Check : LeaveIfCovered, {});
        },
      },
    },
    transitions: {
      count: {
        on: Count,
        description: "Leaves if the other doctor is on call, by the count it was given.",
        say: (_s, msg) => (msg.onCall < 2 ? `Told ${msg.onCall} on call: stays` : `Told ${msg.onCall} on call: leaves`),
        sends: [Leave],
        run(state, msg, ctx) {
          if (msg.onCall < 2) return void (state.phase = "on");
          state.phase = "off";
          ctx.send(ctx.the(Roster), Leave, {});
        },
      },
      left: { on: Left, description: "Off call.", run: (state) => void (state.phase = "off") },
      stay: { on: Stay, description: "Stays on call.", run: (state) => void (state.phase = "on") },
    },
  });

  const covered = defineProperty("covered", {
    description: "Someone is always on call.",
    always: (w) => w.the(Roster).state.onCall >= 1,
  });

  const oneDoctorGoesOffCall = defineScenario("One doctor goes off call", {
    description: "Meredith asks, the other is on call, and she goes off.",
    run(s) {
      const meredith = s.spawn(Doctor, "Meredith");
      s.spawn(Doctor, "Cristina");
      s.act(meredith, "goOff");
      s.settle();
    },
  });

  const bothAtOnce = defineScenario("Both at once", {
    description:
      variant === "buggy"
        ? "Both ask before either leaves; each is told two are on call, and both go: nobody is on call."
        : "Both ask at once; the roster lets the first go and tells the second to stay.",
    run(s) {
      const meredith = s.spawn(Doctor, "Meredith");
      const cristina = s.spawn(Doctor, "Cristina");
      s.act(meredith, "goOff");
      s.act(cristina, "goOff");
      s.settle();
    },
  });

  return defineSpec({
    name: `Write skew (${variant})`,
    actors: [Roster, Doctor],
    properties: [covered],
    finalState: {
      description: "No doctor is waiting on the roster.",
      when: (w) => w.all(Doctor).every((d) => d.state.phase !== "asking"),
    },
    scenarios: [oneDoctorGoesOffCall, bothAtOnce],
  });
}

/** `feynman check write-skew` checks the buggy variant, so you see the checker find the bug. */
export default writeSkew("buggy");
export const fixed = writeSkew("fixed");

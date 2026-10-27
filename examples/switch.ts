// A switch flipped on and off, and a `never` property that counts how often it went on.
//
// After on-then-off the world is exactly as it started, so a search that merges states by
// the world alone never tries "on" a second time, and wrongly says it never happens. What
// the property remembers of the path (here: how often it went on) is part of the state.
//
// Expected: `onOnce` breaks in 3 steps (on, off, on).
import { defineSpec, message } from "@leostera/feynman";

export function lightSwitch() {
  return defineSpec("Switch", { messages: { Noop: message<{}>({ name: "noop" }) } }, (spec) => {
    const zone = spec.defineZone({ name: "Room" });
    const Switch = spec.defineActor({
      name: "Switch",
      zone,
      singleton: true,
      initialState: () => ({ on: false }),
      look: { icon: "plug", status: (s) => (s.on ? "on" : "off"), mood: (s) => (s.on ? "ok" : "off") },
      transitions: {
        up: { description: "Goes on.", when: (s) => !s.on, run: (s) => void (s.on = true) },
        down: { description: "Goes off.", when: (s) => s.on, run: (s) => void (s.on = false) },
      },
    });
    spec.defineProperties({ onOnce: { description: "The switch never goes on twice.", never: (t) => t.count((e) => e.is(Switch, "up")) >= 2 } });
    spec.defineScenario({
      name: "On and off",
      description: "The switch goes on, then off: back where it started.",
      run(s) {
        s.step(s.the(Switch), "up");
        s.step(s.the(Switch), "down");
      },
    });
    spec.defineScenario({
      name: "On again",
      description: "On, off, and on again: the world is as it was after the first, but the switch has gone on twice.",
      run(s) {
        s.step(s.the(Switch), "up");
        s.step(s.the(Switch), "down");
        s.step(s.the(Switch), "up");
      },
    });
    return { Switch };
  });
}

export default lightSwitch();

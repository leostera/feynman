// Chapter 2: a first check. Expected: `neverOn` breaks in 1 event.
import { defineActor, defineProperty, defineSpec, defineZone } from "@leostera/feynman";

const room = defineZone({ name: "Room" });

const Lamp = defineActor({
  name: "Lamp",
  zone: room,
  singleton: true,
  initialState: () => ({ on: false }),
  transitions: {
    switchOn: { description: "Someone switches it on.", when: (s) => !s.on, run: (s) => void (s.on = true) },
    switchOff: { description: "Someone switches it off.", when: (s) => s.on, run: (s) => void (s.on = false) },
  },
});

const neverOn = defineProperty("neverOn", {
  description: "The lamp is never on.",
  always: (w) => !w.the(Lamp).state.on,
});

export default defineSpec({ name: "Hello", actors: [Lamp], properties: [neverOn] });

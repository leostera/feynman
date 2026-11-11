// Icons, shapes and moods: how the spec's presentation vocabulary is drawn, with Kumo tokens only.
// Each icon from its own module: the package's entry loads all three thousand, which takes a
// second, and `feynman check` loads this kit for every spec with a playground file.
import { BellIcon } from "@phosphor-icons/react/dist/csr/Bell";
import { BrowserIcon } from "@phosphor-icons/react/dist/csr/Browser";
import { CameraIcon } from "@phosphor-icons/react/dist/csr/Camera";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { CloudIcon } from "@phosphor-icons/react/dist/csr/Cloud";
import { CodeIcon } from "@phosphor-icons/react/dist/csr/Code";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { CubeIcon } from "@phosphor-icons/react/dist/csr/Cube";
import { DatabaseIcon } from "@phosphor-icons/react/dist/csr/Database";
import { DesktopIcon } from "@phosphor-icons/react/dist/csr/Desktop";
import { DeviceMobileIcon } from "@phosphor-icons/react/dist/csr/DeviceMobile";
import { EnvelopeIcon } from "@phosphor-icons/react/dist/csr/Envelope";
import { EyeIcon } from "@phosphor-icons/react/dist/csr/Eye";
import { FileIcon } from "@phosphor-icons/react/dist/csr/File";
import { FlowArrowIcon } from "@phosphor-icons/react/dist/csr/FlowArrow";
import { FolderIcon } from "@phosphor-icons/react/dist/csr/Folder";
import { GearIcon } from "@phosphor-icons/react/dist/csr/Gear";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import { HardDriveIcon } from "@phosphor-icons/react/dist/csr/HardDrive";
import { HardDrivesIcon } from "@phosphor-icons/react/dist/csr/HardDrives";
import { IdentificationCardIcon } from "@phosphor-icons/react/dist/csr/IdentificationCard";
import { KeyIcon } from "@phosphor-icons/react/dist/csr/Key";
import { LaptopIcon } from "@phosphor-icons/react/dist/csr/Laptop";
import { LockIcon } from "@phosphor-icons/react/dist/csr/Lock";
import { PlugIcon } from "@phosphor-icons/react/dist/csr/Plug";
import { QueueIcon } from "@phosphor-icons/react/dist/csr/Queue";
import { RobotIcon } from "@phosphor-icons/react/dist/csr/Robot";
import { ShieldCheckIcon } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { TableIcon } from "@phosphor-icons/react/dist/csr/Table";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { UserIcon } from "@phosphor-icons/react/dist/csr/User";
import { UsersIcon } from "@phosphor-icons/react/dist/csr/Users";
import { VideoCameraIcon } from "@phosphor-icons/react/dist/csr/VideoCamera";
import { WifiHighIcon } from "@phosphor-icons/react/dist/csr/WifiHigh";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { appearance, type Icon, type Mood, type Shape, type Spec, type World } from "../spec/index.ts";

export const ICONS: Record<Icon, PhosphorIcon> = {
  person: UserIcon,
  people: UsersIcon,
  phone: DeviceMobileIcon,
  laptop: LaptopIcon,
  desktop: DesktopIcon,
  browser: BrowserIcon,
  server: HardDrivesIcon,
  cloud: CloudIcon,
  database: DatabaseIcon,
  shield: ShieldCheckIcon,
  key: KeyIcon,
  lock: LockIcon,
  terminal: TerminalWindowIcon,
  robot: RobotIcon,
  queue: QueueIcon,
  folder: FolderIcon,
  file: FileIcon,
  sheet: TableIcon,
  globe: GlobeIcon,
  gear: GearIcon,
  camera: CameraIcon,
  video: VideoCameraIcon,
  mail: EnvelopeIcon,
  bell: BellIcon,
  clock: ClockIcon,
  cpu: CpuIcon,
  box: CubeIcon,
  plug: PlugIcon,
  wifi: WifiHighIcon,
  chat: ChatCircleIcon,
  router: WifiHighIcon,
  storage: HardDriveIcon,
  code: CodeIcon,
  pipeline: FlowArrowIcon,
  eye: EyeIcon,
  card: IdentificationCardIcon,
};

export function iconFor(icon: Icon | null): PhosphorIcon {
  return (icon && ICONS[icon]) || CubeIcon;
}

/** Icons of things that serve others: drawn as circles with their name inside. */
const SERVICES = new Set<Icon>(["cloud", "server", "database", "shield", "queue", "storage", "gear", "router", "pipeline", "globe", "cpu", "box", "lock", "key"]);
/** Icons of things a person holds or sits at: drawn as rounded squares. */
const DEVICES = new Set<Icon>(["phone", "laptop", "desktop", "browser", "terminal", "camera", "video"]);

/** What a node is drawn as: what the spec says, or what its icon suggests. On a zone's edge, a gate. */
export function shapeFor(display: { icon?: Icon | null; shape?: Shape | null }, edge = false): Shape {
  if (display.shape) return display.shape;
  if (edge) return "gate";
  if (display.icon && DEVICES.has(display.icon)) return "device";
  return "circle";
}

/** Whether a node's name goes inside it: services and gates carry a short name, the rest wear it below. */
export function labelInside(shape: Shape, icon: Icon | null | undefined, label = ""): boolean {
  if (shape === "card") return true;
  if (label.length > 11) return false;
  return shape === "gate" || (shape === "circle" && Boolean(icon && SERVICES.has(icon)));
}

/** A mood worth a ring: how it is doing says something. Without one, the ring is neutral. */
export function telling(mood: Mood | null | undefined): mood is "ok" | "bad" | "warn" | "busy" {
  return mood === "ok" || mood === "bad" || mood === "warn" || mood === "busy";
}

/** A mood as a CSS colour; "off" and no mood are the neutral line colour. */
export function moodColor(mood: Mood | null | undefined): string {
  switch (mood) {
    case "ok":
      return "var(--color-kumo-success)";
    case "warn":
      return "var(--color-kumo-warning)";
    case "bad":
      return "var(--color-kumo-danger)";
    case "busy":
      return "var(--color-kumo-brand)";
    case "info":
      return "var(--color-kumo-info)";
    default:
      return "var(--color-kumo-line)";
  }
}

/** Message tones as colours, for packets in flight. */
export function toneColor(tone: string | undefined): string {
  switch (tone) {
    case "reply":
      return "var(--color-kumo-success)";
    case "refused":
      return "var(--color-kumo-danger)";
    case "stream":
      return "var(--color-kumo-info)";
    default:
      return "var(--color-kumo-brand)";
  }
}

/** Colours that tell instances apart: Alice blue, Bob purple. Singletons stay neutral. */
export const PALETTE = [1, 2, 3, 4, 5].map((n) => `var(--feynman-identity-${n})`);

/**
 * Who wears which colour. When the spec says whose things are (display.owner, or rows with an
 * owner), only the owners get colours, and what they own wears them: Alice blue, her Mac
 * too. Without any owners, every instance that is not a singleton gets its own.
 */
export function identityColors(spec: Spec, world: World): Map<string, string> {
  const colors = new Map<string, string>();
  const find = (ref: string | null | undefined) => (ref ? world.instances.find((i) => i.id === ref || i.label === ref) : undefined);
  const displays = new Map(world.instances.map((i) => [i.id, appearance(spec, world, i.id)]));
  const owners = new Set<string>();
  for (const display of displays.values()) {
    const owner = find(display.owner);
    if (owner) owners.add(owner.id);
    for (const row of display.rows) {
      const of = find(row.owner);
      if (of) owners.add(of.id);
    }
  }
  const declares = spec.actors.some((a) => a.display.owner) || owners.size > 0;
  let n = 0;
  for (const instance of world.instances) {
    const actor = spec.actors.find((a) => a.name === instance.actor);
    if (!actor || actor.singleton) continue;
    if (declares ? owners.has(instance.id) : true) colors.set(instance.id, PALETTE[n++ % PALETTE.length]);
  }
  for (const [id, display] of displays) {
    const color = find(display.owner) && colors.get(find(display.owner)!.id);
    if (color) colors.set(id, color);
  }
  return colors;
}

export const TONES = [
  { tone: "request", label: "request" },
  { tone: "reply", label: "reply" },
  { tone: "refused", label: "refused" },
  { tone: "stream", label: "stream" },
] as const;

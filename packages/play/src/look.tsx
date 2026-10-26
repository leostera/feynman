// Icons, shapes and moods: how the spec's presentation vocabulary is drawn, with Kumo tokens only.
import {
  BellIcon,
  BrowserIcon,
  CameraIcon,
  ChatCircleIcon,
  ClockIcon,
  CloudIcon,
  CodeIcon,
  CpuIcon,
  CubeIcon,
  DatabaseIcon,
  DesktopIcon,
  DeviceMobileIcon,
  EnvelopeIcon,
  EyeIcon,
  FileIcon,
  FlowArrowIcon,
  FolderIcon,
  GearIcon,
  GlobeIcon,
  HardDriveIcon,
  HardDrivesIcon,
  IdentificationCardIcon,
  KeyIcon,
  LaptopIcon,
  LockIcon,
  PlugIcon,
  QueueIcon,
  RobotIcon,
  ShieldCheckIcon,
  TableIcon,
  TerminalWindowIcon,
  UserIcon,
  UsersIcon,
  VideoCameraIcon,
  WifiHighIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { appearance, type Icon, type Mood, type Shape, type Spec, type World } from "@feynman/spec";

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
export function shapeFor(look: { icon?: Icon | null; shape?: Shape | null }, edge = false): Shape {
  if (look.shape) return look.shape;
  if (edge) return "gate";
  if (look.icon && DEVICES.has(look.icon)) return "device";
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
 * Who wears which colour. When the spec says whose things are (look.owner, or rows with an
 * owner), only the owners get colours, and what they own wears them: Alice blue, her Mac
 * too. Without any owners, every instance that is not a singleton gets its own.
 */
export function identityColors(spec: Spec, world: World): Map<string, string> {
  const colors = new Map<string, string>();
  const find = (ref: string | null | undefined) => (ref ? world.instances.find((i) => i.id === ref || i.label === ref) : undefined);
  const looks = new Map(world.instances.map((i) => [i.id, appearance(spec, world, i.id)]));
  const owners = new Set<string>();
  for (const look of looks.values()) {
    const owner = find(look.owner);
    if (owner) owners.add(owner.id);
    for (const row of look.rows) {
      const of = find(row.owner);
      if (of) owners.add(of.id);
    }
  }
  const declares = spec.actors.some((a) => a.look.owner) || owners.size > 0;
  let n = 0;
  for (const instance of world.instances) {
    const actor = spec.actors.find((a) => a.name === instance.actor);
    if (!actor || actor.singleton) continue;
    if (declares ? owners.has(instance.id) : true) colors.set(instance.id, PALETTE[n++ % PALETTE.length]);
  }
  for (const [id, look] of looks) {
    const color = find(look.owner) && colors.get(find(look.owner)!.id);
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

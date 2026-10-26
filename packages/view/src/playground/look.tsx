// Icons and moods: how the spec's presentation vocabulary is drawn, with Kumo tokens only.
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
import { appearance, type Icon, type Mood, type Spec, type World } from "@feynman/spec";

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
const PALETTE = [1, 2, 3, 4, 5].map((n) => `var(--feynman-identity-${n})`);

/**
 * Who wears which colour. Instances of actors that name an owner wear their owner's colour
 * (a Mac, its person's), or none while they have no owner. Other instances that are not
 * singletons each get their own (Alice blue, Bob purple).
 */
export function identityColors(spec: Spec, world: World): Map<string, string> {
  const colors = new Map<string, string>();
  let n = 0;
  for (const instance of world.instances) {
    const actor = spec.actors.find((a) => a.name === instance.actor);
    if (!actor || actor.singleton || actor.look.owner) continue;
    colors.set(instance.id, PALETTE[n++ % PALETTE.length]);
  }
  for (const instance of world.instances) {
    const owner = appearance(spec, world, instance.id).owner;
    if (!owner) continue;
    const of = world.instances.find((i) => i.id === owner || i.label === owner);
    const color = of && colors.get(of.id);
    if (color) colors.set(instance.id, color);
  }
  return colors;
}

export const TONES = [
  { tone: "request", label: "request" },
  { tone: "reply", label: "reply" },
  { tone: "refused", label: "refused" },
  { tone: "stream", label: "stream" },
] as const;

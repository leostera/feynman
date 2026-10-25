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
import type { Icon, Mood } from "@feynman/spec";

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

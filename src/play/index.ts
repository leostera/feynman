// @leostera/feynman/play: how a spec is shown. A playground file (`specs/<name>.play.tsx`) composes
// this kit; the explorer draws its defaults with the same pieces.
export { definePlayground, groupsOf, isPlayground } from "./define.ts";
export type { Act, ActorPresentation, GroupPresentation, GroupProps, LinkStyle, Member, NodeProps, Playground, PlayBuilder, Self, Size, TokenProps } from "./define.ts";
export { Badge, Card, Icon, Node, Panel, PlayProvider, Rows, Terminal, Ticket, usePlay } from "./kit.tsx";
export type { NodeBadge, NodeVisualProps, PlayContextValue } from "./kit.tsx";
export { iconFor, ICONS, identityColors, labelInside, moodColor, PALETTE, shapeFor, telling, toneColor, TONES } from "./display.tsx";

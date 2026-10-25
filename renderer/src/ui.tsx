import { Badge, Text } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import { anchorPath, type Address, type ClaimStatus, type Kind } from "./model";
import { useNavigation } from "./navigation";

export const KIND_LABEL: Record<Kind, string> = {
  overview: "Overview",
  actor: "Actor",
  flow: "Flow",
  state: "State",
  machine: "State machine",
  boundary: "Boundary",
  invariant: "Invariant",
  contract: "Contract",
  observability: "Observability",
  claim: "Claim",
  index: "Index",
};

type BadgeVariant = "neutral" | "blue" | "green" | "orange" | "purple" | "teal" | "red";

const KIND_COLOR: Record<Kind, BadgeVariant> = {
  overview: "neutral",
  actor: "blue",
  flow: "purple",
  state: "teal",
  machine: "teal",
  boundary: "orange",
  invariant: "green",
  contract: "neutral",
  observability: "neutral",
  claim: "orange",
  index: "neutral",
};

export function KindBadge({ kind }: { kind: Kind }) {
  return <Badge variant={KIND_COLOR[kind]}>{KIND_LABEL[kind]}</Badge>;
}

const STATUS: Record<ClaimStatus, { label: string; variant: "success" | "warning" | "error" | "info" }> = {
  supported: { label: "Supported", variant: "success" },
  "partially-supported": { label: "Partially supported", variant: "warning" },
  contradicted: { label: "Contradicted", variant: "error" },
  unverified: { label: "Unverified", variant: "info" },
};

export const STATUS_ORDER: ClaimStatus[] = ["contradicted", "partially-supported", "unverified", "supported"];

export function StatusBadge({ status }: { status: ClaimStatus }) {
  return <Badge variant={STATUS[status].variant}>{STATUS[status].label}</Badge>;
}

export function statusLabel(status: ClaimStatus): string {
  return STATUS[status].label;
}

/** A link to another card. Unknown ids render as plain text. */
export function Ref({ to, children, plain = false }: { to: Address | null; children: ReactNode; plain?: boolean }) {
  const { open } = useNavigation();
  if (!to) return <span>{children}</span>;
  return (
    <button
      type="button"
      onClick={() => open(to)}
      className={`cursor-pointer text-left hover:underline focus-visible:underline focus-visible:outline-none ${
        plain ? "text-kumo-default" : "text-kumo-link"
      }`}
    >
      {children}
    </button>
  );
}

/** Link to any model element by id, resolving its kind. */
export function IdRef({ id }: { id: string }) {
  const { index } = useNavigation();
  const kind = index.kindOf.get(id);
  return <Ref to={kind ? { kind, id } : null}>{id}</Ref>;
}

export function Anchors({ anchors, label = "Anchors" }: { anchors: string[]; label?: string }) {
  if (anchors.length === 0) return null;
  return (
    <Section title={label}>
      <ul className="flex flex-col gap-1">
        {anchors.map((anchor) => {
          const [path, symbol] = anchor.split("#");
          return (
            <li key={anchor} className="font-mono text-xs text-kumo-strong" title={anchorPath(anchor)}>
              {path}
              {symbol && <span className="text-kumo-subtle">#{symbol}</span>}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <Text variant="secondary" size="xs" bold as="p">
        {title.toUpperCase()}
      </Text>
      {children}
    </section>
  );
}

export function Chips({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <Badge key={item} variant="neutral">
          {item}
        </Badge>
      ))}
    </div>
  );
}

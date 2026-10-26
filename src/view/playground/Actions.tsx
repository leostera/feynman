// Acting on a node: clicking it opens a thin bar over it with one small button per action
// its members can take now. An action without inputs runs at once. One with a single input
// offers its choices in the bar; when those name instances, the nodes themselves light up
// and clicking one chooses it ("Open a Mac", then click the Mac). Anything more opens a
// small dialog. The bar also opens and closes groups, inspects state, and restarts.
import { Button, Dialog, Input, Select } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, ArrowLeftIcon, CornersInIcon, CornersOutIcon, EyeIcon, XIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { worldView, type ActionInfo, type Spec, type World } from "../../spec/index.ts";
import { messageName } from "../format";
import type { Op } from "../session";
import type { SceneNode } from "../scene";
import { Sources, StateTree, useExplorer } from "../ui";

/** An action waiting for its inputs; `inputs` are already filled in, such as by a drop. */
export interface Asking {
  instance: string;
  action: string;
  inputs?: Record<string, unknown>;
}

/** An action waiting for its one remaining input, chosen in the bar or by clicking a node. */
export interface Choosing {
  instance: string;
  action: string;
  input: string;
  values: unknown[];
  inputs: Record<string, unknown>;
}

function safe(f: () => boolean): boolean {
  try {
    return f();
  } catch {
    return false;
  }
}

/** What clicking an action does: run it, choose its one input, or ask for several. */
export function startAction(spec: Spec, world: World, instance: string, action: ActionInfo): { run: Op } | { choose: Choosing } | { ask: Asking } {
  const names = Object.keys(action.inputs);
  if (!names.length) return { run: { op: "act", instance, key: action.key, inputs: {} } };
  const examples = examplesOf(spec, world, action);
  if (names.length === 1 && examples[names[0]].length) return { choose: { instance, action: action.key, input: names[0], values: examples[names[0]], inputs: {} } };
  return { ask: { instance, action: action.key } };
}

/** From this many actions, the bar becomes a menu: one action per row, beside the node. */
export const STACK_FROM = 4;

/** The actions a node offers now: every member's actions whose `when` holds. */
export function actionsOf(spec: Spec, node: SceneNode) {
  return node.members.flatMap((m) => {
    const actor = spec.actors.find((a) => a.name === m.actor)!;
    return Object.values(actor.actions)
      .filter((a) => !a.when || safe(() => a.when!(m.state)))
      .map((action) => ({ member: m, action }));
  });
}

export function ActionBar({
  node,
  world,
  choosing,
  group,
  onStart,
  onRun,
  onAsk,
  onBack,
  onInspect,
  onToggleGroup,
  onClose,
  nameOf,
}: {
  /** A choice as a person reads it: an instance by the name of the node it is drawn in. */
  nameOf: (value: unknown) => string;
  node: SceneNode;
  world: World;
  choosing: Choosing | null;
  /** Whether this node is a closed group ("open") or a member of an open one ("close"). */
  group: { label: string; open: boolean } | null;
  onStart: (instance: string, action: ActionInfo) => void;
  onRun: (op: Op) => void;
  onAsk: (asking: Asking) => void;
  onBack: () => void;
  onInspect: (ids: string[]) => void;
  onToggleGroup: () => void;
  onClose: () => void;
}) {
  const { spec } = useExplorer();
  const shell = "flex max-w-[44rem] items-center gap-0.5 rounded-full bg-kumo-elevated p-0.5 pl-2 text-[11px] shadow-xl ring-1 ring-kumo-brand";
  if (choosing) {
    const instance = world.instances.find((i) => i.id === choosing.instance);
    const action = instance && spec.actors.find((a) => a.name === instance.actor)!.actions[choosing.action];
    if (!instance || !action) return null;
    return (
      <div className={shell} role="toolbar" aria-label={`${action.label}: choose ${choosing.input}`}>
        <Button size="xs" variant="ghost" shape="square" aria-label="Back" icon={<ArrowLeftIcon size={11} />} onClick={onBack} />
        <span className="whitespace-nowrap pr-1 font-medium">{action.label}:</span>
        {choosing.values.slice(0, 6).map((value) => (
          <Button key={String(value)} size="xs" variant="secondary" onClick={() => onRun({ op: "act", instance: instance.id, key: action.key, inputs: { ...choosing.inputs, [choosing.input]: value } })}>
            {nameOf(value)}
          </Button>
        ))}
        <Button size="xs" variant="ghost" onClick={() => onAsk({ instance: instance.id, action: action.key, inputs: choosing.inputs })}>
          Other…
        </Button>
      </div>
    );
  }
  const actions = actionsOf(spec, node);
  const many = new Set(actions.map((a) => a.member.id)).size > 1;
  const buttons = actions.map(({ member, action }) => (
    <Button
      key={`${member.id}.${action.key}`}
      size="xs"
      variant={actions.length >= STACK_FROM ? "ghost" : "secondary"}
      className={actions.length >= STACK_FROM ? "w-full justify-start" : undefined}
      title={`${many ? `${member.label}: ` : ""}${action.description}`}
      onClick={() => onStart(member.id, action)}
    >
      {action.label}
      {Object.keys(action.inputs).length ? "…" : ""}
    </Button>
  ));
  const tools = (
    <>
      {group && (
        <Button size="xs" variant="ghost" icon={group.open ? <CornersInIcon size={11} /> : <CornersOutIcon size={11} />} onClick={onToggleGroup}>
          {group.open ? `Close ${group.label}` : "Look inside"}
        </Button>
      )}
      <Button size="xs" variant="ghost" shape="square" aria-label="Inspect" title="Inspect its state" icon={<EyeIcon size={11} />} onClick={() => onInspect(node.members.map((m) => m.id))} />
      {node.members.length === 1 && (
        <Button size="xs" variant="ghost" shape="square" aria-label={`Restart ${node.label}`} title={`Restart ${node.label}`} icon={<ArrowCounterClockwiseIcon size={11} />} onClick={() => onRun({ op: "restart", instance: node.members[0].id })} />
      )}
      <Button size="xs" variant="ghost" shape="square" aria-label="Close" icon={<XIcon size={11} />} onClick={onClose} />
    </>
  );
  if (actions.length >= STACK_FROM) {
    // Too many for one row: a menu, the node's name and tools on top, an action per row below.
    return (
      <div className="flex w-56 flex-col rounded-lg bg-kumo-elevated p-0.5 text-[11px] shadow-xl ring-1 ring-kumo-brand" role="menu" aria-label={node.label}>
        <div className="flex items-center gap-0.5 border-b border-kumo-hairline pb-0.5 pl-2">
          <span className="min-w-0 flex-1 truncate font-semibold">{node.label}</span>
          {tools}
        </div>
        <div className="flex flex-col pt-0.5">{buttons}</div>
      </div>
    );
  }
  return (
    <div className={shell} role="toolbar" aria-label={node.label}>
      <span className="whitespace-nowrap pr-1 font-semibold">{node.label}</span>
      {actions.length === 0 && <span className="whitespace-nowrap px-1 text-kumo-subtle">only answers messages</span>}
      {buttons}
      <span className="mx-0.5 h-4 w-px bg-kumo-line" />
      {tools}
    </div>
  );
}

/** Values an input offers: its examples in this world, or its choices. */
export function examplesOf(spec: Spec, world: World, action: ActionInfo): Record<string, unknown[]> {
  const view = worldView(spec, world);
  return Object.fromEntries(
    Object.entries(action.inputs).map(([name, input]) => {
      let values: unknown[] = [];
      try {
        values = input.examples ? input.examples(view as never) : input.type === "choice" ? (input.values ?? []) : input.type === "boolean" ? [true, false] : [];
      } catch {
        values = [];
      }
      return [name, [...new Set(values.map((v) => JSON.stringify(v)))].map((v) => JSON.parse(v) as unknown)];
    }),
  );
}

export function InputsDialog({ target, world, onClose, onRun }: { target: Asking | null; world: World; onClose: () => void; onRun: (op: Op) => void }) {
  const { spec } = useExplorer();
  const instance = target && world.instances.find((i) => i.id === target.instance);
  const action = instance && spec.actors.find((a) => a.name === instance.actor)!.actions[target!.action];
  return (
    <Dialog.Root open={Boolean(action)} onOpenChange={(open) => !open && onClose()}>
      <Dialog className="w-[26rem] p-6">
        {action && instance && <InputsForm key={`${instance.id}.${action.key}`} action={action} label={instance.label} given={target!.inputs ?? {}} examples={examplesOf(spec, world, action)} onCancel={onClose} onSubmit={(inputs) => (onRun({ op: "act", instance: instance.id, key: action.key, inputs }), onClose())} />}
      </Dialog>
    </Dialog.Root>
  );
}

function InputsForm({ action, label, given, examples, onCancel, onSubmit }: { action: ActionInfo; label: string; given: Record<string, unknown>; examples: Record<string, unknown[]>; onCancel: () => void; onSubmit: (inputs: Record<string, unknown>) => void }) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(action.inputs).map(([name, input]) => [name, String(given[name] ?? examples[name]?.[0] ?? (input.type === "number" ? 0 : ""))])),
  );
  const parse = (name: string, raw: string): unknown => {
    const type = action.inputs[name].type;
    return type === "number" ? Number(raw) : type === "boolean" ? raw === "true" : raw;
  };
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(Object.fromEntries(Object.keys(action.inputs).map((n) => [n, parse(n, values[n])])));
      }}
    >
      <div>
        <Dialog.Title className="text-base font-semibold">
          {label}: {action.label}
        </Dialog.Title>
        <Dialog.Description className="text-sm text-kumo-subtle">{action.description}</Dialog.Description>
      </div>
      {Object.entries(action.inputs).map(([name, input]) =>
        examples[name]?.length ? (
          <ChoiceOrOther key={name} name={name} options={examples[name].map(String)} value={values[name]} onChange={(v) => setValues({ ...values, [name]: v })} />
        ) : (
          <Input key={name} label={name} autoFocus type={input.type === "number" ? "number" : "text"} value={values[name]} onChange={(e) => setValues({ ...values, [name]: e.target.value })} />
        ),
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary">
          {action.label}
        </Button>
      </div>
    </form>
  );
}

/** Pick one of the examples, or type something else. */
function ChoiceOrOther({ name, options, value, onChange }: { name: string; options: string[]; value: string; onChange: (v: string) => void }) {
  const other = !options.includes(value);
  return (
    <div className="flex flex-col gap-2">
      <Select label={name} hideLabel={false} value={other ? "__other" : value} onValueChange={(v) => onChange(v === "__other" ? "" : String(v))}>
        {options.map((o) => (
          <Select.Option key={o} value={o}>
            {o}
          </Select.Option>
        ))}
        <Select.Option value="__other">Something else…</Select.Option>
      </Select>
      {other && <Input aria-label={`${name}, something else`} autoFocus value={value} onChange={(e) => onChange(e.target.value)} />}
    </div>
  );
}

export function InspectDialog({ ids, world, onClose }: { ids: string[] | null; world: World; onClose: () => void }) {
  const { spec } = useExplorer();
  const instances = (ids ?? []).map((id) => world.instances.find((i) => i.id === id)).filter((i): i is NonNullable<typeof i> => Boolean(i));
  return (
    <Dialog.Root open={instances.length > 0} onOpenChange={(open) => !open && onClose()}>
      <Dialog className="max-h-[80vh] w-[34rem] overflow-y-auto p-5">
        <div className="flex flex-col gap-5">
          {instances.map((instance, n) => {
            const actor = spec.actors.find((a) => a.name === instance.actor)!;
            return (
              <div key={instance.id} className="flex flex-col gap-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    {n === 0 ? <Dialog.Title className="text-sm font-semibold">{instance.label}</Dialog.Title> : <h2 className="text-sm font-semibold">{instance.label}</h2>}
                    <p className="text-xs text-kumo-subtle">{actor.description ?? `${actor.name}, in ${actor.zone}`}</p>
                  </div>
                  {n === 0 && <Dialog.Close render={(props) => <Button {...props} variant="ghost" size="sm" shape="square" aria-label="Close" icon={<XIcon />} />} />}
                </div>
                <section>
                  <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-kumo-subtle">State</h3>
                  <StateTree value={instance.state} />
                  {actor.durable.length > 0 && <p className="mt-1 text-xs text-kumo-subtle">A restart keeps {actor.durable.join(", ")}.</p>}
                </section>
                {Object.values(actor.transitions).length > 0 && (
                  <section className="flex flex-col gap-1.5">
                    <h3 className="text-[11px] font-medium uppercase tracking-wide text-kumo-subtle">What it does by itself</h3>
                    {Object.values(actor.transitions).map((t) => (
                      <div key={t.key} className="flex flex-col gap-1">
                        <p className="text-xs">
                          <span className="font-medium">{t.message ? `On ${messageName(spec, t.message)}` : t.key}</span> <span className="text-kumo-subtle">{t.description}</span>
                        </p>
                        <Sources sources={t.sources} />
                      </div>
                    ))}
                  </section>
                )}
              </div>
            );
          })}
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

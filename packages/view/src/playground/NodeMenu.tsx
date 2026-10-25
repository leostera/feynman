// Acting on a node: clicking it opens a menu with one line per action. An action without
// inputs runs at once; one with inputs opens a small dialog for them first. "Inspect" shows
// its state and what it does by itself; "Restart" crashes it.
import { Button, Dialog, DropdownMenu, Input, Select } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, EyeIcon, LightningIcon, XIcon } from "@phosphor-icons/react";
import { useState, type ReactElement, type ReactNode } from "react";
import { appearance, worldView, type ActionInfo, type Spec, type World } from "@feynman/spec";
import { messageName } from "../format";
import type { Op } from "../session";
import { Sources, StateTree, useExplorer } from "../ui";

/** An action waiting for its inputs; `inputs` are already filled in, such as by a drop. */
export interface Asking {
  instance: string;
  action: string;
  inputs?: Record<string, unknown>;
}

export interface MenuHandlers {
  onRun: (op: Op) => void;
  /** Ask for an action's inputs before running it. */
  onInputs: (instance: string, action: string) => void;
  onInspect: (instance: string) => void;
}

function safe(f: () => boolean): boolean {
  try {
    return f();
  } catch {
    return false;
  }
}

export function NodeMenu({ id, world, trigger, children, handlers }: { id: string; world: World; trigger: ReactElement; children: ReactNode; handlers: MenuHandlers }) {
  const { spec } = useExplorer();
  const instance = world.instances.find((i) => i.id === id);
  if (!instance) return null;
  const actor = spec.actors.find((a) => a.name === instance.actor)!;
  const look = appearance(spec, world, id);
  const actions = Object.values(actor.actions);
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger render={trigger}>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Content>
        <DropdownMenu.Group>
        <DropdownMenu.Label>
          {instance.label}
          {look.status ? ` · ${look.status}` : ""}
        </DropdownMenu.Label>
        {actions.length === 0 && <DropdownMenu.Item disabled>Nothing to do here; it only answers messages</DropdownMenu.Item>}
        {actions.map((action) => {
          const enabled = !action.when || safe(() => action.when!(instance.state));
          const asks = Object.keys(action.inputs).length > 0;
          return (
            <DropdownMenu.Item
              key={action.key}
              icon={<LightningIcon />}
              disabled={!enabled}
              onClick={() => (asks ? handlers.onInputs(id, action.key) : handlers.onRun({ op: "act", instance: id, key: action.key, inputs: {} }))}
            >
              {action.label}
              {asks ? "…" : ""}
            </DropdownMenu.Item>
          );
        })}
        </DropdownMenu.Group>
        <DropdownMenu.Separator />
        <DropdownMenu.Item icon={<EyeIcon />} onClick={() => handlers.onInspect(id)}>
          Inspect…
        </DropdownMenu.Item>
        <DropdownMenu.Item icon={<ArrowCounterClockwiseIcon />} variant="danger" onClick={() => handlers.onRun({ op: "restart", instance: id })}>
          Restart {instance.label}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

/** Values an input offers: its examples in this world, or its choices. */
function examplesOf(spec: Spec, world: World, action: ActionInfo): Record<string, unknown[]> {
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

export function InspectDialog({ id, world, onClose }: { id: string | null; world: World; onClose: () => void }) {
  const { spec } = useExplorer();
  const instance = id ? world.instances.find((i) => i.id === id) : null;
  const actor = instance && spec.actors.find((a) => a.name === instance.actor)!;
  return (
    <Dialog.Root open={Boolean(instance)} onOpenChange={(open) => !open && onClose()}>
      <Dialog className="max-h-[80vh] w-[34rem] overflow-y-auto p-6">
        {instance && actor && (
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <Dialog.Title className="text-base font-semibold">{instance.label}</Dialog.Title>
                <Dialog.Description className="text-sm text-kumo-subtle">{actor.description ?? `${actor.name}, in ${actor.zone}`}</Dialog.Description>
              </div>
              <Dialog.Close render={(props) => <Button {...props} variant="ghost" size="sm" shape="square" aria-label="Close" icon={<XIcon />} />} />
            </div>
            <section>
              <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-kumo-subtle">State</h3>
              <StateTree value={instance.state} />
              {actor.durable.length > 0 && <p className="mt-1 text-xs text-kumo-subtle">A restart keeps {actor.durable.join(", ")}.</p>}
            </section>
            {Object.values(actor.transitions).length > 0 && (
              <section className="flex flex-col gap-2">
                <h3 className="text-[11px] font-medium uppercase tracking-wide text-kumo-subtle">What it does by itself</h3>
                {Object.values(actor.transitions).map((t) => (
                  <div key={t.key} className="flex flex-col gap-1">
                    <p className="text-sm">
                      <span className="font-medium">{t.message ? `On ${messageName(spec, t.message)}` : t.key}</span> <span className="text-kumo-subtle">{t.description}</span>
                    </p>
                    <Sources sources={t.sources} />
                  </div>
                ))}
              </section>
            )}
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  );
}

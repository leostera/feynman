import { Badge, Button, LayerCard, LinkButton, Text } from "@cloudflare/kumo";
import {
  ArrowRightIcon,
  ArrowsLeftRightIcon,
  ChatsCircleIcon,
  CheckIcon,
  CircleHalfIcon,
  CodeIcon,
  CopyIcon,
  FileHtmlIcon,
  GitPullRequestIcon,
  GlobeIcon,
  PlayIcon,
  RobotIcon,
  ShieldCheckIcon,
  TerminalIcon,
  type Icon,
} from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import sims from "../sims.json";
import type { Sim } from "../scripts/sims.ts";
import { published, refLabel } from "../scripts/published.ts";
import install from "../snippets/install.sh?highlight";
import leaseLock from "../snippets/lease-lock.ts?highlight";
import prompt from "../snippets/prompt.txt?highlight";

const SIMS = sims as Sim[];
const AXO = SIMS.find((sim) => sim.slug === "github.com/leostera/axo");

const VIEWS: { icon: Icon; name: string; text: string }[] = [
  {
    icon: PlayIcon,
    name: "A simulator",
    text: "Add people and machines, press the buttons they would, and watch each message travel. Step through the timeline, go back to any moment, and try something else from there.",
  },
  {
    icon: ShieldCheckIcon,
    name: "A model checker",
    text: "Tries every order of events within bounds, with lost messages and retries, then takes long random runs. It shows the shortest trace that breaks a rule, and says how sure it is.",
  },
  {
    icon: ArrowsLeftRightIcon,
    name: "Flows, and how they change",
    text: "Every scenario as a step-by-step flow. Compare with another commit to see which flows a change alters, and how.",
  },
  {
    icon: CodeIcon,
    name: "The code behind each step",
    text: "Each step links to the code it stands for, with its call tree. The checker notices when that code changes under the spec.",
  },
];

const SPEC_PARTS: { name: string; text: string }[] = [
  { name: "Actors", text: "hold state. Actions are what people do; transitions answer messages and timers." },
  { name: "Messages and timers", text: "take time, and messages can be lost. Limits bound retries and sizes." },
  { name: "Invariants", text: "say what must always, or eventually, hold. Scenarios are named stories the checker starts from." },
  { name: "Sources", text: "anchor each step to a file and symbol in the repository." },
];

const VERDICTS: { mark: string; name: string; text: string; tone: string }[] = [
  { mark: "✗", name: "Broken", text: "with the trace that breaks it, found by the search, a random run, or a scenario.", tone: "text-kumo-danger" },
  { mark: "✓", name: "Holds", text: "in every state within the bounds, all of them explored.", tone: "text-kumo-success" },
  { mark: "~", name: "Held so far", text: "in every state explored, but the search ran out of time or states first.", tone: "text-kumo-warning" },
  { mark: "?", name: "Never tested", text: "nothing reached the situation the rule is about, so it says nothing yet.", tone: "text-kumo-subtle" },
];

const STEPS: { icon: Icon; name: string; text: ReactNode }[] = [
  {
    icon: RobotIcon,
    name: "An agent writes the spec",
    text: (
      <>
        Ask your coding agent to model part of your system with the Feynman skill. It reads the code, writes <Code>specs/&lt;name&gt;.ts</Code>,
        and runs the checker until every rule holds, or a break is a real bug.
      </>
    ),
  },
  {
    icon: TerminalIcon,
    name: "You check it and play with it",
    text: (
      <>
        <Code>feynman check</Code> reports every rule in the terminal. <Code>feynman dev</Code> serves the simulator and reloads it as the spec
        changes.
      </>
    ),
  },
  {
    icon: FileHtmlIcon,
    name: "You share one file",
    text: (
      <>
        <Code>feynman build</Code> writes the simulator, the checks, and the flows into one self-contained HTML file. Open it from disk, attach it
        to a pull request, or publish it, like the ones below.
      </>
    ),
  },
];

const ROADMAP: { icon: Icon; name: string; status: "now" | "next" | "later"; text: string }[] = [
  {
    icon: PlayIcon,
    name: "Specs, the simulator, and the checker",
    status: "now",
    text: "Write a spec, play with it, check it, and build it into a single page.",
  },
  {
    icon: GlobeIcon,
    name: "A simulator for any repository",
    status: "next",
    text: "Open feynman.leostera.dev/s/<host>/<owner>/<repo>, and a Worker builds the simulator from the specs in that repository.",
  },
  {
    icon: GitPullRequestIcon,
    name: "What a change does",
    status: "next",
    text: "On every pull request: the flows it alters and the rules it breaks, next to the diff.",
  },
  {
    icon: ChatsCircleIcon,
    name: "Review in the loop",
    status: "later",
    text: "While you build with an agent, try the change in the simulator and send your comments back to the same session.",
  },
];

export function App() {
  return (
    <div className="min-h-screen bg-kumo-canvas text-kumo-default">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <a href="/" className="text-lg font-semibold tracking-tight text-kumo-default">
          Feynman
        </a>
        <nav className="flex items-center gap-1">
          <LinkButton href="#simulators" variant="ghost" size="sm">
            Simulators
          </LinkButton>
          <LinkButton href="#start" variant="ghost" size="sm">
            Get started
          </LinkButton>
          <LinkButton href="#agents" variant="ghost" size="sm">
            Agents
          </LinkButton>
          <LinkButton href="#checker" variant="ghost" size="sm">
            Checker
          </LinkButton>
          <LinkButton href="#roadmap" variant="ghost" size="sm">
            Roadmap
          </LinkButton>
          <ModeToggle />
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-6">
        <section className="pt-16 pb-12 sm:pt-24">
          <Badge variant="beta">Early</Badge>
          <h1 className="mt-5 max-w-3xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
            Understand how a system behaves, and what each change does to it.
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-kumo-subtle">
            A Feynman spec is a small model of a system that runs: its actors and their state, the messages between them, the actions people
            take, and the rules that must always hold. Each step names the code it stands for. From one spec, Feynman builds a simulator you can
            play with, and a model checker that looks for the order of events that breaks your rules.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            {AXO && (
              <LinkButton href={simHref(AXO)} variant="primary" icon={ArrowRightIcon}>
                Open the axo simulator
              </LinkButton>
            )}
            <LinkButton href="#start" variant="secondary">
              Get started
            </LinkButton>
          </div>
        </section>

        {AXO && (
          <figure className="pb-16">
            <a href={simHref(AXO)} className="block overflow-hidden rounded-xl ring-1 ring-kumo-line shadow-lg transition hover:ring-kumo-brand">
              <img src="/axo-sim-light.jpg" alt="The axo simulator: two people, two Macs, and the relay between them" width={1500} height={900} className="block w-full [[data-mode=dark]_&]:hidden" />
              <img src="/axo-sim-dark.jpg" alt="The axo simulator: two people, two Macs, and the relay between them" width={1500} height={900} className="hidden w-full [[data-mode=dark]_&]:block" />
            </a>
            <figcaption className="mt-3 text-sm text-kumo-subtle">
              axo's remote access, built from its spec. It is the real thing, not a video: open it, add a Mac, lose a message, go back in time.
            </figcaption>
          </figure>
        )}

        <Section id="views" title="One spec, four ways to look at it" lead="Write the behaviour down once. Everything else is derived from it, so nothing drifts apart.">
          <div className="grid gap-4 sm:grid-cols-2">
            {VIEWS.map(({ icon: Icon, name, text }) => (
              <LayerCard key={name} className="p-5">
                <Icon size={22} className="text-kumo-subtle" />
                <Text variant="heading3" as="h3">
                  <span className="mt-3 block">{name}</span>
                </Text>
                <p className="mt-2 text-sm text-kumo-subtle">{text}</p>
              </LayerCard>
            ))}
          </div>
        </Section>

        <Section
          id="spec"
          title="What a spec looks like"
          lead="Plain TypeScript, kept next to the code it describes, and written to be read. This one is complete: a lock server that hands out tokens, clients that take the lock, and a rule they must keep."
        >
          <div className="grid gap-8 lg:grid-cols-[1fr_1.7fr]">
            <ul className="space-y-4 text-sm text-kumo-subtle">
              {SPEC_PARTS.map(({ name, text }) => (
                <li key={name}>
                  <strong className="text-kumo-default">{name}</strong> {text}
                </li>
              ))}
              <li>
                A spec has no presentation in it. An optional <Code>.play.tsx</Code> file next to it gives the simulator its own look.
              </li>
            </ul>
            <CodeBlock snippet={leaseLock} label="specs/lease-lock.ts" />
          </div>
        </Section>

        <Section id="start" title="Get started" lead="Feynman is one package, @leostera/feynman, and runs on Bun 1.3 or later.">
          <CodeBlock snippet={install} label="In the repository to model" />
          <p className="mt-4 text-sm text-kumo-subtle">
            Specs live in <Code>specs/*.ts</Code> and import <Code>@leostera/feynman</Code>. An optional <Code>specs/&lt;name&gt;.play.tsx</Code>{" "}
            imports <Code>@leostera/feynman/play</Code>.{" "}
            <a className="text-kumo-link underline" href="https://www.npmjs.com/package/@leostera/feynman">
              The package on npm
            </a>
            .
          </p>
        </Section>

        <Section id="agents" title="Hand it to your agent" lead="Agents write and maintain specs; Feynman gives them what they need to do it well.">
          <CodeBlock snippet={prompt} label="A prompt to start from" />
          <ul className="mt-6 grid gap-3 text-sm text-kumo-subtle sm:grid-cols-3">
            <li>
              <a className="font-semibold text-kumo-default underline" href="/SKILL.md">
                /SKILL.md
              </a>{" "}
              is the whole method: how to read a codebase, model it, check it, and report. The package ships it as a skill too, which Pi loads.
            </li>
            <li>
              <a className="font-semibold text-kumo-default underline" href="/llms.txt">
                /llms.txt
              </a>{" "}
              says what Feynman is and lists everything here, in plain text.
            </li>
            <li>
              <strong className="text-kumo-default">Every simulator</strong> has its check report beside it as text, such as{" "}
              {AXO ? (
                <a className="font-mono text-kumo-default underline" href={`${simHref(AXO)}check.txt`}>
                  check.txt
                </a>
              ) : (
                "check.txt"
              )}
              , and links to its spec at the commit it was built from.
            </li>
          </ul>
        </Section>

        <Section id="checker" title="A checker that says how sure it is" lead="Every rule gets one of four verdicts, and Feynman never rounds up.">
          <ul className="grid gap-3 sm:grid-cols-2">
            {VERDICTS.map(({ mark, name, text, tone }) => (
              <li key={name} className="flex gap-3 rounded-lg border border-kumo-hairline p-4">
                <span className={`w-5 shrink-0 text-center font-mono text-lg font-semibold leading-6 ${tone}`}>{mark}</span>
                <p className="text-sm text-kumo-subtle">
                  <strong className="text-kumo-default">{name}</strong> {text}
                </p>
              </li>
            ))}
          </ul>
          <p className="mt-8 max-w-3xl text-sm text-kumo-subtle">
            The checker is tested against others. A corpus of well-known systems (two-phase commit, leader election, a lease lock, a cache, a job
            queue, payments) comes in a buggy and a fixed version of each. Where the same system is modelled in TLA+, Feynman finds the same number
            of distinct states, the same verdicts, and counterexamples of the same length as TLC. The P checker agrees on the verdicts.
          </p>
        </Section>

        <Section id="how" title="How you get a spec" lead="Agents write and maintain specs. Feynman owns the engine, the checker, and every view.">
          <ol className="grid gap-4 sm:grid-cols-3">
            {STEPS.map(({ icon: Icon, name, text }) => (
              <li key={name} className="rounded-lg border border-kumo-hairline p-5">
                <Icon size={22} className="text-kumo-subtle" />
                <Text variant="heading3" as="h3">
                  <span className="mt-3 block">{name}</span>
                </Text>
                <p className="mt-2 text-sm text-kumo-subtle">{text}</p>
              </li>
            ))}
          </ol>
        </Section>

        <Section id="simulators" title="Simulators" lead="Built from the specs in public repositories, at the commit named on each.">
          <div className="grid gap-4 sm:grid-cols-2">
            {SIMS.filter(published).map((sim) => (
              <a key={sim.slug} href={simHref(sim)} className="group block">
                <LayerCard className="h-full p-5 transition-colors group-hover:bg-kumo-tint">
                  <div className="flex items-center justify-between">
                    <Text variant="heading3" as="h3">
                      {sim.title}
                    </Text>
                    <ArrowRightIcon size={18} className="text-kumo-subtle" />
                  </div>
                  <p className="mt-2 text-sm text-kumo-subtle">{sim.summary}</p>
                  <p className="mt-4 font-mono text-xs text-kumo-subtle">
                    /s/{sim.slug} · {refLabel(sim)} · {sim.specs.length} spec{sim.specs.length === 1 ? "" : "s"}
                  </p>
                </LayerCard>
              </a>
            ))}
          </div>
        </Section>

        <Section id="roadmap" title="Where it's going" lead="From a spec you build by hand to a simulator for every repository and every change.">
          <ol className="divide-y divide-kumo-hairline rounded-lg border border-kumo-hairline">
            {ROADMAP.map(({ icon: Icon, name, status, text }) => (
              <li key={name} className="flex gap-4 p-5">
                <Icon size={22} className="mt-0.5 shrink-0 text-kumo-subtle" />
                <div>
                  <div className="flex items-center gap-2">
                    <Text variant="heading3" as="h3">
                      {name}
                    </Text>
                    <Badge variant={status === "now" ? "primary" : status === "next" ? "secondary" : "outline"}>{status}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-kumo-subtle">{text}</p>
                </div>
              </li>
            ))}
          </ol>
        </Section>
      </main>

      <footer className="mx-auto max-w-5xl px-6 py-12 text-sm text-kumo-subtle">
        Feynman, after Richard Feynman: if you can explain it simply, you understand it.
      </footer>
    </div>
  );
}

const simHref = (sim: Sim) => `/s/${sim.slug}/`;

/** A highlighted snippet (from scripts/highlight.ts) with what it is and a copy button. */
function CodeBlock({ snippet, label }: { snippet: { code: string; html: string }; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => void navigator.clipboard.writeText(snippet.code).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)));
  return (
    <figure className="overflow-hidden rounded-lg bg-kumo-recessed ring-1 ring-kumo-hairline">
      <figcaption className="flex items-center justify-between border-b border-kumo-hairline py-1 pl-4 pr-1 text-xs text-kumo-subtle">
        <span className="font-mono">{label}</span>
        <Button variant="ghost" size="xs" icon={copied ? CheckIcon : CopyIcon} onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </figcaption>
      <div className="code overflow-x-auto p-4 text-[12px] leading-relaxed" dangerouslySetInnerHTML={{ __html: snippet.html }} />
    </figure>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-kumo-recessed px-1 py-px font-mono text-[0.9em] text-kumo-default">{children}</code>;
}

function Section({ id, title, lead, children }: { id: string; title: string; lead: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-8 border-t border-kumo-hairline py-16">
      <Text variant="heading2" as="h2">
        {title}
      </Text>
      <p className="mt-2 mb-8 max-w-2xl text-kumo-subtle">{lead}</p>
      {children}
    </section>
  );
}

function ModeToggle() {
  const toggle = () => {
    const next = document.documentElement.getAttribute("data-mode") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-mode", next);
    localStorage.setItem("feynman.mode", next);
  };
  return <Button variant="ghost" size="sm" shape="square" icon={CircleHalfIcon} aria-label="Toggle light and dark" onClick={toggle} />;
}

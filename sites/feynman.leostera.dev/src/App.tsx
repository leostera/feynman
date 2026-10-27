import { Badge, Button, LayerCard, LinkButton, Text } from "@cloudflare/kumo";
import {
  ArrowRightIcon,
  CheckIcon,
  CircleHalfIcon,
  CodeIcon,
  CopyIcon,
  LinkIcon,
  PlayIcon,
  RobotIcon,
  ShieldCheckIcon,
  type Icon,
} from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import sims from "../sims.json";
import type { Sim } from "../scripts/sims.ts";
import { published, refLabel } from "../scripts/published.ts";
import prompt from "../snippets/prompt.txt?highlight";

const SIMS = sims as Sim[];
const FEATURED_SIM = SIMS.find((sim) => sim.slug === "github.com/leostera/axo");

const USE_CASES: { icon: Icon; title: string; text: string }[] = [
  {
    icon: PlayIcon,
    title: "Building a new system",
    text: "Work with your agent to model the behavior before you implement it. Make the actors, state, messages, timers, and invariants explicit; then explore scenarios and event orderings while the design is still easy to change.",
  },
  {
    icon: RobotIcon,
    title: "Understanding a system you have",
    text: "Ask an agent to trace a behavior through the existing code and model what it finds. Link steps to their sources, then use the playground to follow a scenario, inspect state, and try another sequence.",
  },
  {
    icon: ShieldCheckIcon,
    title: "Checking a system as it changes",
    text: "When a change reshapes the architecture or behavior, update the model, compare scenario flows, and check the rules again: what must never happen, and what must eventually happen. Feynman searches within configured bounds and shows a counterexample when a rule fails.",
  },
];

const PLAYGROUND_FEATURES: { icon: Icon; title: string; text: string }[] = [
  {
    icon: PlayIcon,
    title: "Step through it",
    text: "Add people and machines, act as they would, and watch each message travel. Play, step, rewind to any event, or deliver and drop messages by hand to try another ordering.",
  },
  {
    icon: CodeIcon,
    title: "See the code behind each step",
    text: "The Code view walks the timeline event by event: what came in, what went out, and the code the step names. Open any function it reaches in your code to read it in place, highlighted.",
  },
  {
    icon: LinkIcon,
    title: "Share what you found",
    text: "The URL carries the scenario, the timeline, and the view, so a link opens the same session. Copy the timeline to hand it to your agent and turn it into a scenario.",
  },
];

const VERDICTS: { mark: string; name: string; text: string; tone: string }[] = [
  { mark: "✗", name: "Broken", text: "A scenario, search, or random walk found a trace that violates the rule.", tone: "text-kumo-danger" },
  { mark: "✓", name: "Holds", text: "The bounded search explored every state it was configured to reach and found no violation.", tone: "text-kumo-success" },
  { mark: "~", name: "Held so far", text: "No violation appeared, but a search limit stopped exploration before it finished.", tone: "text-kumo-warning" },
  { mark: "?", name: "Not tested", text: "The explored states never reached a case where this rule could be judged.", tone: "text-kumo-subtle" },
];

export function App() {
  return (
    <div className="min-h-screen bg-kumo-canvas text-kumo-default">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <a href="/" className="text-lg font-semibold text-kumo-default">
          Feynman
        </a>
        <nav className="flex items-center gap-1">
          <LinkButton href="#use-cases" variant="ghost" size="sm">
            Use cases
          </LinkButton>
          <LinkButton href="#playground" variant="ghost" size="sm">
            Playground
          </LinkButton>
          <LinkButton href="#agents" variant="ghost" size="sm">
            For agents
          </LinkButton>
          <LinkButton href="#agents" variant="primary" size="sm" icon={RobotIcon}>
            Onboard your agent
          </LinkButton>
          <ModeToggle />
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-6">
        <section className="pt-16 pb-12 sm:pt-24">
          <h1 className="max-w-3xl text-4xl font-semibold leading-tight sm:text-5xl">
            Model a system before you build it. Understand it once it runs. Check it as it changes.
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-kumo-subtle">
            Feynman turns a behavior model into an interactive playground and a bounded model checker. Work with your coding agent to describe how
            the system should behave, understand how it does behave, and check important rules as the code evolves.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            <LinkButton href="#agents" variant="primary" icon={RobotIcon}>
              Onboard your agent
            </LinkButton>
            {FEATURED_SIM && (
              <LinkButton href={simHref(FEATURED_SIM)} variant="secondary" icon={ArrowRightIcon}>
                Explore the playground
              </LinkButton>
            )}
          </div>
        </section>

        <Section id="use-cases" title="Three ways to use Feynman" lead="The same model helps at different points in a system's life.">
          <div className="grid gap-4 md:grid-cols-3">
            {USE_CASES.map(({ icon: Icon, title, text }) => (
              <LayerCard key={title} className="p-5">
                <Icon size={22} className="text-kumo-subtle" />
                <Text variant="heading3" as="h3">
                  <span className="mt-3 block">{title}</span>
                </Text>
                <p className="mt-2 text-sm text-kumo-subtle">{text}</p>
              </LayerCard>
            ))}
          </div>
        </Section>

        <Section id="agents" title="Put your agent to work" lead="You do not need to write the spec by hand. Give your agent the Feynman skill and a behavior to work on.">
          <div className="grid gap-8 lg:grid-cols-[1fr_1.2fr]">
            <div>
              <p className="text-sm text-kumo-subtle">
                The skill tells an agent how to trace behavior through a codebase, write a model, run the checker, and report what it found—including
                the limits of the search. Start with one behavior, then expand the model as you learn more about the system.
              </p>
              <div className="mt-5 flex flex-wrap gap-3">
                <LinkButton href="/SKILL.md" variant="primary" icon={RobotIcon}>
                  Open the Feynman skill
                </LinkButton>
                <a className="self-center text-sm text-kumo-link underline" href="https://www.npmjs.com/package/@leostera/feynman">
                  Feynman on npm
                </a>
              </div>
              <p className="mt-5 text-sm text-kumo-subtle">
                The skill is included with the package for Pi. You can also give the linked skill file to another coding agent.
              </p>
              <p className="mt-3 text-sm text-kumo-subtle">
                Run <code className="rounded bg-kumo-recessed px-1 py-0.5 font-mono text-[12px]">bunx feynman dev</code> to open the playground on your
                own specs. It reloads as the spec changes, and checks and code links fill in as they finish.
              </p>
            </div>
            <CodeBlock snippet={prompt} label="A prompt to start with" />
          </div>
        </Section>

        <Section id="playground" title="Explore the playground" lead="Open a working model. Move through its events, read the code behind each one, and share exactly what you found.">
          {FEATURED_SIM && (
            <figure className="mb-8">
              <a href={simHref(FEATURED_SIM)} className="block overflow-hidden rounded-xl ring-1 ring-kumo-line shadow-lg transition hover:ring-kumo-brand">
                <img src="/axo-sim-light.jpg" alt="An interactive system model with people, computers, and a relay" width={1500} height={900} className="block w-full [[data-mode=dark]_&]:hidden" />
                <img src="/axo-sim-dark.jpg" alt="An interactive system model with people, computers, and a relay" width={1500} height={900} className="hidden w-full [[data-mode=dark]_&]:block" />
              </a>
              <figcaption className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-kumo-subtle">
                <span>A live playground generated from a Feynman spec.</span>
                <LinkButton href={simHref(FEATURED_SIM)} variant="secondary" icon={ArrowRightIcon}>
                  Explore the playground
                </LinkButton>
              </figcaption>
            </figure>
          )}
          <div className="mb-10 grid gap-4 md:grid-cols-3">
            {PLAYGROUND_FEATURES.map(({ icon: Icon, title, text }) => (
              <div key={title}>
                <Icon size={20} className="text-kumo-subtle" />
                <h3 className="mt-2 text-sm font-semibold">{title}</h3>
                <p className="mt-1 text-sm text-kumo-subtle">{text}</p>
              </div>
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {SIMS.filter(published).map((sim) => (
              <a key={sim.slug} href={simHref(sim)} className="group block">
                <LayerCard className="h-full px-5 py-4 group-hover:bg-kumo-tint">
                  <div className="flex items-center justify-between">
                    <Text variant="heading3" as="h3">
                      {simTitle(sim)}
                    </Text>
                    <ArrowRightIcon size={18} className="text-kumo-subtle" />
                  </div>
                  <p className="mt-2 text-sm text-kumo-subtle">{sim.summary}</p>
                  <p className="mt-4 font-mono text-xs text-kumo-subtle">
                    {refLabel(sim)} · {sim.specs.length} spec{sim.specs.length === 1 ? "" : "s"}
                  </p>
                </LayerCard>
              </a>
            ))}
          </div>
        </Section>

        <Section id="checker" title="A check is only as broad as its search" lead="Feynman makes the result explicit: what failed, what held within the bounds, and what the search did not reach.">
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
          <p className="mt-6 max-w-3xl text-sm text-kumo-subtle">
            A clean result is not a proof about every possible execution. It means no violation appeared in the states and scenarios the checker
            explored. Configure the bounds and scenarios to cover the behavior that matters to you.
          </p>
        </Section>
      </main>

    </div>
  );
}

const simHref = (sim: Sim) => `/s/${sim.slug}/`;

function simTitle(sim: Sim): string {
  if (sim.slug === "github.com/leostera/axo") return "Remote access";
  if (sim.slug === "github.com/leostera/feynman") return "Distributed systems examples";
  return sim.title;
}

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

import { Button, LinkButton, Text } from "@cloudflare/kumo";
import { ArrowRightIcon, CheckIcon, CircleHalfIcon, CopyIcon, RobotIcon } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import payments from "../snippets/payments.ts?highlight";
import paymentsCheck from "../snippets/payments-check.txt?highlight";
import faultsSnippet from "../snippets/faults.ts?highlight";
import faultsCheck from "../snippets/faults-check.txt?highlight";
import prompt from "../snippets/prompt.txt?highlight";
import rules from "../snippets/rules.ts?highlight";
import rulesCheck from "../snippets/rules-check.txt?highlight";

type Showcase = {
  id: string;
  moment: string;
  example: string;
  text: string;
  image: string;
  alt: string;
  /** The repository whose explorer it opens (`<host>/<path>`, served under /s/), and where in it. */
  repository: string;
  at?: string;
};

/** The three moments to reach for Feynman, each shown on a real playground. */
const SHOWCASES: Showcase[] = [
  {
    id: "design",
    moment: "Design a system",
    example: "Two-phase commit",
    text: "Settle the design with your agent before it writes the code.",
    image: "two-phase-commit",
    alt: "Playground of a two-phase commit: a coordinator and two participants that have committed",
    repository: "github.com/leostera/feynman",
    at: `#/playground/two-phase-commit/${encodeURIComponent("Everyone votes yes")}`,
  },
  {
    id: "understand",
    moment: "Understand a system",
    example: "Remote access",
    text: "Model how existing code behaves, and find the constraints it relies on.",
    image: "axo-sim",
    alt: "Playground of remote access: people, Macs, Cloudflare Access and a relay",
    repository: "github.com/leostera/axo",
  },
  {
    id: "change",
    moment: "Check a change",
    example: "Payments",
    text: "See what a change does to every flow. Here, a retry charges twice.",
    image: "payments",
    alt: "Playground of payments: the bank debits the same payment twice and the property is broken",
    repository: "github.com/leostera/feynman",
    at: `#/playground/payments/${encodeURIComponent("The retry fires first")}`,
  },
];

/** An example spec in Feynman's own explorer, opened at the scenario that shows the bug. */
type Example = { spec: string; scenario: string; name: string };

const EXAMPLES = "/s/github.com/leostera/feynman/";
const exampleHref = (e: Example) => `${EXAMPLES}#/playground/${e.spec}/${encodeURIComponent(e.scenario)}`;

/** The kinds of bug a design hides, each in examples that open on the trace that shows it. */
const BUGS: { title: string; text: string; examples: Example[] }[] = [
  {
    title: "A retry does it twice",
    text: "The bank's answer is lost, the client's call fails, it retries, and the bank charges again. Or the retry timer fires before the answer arrives, with nothing lost at all.",
    examples: [
      { spec: "retried-call", scenario: "The answer is lost", name: "Retried call" },
      { spec: "payments", scenario: "The retry fires first", name: "Payments" },
    ],
  },
  {
    title: "A restart forgets",
    text: "A node votes, restarts with its vote only in memory, and votes again in the same term: two leaders. An order is stored, and its announcement dies with the process.",
    examples: [
      { spec: "raft-vote", scenario: "A voter restarts", name: "Raft vote" },
      { spec: "outbox", scenario: "The shop restarts after storing", name: "Outbox" },
    ],
  },
  {
    title: "A late message wins",
    text: "A lock holder stalls past its lease and wakes up, and its write lands after the next holder's. A slow cache fill overtakes the invalidation that should have replaced it.",
    examples: [
      { spec: "lease-lock", scenario: "A stalled holder wakes up", name: "Lease lock" },
      { spec: "cache", scenario: "A stale fill overtakes the invalidation", name: "Cache" },
    ],
  },
  {
    title: "Check, then act",
    text: "Two doctors each see the other on call, and both go home. Two withdrawals read the same balance, and one is never taken off.",
    examples: [
      { spec: "write-skew", scenario: "Both at once", name: "Write skew" },
      { spec: "lost-update", scenario: "Both read before either writes", name: "Lost update" },
    ],
  },
  {
    title: "Reads go back in time",
    text: "A client reads from the head of a chain, then from the tail, and sees an older value the second time. A read from one replica misses a write that finished.",
    examples: [
      { spec: "chain-replication", scenario: "Reading from both ends", name: "Chain replication" },
      { spec: "quorum", scenario: "A read misses the write", name: "Quorum" },
    ],
  },
  {
    title: "Replicas never agree",
    text: "Two writes get the same timestamp, the replicas keep them in different orders, and no amount of waiting brings them back together.",
    examples: [{ spec: "lww-register", scenario: "Two writes at the same time", name: "Last-writer-wins" }],
  },
  {
    title: "Two of the one thing",
    text: "A resent token crosses its slow first copy, and two nodes hold the one token. Two nodes ask at the same moment, and each lets the other in.",
    examples: [
      { spec: "token-ring", scenario: "A resend crosses the first copy", name: "Token ring" },
      { spec: "ricart-agrawala", scenario: "Both ask at once", name: "Ricart–Agrawala" },
    ],
  },
  {
    title: "Waiting forever",
    text: "A vote is lost and the coordinator never decides. Two philosophers each hold one fork and wait for the other. The checker says who waits, and for what.",
    examples: [
      { spec: "two-phase-commit", scenario: "A vote is lost", name: "Two-phase commit" },
      { spec: "dining-philosophers", scenario: "Both get hungry", name: "Dining philosophers" },
    ],
  },
];

/** Bugs found while designing real systems with Feynman, before their code was written. */
const FOUND = [
  "Two quick sign-ins, then a refresh: the service refused the old grant's refresh, and the handler deleted the newer grant.",
  "A shard split whose activation message was lost: listings asked the new shard, forever, to serve.",
  "A partial message that held one of a receiver's four slots forever, once its sender gave up on it.",
  "Text edited after it was approved for saving: it was stored without passing the content screen again.",
];

const VERDICTS: { mark: string; name: string; text: string; tone: string }[] = [
  { mark: "✗", name: "Broken", text: "A scenario, search, or random walk found a trace that breaks the property.", tone: "text-kumo-danger" },
  { mark: "✓", name: "Holds", text: "The bounded search explored every state it was configured to reach and found no violation.", tone: "text-kumo-success" },
  { mark: "~", name: "Held so far", text: "A limit stopped the search first. It says how far it got (\u201cheld on every path of up to 9 events\u201d) and what to make smaller.", tone: "text-kumo-warning" },
  { mark: "?", name: "Not tested", text: "The explored states never reached a case where this property could be judged.", tone: "text-kumo-subtle" },
];

export function App() {
  return (
    <div className="min-h-screen bg-kumo-canvas text-kumo-default">
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-5">
        <a href="/" className="text-lg font-semibold text-kumo-default">
          Feynman
        </a>
        <nav className="flex items-center gap-1">
          <span className="hidden items-center gap-1 md:flex">
            <LinkButton href="#bugs" variant="ghost" size="sm">
              What it finds
            </LinkButton>
            <LinkButton href="#model" variant="ghost" size="sm">
              How it works
            </LinkButton>
            <LinkButton href="#agents" variant="ghost" size="sm">
              For agents
            </LinkButton>
          </span>
          <LinkButton href="#agents" variant="primary" size="sm" icon={RobotIcon} className="px-4">
            Onboard your agent
          </LinkButton>
          <ModeToggle />
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-6">
        <section className="pt-12 pb-16 sm:pt-20">
          <h1 className="max-w-4xl text-4xl font-semibold leading-[1.05] tracking-[-0.02em] text-balance sm:text-6xl">
            Find design bugs before your code does.
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-kumo-subtle">
            Model how your system behaves once. Explore it in a playground, and check it for the orderings and failures that break it.
          </p>
          <div className="mt-8">
            <LinkButton href="#agents" variant="primary" size="lg" icon={RobotIcon} className="px-5">
              Onboard your agent
            </LinkButton>
          </div>
          <Showcases />
        </section>

        <Section
          id="bugs"
          title="The bugs designs hide"
          lead="Not typos or types: orderings. A message lost, late, or delivered twice; a restart in the middle; two people at once. Each example is a spec you can open, on the shortest trace that breaks it."
        >
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {BUGS.map((bug) => (
              <li key={bug.title} className="flex flex-col gap-3 rounded-lg bg-kumo-recessed p-4">
                <p className="font-medium">{bug.title}</p>
                <p className="flex-1 text-kumo-subtle text-pretty">{bug.text}</p>
                <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {bug.examples.map((e) => (
                    <a key={e.spec} href={exampleHref(e)} className="inline-flex items-center gap-1 font-medium text-kumo-brand hover:underline">
                      {e.name} <ArrowRightIcon size={14} />
                    </a>
                  ))}
                </p>
              </li>
            ))}
          </ul>
          <div className="mt-8 rounded-lg p-5 ring-1 ring-kumo-line">
            <p className="font-medium">Found in real designs, before the code</p>
            <ul className="mt-3 grid gap-2 text-kumo-subtle sm:grid-cols-2">
              {FOUND.map((f) => (
                <li key={f} className="flex gap-2">
                  <span className="font-mono text-kumo-danger">✗</span>
                  <span className="text-pretty">{f}</span>
                </li>
              ))}
            </ul>
          </div>
        </Section>

        <Section id="model" title="One model. Explore it and check it." lead="A spec is a TypeScript file: actors, messages, the faults they meet, and the properties that must hold. The same file runs the playground and the checker.">
          <div className="grid items-start gap-4 lg:grid-cols-[1.25fr_1fr]">
            <CodeBlock snippet={payments} label="specs/payments.ts" />
            <div className="space-y-3 lg:sticky lg:top-6">
              <CodeBlock snippet={paymentsCheck} label="bunx feynman check" />
              <p className="text-kumo-subtle">The checker finds the shortest order of events in which a retry charges twice.</p>
            </div>
          </div>
        </Section>

        <Section
          id="faults"
          title="Say how your system fails"
          lead="Faults are steps the spec declares, where they happen: a message lost on the way, delivered twice, a process that crashes and keeps only what is on disk, a call that throws. A budget bounds how many happen on one path. Declare the failures your system really meets, and nothing else; a fault the library lacks is a step you write."
        >
          <div className="grid items-start gap-4 lg:grid-cols-[1.15fr_1fr]">
            <CodeBlock snippet={faultsSnippet} label="specs/retried-call.ts" />
            <div className="space-y-3 lg:sticky lg:top-6">
              <CodeBlock snippet={faultsCheck} label="bunx feynman check" />
              <p className="text-kumo-subtle">Every counterexample says how many faults it needs. With none, the retry holds; one lost answer, and it charges twice.</p>
            </div>
          </div>
        </Section>

        <Section id="checker" title="Know how far a check went" lead="Every property gets a verdict that says what the search covered.">
          <ul className="grid gap-3 sm:grid-cols-2">
            {VERDICTS.map(({ mark, name, text, tone }) => (
              <li key={name} className="flex gap-3 rounded-lg bg-kumo-recessed p-4">
                <span className={`w-5 shrink-0 text-center font-mono text-lg font-semibold leading-6 ${tone}`}>{mark}</span>
                <p className="text-kumo-subtle">
                  <strong className="text-kumo-default">{name}</strong> {text}
                </p>
              </li>
            ))}
          </ul>
        </Section>

        <Section
          id="rules"
          title="Know which parts of the design matter"
          lead="Name the rules a design relies on, and say which properties need them. The checker also checks the design without each rule, and fails if nothing breaks: the rule does nothing, or the property is too weak to see what it prevents."
        >
          <div className="grid items-start gap-4 lg:grid-cols-[1fr_1.15fr]">
            <CodeBlock snippet={rules} label="specs/retried-call.ts" />
            <div className="space-y-3 lg:sticky lg:top-6">
              <CodeBlock snippet={rulesCheck} label="bunx feynman check" />
              <p className="text-kumo-subtle">Without the idempotency key, a lost answer and a retry charge the customer twice.</p>
            </div>
          </div>
        </Section>

        <Section id="agents" title="Onboard your agent" lead="Give your agent the Feynman skill and one behavior to model. It reads the code, writes the spec, runs the checks, and reports what it found.">
          <div className="grid items-start gap-8 lg:grid-cols-[1fr_1.2fr]">
            <div className="space-y-5">
              <LinkButton href="/SKILL.md" variant="primary" icon={RobotIcon}>
                Open the Feynman skill
              </LinkButton>
              <p className="text-kumo-subtle">
                Pi loads the skill from the package. Other agents can read it from this site; the prompt beside it is a good start.
              </p>
            </div>
            <div className="lg:sticky lg:top-6">
              <CodeBlock snippet={prompt} label="A prompt to start with" />
            </div>
          </div>
        </Section>
      </main>
    </div>
  );
}

/** The hero's playground: one large preview per moment, switched by tabs. */
function Showcases() {
  const [current, setCurrent] = useState(SHOWCASES[1].id);
  const shown = SHOWCASES.find((item) => item.id === current) ?? SHOWCASES[1];
  const href = `/s/${shown.repository}/${shown.at ?? ""}`;
  return (
    <div className="mt-12">
      <div role="tablist" aria-label="When to use Feynman" className="grid gap-2 sm:flex sm:flex-wrap">
        {SHOWCASES.map((item) => (
          <button
            key={item.id}
            id={`tab-${item.id}`}
            role="tab"
            type="button"
            aria-selected={item.id === current}
            aria-controls="showcase"
            onClick={() => setCurrent(item.id)}
            className="cursor-pointer rounded-lg px-4 py-2.5 text-left ring-1 ring-kumo-line transition-colors hover:bg-kumo-tint aria-selected:bg-kumo-contrast aria-selected:text-kumo-inverse aria-selected:ring-kumo-contrast"
          >
            <span className="font-medium">{item.moment}</span>
            <span className="opacity-70"> · {item.example}</span>
          </button>
        ))}
      </div>
      <div id="showcase" role="tabpanel" aria-labelledby={`tab-${shown.id}`} className="mt-4">
        <Preview showcase={shown} href={href} />
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-kumo-subtle">{shown.text}</p>
          <LinkButton href={href} variant="secondary" icon={ArrowRightIcon} className="sm:hidden">
            Explore playground
          </LinkButton>
        </div>
      </div>
    </div>
  );
}

/** A screenshot of the playground in both modes; on wider screens, the whole image opens it. */
function Preview({ showcase, href }: { showcase: Showcase; href: string }) {
  const images = (
    <>
      <img src={`/${showcase.image}-light.jpg`} alt={showcase.alt} width={1500} height={900} className="block w-full [[data-mode=dark]_&]:hidden" />
      <img src={`/${showcase.image}-dark.jpg`} alt={showcase.alt} width={1500} height={900} className="hidden w-full [[data-mode=dark]_&]:block" />
    </>
  );
  const frame = "overflow-hidden rounded-2xl ring-1 ring-kumo-line shadow-[0_12px_40px_-12px_rgb(0_0_0/0.25)]";
  return (
    <>
      <div className={`${frame} sm:hidden`}>{images}</div>
      <a href={href} className={`${frame} group relative hidden sm:block`}>
        {images}
        <span className="absolute inset-0 flex items-center justify-center bg-kumo-contrast/0 transition-colors duration-300 group-hover:bg-kumo-contrast/25 group-focus-visible:bg-kumo-contrast/25">
          <span className="flex translate-y-1 items-center gap-2 rounded-lg bg-kumo-brand px-5 py-3 font-medium text-white opacity-0 shadow-lg transition duration-300 ease-out group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100">
            Explore playground <ArrowRightIcon size={18} />
          </span>
        </span>
      </a>
    </>
  );
}

/** A highlighted snippet (from scripts/highlight.ts) with what it is and a copy button. */
function CodeBlock({ snippet, label }: { snippet: { code: string; html: string }; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => void navigator.clipboard.writeText(snippet.code).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)));
  return (
    <figure className="flex min-w-0 flex-col items-start overflow-hidden rounded-lg bg-kumo-recessed ring-1 ring-kumo-hairline">
      <figcaption className="flex w-full items-center justify-between border-b border-kumo-hairline py-1 pl-4 pr-1 text-sm text-kumo-subtle">
        <span className="font-mono">{label}</span>
        <Button variant="ghost" size="xs" icon={copied ? CheckIcon : CopyIcon} onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </figcaption>
      <div className="code w-full self-start overflow-x-auto p-4 text-[12px] leading-relaxed" dangerouslySetInnerHTML={{ __html: snippet.html }} />
    </figure>
  );
}

function Section({ id, title, lead, children }: { id: string; title: string; lead: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-8 py-16">
      <Text variant="heading2" as="h2">
        {title}
      </Text>
      <p className="mt-2 mb-8 max-w-2xl text-kumo-subtle text-pretty">{lead}</p>
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

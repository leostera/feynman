import { Badge, Button, LayerCard, LinkButton, Text } from "@cloudflare/kumo";
import {
  ArrowRightIcon,
  ArrowsLeftRightIcon,
  ChatsCircleIcon,
  CircleHalfIcon,
  GaugeIcon,
  GitCommitIcon,
  GraphIcon,
  HardDrivesIcon,
  PlugsConnectedIcon,
  SealCheckIcon,
  ShieldCheckIcon,
  UsersThreeIcon,
  type Icon,
} from "@phosphor-icons/react";
import { useEffect, useState, type ReactNode } from "react";

interface Explainer {
  name: string;
  title: string;
  summary: string;
}

const ELEMENTS: { icon: Icon; name: string; text: string }[] = [
  { icon: UsersThreeIcon, name: "Actors", text: "The components that make up the system, where each one runs, and the people and services around it." },
  { icon: ArrowsLeftRightIcon, name: "Flows", text: "What happens when something happens: step by step, which actor does what to which other actor." },
  { icon: PlugsConnectedIcon, name: "Protocols", text: "How actors talk: the messages, their fields and replies, framing, and versioning." },
  { icon: HardDrivesIcon, name: "State", text: "What the system remembers, who owns it, how long it lives, and the lifecycles it moves through." },
  { icon: ShieldCheckIcon, name: "Invariants", text: "The rules that must always hold, how each is enforced, and the call path that enforces it." },
  { icon: SealCheckIcon, name: "Claims", text: "What docs, comments, and names promise, with the evidence for whether the code bears it out." },
  { icon: GaugeIcon, name: "Limits", text: "Sizes, timeouts, rates, and capacities, and exactly where each one is set." },
];

const PHASES = [
  { name: "Actors", text: "Survey the whole repository and map its actors and who talks to whom, before reading anything in depth." },
  { name: "Flows", text: "Read the code of each group of connected actors in full, and write the flows that run through them." },
  { name: "Depth", text: "Revise the model as a whole until every flow, protocol, invariant, claim, and limit is precise." },
];

const ROADMAP: { icon: Icon; name: string; status: "now" | "next" | "later"; text: string }[] = [
  {
    icon: GraphIcon,
    name: "A model of one revision",
    status: "now",
    text: "Extract a model of a repository at a commit, check it covers every file, and render it as an explainer.",
  },
  {
    icon: GitCommitIcon,
    name: "A model for every commit",
    status: "next",
    text: "Update the model commit by commit, so you can browse how the system changes without reading the code: new actors, new or changed flows, rules that moved.",
  },
  {
    icon: ChatsCircleIcon,
    name: "Review in the loop",
    status: "next",
    text: "While you build with an agent, see what your change does to the system, comment on it in the browser, and send the comments back to the same session.",
  },
  {
    icon: PlugsConnectedIcon,
    name: "Feynman as a service",
    status: "later",
    text: "Connect a repository and keep its explainers up to date as it evolves.",
  },
];

export function App() {
  const explainers = useExplainers();
  const feynman = explainers.find((explainer) => explainer.name === "feynman");

  return (
    <div className="min-h-screen bg-kumo-canvas text-kumo-default">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <a href="/" className="text-lg font-semibold tracking-tight text-kumo-default">
          Feynman
        </a>
        <nav className="flex items-center gap-1">
          <LinkButton href="#model" variant="ghost" size="sm">
            The model
          </LinkButton>
          <LinkButton href="#explainers" variant="ghost" size="sm">
            Explainers
          </LinkButton>
          <LinkButton href="#roadmap" variant="ghost" size="sm">
            Roadmap
          </LinkButton>
          <ModeToggle />
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-6">
        <section className="py-20 sm:py-28">
          <Badge variant="beta">Early</Badge>
          <h1 className="mt-5 max-w-3xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
            Understand how a system works, and what each change does to it.
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-kumo-subtle">
            Feynman reads a repository and writes down how the system behaves: its actors, the flows between them, the protocols they speak, the
            state they keep, and the rules they enforce. Then it renders that model as an explainer you can read instead of the code.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            {feynman ? (
              <LinkButton href={`/explainers/${feynman.name}/`} variant="primary" icon={ArrowRightIcon}>
                Read Feynman's own explainer
              </LinkButton>
            ) : null}
            <LinkButton href="#how" variant="secondary">
              How it works
            </LinkButton>
          </div>
        </section>

        <Section id="model" title="What a model holds" lead="Behaviour, not structure. Every element is anchored to the code it comes from.">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {ELEMENTS.map(({ icon: Icon, name, text }) => (
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
          id="how"
          title="How a model is made"
          lead="An agent builds the model in your own development session, working from the outside in. Feynman checks its work as it goes."
        >
          <ol className="grid gap-4 sm:grid-cols-3">
            {PHASES.map(({ name, text }, i) => (
              <li key={name} className="rounded-lg border border-kumo-hairline p-5">
                <Text variant="mono-secondary">
                  Phase {i + 1}
                </Text>
                <Text variant="heading3" as="h3">
                  <span className="mt-1 block">{name}</span>
                </Text>
                <p className="mt-2 text-sm text-kumo-subtle">{text}</p>
              </li>
            ))}
          </ol>
          <ul className="mt-8 grid gap-3 text-sm text-kumo-subtle sm:grid-cols-3">
            <li>
              <strong className="text-kumo-default">Nothing skipped.</strong> Every tracked file passes through the agent's context, or is set aside
              as vendored or generated with its origin named.
            </li>
            <li>
              <strong className="text-kumo-default">Checked, not trusted.</strong> Each element is validated against a schema, and every anchor must
              point at real code at the modelled commit.
            </li>
            <li>
              <strong className="text-kumo-default">Built for change.</strong> Elements record hashes of the files they come from, so an update knows
              exactly what to revisit.
            </li>
          </ul>
        </Section>

        <Section id="explainers" title="Explainers" lead="Models rendered as self-contained pages: actors, flows, protocols, state, invariants, claims, and limits.">
          {explainers.length ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {explainers.map((explainer) => (
                <a key={explainer.name} href={`/explainers/${explainer.name}/`} className="group block">
                  <LayerCard className="h-full p-5 transition-colors group-hover:bg-kumo-tint">
                    <div className="flex items-center justify-between">
                      <Text variant="heading3" as="h3">
                        {explainer.title}
                      </Text>
                      <ArrowRightIcon size={18} className="text-kumo-subtle" />
                    </div>
                    <p className="mt-2 text-sm text-kumo-subtle">{explainer.summary}</p>
                  </LayerCard>
                </a>
              ))}
            </div>
          ) : (
            <p className="text-sm text-kumo-subtle">The first explainers are being extracted.</p>
          )}
        </Section>

        <Section id="roadmap" title="Where it's going" lead="From a snapshot of one revision to a running account of how a system changes.">
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

function useExplainers(): Explainer[] {
  const [explainers, setExplainers] = useState<Explainer[]>([]);
  useEffect(() => {
    fetch("/explainers/index.json")
      .then((response) => (response.ok ? response.json() : []))
      .then(setExplainers, () => setExplainers([]));
  }, []);
  return explainers;
}

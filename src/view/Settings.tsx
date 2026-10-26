// Settings: the theme, auto-play and reduced motion, kept in this browser; and where the page
// was built from.
import { Badge, Switch, Tabs } from "@cloudflare/kumo";
import type { Bundle } from "./data";
import { saveSettings, useSettings, type Theme } from "./preferences";

const THEMES: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function SettingsPage({ bundle }: { bundle: Bundle }) {
  const settings = useSettings();
  const { repository } = bundle;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-8">
        <div className="grid gap-1.5">
          <h1 className="text-lg font-semibold">Settings</h1>
          <p className="text-sm text-kumo-subtle">Kept in this browser.</p>
        </div>
        <Setting title="Theme" description="Follow the system, or always light or dark.">
          <Tabs size="sm" value={settings.theme} onValueChange={(v) => saveSettings({ theme: v as Theme })} tabs={THEMES} />
        </Setting>
        <Setting title="Auto-play" description="Open the playground with Play on, so whatever happens plays out by itself.">
          <Switch size="sm" aria-label="Auto-play" checked={settings.autoPlay} onCheckedChange={(on) => saveSettings({ autoPlay: on })} />
        </Setting>
        <Setting title="Reduce motion" description="No animations: events land at once, and nothing pulses or slides.">
          <Switch size="sm" aria-label="Reduce motion" checked={settings.reduceMotion} onCheckedChange={(on) => saveSettings({ reduceMotion: on })} />
        </Setting>
        <Setting title="Built from" description="The repository and commit this page shows.">
          <span className="flex items-center gap-2 text-sm">
            <span className="font-mono text-[0.9em]">
              {repository.name} @ {repository.commit.slice(0, 7)}
            </span>
            {repository.dirty && <Badge variant="warning">+ changes</Badge>}
          </span>
        </Setting>
      </div>
    </div>
  );
}

function Setting({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="flex items-center justify-between gap-6 border-t border-kumo-line pt-6">
      <div className="grid gap-1">
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="text-sm text-kumo-subtle">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </section>
  );
}

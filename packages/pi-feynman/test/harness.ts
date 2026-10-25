// Run pi-feynman inside a real, in-process Pi session whose model is scripted.
//
// The session uses Pi's SDK with in-memory settings, sessions, and credentials, and
// pi-ai's faux provider: each model request is answered by the next scripted step,
// so tests decide exactly which tools the "agent" calls and when it stops.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";

export { fauxAssistantMessage, fauxText, fauxToolCall };

const EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "../src/index.ts");

/** A throwaway git repository with `files` committed. */
export function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "feynman-test-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-qm", "init");
  return root;
}

export interface Harness {
  session: AgentSession;
  /** Script the next model responses, in order. */
  respond(steps: FauxResponseStep[]): void;
  /** Scripted responses not yet consumed. */
  pending(): number;
  /** Custom messages the extension appended, by type. */
  customMessages(customType: string): string[];
  dispose(): void;
}

export async function startSession(cwd: string): Promise<Harness> {
  const agentDir = mkdtempSync(join(tmpdir(), "feynman-agent-"));
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, authPath: join(agentDir, "auth.json") });
  modelRuntime.registerNativeProvider(faux.provider);

  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, additionalExtensionPaths: [EXTENSION] });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel(),
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader,
  });
  await session.bindExtensions({});

  return {
    session,
    respond: (steps) => faux.setResponses(steps),
    pending: () => faux.getPendingResponseCount(),
    customMessages: (customType) =>
      session.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "custom_message" && entry.customType === customType)
        .map((entry) => (entry as { content: unknown }).content as string),
    dispose: () => session.dispose(),
  };
}

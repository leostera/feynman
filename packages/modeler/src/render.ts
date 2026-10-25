// Render a model directory to a self-contained HTML file with @feynman/renderer.
import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const RENDERER = dirname(fileURLToPath(import.meta.resolve("@feynman/renderer/package.json")));

export async function renderModel(modelDir: string, out: string): Promise<void> {
  await promisify(execFile)("bun", ["run", "build", modelDir, out], { cwd: RENDERER, maxBuffer: 1 << 24 });
}

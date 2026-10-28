import { defineConfig } from "@leostera/feynman/config";

// This repository's specs are the package's examples. The config is at the root because the
// site's explorer (packages/share) builds a repository from its root.
export default defineConfig({ specs: ["packages/feynman/examples/*.ts"] });

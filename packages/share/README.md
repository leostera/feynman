# @feynman/share

This package serves the Feynman explorer of any public git repository. It is a [Hono](https://hono.dev) app that the site Worker (`sites/feynman.leostera.dev`) mounts at `/s`:

```
https://feynman.leostera.dev/s/github.com/leostera/feynman?ref=main
https://feynman.leostera.dev/s/gitlab.com/group/sub/project?ref=v1.2.0
https://feynman.leostera.dev/s/codeberg.org/user/repo?ref=01fa5df
```

`ref` is a branch, a tag, a full ref, or a commit (full or abbreviated). Leave it out to get the default branch (HEAD).

## How a request is served

1. **Parse the path** (`src/repository.ts`). The host must be a public DNS name, and the path must be plain segments. The result is `https://<host>/<path>`.
2. **Resolve `ref`** (`src/refs.ts`). The Worker sends `GET <repo>/info/refs?service=git-upload-pack`, which is `git ls-remote` over git's smart HTTP protocol, and finds the commit. It retries with `.git` appended if the first URL does not answer. No sandbox is needed for this step.
3. **Serve from R2** if `pages/<host>/<path>/<commit>.html` exists.
4. **Otherwise build it** (`src/builder.ts`). The `ShareBuilder` Durable Object is named `<host>/<path>@<commit>`, so concurrent requests for the same page wait for one build. It starts a container from `Dockerfile` (Bun, git and the published `@leostera/feynman`). The container fetches that one commit (`git fetch --depth 1`), or does a blobless clone when it must resolve an abbreviated commit. Then it runs `feynman build`, puts the page in R2 and destroys the container.

A page built from a full commit is served with `immutable` caching. A page found through a branch or tag is cached for 60 seconds, so it picks up new commits.

The build runs spec code from the internet, so the container has no direct internet access (`enableInternet: false`). All of its HTTP and HTTPS traffic goes through the `ShareOutbound` entrypoint, which only allows HTTPS to the repository's own host.

## Mounting it

The package has no Worker of its own. The Worker that mounts it does three things:

- **Routes it.** In `worker/index.ts`:

  ```ts
  import { share } from "@feynman/share";
  export { ShareBuilder, ShareOutbound } from "@feynman/share";

  app.route("/s", share);
  ```

- **Declares the resources.** `@feynman/share/config` (`config.ts`) describes them for `cloudflare.config.ts`:

  ```ts
  import { shareBindings, shareContainer, shareExports } from "@feynman/share/config";

  worker: { env: { ...shareBindings(name) }, exports: { ...shareExports } },
  containers: [shareContainer],
  ```

  These are the `SHARE_PAGES` R2 bucket (`feynman-share`), the `SHARE_BUILDER` namespace, and the container that `ShareBuilder` starts.

- **Runs before its assets on the mount path.** Set `assets.runWorkerFirst: ["/s/*"]`. Without it, the asset handler answers unmatched paths with its 404 page, and the request never reaches the Worker.

## Develop

```sh
bun run test        # path and ref parsing
bun run typecheck
```

To run it end to end, run `cf dev` in `sites/feynman.leostera.dev` with Docker running. It builds the container image and uses a local R2.

To update Feynman in the sandbox, change `FEYNMAN_VERSION` in `Dockerfile`. Pages already in R2 stay as they were built. Delete their objects to rebuild them.

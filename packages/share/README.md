# @feynman/share

A Worker that serves the Feynman explorer of any public git repository:

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
4. **Otherwise build it** (`src/builder.ts`). The `Builder` Durable Object is named `<host>/<path>@<commit>`, so concurrent requests for the same page wait for one build. It starts a container from `Dockerfile` (Bun, git and the published `@leostera/feynman`). The container fetches that one commit (`git fetch --depth 1`), or does a blobless clone when it must resolve an abbreviated commit. Then it runs `feynman build`, puts the page in R2 and destroys the container.

A page built from a full commit is served with `immutable` caching. A page found through a branch or tag is cached for 60 seconds, so it picks up new commits.

The build runs spec code from the internet, so the container has no direct internet access (`enableInternet: false`). All of its HTTP and HTTPS traffic goes through the `Outbound` entrypoint, which only allows HTTPS to the repository's own host.

## Develop

The Worker, its R2 bucket, the Durable Object and the container are all declared in `cloudflare.config.ts`, which the `cf` CLI reads. Run this with Docker running. `cf dev` builds the image and uses a local R2:

```sh
bun run dev                     # http://localhost:5173/s/github.com/leostera/feynman?ref=main
bun run test                    # path and ref parsing
bun run typecheck               # regenerates .cloudflare/types, then tsc
```

## Deploy

```sh
npx cf r2 buckets create --name feynman-share   # once
bun run deploy                                  # cf deploy
```

The route `feynman.leostera.dev/s/*` takes precedence over the site Worker's custom domain on the same hostname. The rest of the hostname keeps going to `sites/feynman.leostera.dev`.

To update Feynman in the sandbox, change `FEYNMAN_VERSION` in `Dockerfile`. Pages already in R2 stay as they were built. Delete their objects to rebuild them.

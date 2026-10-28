// <mount>/<host>/<path>?ref=<branch, tag or commit>: the Feynman explorer of a public git
// repository. The ref resolves to a commit with one request to the git host; a commit that has
// a page in R2 is served from there, and any other is built in a sandbox first.
import { Hono } from "hono";
import type { BuildJob } from "./builder.ts";
import type { ShareEnv } from "./env.ts";
import { type ShareExports, shareExports } from "./exports.ts";
import { errorPage, pageKey, pageResponse } from "./pages.ts";
import { asCommit, type Commit, lsRemote, resolveRef } from "./refs.ts";
import { parseRepository, type Repository } from "./repository.ts";

/** Mount it with `app.route("/s", share)`. GET serves pages; Hono answers HEAD from it. */
export const share = new Hono<{ Bindings: ShareEnv }>();

share.get("/", () => errorPage(404, "Name a repository", "For example /s/github.com/leostera/feynman?ref=main."));

share.get("/:repository{.+}", (c) => {
  const parsed = parseRepository(c.req.param("repository"));
  if (!parsed.ok) return errorPage(400, "Not a repository", parsed.reason);
  return serve(c.env, shareExports(c.executionCtx), parsed.repository, c.req.query("ref") ?? null);
});

async function serve(env: ShareEnv, exports: ShareExports, repository: Repository, ref: string | null): Promise<Response> {
  const lookup = await lsRemote(repository.url);
  if (!lookup.ok) return errorPage(404, "Repository not found", lookup.reason);
  const resolution = resolveRef(lookup.remote.refs, ref);
  if (resolution.kind === "missing") {
    return errorPage(404, "Ref not found", `${repository.id} has no branch, tag or commit named ${JSON.stringify(ref ?? "HEAD")}.`);
  }
  // Only a ref that is a commit names the same page forever.
  const immutable = asCommit(ref?.trim().toLowerCase() ?? "") !== null;
  if (resolution.kind === "commit") {
    const stored = await env.SHARE_PAGES.get(pageKey(repository, resolution.commit));
    if (stored) return pageResponse(stored, resolution.commit, { immutable });
  }
  const target = resolution.kind === "commit" ? resolution.commit : resolution.prefix;
  const job: BuildJob = { repository, cloneUrl: lookup.remote.url, target };
  const result = await exports.ShareBuilder.getByName(`${repository.id}@${target}`).build(job);
  if (!result.ok) return errorPage(result.status, result.message, "", result.log);
  return stored(env, repository, result.commit, immutable);
}

async function stored(env: ShareEnv, repository: Repository, commit: Commit, immutable: boolean): Promise<Response> {
  const object = await env.SHARE_PAGES.get(pageKey(repository, commit));
  if (!object) return errorPage(500, "The page went missing", `the build of ${commit} finished, but R2 has no page for it`);
  return pageResponse(object, commit, { immutable });
}

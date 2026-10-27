// feynman.leostera.dev/s/<host>/<path>?ref=<branch, tag or commit>: the Feynman explorer of a
// public git repository. The ref resolves to a commit with one request to the git host; a
// commit that has a page in R2 is served from there, and any other is built in a sandbox first.
import type { BuildJob } from "./builder.ts";
import { errorPage, pageKey, pageResponse } from "./pages.ts";
import { asCommit, type Commit, lsRemote, resolveRef } from "./refs.ts";
import { parseRepository, type Repository } from "./repository.ts";

export { Builder, Outbound } from "./builder.ts";

const PREFIX = "/s/";

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX) || url.pathname === PREFIX) {
      return errorPage(404, "Name a repository", "For example /s/github.com/leostera/feynman?ref=main.");
    }
    const parsed = parseRepository(url.pathname.slice(PREFIX.length));
    if (!parsed.ok) return errorPage(400, "Not a repository", parsed.reason);
    return share(env, parsed.repository, url.searchParams.get("ref"), request.method === "HEAD");
  },
} satisfies ExportedHandler<Env>;

async function share(env: Env, repository: Repository, ref: string | null, head: boolean): Promise<Response> {
  const lookup = await lsRemote(repository.url);
  if (!lookup.ok) return errorPage(404, "Repository not found", lookup.reason);
  const resolution = resolveRef(lookup.remote.refs, ref);
  if (resolution.kind === "missing") {
    return errorPage(404, "Ref not found", `${repository.id} has no branch, tag or commit named ${JSON.stringify(ref ?? "HEAD")}.`);
  }
  // Only a ref that is a commit names the same page forever.
  const immutable = asCommit(ref?.trim().toLowerCase() ?? "") !== null;
  if (resolution.kind === "commit") {
    const stored = await env.PAGES.get(pageKey(repository, resolution.commit));
    if (stored) return pageResponse(stored, resolution.commit, { immutable, head });
  }
  const target = resolution.kind === "commit" ? resolution.commit : resolution.prefix;
  const job: BuildJob = { repository, cloneUrl: lookup.remote.url, target };
  const result = await env.BUILDER.getByName(`${repository.id}@${target}`).build(job);
  if (!result.ok) return errorPage(result.status, result.message, "", result.log);
  return served(env, repository, result.commit, { immutable, head });
}

async function served(env: Env, repository: Repository, commit: Commit, options: { immutable: boolean; head: boolean }): Promise<Response> {
  const stored = await env.PAGES.get(pageKey(repository, commit));
  if (!stored) return errorPage(500, "The page went missing", `the build of ${commit} finished, but R2 has no page for it`);
  return pageResponse(stored, commit, options);
}

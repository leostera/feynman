// <mount>/<host>/<path>?ref=<branch, tag or commit>: the Feynman explorer of a public git
// repository. The ref resolves to a commit with one request to the git host; a commit that has
// a page in R2 is served from there, and any other is built in a sandbox first.
//
// What it costs is bounded in layers: every request counts against its IP (SHARE_REQUESTS); a
// request that would build counts against a tighter one (SHARE_BUILDS); a failed build answers
// from R2 for an hour; and ShareGate lets one build run at a time, and so many a day.
import { Hono } from "hono";
import type { BuildJob } from "./builder.ts";
import type { ShareEnv } from "./env.ts";
import { type ShareExports, shareExports } from "./exports.ts";
import { errorPage, getFailure, pageKey, pageResponse } from "./pages.ts";
import { asCommit, type Commit, lsRemote, resolveRef } from "./refs.ts";
import { parseRepository, type Repository } from "./repository.ts";

/** What a client over a rate limit is told to wait: the limits count per minute. */
const LIMITED_RETRY_S = 60;

/** Mount it with `app.route("/s", share)`. GET serves pages; Hono answers HEAD from it. */
export const share = new Hono<{ Bindings: ShareEnv }>();

share.use(async (c, next) => {
  const { success } = await c.env.SHARE_REQUESTS.limit({ key: clientOf(c.req.raw) });
  if (!success) return tooMany("Too many requests", "Wait a minute and try again.");
  await next();
});

share.get("/", () => errorPage(404, "Name a repository", "For example /s/github.com/leostera/feynman?ref=main."));

share.get("/:repository{.+}", (c) => {
  const parsed = parseRepository(c.req.param("repository"));
  if (!parsed.ok) return errorPage(400, "Not a repository", parsed.reason);
  const request: ShareRequest = { env: c.env, exports: shareExports(c.executionCtx), client: clientOf(c.req.raw) };
  return serve(request, parsed.repository, c.req.query("ref") ?? null);
});

interface ShareRequest {
  readonly env: ShareEnv;
  readonly exports: ShareExports;
  /** The client's IP, which the rate limits count by. */
  readonly client: string;
}

async function serve(request: ShareRequest, repository: Repository, ref: string | null): Promise<Response> {
  const { env } = request;
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
  const failed = await getFailure(env.SHARE_PAGES, repository, target);
  if (failed) return errorPage(failed.status, failed.message, "This build failed within the last hour.", failed.log);
  const { success } = await env.SHARE_BUILDS.limit({ key: request.client });
  if (!success) return tooMany("Too many builds", "Pages that are already built still load; wait a minute to build another.");
  const job: BuildJob = { repository, cloneUrl: lookup.remote.url, target };
  const result = await request.exports.ShareBuilder.getByName(`${repository.id}@${target}`).build(job);
  if (!result.ok) {
    const retryAfter = result.status === 503 ? result.retryAfterSeconds : undefined;
    return errorPage(result.status, result.message, retryAfter ? "Try again in a little while." : "", result.log, retryAfter);
  }
  return stored(env, repository, result.commit, immutable);
}

async function stored(env: ShareEnv, repository: Repository, commit: Commit, immutable: boolean): Promise<Response> {
  const object = await env.SHARE_PAGES.get(pageKey(repository, commit));
  if (!object) return errorPage(500, "The page went missing", `the build of ${commit} finished, but R2 has no page for it`);
  return pageResponse(object, commit, { immutable });
}

function tooMany(title: string, detail: string): Response {
  return errorPage(429, title, detail, "", LIMITED_RETRY_S);
}

/** The client's IP, as Cloudflare saw it. Local development has none, and counts as one client. */
function clientOf(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "local";
}

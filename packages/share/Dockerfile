# The donor image ships sandbox-shim, which Files from @cloudflare/sandbox runs in the container.
# Keep its tag equal to the installed @cloudflare/sandbox version.
ARG SANDBOX_TOOLS_IMAGE=docker.io/cloudflare/sandbox:1.0.3
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM oven/bun:1.3-debian
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git coreutils \
  && rm -rf /var/lib/apt/lists/*
# The published Feynman, the same one `bunx @leostera/feynman` runs. Specs need nothing else
# installed: their `@leostera/feynman` imports resolve to this installation.
ARG FEYNMAN_VERSION=0.8.0
RUN mkdir -p /opt/feynman \
  && cd /opt/feynman \
  && echo '{"private":true}' > package.json \
  && bun add "@leostera/feynman@${FEYNMAN_VERSION}" \
  && ln -s /opt/feynman/node_modules/@leostera/feynman/bin/feynman.ts /usr/local/bin/feynman
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN mkdir -p /workspace
WORKDIR /workspace
CMD ["sleep", "infinity"]

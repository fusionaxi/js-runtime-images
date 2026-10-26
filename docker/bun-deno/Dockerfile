# syntax=docker/dockerfile:1
ARG BUN_IMAGE=oven/bun:1-debian
ARG RUNTIME_IMAGE=denoland/deno:debian
FROM ${BUN_IMAGE} AS bun
FROM ${RUNTIME_IMAGE}
USER root

# Keep Deno's official Alpine glibc setup intact; copy a musl Bun binary into it.
RUN set -eu; if [ -f /etc/alpine-release ]; then \
      apk add --no-cache ca-certificates libgcc libstdc++ tini; \
      addgroup -g 1001 bun; \
      adduser -D -u 1001 -G bun -s /bin/sh bun; \
    else \
      apt-get update; \
      apt-get install -y --no-install-recommends ca-certificates libstdc++6 tini; \
      rm -rf /var/lib/apt/lists/*; \
      groupadd --gid 1001 bun; \
      useradd --uid 1001 --gid bun --create-home --shell /bin/sh bun; \
    fi

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/fusionaxi-entrypoint
COPY LICENSE /usr/share/licenses/fusionaxi-js-runtime-images/LICENSE

ENV BUN_INSTALL=/home/bun/.bun \
    BUN_INSTALL_BIN=/home/bun/.bun/bin \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    DENO_DIR=/home/bun/.cache/deno \
    DENO_INSTALL_ROOT=/home/bun/.deno \
    DENO_NO_UPDATE_CHECK=1 \
    DENO_NO_PROMPT=1 \
    PATH=/home/bun/.bun/bin:/home/bun/.deno/bin:$PATH
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx \
    && mkdir -p /app /home/bun/.bun/bin /home/bun/.deno/bin /home/bun/.cache/deno \
    && chown -R bun:bun /app /home/bun \
    && bun --version && deno --version

LABEL org.opencontainers.image.title="FusionAxi Bun + Deno" \
      org.opencontainers.image.vendor="FusionAxi" \
      org.opencontainers.image.description="Bun tooling with the official Deno runtime" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
USER bun
ENTRYPOINT ["tini", "--", "/usr/local/bin/fusionaxi-entrypoint"]
CMD ["bun", "--help"]

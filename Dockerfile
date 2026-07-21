FROM oven/bun:1.3.6-alpine@sha256:819f91180e721ba09e0e5d3eb7fb985832fd23f516e18ddad7e55aaba8100be7 AS builder
WORKDIR /app

# The pinned Bun image is immutable, so refresh Alpine packages with fixes that
# were published after that image digest was built. Release CI scans the final
# image for fixable high/critical vulnerabilities before publishing it.
RUN apk upgrade --no-cache

COPY ./package.json ./bun.lock ./
RUN bun install --frozen-lockfile

COPY ./tsconfig.json ./tsdown.config.ts ./
COPY ./src ./src
RUN bun run build

FROM oven/bun:1.3.6-alpine@sha256:819f91180e721ba09e0e5d3eb7fb985832fd23f516e18ddad7e55aaba8100be7 AS runner
WORKDIR /app
ENV XDG_DATA_HOME=/home/bun/.local/share

RUN apk upgrade --no-cache

COPY ./package.json ./bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts --no-cache \
  && mkdir -p /home/bun/.local/share/copilot-proxy \
  && chown -R bun:bun /app /home/bun/.local

COPY --from=builder --chown=bun:bun /app/dist ./dist
COPY --chown=bun:bun ./LICENSE ./LICENSE
COPY --chown=bun:bun ./README.md ./README.zh-CN.md ./SECURITY.md ./
COPY --chown=bun:bun ./docs ./docs

EXPOSE 4399

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD /entrypoint.sh --healthcheck

COPY --chown=bun:bun entrypoint.sh /entrypoint.sh
COPY --chown=bun:bun scripts/resolve-container-port.sh /resolve-container-port.sh
RUN chmod +x /entrypoint.sh /resolve-container-port.sh
USER bun
ENTRYPOINT ["/entrypoint.sh"]

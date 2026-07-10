FROM oven/bun:1.3.6-alpine@sha256:819f91180e721ba09e0e5d3eb7fb985832fd23f516e18ddad7e55aaba8100be7 AS builder
WORKDIR /app

COPY ./package.json ./bun.lock ./
RUN bun install --frozen-lockfile

COPY ./tsconfig.json ./tsdown.config.ts ./
COPY ./src ./src
RUN bun run build

FROM oven/bun:1.3.6-alpine@sha256:819f91180e721ba09e0e5d3eb7fb985832fd23f516e18ddad7e55aaba8100be7 AS runner
WORKDIR /app
ENV XDG_DATA_HOME=/home/bun/.local/share

COPY ./package.json ./bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts --no-cache \
  && mkdir -p /home/bun/.local/share/copilot-proxy \
  && chown -R bun:bun /app /home/bun/.local

COPY --from=builder --chown=bun:bun /app/dist ./dist

EXPOSE 4399

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:4399/ || exit 1

COPY --chown=bun:bun entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
USER bun
ENTRYPOINT ["/entrypoint.sh"]

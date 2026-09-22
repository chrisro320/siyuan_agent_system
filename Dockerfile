FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
COPY integrations ./integrations
RUN bun run build

FROM oven/bun:1.3.14
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/src ./src
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown bun:bun /data
USER bun
ENV HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
EXPOSE 8787
CMD ["bun", "src/server/index.ts"]

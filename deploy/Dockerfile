# Dockerfile for Railway — Option B Tailscale mesh (Phase 5)
# Geek-Crawler v2 only. Does not deploy or alter Geek-Crawler v1.

FROM node:24-bookworm AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS final
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl iptables ca-certificates \
    && curl -fsSL https://tailscale.com/install.sh | sh \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/package.json /src/package-lock.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY deploy/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Playwright Chromium deps are large; install browsers in a follow-up image layer when enabling PW on Railway.
ENV EGRESS_MODE=mesh
ENV PORT=8787
EXPOSE 8787
ENTRYPOINT ["/app/entrypoint.sh"]

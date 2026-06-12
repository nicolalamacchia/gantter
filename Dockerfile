# syntax=docker/dockerfile:1
# Build stage: compile the SvelteKit app (adapter-node) and trim dev deps.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# Runtime: the adapter-node output needs build/, package.json and the
# production node_modules — nothing else.
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
USER node
EXPOSE 3000
# adapter-node honors PORT/HOST (Cloud Run-style platforms inject PORT).
CMD ["node", "build"]

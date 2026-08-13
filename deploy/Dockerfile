# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22.22.3-alpine3.23

FROM ${NODE_IMAGE} AS build-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM build-deps AS build
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS production-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NPM_CONFIG_UPDATE_NOTIFIER=false
RUN addgroup -S -g 10001 app && adduser -S -D -H -u 10001 -G app app
WORKDIR /app
COPY --from=production-deps --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --from=build --chown=10001:10001 /app/migrations ./migrations
COPY --from=build --chown=10001:10001 /app/package.json ./package.json
USER 10001:10001
EXPOSE 3000
CMD ["npm", "run", "start"]

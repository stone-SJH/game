FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY api ./api
COPY core ./core
COPY tools ./tools
COPY deploy/migrations ./deploy/migrations
COPY DEPLOYMENT.md ./
RUN mkdir -p /var/lib/yahahagame-controller/artifacts && chown -R node:node /var/lib/yahahagame-controller
USER node
CMD ["node", "api/server.mjs"]

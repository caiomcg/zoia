FROM node:22-alpine

WORKDIR /app

# Install production dependencies first so the layer caches across code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server

# The key store is bind-mounted at runtime; create it so the unprivileged user
# owns the mount point.
RUN mkdir -p /app/server/data && chown -R node:node /app

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]

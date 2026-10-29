# The addon host (ADR 0041). No dependencies to install: it is plain Node.
# It runs as root because the Docker socket is root's; nothing reaches it but
# the app, on the compose network, and it publishes no port.
FROM node:25-alpine

WORKDIR /host
COPY src ./src

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]

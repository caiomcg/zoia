# Echo's image. Zoia runs it with a read-only root, as a user with no
# capabilities, so write only under /tmp.
FROM node:22-alpine
WORKDIR /addon
COPY src ./src
USER node
CMD ["node", "src/index.js"]

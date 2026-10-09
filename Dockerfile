# Playwright's image ships Chromium and all its system libraries; keep the tag in sync
# with the exact "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.55.1-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/index.js"]

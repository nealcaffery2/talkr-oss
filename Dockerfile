# Talkr Platform API server, with the worker running inline (WORKER_INLINE=true)
# so one container is a complete product-testing deployment. Production runs
# the worker as a second process from this same image:
#   npm run worker -w apps/server
# Any Dockerfile host works (Railway, Render, Fly); see docs/deploy.md.

FROM node:22-alpine
WORKDIR /app

# The server runs its TypeScript through tsx, which is a root devDependency,
# so dev dependencies are installed on purpose.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
# apps/web is a workspace too; npm needs its manifest to resolve the lockfile.
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci --include=dev --no-audit --no-fund

ENV NODE_ENV=production PORT=4000
EXPOSE 4000
CMD ["npm", "run", "start", "-w", "apps/server"]

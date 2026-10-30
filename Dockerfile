# syntax=docker/dockerfile:1

FROM ghcr.io/marx-org/base-node:22-alpine@sha256:2be4359005a5800a6aa0bbb3236327132b12509cc4c345f5bccfe6b4b56ebe43

WORKDIR /app

# APP_VERSION is passed by CI (release tag); falls back to package.json at runtime
ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}

COPY package.json package-lock.json .npmrc ./
RUN --mount=type=secret,id=NODE_AUTH_TOKEN,env=NODE_AUTH_TOKEN,required=true \
    printf '%s\n' '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}' >> .npmrc && \
    npm ci && \
    rm -f .npmrc

COPY tsconfig.json ./
COPY drizzle.config.ts ./
COPY drizzle/ drizzle/
COPY src/ src/

RUN npm run build

ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "-c", "npm run db:migrate && node --import ./dist/iitm.js --import ./dist/instrumentation.js dist/server.js"]

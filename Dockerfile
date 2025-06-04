FROM node:24-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY pnpm-lock.yaml package.json ./
RUN pnpm install --frozen-lockfile --prod

COPY . .

RUN pnpm run build


FROM node:24-alpine

RUN apk update && apk add ffmpeg

COPY --from=builder /app/dist/ .
COPY --from=builder /app/node_modules/ ./node_modules/

ENTRYPOINT ["node", "index.js"]

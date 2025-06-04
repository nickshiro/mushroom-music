FROM node:23
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

RUN apt-get update && \
    apt-get install -y ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

COPY pnpm-lock.yaml* package.json ./
RUN pnpm install --frozen-lockfile

COPY . .

CMD ["pnpm", "start"]
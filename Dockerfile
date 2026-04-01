FROM node:22-bookworm-slim AS dev

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ tmux \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /workspace

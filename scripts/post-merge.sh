#!/bin/bash
set -e
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @workspace/db run push

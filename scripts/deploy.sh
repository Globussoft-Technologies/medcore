#!/bin/bash
# One-command deployment script for MedCore
# Usage: ./deploy.sh [--seed]

set -e

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

MEDCORE_DIR="/home/empcloud-development/medcore"
DB_URL="postgresql://medcore:medcore_secure_2024@localhost:5433/medcore?schema=public"

cd "$MEDCORE_DIR"

echo "=== Pulling latest code ==="
git pull origin main

echo "=== Installing dependencies ==="
npm install --ignore-scripts 2>/dev/null || npm install

echo "=== Generating Prisma client ==="
DATABASE_URL="$DB_URL" npx prisma generate --schema packages/db/prisma/schema.prisma

echo "=== Applying database migrations ==="
# Use prisma migrate deploy in production: it applies pending migrations from
# packages/db/prisma/migrations and never resets data. Schema changes must go
# through `prisma migrate dev --name <descriptor>` in development first.
DATABASE_URL="$DB_URL" npx prisma migrate deploy --schema packages/db/prisma/schema.prisma

echo "=== Building web app ==="
cd apps/web && npx next build && cd ../..

echo "=== Restarting services ==="
pm2 restart medcore-api medcore-web
sleep 3

echo "=== Verifying ==="
curl -sf http://localhost:4100/api/health && echo " API OK" || echo " API FAILED"
curl -sf http://localhost:3200 > /dev/null && echo "Web OK" || echo "Web FAILED"

pm2 save
echo "=== Deployment complete ==="

# Optional: re-seed
if [ "$1" == "--seed" ]; then
    echo "=== Re-seeding database ==="
    DATABASE_URL="$DB_URL" npx prisma db push --schema packages/db/prisma/schema.prisma --force-reset --accept-data-loss
    DATABASE_URL="$DB_URL" npx tsx packages/db/src/seed-realistic.ts
    pm2 restart medcore-api
    echo "=== Seed complete ==="
fi

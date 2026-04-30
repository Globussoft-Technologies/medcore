#!/bin/bash
# Health check script — run via cron every 5 minutes
# 0/5 * * * * /home/empcloud-development/medcore/scripts/healthcheck.sh

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

API_OK=$(curl -sf http://localhost:4100/api/health > /dev/null 2>&1 && echo "1" || echo "0")
WEB_OK=$(curl -sf http://localhost:3200 > /dev/null 2>&1 && echo "1" || echo "0")
PG_OK=$(docker exec medcore-postgres pg_isready -U medcore > /dev/null 2>&1 && echo "1" || echo "0")

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

if [ "$API_OK" != "1" ]; then
    echo "[$TIMESTAMP] API DOWN - restarting..."
    pm2 restart medcore-api
fi

if [ "$WEB_OK" != "1" ]; then
    echo "[$TIMESTAMP] WEB DOWN - restarting..."
    pm2 restart medcore-web
fi

if [ "$PG_OK" != "1" ]; then
    echo "[$TIMESTAMP] POSTGRES DOWN - restarting..."
    docker start medcore-postgres
fi

if [ "$API_OK" == "1" ] && [ "$WEB_OK" == "1" ] && [ "$PG_OK" == "1" ]; then
    # Only log every hour (when minute is 00)
    if [ "$(date +%M)" == "00" ]; then
        echo "[$TIMESTAMP] All services healthy"
    fi
fi

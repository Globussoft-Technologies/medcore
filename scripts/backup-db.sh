#!/bin/bash
# Automated PostgreSQL backup via Docker
# Run via cron: 0 2 * * * /home/empcloud-development/medcore/scripts/backup-db.sh

BACKUP_DIR="/home/empcloud-development/medcore/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/medcore_$TIMESTAMP.sql.gz"

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Dump and compress
docker exec medcore-postgres pg_dump -U medcore medcore | gzip > "$BACKUP_FILE"

# Check if backup succeeded
if [ $? -eq 0 ] && [ -s "$BACKUP_FILE" ]; then
    echo "Backup successful: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"
else
    echo "ERROR: Backup failed!"
    rm -f "$BACKUP_FILE"
    exit 1
fi

# Keep only last 30 days of backups
find "$BACKUP_DIR" -name "medcore_*.sql.gz" -mtime +30 -delete

echo "Old backups cleaned. Current backups:"
ls -lh "$BACKUP_DIR"/medcore_*.sql.gz 2>/dev/null | tail -5

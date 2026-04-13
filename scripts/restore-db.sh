#!/bin/bash
# Restore PostgreSQL backup
# Usage: ./restore-db.sh /path/to/backup.sql.gz

if [ -z "$1" ]; then
    echo "Usage: $0 <backup-file.sql.gz>"
    echo "Available backups:"
    ls -lh /home/empcloud-development/medcore/backups/medcore_*.sql.gz 2>/dev/null
    exit 1
fi

BACKUP_FILE="$1"

if [ ! -f "$BACKUP_FILE" ]; then
    echo "Error: File not found: $BACKUP_FILE"
    exit 1
fi

echo "WARNING: This will overwrite the current database!"
read -p "Continue? (yes/no): " confirm
if [ "$confirm" != "yes" ]; then
    echo "Aborted."
    exit 0
fi

echo "Restoring from $BACKUP_FILE..."

# Drop and recreate
docker exec medcore-postgres psql -U medcore -d postgres -c "DROP DATABASE IF EXISTS medcore;"
docker exec medcore-postgres psql -U medcore -d postgres -c "CREATE DATABASE medcore;"

# Restore
gunzip -c "$BACKUP_FILE" | docker exec -i medcore-postgres psql -U medcore medcore

if [ $? -eq 0 ]; then
    echo "Restore completed successfully."
else
    echo "ERROR: Restore failed!"
    exit 1
fi

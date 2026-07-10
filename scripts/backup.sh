#!/bin/bash

# PicPeak Backup Script
# Creates backups of database and storage

set -e

# Configuration
BACKUP_DIR="./backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="picpeak_backup_${TIMESTAMP}"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo "🔄 Starting PicPeak backup..."

# Create backup directory
mkdir -p "${BACKUP_DIR}/${BACKUP_NAME}"

# Backup database
echo "📊 Backing up database..."
if [ -f "./data/photo_sharing.db" ]; then
    cp ./data/photo_sharing.db "${BACKUP_DIR}/${BACKUP_NAME}/"
    echo -e "${GREEN}✓ SQLite database backed up${NC}"
else
    # PostgreSQL backup
    docker exec picpeak-postgres pg_dump -U picpeak picpeak > "${BACKUP_DIR}/${BACKUP_NAME}/database.sql" 2>/dev/null || {
        echo -e "${RED}⚠ Database backup failed - is PostgreSQL running?${NC}"
    }
fi

# Backup storage
echo "📸 Backing up photos..."
if [ -d "./storage" ]; then
    tar -czf "${BACKUP_DIR}/${BACKUP_NAME}/storage.tar.gz" ./storage 2>/dev/null || {
        echo -e "${RED}⚠ Storage backup failed${NC}"
        exit 1
    }
    echo -e "${GREEN}✓ Storage backed up${NC}"
fi

# Backup environment files
echo "⚙️  Backing up configuration..."
cp .env "${BACKUP_DIR}/${BACKUP_NAME}/.env.backup" 2>/dev/null || true

# Create backup info
echo "📝 Creating backup info..."
cat > "${BACKUP_DIR}/${BACKUP_NAME}/backup_info.txt" << EOF
PicPeak Backup
Created: $(date)
Version: $(grep version backend/package.json | head -1 | awk -F'"' '{print $4}')
Storage Size: $(du -sh ./storage 2>/dev/null | cut -f1 || echo "N/A")
EOF

# Compress entire backup
echo "📦 Compressing backup..."
cd "${BACKUP_DIR}"
tar -czf "${BACKUP_NAME}.tar.gz" "${BACKUP_NAME}"
rm -rf "${BACKUP_NAME}"

# Cleanup old backups (keep last 7)
echo "🧹 Cleaning up old backups..."
ls -t *.tar.gz | tail -n +8 | xargs -r rm

echo -e "${GREEN}✅ Backup completed: ${BACKUP_DIR}/${BACKUP_NAME}.tar.gz${NC}"
echo "💡 To restore: tar -xzf ${BACKUP_NAME}.tar.gz && follow restore instructions"
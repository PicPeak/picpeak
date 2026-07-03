#!/bin/bash
set -e

echo "Photo Sharing Platform - Docker Installation"
echo "==========================================="

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   echo "This script must be run as root" 
   exit 1
fi

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check prerequisites
echo "Checking prerequisites..."

# Install Docker if not present
if ! command_exists docker; then
    echo "Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
fi

# Install Docker Compose if not present
if ! command_exists docker-compose; then
    echo "Installing Docker Compose..."
    curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
fi

# Create necessary directories
echo "Creating directory structure..."
mkdir -p storage/events/{active,archived}
mkdir -p storage/thumbnails
mkdir -p data
mkdir -p logs
mkdir -p nginx/sites-enabled
mkdir -p certbot/{conf,www}

# Set permissions
chmod -R 755 storage
chmod -R 755 data
chmod -R 755 logs

# Copy environment file
if [ ! -f .env ]; then
    cp .env.example .env
    echo "Created .env file. Please edit it with your configuration."
fi

# Generate secure passwords
echo "Generating secure passwords..."
JWT_SECRET=$(openssl rand -base64 32)
DB_PASSWORD=$(openssl rand -base64 32)
UMAMI_HASH_SALT=$(openssl rand -base64 32)

# Update .env file with generated values
sed -i "s/JWT_SECRET=.*/JWT_SECRET=$JWT_SECRET/" .env
sed -i "s/DB_PASSWORD=.*/DB_PASSWORD=$DB_PASSWORD/" .env
sed -i "s/UMAMI_HASH_SALT=.*/UMAMI_HASH_SALT=$UMAMI_HASH_SALT/" .env

echo ""
echo "Installation complete!"
echo "Next steps:"
echo "1. Edit .env file with your domain names and SMTP settings"
echo "2. Run: ./scripts/setup-ssl.sh to configure SSL certificates"
echo "3. Run: docker-compose -f docker-compose.prod.yml up -d"
echo "4. Run: docker-compose -f docker-compose.prod.yml exec backend npm run migrate"

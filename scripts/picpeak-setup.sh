#!/usr/bin/env bash

################################################################################
# PicPeak Unified Setup Script
# Version: 2.1.0
# Description: Universal installer for PicPeak with Docker and Native options
# Supports: Ubuntu, Debian, Fedora, RHEL/CentOS, Raspberry Pi OS
################################################################################

set -euo pipefail
IFS=$'\n\t'

# Script configuration
readonly SCRIPT_VERSION="2.1.0"
readonly APP_NAME="PicPeak"
readonly REPO_URL="https://github.com/the-luap/picpeak.git"
readonly NODE_VERSION="20"
readonly MIN_RAM_DOCKER=2048
readonly MIN_RAM_NATIVE=1024
readonly MIN_DISK_GB=2
readonly DEFAULT_PORT=3001

# Installation paths
readonly NATIVE_APP_DIR="/opt/picpeak"
readonly NATIVE_APP_USER="picpeak"
readonly DOCKER_APP_DIR="$HOME/picpeak"

# Color codes for output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly PURPLE='\033[0;35m'
readonly CYAN='\033[0;36m'
readonly NC='\033[0m' # No Color

# Logging
readonly LOG_FILE="/tmp/picpeak-setup-$(date +%Y%m%d-%H%M%S).log"
exec 1> >(tee -a "$LOG_FILE")
exec 2>&1

# Global variables
INSTALL_METHOD=""  # docker or native
OS_TYPE=""
OS_VERSION=""
PACKAGE_MANAGER=""
ADMIN_EMAIL="admin@example.com"
DOMAIN_NAME=""
SMTP_HOST=""
SMTP_PORT=""
SMTP_USER=""
SMTP_PASS=""
ENABLE_SSL=false
CUSTOM_PORT=""
UNATTENDED=false
UPDATE_MODE=false
UNINSTALL_MODE=false
FORCE_ADMIN_PASSWORD_RESET=false

################################################################################
# Helper Functions
################################################################################

# Run a command as the application user, even if sudo is not available
run_as_user() {
    local cmd="$*"
    local current_dir_escaped
    current_dir_escaped=$(printf '%q' "$(pwd)")
    if [[ "$(id -u)" -ne 0 ]]; then
        # Already non-root; preserve working directory
        bash -lc "cd $current_dir_escaped && $cmd"
        return $?
    fi
    if command_exists sudo; then
        sudo -H -u "$NATIVE_APP_USER" bash -lc "cd $current_dir_escaped && $cmd"
    elif command_exists runuser; then
        runuser -u "$NATIVE_APP_USER" -- bash -lc "cd $current_dir_escaped && $cmd"
    else
        su -s /bin/bash - "$NATIVE_APP_USER" -c "cd $current_dir_escaped && $cmd"
    fi
}

# Prompt for admin email interactively (unless provided or unattended)
prompt_admin_email() {
    if [[ -n "$ADMIN_EMAIL" ]]; then
        return
    fi
    if [[ "$UNATTENDED" == "true" ]]; then
        ADMIN_EMAIL="admin@example.com"
        return
    fi
    echo
    echo "Please enter the admin email address (used for the initial admin account):"
    read -p "Admin email [admin@example.com]: " ADMIN_EMAIL
    ADMIN_EMAIL=${ADMIN_EMAIL:-admin@example.com}
}

print_banner() {
    echo -e "${PURPLE}"
    echo "╔════════════════════════════════════════════════════════════════════════╗"
    echo "║                                                                        ║"
    echo "║     ____  _      ____            _      ____       _                  ║"
    echo "║    |  _ \\(_) ___|  _ \\ ___  __ _| | __ / ___|  ___| |_ _   _ _ __     ║"
    echo "║    | |_) | |/ __| |_) / _ \\/ _\` | |/ / \\___ \\ / _ \\ __| | | | '_ \\    ║"
    echo "║    |  __/| | (__|  __/  __/ (_| |   <   ___) |  __/ |_| |_| | |_) |   ║"
    echo "║    |_|   |_|\\___|_|   \\___|\\__,_|_|\\_\\ |____/ \\___|\\__|\\__,_| .__/    ║"
    echo "║                                                              |_|       ║"
    echo "║                                                                        ║"
    echo "║              🚀 Unified Setup Script v${SCRIPT_VERSION}                       ║"
    echo "║           📸 Secure Photo Sharing for Weddings & Events               ║"
    echo "║                                                                        ║"
    echo "╚════════════════════════════════════════════════════════════════════════╝"
    echo -e "${NC}\n"
}

print_header() {
    echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

log_info() { echo -e "${CYAN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_success() { echo -e "${GREEN}✅${NC} $1"; }
log_step() { echo -e "${PURPLE}🔄${NC} $1"; }

die() {
    log_error "$1"
    echo -e "\n${RED}Installation failed. Check the log file: $LOG_FILE${NC}"
    exit 1
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

ensure_storage_layout() {
    local base_dir="$1"
    local storage_root="$base_dir/storage"
    local storage_events_dir="$storage_root/events"

    mkdir -p "$storage_events_dir/active" \
             "$storage_events_dir/archived" \
             "$storage_root/thumbnails" \
             "$storage_root/tmp"

    local legacy_dir="$base_dir/events"
    if [[ -d "$legacy_dir" ]]; then
        log_step "Migrating legacy events directory to storage/events..."
        mkdir -p "$storage_events_dir"

        local existing=""
        if [[ -d "$storage_events_dir" ]]; then
            existing=$(ls -A "$storage_events_dir" 2>/dev/null || true)
        fi

        if [[ ! -d "$storage_events_dir" || -z "$existing" ]]; then
            rm -rf "$storage_events_dir"
            mv "$legacy_dir" "$storage_events_dir"
        else
            cp -a "$legacy_dir/." "$storage_events_dir/"
            rm -rf "$legacy_dir"
        fi
    fi
    mkdir -p "$storage_events_dir/active" "$storage_events_dir/archived"
}

generate_password() {
    openssl rand -base64 32 | tr -d "=+/" | cut -c1-16
}

generate_jwt_secret() {
    openssl rand -base64 64 | tr -d "\n"
}

get_available_ram_mb() {
    # Prefer /proc/meminfo (always available on Linux), fallback to free(1)
    if [[ -r /proc/meminfo ]]; then
        awk '/^MemTotal:/ { printf "%d\n", $2/1024 }' /proc/meminfo
        return
    fi
    if command_exists free; then
        free -m | awk '/^Mem:/ {print $2}'
        return
    fi
    echo "0"
}

get_available_disk_gb() {
    df -BG / | awk 'NR==2 {print $4}' | sed 's/G//'
}

confirm() {
    local prompt="$1"
    local default="${2:-n}"
    local REPLY
    
    if [[ "$UNATTENDED" == "true" ]]; then
        [[ "$default" == "y" ]] && return 0 || return 1
    fi
    
    if [[ "$default" == "y" ]]; then
        prompt="$prompt [Y/n]: "
    else
        prompt="$prompt [y/N]: "
    fi
    
    read -p "$prompt" REPLY
    REPLY=${REPLY:-$default}
    
    [[ "$REPLY" =~ ^[Yy]$ ]]
}

detect_os() {
    if [[ -f /etc/os-release ]]; then
        . /etc/os-release
        OS_TYPE="$ID"
        OS_VERSION="$VERSION_ID"
    else
        die "Cannot detect operating system"
    fi
    
    case "$OS_TYPE" in
        ubuntu|debian|raspbian)
            PACKAGE_MANAGER="apt"
            ;;
        fedora|rhel|centos|rocky|almalinux)
            PACKAGE_MANAGER="dnf"
            command_exists dnf || PACKAGE_MANAGER="yum"
            ;;
        *)
            die "Unsupported operating system: $OS_TYPE"
            ;;
    esac
    
    log_info "Detected OS: $OS_TYPE $OS_VERSION"
}

################################################################################
# Installation Method Selection
################################################################################

select_install_method() {
    if [[ -n "$INSTALL_METHOD" ]]; then
        return
    fi
    
    if [[ "$UNATTENDED" == "true" ]]; then
        INSTALL_METHOD="docker"
        return
    fi
    
    print_header "Select Installation Method"
    
    echo "Please choose your preferred installation method:"
    echo
    echo -e "${GREEN}1) Docker Installation (Recommended)${NC}"
    echo "   ✅ Easier to install and update"
    echo "   ✅ Isolated environment"
    echo "   ✅ Includes PostgreSQL and Redis"
    echo "   ⚠️  Requires ~4GB RAM"
    echo
    echo -e "${YELLOW}2) Native Installation${NC}"
    echo "   ✅ Lower resource usage (~1GB RAM)"
    echo "   ✅ Better for Raspberry Pi"
    echo "   ✅ Direct system control"
    echo "   ⚠️  More complex setup"
    echo
    
    local choice
    while true; do
        read -p "Enter your choice (1 or 2): " choice
        case $choice in
            1) INSTALL_METHOD="docker"; break;;
            2) INSTALL_METHOD="native"; break;;
            *) log_error "Invalid choice. Please enter 1 or 2.";;
        esac
    done
    
    log_success "Selected: ${INSTALL_METHOD^} installation"
}

################################################################################
# System Requirements Check
################################################################################

check_system_requirements() {
    print_header "Checking System Requirements"
    
    local required_ram
    if [[ "$INSTALL_METHOD" == "docker" ]]; then
        required_ram=$MIN_RAM_DOCKER
    else
        required_ram=$MIN_RAM_NATIVE
    fi
    
    # Check RAM
    local available_ram=$(get_available_ram_mb)
    if [[ $available_ram -lt $required_ram ]]; then
        log_warn "System has ${available_ram}MB RAM, recommended: ${required_ram}MB"
        if ! confirm "Continue with limited RAM?"; then
            die "Insufficient RAM"
        fi
    else
        log_success "RAM check passed: ${available_ram}MB available"
    fi
    
    # Check disk space
    local available_disk=$(get_available_disk_gb)
    if [[ $available_disk -lt $MIN_DISK_GB ]]; then
        log_warn "System has ${available_disk}GB free space, recommended: ${MIN_DISK_GB}GB"
        if ! confirm "Continue with limited disk space?"; then
            die "Insufficient disk space"
        fi
    else
        log_success "Disk space check passed: ${available_disk}GB available"
    fi
    
    # Check architecture
    local arch=$(uname -m)
    log_info "System architecture: $arch"
    
    # Check required commands
    if ! command_exists openssl; then
        log_warn "OpenSSL not found, installing..."
        install_package openssl
    fi
    
    if ! command_exists curl; then
        log_warn "curl not found, installing..."
        install_package curl
    fi
    
    if ! command_exists git; then
        log_warn "git not found, installing..."
        install_package git
    fi
}

################################################################################
# Docker Installation
################################################################################

install_docker() {
    if command_exists docker; then
        log_success "Docker is already installed"
        return
    fi
    
    print_header "Installing Docker"
    log_step "Installing Docker and Docker Compose..."
    
    case "$PACKAGE_MANAGER" in
        apt)
            curl -fsSL https://get.docker.com | sh
            ;;
        dnf|yum)
            $PACKAGE_MANAGER config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
            $PACKAGE_MANAGER install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
            ;;
    esac
    
    # Start Docker service
    systemctl start docker
    systemctl enable docker
    
    # Add current user to docker group
    if [[ -n "${SUDO_USER:-}" ]]; then
        usermod -aG docker "$SUDO_USER"
    fi
    
    log_success "Docker installed successfully"
}

setup_docker_installation() {
    print_header "Docker Installation Setup"
    
    # Install Docker if needed
    install_docker
    
    # Create application directory
    local app_dir="$DOCKER_APP_DIR"
    if [[ -n "${SUDO_USER:-}" ]]; then
        app_dir="/home/$SUDO_USER/picpeak"
    fi
    
    log_step "Preparing application directory at $app_dir"
    local app_parent_dir
    app_parent_dir=$(dirname "$app_dir")
    mkdir -p "$app_parent_dir"

    if [[ -d "$app_dir/.git" ]]; then
        log_step "Existing PicPeak repository detected; pulling latest changes"
        cd "$app_dir"
        git pull
    elif [[ -d "$app_dir" ]]; then
        if [[ -z "$(ls -A "$app_dir" 2>/dev/null)" ]]; then
            log_warn "Existing directory $app_dir is empty but not a git repository; recreating it..."
            rm -rf "$app_dir"
            git clone "$REPO_URL" "$app_dir"
        else
            log_warn "Directory $app_dir already exists and is not a git repository."
            if [[ "$UNATTENDED" == "true" ]]; then
                local backup_dir="${app_dir}.backup-$(date +%Y%m%d-%H%M%S)"
                log_warn "Unattended mode: backing up directory to $backup_dir and cloning a fresh copy."
                mv "$app_dir" "$backup_dir"
                git clone "$REPO_URL" "$app_dir"
            else
                if confirm "Replace existing directory $app_dir with a fresh clone? This will move the current contents to a backup folder." "y"; then
                    local backup_dir="${app_dir}.backup-$(date +%Y%m%d-%H%M%S)"
                    mv "$app_dir" "$backup_dir"
                    log_step "Existing directory moved to $backup_dir"
                    git clone "$REPO_URL" "$app_dir"
                else
                    die "Installation aborted because $app_dir already exists and is not a PicPeak git repository."
                fi
            fi
        fi
    else
        if [[ -d "$app_dir" && -n "$(find "$app_dir" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
            die "Target directory $app_dir already exists and is not empty. Remove it or specify --install-dir before retrying."
        fi

        log_step "Cloning PicPeak..."
        rm -rf "$app_dir"
        git clone "$REPO_URL" "$app_dir"
    fi

    # Ensure storage layout exists after cloning
    mkdir -p "$app_dir"/{storage/events/{active,archived},logs,backup,config,data,events}
    
    # Determine host user for container mapping (PUID/PGID)
    local host_uid host_gid
    if [[ -n "${SUDO_USER:-}" ]]; then
        host_uid=$(id -u "$SUDO_USER" 2>/dev/null || echo 1000)
        host_gid=$(id -g "$SUDO_USER" 2>/dev/null || echo 1000)
    else
        host_uid=$(id -u 2>/dev/null || echo 1000)
        host_gid=$(id -g 2>/dev/null || echo 1000)
    fi

    # Generate secrets
    local jwt_secret=$(generate_jwt_secret)
    local db_password=$(generate_password)
    local redis_password=$(generate_password)
    
    # Create .env file
    log_step "Creating configuration..."
    cat > "$app_dir/.env" <<EOF
# PicPeak Docker Configuration
# Generated: $(date)

# Application
NODE_ENV=production
PORT=3001
JWT_SECRET=$jwt_secret

# Admin
ADMIN_EMAIL=$ADMIN_EMAIL

# Runtime user mapping for Docker bind mounts
PUID=$host_uid
PGID=$host_gid

# Database
DB_HOST=postgres
DB_PORT=5432
DB_USER=picpeak
DB_PASSWORD=$db_password
DB_NAME=picpeak

# Redis
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=$redis_password

# Storage
PHOTOS_DIR=/app/storage/events

# Email
SMTP_ENABLED=${SMTP_HOST:+true}
SMTP_HOST=$SMTP_HOST
SMTP_PORT=$SMTP_PORT
SMTP_USER=$SMTP_USER
SMTP_PASS=$SMTP_PASS
SMTP_FROM=${SMTP_USER:-noreply@localhost}

# URLs
FRONTEND_URL=${DOMAIN_NAME:+https://$DOMAIN_NAME}
ADMIN_URL=${DOMAIN_NAME:+https://$DOMAIN_NAME}

# Auth cookie behavior — 'auto' emits Secure on HTTPS, omits it on HTTP.
# Without this, first-time HTTP installs (no reverse proxy yet) silently
# fail at login because the browser drops Secure cookies over HTTP (#427).
# On HTTPS via reverse proxy, req.secure is true → Secure flag is still
# emitted, so this is not a security regression for production deploys.
COOKIE_SECURE=auto

# Features
ENABLE_FILE_WATCHER=true
ENABLE_EXPIRATION_CHECKER=true
ENABLE_EMAIL_SERVICE=true
DEFAULT_EXPIRY_DAYS=30
EOF

    # Ensure bind mounts are writable by mapped user
    chown -R "$host_uid":"$host_gid" "$app_dir"/storage "$app_dir"/logs "$app_dir"/backup "$app_dir"/data "$app_dir"/events 2>/dev/null || true

    # Create docker-compose.yml if it doesn't exist
    if [[ ! -f "$app_dir/docker-compose.yml" ]]; then
        log_step "Creating Docker Compose configuration..."
        create_docker_compose_file "$app_dir"
    fi

    # Set up SSL if requested
    if [[ "$ENABLE_SSL" == "true" ]] && [[ -n "$DOMAIN_NAME" ]]; then
        setup_ssl_docker "$app_dir"
    fi

    # Clean up the legacy picpeak-workers container from prior installs
    # (workers are now in-process — see create_docker_compose_file).
    # Otherwise the leftover container keeps running its own
    # fileWatcher / expirationChecker against the same DB rows the new
    # backend container processes.
    if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^picpeak-workers$'; then
      log_step "Removing legacy picpeak-workers container (workers now run in-process)..."
      docker stop picpeak-workers >/dev/null 2>&1 || true
      docker rm picpeak-workers >/dev/null 2>&1 || true
    fi

    # Start services
    log_step "Starting services..."
    cd "$app_dir"
    docker compose up -d

    # Wait for services to be ready
    log_step "Waiting for services to initialize..."
    sleep 10

    # Migrations are run automatically by backend/wait-for-db.sh on
    # container startup (`npm run migrate:safe`). Running migrate here
    # in parallel — as we used to — could race against the in-container
    # migration and leave the schema half-applied (the actual mechanism
    # behind the "relation 'photos' does not exist" symptom in #484
    # when re-installing on top of partial state). Wait briefly for the
    # backend to finish its migrate:safe pass instead.
    log_step "Waiting for backend to finish migrations and become healthy..."
    for _ in $(seq 1 30); do
      if docker inspect -f '{{.State.Health.Status}}' picpeak-backend 2>/dev/null | grep -q '^healthy$'; then
        log_success "Backend healthy."
        break
      fi
      sleep 2
    done

    if [[ "$FORCE_ADMIN_PASSWORD_RESET" == "true" ]]; then
        log_step "Resetting admin credentials..."
        if docker compose exec -T backend node scripts/reset-admin-password.js --force --credentials-file data/ADMIN_CREDENTIALS.txt; then
            docker compose cp backend:/app/data/ADMIN_CREDENTIALS.txt "$app_dir/data/ADMIN_CREDENTIALS.txt" 2>/dev/null || true
        else
            log_warn "Automatic admin password reset failed; run reset-admin-password.js inside the backend container."
        fi
    fi

    # Always surface the admin credentials file (#427: iSchumi reported
    # admins couldn't find the generated password — the migration writes it
    # to the in-container path and we never copied it to the host unless
    # --reset-admin-password was used). Best-effort: a missing file just
    # means the migration ran on a pre-existing DB and didn't generate one.
    if docker compose cp backend:/app/data/ADMIN_CREDENTIALS.txt "$app_dir/data/ADMIN_CREDENTIALS.txt" 2>/dev/null; then
        chown "$host_uid":"$host_gid" "$app_dir/data/ADMIN_CREDENTIALS.txt" 2>/dev/null || true
        chmod 600 "$app_dir/data/ADMIN_CREDENTIALS.txt" 2>/dev/null || true
        log_step "Admin credentials saved to: $app_dir/data/ADMIN_CREDENTIALS.txt"
        # Show the password in the install output so the operator can log
        # in immediately. The file remains as a backup record.
        echo
        echo "--------------------------------------------------"
        grep -E '^Email:|^Password:' "$app_dir/data/ADMIN_CREDENTIALS.txt" 2>/dev/null || true
        echo "--------------------------------------------------"
        echo "  Login URL: ${DOMAIN_NAME:+https://$DOMAIN_NAME}${DOMAIN_NAME:-http://YOUR_HOST_IP:3000}/admin"
        echo "  Full credentials file: $app_dir/data/ADMIN_CREDENTIALS.txt"
        echo "  Delete the file after recording the password."
        echo
    fi

    log_success "Docker installation completed!"
}

create_docker_compose_file() {
    local app_dir="$1"
    cat > "$app_dir/docker-compose.yml" <<'EOF'
version: '3.8'

services:
  postgres:
    image: postgres:15-alpine
    container_name: picpeak-postgres
    environment:
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: ${DB_NAME}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    networks:
      - picpeak-network
    restart: unless-stopped
    healthcheck:
      # `pg_isready -U <user>` without -d defaults to probing a database
      # whose name matches the user — postgres logs constant `FATAL:
      # database "<user>" does not exist` even though the actual DB
      # is `${DB_NAME}`. Pinning -d to DB_NAME silences the noise
      # that made #484's reporter think the install was broken.
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER} -d ${DB_NAME}"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    container_name: picpeak-redis
    command: redis-server --requirepass ${REDIS_PASSWORD}
    volumes:
      - redis-data:/data
    networks:
      - picpeak-network
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "--raw", "incr", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  backend:
    build: ./backend
    container_name: picpeak-backend
    env_file: .env
    volumes:
      - ./storage:/app/storage
      - ./logs:/app/logs
    ports:
      - "${PORT:-3001}:3001"
    networks:
      - picpeak-network
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      # backend image only ships wget (Alpine base) — using curl
      # makes `docker ps` show the container as `unhealthy`
      # indefinitely even when /api/health responds. Mirrors the
      # wget-based HEALTHCHECK in backend/Dockerfile.
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:3001/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  # Frontend container (#484). Previously absent from the
  # script-generated compose, which left the script's docker
  # architecture (backend on host port 3001, no separate frontend)
  # different from the documented production install
  # (docker-compose.production.yml: backend internal-only +
  # frontend nginx serving /api proxy on host port 3000). Aligning
  # both shapes on the same 3-service shape — postgres + redis +
  # backend, plus a frontend nginx — eliminates the doc/script
  # divergence MrGabri flagged.
  frontend:
    build: ./frontend
    container_name: picpeak-frontend
    ports:
      - "${FRONTEND_PORT:-3000}:80"
    networks:
      - picpeak-network
    depends_on:
      - backend
    restart: unless-stopped
    healthcheck:
      # frontend Dockerfile installs curl (apk add --no-cache curl)
      # — safe to use here unlike the backend.
      test: ["CMD", "curl", "-f", "http://localhost/health"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  postgres-data:
  redis-data:

networks:
  picpeak-network:
    driver: bridge
EOF
}

################################################################################
# Native Installation
################################################################################

install_nodejs() {
    if command_exists node && [[ $(node -v | cut -d'v' -f2 | cut -d'.' -f1) -ge $NODE_VERSION ]]; then
        log_success "Node.js $(node -v) is already installed"
        return
    fi
    
    log_step "Installing Node.js $NODE_VERSION..."
    
    case "$PACKAGE_MANAGER" in
        apt)
            curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
            apt-get install -y nodejs
            ;;
        dnf|yum)
            curl -fsSL https://rpm.nodesource.com/setup_${NODE_VERSION}.x | bash -
            $PACKAGE_MANAGER install -y nodejs
            ;;
    esac
    
    log_success "Node.js installed: $(node -v)"
}

setup_native_installation() {
    print_header "Native Installation Setup"
    
    # Install Node.js
    install_nodejs
    
    # Install SQLite
    log_step "Installing SQLite..."
    install_package sqlite3
    
    # Install build tools
    log_step "Installing build tools..."
    case "$PACKAGE_MANAGER" in
        apt)
            apt-get install -y build-essential python3
            ;;
        dnf)
            if ! $PACKAGE_MANAGER install -y @development-tools; then
                log_warn "dnf @development-tools group install failed, retrying with legacy groupinstall syntax..."
                $PACKAGE_MANAGER groupinstall -y "Development Tools"
            fi
            $PACKAGE_MANAGER install -y python3
            ;;
        yum)
            $PACKAGE_MANAGER groupinstall -y "Development Tools"
            $PACKAGE_MANAGER install -y python3
            ;;
    esac
    
    # Create system user
    if ! id "$NATIVE_APP_USER" &>/dev/null; then
        log_step "Creating system user..."
        useradd -r -s /bin/bash -m -d /home/$NATIVE_APP_USER $NATIVE_APP_USER
    fi
    
    # Create application directory
    log_step "Creating application directory..."
    mkdir -p "$NATIVE_APP_DIR"/{app,logs,config}
    ensure_storage_layout "$NATIVE_APP_DIR"
    chown -R $NATIVE_APP_USER:$NATIVE_APP_USER "$NATIVE_APP_DIR"
    
    # Clone repository
    log_step "Downloading PicPeak..."
    if [[ -d "$NATIVE_APP_DIR/app/.git" ]]; then
        cd "$NATIVE_APP_DIR/app"
        # Ensure correct remote and update even if history was rewritten
        run_as_user "git config --global --add safe.directory $NATIVE_APP_DIR/app" || true
        run_as_user "git remote set-url origin $REPO_URL" || true
        run_as_user "git fetch --all --prune" || true
        # Prefer checking out remote main and hard resetting to avoid merge prompts
        if ! run_as_user "git checkout -B main origin/main"; then
          run_as_user "git checkout main" || true
          run_as_user "git reset --hard origin/main"
        fi
    else
        run_as_user "git clone $REPO_URL $NATIVE_APP_DIR/app" || {
            run_as_user "git config --global --add safe.directory $NATIVE_APP_DIR/app"
            run_as_user "git clone $REPO_URL $NATIVE_APP_DIR/app"
        }
    fi
    
    # Install dependencies
    log_step "Installing dependencies..."
    # The repository root contains both backend/ and frontend/
    # Install backend production dependencies
    cd "$NATIVE_APP_DIR/app/backend"
    npm install --production
    # Ensure SQLite data directory exists for native installs
    mkdir -p "$NATIVE_APP_DIR/app/backend/data"

    # Build frontend for native serving
    log_step "Building frontend..."
    if [[ -d "$NATIVE_APP_DIR/app/frontend" ]]; then
      cd "$NATIVE_APP_DIR/app/frontend"
      # Try ci (faster/clean) then fallback to install
      run_as_user "npm ci --include=dev" || run_as_user "npm install"
      run_as_user "npm run build"
    else
      log_warn "Frontend directory not found; admin UI will not be served by backend"
    fi
    
    # Generate secrets
    local jwt_secret=$(generate_jwt_secret)
    
    # Create .env file
    log_step "Creating configuration..."
    cat > "$NATIVE_APP_DIR/app/backend/.env" <<EOF
# PicPeak Native Configuration
# Generated: $(date)

# Application
NODE_ENV=production
PORT=${CUSTOM_PORT:-$DEFAULT_PORT}
JWT_SECRET=$jwt_secret

# Admin
ADMIN_USERNAME=admin
ADMIN_EMAIL=$ADMIN_EMAIL

# Database (native uses SQLite by default)
DATABASE_CLIENT=sqlite3
DATABASE_PATH=$NATIVE_APP_DIR/app/backend/data/photo_sharing.db

# Storage root (thumbnails/uploads live under this path)
STORAGE_PATH=$NATIVE_APP_DIR/storage

# Email
SMTP_ENABLED=${SMTP_HOST:+true}
SMTP_HOST=$SMTP_HOST
SMTP_PORT=$SMTP_PORT
SMTP_USER=$SMTP_USER
SMTP_PASS=$SMTP_PASS
SMTP_FROM=${SMTP_USER:-noreply@localhost}

# URLs
FRONTEND_URL=${DOMAIN_NAME:+https://$DOMAIN_NAME}
ADMIN_URL=${DOMAIN_NAME:+https://$DOMAIN_NAME}

# Auth cookie behavior — see Docker .env block above for rationale (#427).
COOKIE_SECURE=auto

# Features
ENABLE_FILE_WATCHER=true
ENABLE_EXPIRATION_CHECKER=true
ENABLE_EMAIL_SERVICE=true
DEFAULT_EXPIRY_DAYS=30

# Logging
LOG_DIR=$NATIVE_APP_DIR/logs
LOG_LEVEL=info

# Frontend serving (native installs)
SERVE_FRONTEND=true
FRONTEND_DIR=$NATIVE_APP_DIR/app/frontend/dist
EOF

    # Set permissions
    chown -R $NATIVE_APP_USER:$NATIVE_APP_USER "$NATIVE_APP_DIR"
    chmod 600 "$NATIVE_APP_DIR/app/backend/.env"

    # Run database migrations
    log_step "Initializing database..."
    cd "$NATIVE_APP_DIR/app/backend"
    run_as_user "npm run migrate"

    if [[ "$FORCE_ADMIN_PASSWORD_RESET" == "true" ]]; then
        log_step "Resetting admin credentials..."
        if ! run_as_user "node scripts/reset-admin-password.js --force --credentials-file data/ADMIN_CREDENTIALS.txt"; then
            log_warn "Automatic admin password reset failed; please run reset-admin-password.js manually."
        fi
    fi

    # Always surface the admin credentials file (#427).
    local creds_path="$NATIVE_APP_DIR/app/backend/data/ADMIN_CREDENTIALS.txt"
    if [[ -f "$creds_path" ]]; then
        chmod 600 "$creds_path" 2>/dev/null || true
        log_step "Admin credentials saved to: $creds_path"
        echo
        echo "--------------------------------------------------"
        grep -E '^Email:|^Password:' "$creds_path" 2>/dev/null || true
        echo "--------------------------------------------------"
        echo "  Login URL: ${DOMAIN_NAME:+https://$DOMAIN_NAME}${DOMAIN_NAME:-http://YOUR_HOST_IP:${CUSTOM_PORT:-$DEFAULT_PORT}}/admin"
        echo "  Full credentials file: $creds_path"
        echo "  Delete the file after recording the password."
        echo
    fi

    # Create systemd services
    create_systemd_services
    
    # Set up web server if requested
    if [[ "$ENABLE_SSL" == "true" ]] && [[ -n "$DOMAIN_NAME" ]]; then
        setup_caddy
    fi
    
    # Start services
    log_step "Starting services..."
    systemctl daemon-reload
    systemctl enable picpeak-backend
    # Stop/remove legacy workers service if present
    if systemctl list-unit-files | grep -q '^picpeak-workers.service'; then
      systemctl disable picpeak-workers || true
      systemctl stop picpeak-workers || true
      rm -f /etc/systemd/system/picpeak-workers.service
      systemctl daemon-reload
    fi
    systemctl start picpeak-backend
    
    log_success "Native installation completed!"
}

create_systemd_services() {
    log_step "Creating systemd services..."

    # Backend service (includes workers - fileWatcher, expirationChecker are started by server.js)
    cat > /etc/systemd/system/picpeak-backend.service <<EOF
[Unit]
Description=PicPeak Backend Service
After=network.target

[Service]
Type=simple
User=$NATIVE_APP_USER
    WorkingDirectory=$NATIVE_APP_DIR/app/backend
Environment="NODE_ENV=production"
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
StandardOutput=append:$NATIVE_APP_DIR/logs/backend.log
StandardError=append:$NATIVE_APP_DIR/logs/backend-error.log

[Install]
WantedBy=multi-user.target
EOF

    # Note: Workers (fileWatcher, expirationChecker, emailProcessor) are now started
    # automatically by server.js, so a separate workers service is no longer needed.
    # Legacy picpeak-workers.service will be cleaned up during installation.
}

setup_caddy() {
    log_step "Setting up Caddy web server..."
    
    # Install Caddy
    case "$PACKAGE_MANAGER" in
        apt)
            apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
            curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
            curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
            apt-get update
            apt-get install -y caddy
            ;;
        dnf|yum)
            $PACKAGE_MANAGER install -y 'dnf-command(copr)'
            $PACKAGE_MANAGER copr enable @caddy/caddy -y
            $PACKAGE_MANAGER install -y caddy
            ;;
    esac
    
    # Configure Caddy
    cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN_NAME {
    reverse_proxy localhost:${CUSTOM_PORT:-$DEFAULT_PORT}
    
    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        X-XSS-Protection "1; mode=block"
        Referrer-Policy no-referrer-when-downgrade
    }
    
    encode gzip
    
    file_server {
        hide .git
    }
    
    @api path /api/*
    handle @api {
        reverse_proxy localhost:${CUSTOM_PORT:-$DEFAULT_PORT}
    }
    
    @admin path /admin/*
    handle @admin {
        reverse_proxy localhost:${CUSTOM_PORT:-$DEFAULT_PORT}
    }
}
EOF
    
    # Start Caddy
    systemctl enable caddy
    systemctl restart caddy
}

################################################################################
# Common Functions
################################################################################

install_package() {
    local package="$1"
    log_step "Installing $package..."
    
    case "$PACKAGE_MANAGER" in
        apt)
            apt-get update
            apt-get install -y "$package"
            ;;
        dnf|yum)
            $PACKAGE_MANAGER install -y "$package"
            ;;
    esac
}

configure_email() {
    if [[ "$UNATTENDED" == "true" ]]; then
        return
    fi
    
    print_header "Email Configuration (Optional)"
    
    echo "Configure email notifications for gallery expiration warnings?"
    echo "You can also configure this later in the admin panel."
    echo
    
    if ! confirm "Set up email now?" "n"; then
        log_info "Skipping email configuration"
        return
    fi
    
    echo -e "\nSelect email provider:"
    echo "1) Gmail"
    echo "2) SendGrid"
    echo "3) Custom SMTP"
    echo "4) Skip"
    
    local choice
    read -p "Enter choice (1-4): " choice
    
    case $choice in
        1)
            SMTP_HOST="smtp.gmail.com"
            SMTP_PORT="587"
            read -p "Gmail address: " SMTP_USER
            read -s -p "App password: " SMTP_PASS
            echo
            ;;
        2)
            SMTP_HOST="smtp.sendgrid.net"
            SMTP_PORT="587"
            SMTP_USER="apikey"
            read -s -p "SendGrid API key: " SMTP_PASS
            echo
            ;;
        3)
            read -p "SMTP host: " SMTP_HOST
            read -p "SMTP port [587]: " SMTP_PORT
            SMTP_PORT=${SMTP_PORT:-587}
            read -p "SMTP username: " SMTP_USER
            read -s -p "SMTP password: " SMTP_PASS
            echo
            ;;
        *)
            log_info "Email configuration skipped"
            ;;
    esac
}

print_success_message() {
    local app_dir port manual_reset_hint
    
    if [[ "$INSTALL_METHOD" == "docker" ]]; then
        app_dir="$DOCKER_APP_DIR"
        [[ -n "${SUDO_USER:-}" ]] && app_dir="/home/$SUDO_USER/picpeak"
        port="${CUSTOM_PORT:-$DEFAULT_PORT}"
        manual_reset_hint="cd $(printf %q "$app_dir") && docker compose exec -T backend node scripts/reset-admin-password.js --force --credentials-file data/ADMIN_CREDENTIALS.txt"
    else
        app_dir="$NATIVE_APP_DIR"
        port="${CUSTOM_PORT:-$DEFAULT_PORT}"
        manual_reset_hint="cd $(printf %q "${NATIVE_APP_DIR}/app/backend") && sudo -H -u $(printf %q "$NATIVE_APP_USER") node scripts/reset-admin-password.js --force --credentials-file data/ADMIN_CREDENTIALS.txt"
    fi
    
    print_header "🎉 Installation Complete!"
    
    echo -e "${GREEN}PicPeak has been successfully installed!${NC}\n"
    
    echo "📍 Access Information:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    if [[ -n "$DOMAIN_NAME" ]] && [[ "$ENABLE_SSL" == "true" ]]; then
        echo -e "Admin Panel: ${CYAN}https://$DOMAIN_NAME/admin${NC}"
        echo -e "Gallery URL: ${CYAN}https://$DOMAIN_NAME${NC}"
    else
        echo -e "Admin Panel: ${CYAN}http://$(hostname -I | awk '{print $1}'):$port/admin${NC}"
        echo -e "Gallery URL: ${CYAN}http://$(hostname -I | awk '{print $1}'):$port${NC}"
    fi
    
    echo
    echo "🔐 Admin Credentials:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    # Read from ADMIN_CREDENTIALS.txt when available
    local cred_file email_line pass_line admin_email_val admin_pass_val
    if [[ "$INSTALL_METHOD" == "docker" ]]; then
        cred_file="$app_dir/data/ADMIN_CREDENTIALS.txt"
    else
        cred_file="$NATIVE_APP_DIR/app/backend/data/ADMIN_CREDENTIALS.txt"
    fi
    if [[ -f "$cred_file" ]]; then
        email_line=$(grep -m1 '^Email:' "$cred_file" || true)
        pass_line=$(grep -m1 '^Password:' "$cred_file" || true)
        admin_email_val=${email_line#Email: }
        admin_pass_val=${pass_line#Password: }
        if [[ -n "$admin_email_val" ]]; then
          echo -e "Email:    ${CYAN}$admin_email_val${NC}"
        else
          echo -e "Email:    ${CYAN}$ADMIN_EMAIL${NC}"
        fi
        if [[ -n "$admin_pass_val" ]]; then
          echo -e "Password: ${CYAN}$admin_pass_val${NC}"
        else
          echo -e "Password: ${YELLOW}(see $cred_file)${NC}"
        fi
      else
        echo -e "Email:    ${CYAN}$ADMIN_EMAIL${NC}"
        echo -e "Password: ${YELLOW}(credentials file not found - rerun setup with --force-admin-password-reset or run '${manual_reset_hint}')${NC}"
      fi
    echo
    echo -e "${YELLOW}⚠️  IMPORTANT: Change the admin password on first login!${NC}"
    
    echo
    echo "📁 Installation Details:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Installation directory: $app_dir"
    echo "Installation method: ${INSTALL_METHOD^}"
    echo "Log file: $LOG_FILE"
    
    if [[ "$INSTALL_METHOD" == "docker" ]]; then
        echo
        echo "🐳 Docker Commands:"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "View logs:    cd $app_dir && docker compose logs -f"
        echo "Stop:         cd $app_dir && docker compose down"
        echo "Start:        cd $app_dir && docker compose up -d"
        echo "Update:       cd $app_dir && git pull && docker compose up -d --build"
    else
        echo
        echo "🔧 Service Commands:"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "View logs:    sudo journalctl -u picpeak-backend -f"
        echo "Stop:         sudo systemctl stop picpeak-backend"
        echo "Start:        sudo systemctl start picpeak-backend"
        echo "Status:       sudo systemctl status picpeak-backend"
    fi
    
    echo
    echo "📚 Documentation:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Setup Guide:  https://github.com/the-luap/picpeak/blob/main/SIMPLE_SETUP.md"
    echo "Full Docs:    https://github.com/the-luap/picpeak"
    echo
    echo -e "${GREEN}✨ Setup complete! Visit the admin panel to start creating galleries.${NC}"
}

################################################################################
# Update Functions
################################################################################

update_installation() {
    print_header "Updating PicPeak"

    # Prefer explicit native install detection first
    native_detected=false
    docker_detected=false

    # Native detection: app/backend exists OR systemd unit present
    if [[ -d "$NATIVE_APP_DIR/app/backend" ]]; then
        native_detected=true
    elif command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q '^picpeak-backend.service'; then
        native_detected=true
    fi

    # Docker detection: docker app dir or user home picpeak dir exists
    if [[ -d "$DOCKER_APP_DIR" ]] || [[ -n "${SUDO_USER:-}" && -d "/home/${SUDO_USER}/picpeak" ]]; then
        docker_detected=true
    fi

    if [[ "$native_detected" == true ]]; then
        INSTALL_METHOD="native"
        update_native_installation
    elif [[ "$docker_detected" == true ]]; then
        INSTALL_METHOD="docker"
        update_docker_installation
    else
        die "No existing PicPeak installation found (native dir $NATIVE_APP_DIR/app/backend or docker dir $DOCKER_APP_DIR not present)"
    fi
}

update_docker_installation() {
    local app_dir="$DOCKER_APP_DIR"
    [[ -n "${SUDO_USER:-}" ]] && app_dir="/home/$SUDO_USER/picpeak"
    
    log_step "Updating Docker installation..."
    
    cd "$app_dir"
    
    # Backup current configuration
    cp .env .env.backup-$(date +%Y%m%d-%H%M%S)
    
    # Pull latest code
    git pull

    # Rebuild and restart containers
    docker compose down
    docker compose build --no-cache

    # Clean up the legacy picpeak-workers container if it exists
    # (workers are now in-process — see comment in
    # create_docker_compose_file). Best-effort: ignore if absent.
    if docker ps -a --format '{{.Names}}' | grep -q '^picpeak-workers$'; then
      log_step "Removing legacy picpeak-workers container (workers now run in-process)..."
      docker stop picpeak-workers >/dev/null 2>&1 || true
      docker rm picpeak-workers >/dev/null 2>&1 || true
    fi

    docker compose up -d

    # Migrations are run automatically by backend/wait-for-db.sh on
    # container startup. Wait for the backend to become healthy
    # rather than racing it with a manual `npm run migrate`.
    log_step "Waiting for backend to finish migrations and become healthy..."
    for _ in $(seq 1 30); do
      if docker inspect -f '{{.State.Health.Status}}' picpeak-backend 2>/dev/null | grep -q '^healthy$'; then
        log_success "Backend healthy."
        break
      fi
      sleep 2
    done

    log_success "Docker installation updated successfully!"
}

update_native_installation() {
    log_step "Updating native installation..."
    
    # Stop services
    systemctl stop picpeak-backend || true
    if systemctl list-unit-files | grep -q '^picpeak-workers.service'; then
      systemctl stop picpeak-workers || true
    fi
    
    # Backup current configuration
    if [[ -f "$NATIVE_APP_DIR/app/backend/.env" ]]; then
      cp "$NATIVE_APP_DIR/app/backend/.env" "$NATIVE_APP_DIR/app/backend/.env.backup-$(date +%Y%m%d-%H%M%S)"
    fi
    
    # Pull latest code
    cd "$NATIVE_APP_DIR/app"
    run_as_user "git config --global --add safe.directory $NATIVE_APP_DIR/app" || true
    run_as_user "git remote set-url origin $REPO_URL" || true
    run_as_user "git fetch --all --prune"
    if ! run_as_user "git checkout -B main origin/main"; then
      run_as_user "git checkout main" || true
      run_as_user "git reset --hard origin/main"
    fi
    
    # Update backend dependencies
    cd "$NATIVE_APP_DIR/app/backend"
    run_as_user "npm install --production"
    
    # Run migrations
    run_as_user "npm run migrate"

    # Rebuild frontend (ensure admin UI for native installs)
    if [[ -d "$NATIVE_APP_DIR/app/frontend" ]]; then
      log_step "Rebuilding frontend..."
      cd "$NATIVE_APP_DIR/app/frontend"
      run_as_user "npm ci --include=dev" || run_as_user "npm install"
      run_as_user "npm run build"
    fi

    # Ensure env has frontend serving flags
    if ! grep -q '^SERVE_FRONTEND=' "$NATIVE_APP_DIR/app/backend/.env"; then
      echo "SERVE_FRONTEND=true" >> "$NATIVE_APP_DIR/app/backend/.env"
    fi
    if ! grep -q '^FRONTEND_DIR=' "$NATIVE_APP_DIR/app/backend/.env"; then
      echo "FRONTEND_DIR=$NATIVE_APP_DIR/app/frontend/dist" >> "$NATIVE_APP_DIR/app/backend/.env"
    fi

    ensure_storage_layout "$NATIVE_APP_DIR"
    chown -R $NATIVE_APP_USER:$NATIVE_APP_USER "$NATIVE_APP_DIR/storage"

    if [[ -f "$NATIVE_APP_DIR/app/backend/.env" ]]; then
      if grep -q '^STORAGE_PATH=' "$NATIVE_APP_DIR/app/backend/.env"; then
        sed -i "s|^STORAGE_PATH=.*|STORAGE_PATH=$NATIVE_APP_DIR/storage|" "$NATIVE_APP_DIR/app/backend/.env"
      else
        echo "STORAGE_PATH=$NATIVE_APP_DIR/storage" >> "$NATIVE_APP_DIR/app/backend/.env"
      fi
    fi
    
    # Restart services
    systemctl restart picpeak-backend
    
    log_success "Native installation updated successfully!"
}

################################################################################
# Uninstall Functions
################################################################################

uninstall_picpeak() {
    print_header "Uninstall PicPeak"
    
    log_warn "This will remove PicPeak from your system."
    
    if ! confirm "Are you sure you want to uninstall PicPeak?" "n"; then
        log_info "Uninstall cancelled"
        exit 0
    fi
    
    # Detect existing installation
    if [[ -d "$DOCKER_APP_DIR" ]] || [[ -d "/home/${SUDO_USER:-}/picpeak" ]]; then
        uninstall_docker
    elif [[ -d "$NATIVE_APP_DIR" ]]; then
        uninstall_native
    else
        die "No PicPeak installation found"
    fi
    
    log_success "PicPeak has been uninstalled"
}

uninstall_docker() {
    local app_dir="$DOCKER_APP_DIR"
    [[ -n "${SUDO_USER:-}" ]] && app_dir="/home/$SUDO_USER/picpeak"
    
    log_step "Removing Docker installation..."
    
    cd "$app_dir"
    docker compose down -v
    
    if confirm "Remove all data and photos?" "n"; then
        rm -rf "$app_dir"
    else
        log_info "Keeping data in $app_dir"
    fi
}

uninstall_native() {
    log_step "Removing native installation..."
    
    # Stop and disable services
    systemctl stop picpeak-backend picpeak-workers
    systemctl disable picpeak-backend picpeak-workers
    rm -f /etc/systemd/system/picpeak-*.service
    systemctl daemon-reload
    
    # Remove Caddy configuration if exists
    [[ -f /etc/caddy/Caddyfile ]] && rm -f /etc/caddy/Caddyfile
    
    if confirm "Remove all data and photos?" "n"; then
        rm -rf "$NATIVE_APP_DIR"
        userdel -r $NATIVE_APP_USER 2>/dev/null || true
    else
        log_info "Keeping data in $NATIVE_APP_DIR"
    fi
}

################################################################################
# Main Script Flow
################################################################################

parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --docker)
                INSTALL_METHOD="docker"
                shift
                ;;
            --native)
                INSTALL_METHOD="native"
                shift
                ;;
            --unattended)
                UNATTENDED=true
                shift
                ;;
            --domain)
                DOMAIN_NAME="$2"
                shift 2
                ;;
            --email)
                ADMIN_EMAIL="$2"
                shift 2
                ;;
            --smtp-host)
                SMTP_HOST="$2"
                shift 2
                ;;
            --smtp-port)
                SMTP_PORT="$2"
                shift 2
                ;;
            --smtp-user)
                SMTP_USER="$2"
                shift 2
                ;;
            --smtp-pass)
                SMTP_PASS="$2"
                shift 2
                ;;
            --force-admin-password-reset)
                FORCE_ADMIN_PASSWORD_RESET=true
                shift
                ;;
            --enable-ssl)
                ENABLE_SSL=true
                shift
                ;;
            --port)
                CUSTOM_PORT="$2"
                shift 2
                ;;
            --update)
                UPDATE_MODE=true
                shift
                ;;
            --uninstall)
                UNINSTALL_MODE=true
                shift
                ;;
            --help)
                show_help
                exit 0
                ;;
            *)
                die "Unknown option: $1"
                ;;
        esac
    done
}

show_help() {
    cat <<EOF
PicPeak Unified Setup Script v$SCRIPT_VERSION

Usage: $0 [OPTIONS]

Installation Methods:
  --docker            Use Docker installation (default if unattended)
  --native            Use native installation (systemd)

Options:
  --unattended        Run without prompts
  --domain DOMAIN     Set domain name for HTTPS
  --email EMAIL       Admin email address
  --smtp-host HOST    SMTP server hostname
  --smtp-port PORT    SMTP server port
  --smtp-user USER    SMTP username
  --smtp-pass PASS    SMTP password
  --force-admin-password-reset  Regenerate admin credentials after setup
  --enable-ssl        Enable HTTPS with Let's Encrypt
  --port PORT         Custom port (native only)
  --update            Update existing installation
  --uninstall         Remove PicPeak installation
  --help              Show this help message

Examples:
  # Interactive installation
  sudo $0

  # Docker installation with domain
  sudo $0 --docker --domain photos.example.com --enable-ssl

  # Native installation for Raspberry Pi
  sudo $0 --native --port 8080

  # Fully automated Docker setup
  sudo $0 --docker --unattended --domain photos.example.com \\
    --email admin@example.com \\
    --smtp-host smtp.gmail.com --smtp-port 587 \\
    --smtp-user user@gmail.com --smtp-pass app-password \\
    --enable-ssl

EOF
}

main() {
    # Check if running as root
    if [[ $EUID -ne 0 ]]; then
        die "This script must be run as root (use sudo)"
    fi
    
    # Parse command line arguments
    parse_arguments "$@"
    
    # Handle special modes
    if [[ "$UPDATE_MODE" == "true" ]]; then
        update_installation
        exit 0
    fi
    
    if [[ "$UNINSTALL_MODE" == "true" ]]; then
        uninstall_picpeak
        exit 0
    fi
    
    # Start installation
    print_banner
    
    # Detect OS
    detect_os
    
    # Select installation method
    select_install_method
    
    # Check system requirements
    check_system_requirements
    
    # Prompt for admin email (design choice: always ask unless provided)
    prompt_admin_email
    
    # Configure email (optional)
    configure_email
    
    # Perform installation
    if [[ "$INSTALL_METHOD" == "docker" ]]; then
        setup_docker_installation
    else
        setup_native_installation
    fi
    
    # Show success message
    print_success_message
}

# Run main function
main "$@"

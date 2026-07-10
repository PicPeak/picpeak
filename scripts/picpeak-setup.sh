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
readonly REPO_URL="https://github.com/PicPeak/picpeak.git"
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
ADMIN_EMAIL=""              # empty until set by the wizard, --email, or the unattended default
ADMIN_PASSWORD=""          # optional. When set, the admin is seeded directly (headless).
                           # Empty = browser-first: the app prints a one-time /setup token.
DOMAIN_NAME=""
INSTALL_DIR=""             # override for the install directory (else per-method default)
PICPEAK_CHANNEL="stable"   # GHCR image tag for the production compose (stable|beta)
HTTPS_MODE=""              # caddy | proxy | none — how TLS is terminated
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

# Resolve the Docker install directory (honours --install-dir and sudo).
docker_default_dir() {
    if [[ -n "$INSTALL_DIR" ]]; then echo "$INSTALL_DIR"; return; fi
    if [[ -n "${SUDO_USER:-}" ]]; then echo "/home/$SUDO_USER/picpeak"; else echo "$DOCKER_APP_DIR"; fi
}

# Best-effort primary IPv4 for building an access URL when there is no domain.
primary_ip() {
    hostname -I 2>/dev/null | awk '{print $1}' | grep -E '^[0-9]' || echo "YOUR_HOST_IP"
}

# The user-facing port (frontend for Docker, backend for native).
access_port() {
    if [[ "$INSTALL_METHOD" == "docker" ]]; then
        echo "${CUSTOM_PORT:-3000}"
    else
        echo "${CUSTOM_PORT:-$DEFAULT_PORT}"
    fi
}

# The scheme+host users open in a browser. HTTPS when a domain is fronted by
# Caddy or the operator's own reverse proxy; plain HTTP otherwise.
base_url() {
    if [[ -n "$DOMAIN_NAME" ]]; then
        if [[ "$HTTPS_MODE" == "none" ]]; then echo "http://$DOMAIN_NAME"; else echo "https://$DOMAIN_NAME"; fi
    else
        echo "http://$(primary_ip):$(access_port)"
    fi
}

# --- Interactive wizard -------------------------------------------------------

# Ask how TLS is terminated for the given domain. Caddy auto-HTTPS is only
# offered for native installs (the Docker path has no built-in cert automation
# yet — operators front it with their own proxy).
choose_https_mode() {
    echo
    echo "How should HTTPS be handled for ${DOMAIN_NAME}?"
    if [[ "$INSTALL_METHOD" == "native" ]]; then
        echo "  1) Automatic HTTPS via Caddy (installs Caddy + Let's Encrypt)   [recommended]"
        echo "  2) I run my own reverse proxy (Traefik / nginx / Cloudflare)"
        echo "  3) Plain HTTP (no TLS)"
        local c; read -p "Choice [1]: " c; c="${c:-1}"
        case "$c" in
            1) HTTPS_MODE="caddy"; ENABLE_SSL=true;;
            2) HTTPS_MODE="proxy";;
            *) HTTPS_MODE="none";;
        esac
    else
        echo "  1) I run my own reverse proxy (Traefik / nginx / Cloudflare)     [recommended]"
        echo "  2) Plain HTTP (no TLS)"
        echo "     (Built-in Docker HTTPS via a Caddy sidecar is planned separately.)"
        local c; read -p "Choice [1]: " c; c="${c:-1}"
        case "$c" in
            1) HTTPS_MODE="proxy";;
            *) HTTPS_MODE="none";;
        esac
    fi
}

# Final summary + go/no-go before anything is installed.
review_and_confirm() {
    print_header "Review"
    echo "  Install method : ${INSTALL_METHOD}"
    echo "  Directory      : $([[ "$INSTALL_METHOD" == "docker" ]] && docker_default_dir || echo "$NATIVE_APP_DIR")"
    [[ "$INSTALL_METHOD" == "docker" ]] && echo "  Release channel: ${PICPEAK_CHANNEL}"
    echo "  Domain         : ${DOMAIN_NAME:-（none — local IP over HTTP）}"
    echo "  HTTPS          : ${HTTPS_MODE}"
    echo "  Admin email    : ${ADMIN_EMAIL}"
    echo "  Admin account  : $([[ -n "$ADMIN_PASSWORD" ]] && echo "seeded from --admin-password" || echo "created in browser (one-time /setup token)")"
    echo "  Email/SMTP     : ${SMTP_HOST:-not configured}"
    echo "  Access URL     : $(base_url)"
    echo
    if ! confirm "Proceed with installation?" "y"; then
        die "Installation cancelled by user."
    fi
}

# Full step-by-step wizard. Only runs in interactive mode; each value already
# supplied on the command line is respected and its question skipped.
run_wizard() {
    print_header "PicPeak Setup Wizard"
    echo "Answer a few questions and PicPeak configures itself."
    echo "Press Enter to accept the [default] in brackets."

    # 1) Install method (docker/native) — select_install_method handles the prompt
    select_install_method

    # 2) Install directory (Docker only; native is fixed at $NATIVE_APP_DIR)
    if [[ "$INSTALL_METHOD" == "docker" && -z "$INSTALL_DIR" ]]; then
        local default_dir; default_dir="$(docker_default_dir)"
        echo
        read -p "Install directory [$default_dir]: " INSTALL_DIR
        INSTALL_DIR="${INSTALL_DIR:-$default_dir}"
    fi

    # 3) Release channel (Docker uses prebuilt images)
    if [[ "$INSTALL_METHOD" == "docker" ]]; then
        echo
        echo "Release channel: 'stable' (recommended) or 'beta' (newest features)."
        local ch; read -p "Channel [${PICPEAK_CHANNEL}]: " ch
        PICPEAK_CHANNEL="${ch:-$PICPEAK_CHANNEL}"
    fi

    # 4) Domain
    if [[ -z "$DOMAIN_NAME" ]]; then
        echo
        echo "Do you have a domain pointed at this server?"
        echo "Leave blank to run on the local IP over HTTP (you can add a domain later)."
        read -p "Domain (e.g. photos.example.com) [none]: " DOMAIN_NAME
    fi

    # 5) HTTPS mode
    if [[ -n "$DOMAIN_NAME" ]]; then
        choose_https_mode
    else
        HTTPS_MODE="none"
    fi

    # 6) Admin email (account itself is created in the browser)
    if [[ -z "$ADMIN_EMAIL" ]]; then
        echo
        echo "Your admin account is created in the browser on first visit (no password in a file)."
        read -p "Admin email [admin@example.com]: " ADMIN_EMAIL
        ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
    fi

    # 7) Optional email/SMTP
    configure_email

    # 8) Review + confirm
    review_and_confirm
}

# Non-interactive path: fill defaults and reject impossible combinations so an
# --unattended run fails fast instead of silently doing the wrong thing.
validate_unattended() {
    [[ -z "$INSTALL_METHOD" ]] && INSTALL_METHOD="docker"
    [[ -z "$ADMIN_EMAIL" ]] && ADMIN_EMAIL="admin@example.com"

    if [[ "$ENABLE_SSL" == "true" && -z "$DOMAIN_NAME" ]]; then
        die "--enable-ssl requires --domain in unattended mode."
    fi
    # Resolve HTTPS mode for unattended runs.
    if [[ -n "$DOMAIN_NAME" ]]; then
        if [[ "$ENABLE_SSL" == "true" && "$INSTALL_METHOD" == "native" ]]; then
            HTTPS_MODE="caddy"
        else
            # Docker + domain, or native without --enable-ssl: assume a fronting proxy.
            HTTPS_MODE="proxy"
        fi
    else
        HTTPS_MODE="none"
    fi
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

    # Ensure storage layout exists after cloning (production compose mounts
    # ./storage, ./data, ./logs — no separate top-level events dir).
    mkdir -p "$app_dir"/{storage/events/{active,archived},storage/thumbnails,logs,backup,data}
    
    # Determine host user for container mapping (PUID/PGID)
    local host_uid host_gid
    if [[ -n "${SUDO_USER:-}" ]]; then
        host_uid=$(id -u "$SUDO_USER" 2>/dev/null || echo 1000)
        host_gid=$(id -g "$SUDO_USER" 2>/dev/null || echo 1000)
    else
        host_uid=$(id -u 2>/dev/null || echo 1000)
        host_gid=$(id -g 2>/dev/null || echo 1000)
    fi

    # Generate machine secrets. Written to .env so they are stable across
    # restarts; once PR #714's secrets-init service is present it reuses these
    # exact values (explicit env always wins), so this stays correct either way.
    local jwt_secret=$(generate_jwt_secret)
    local db_password=$(generate_password)
    local redis_password=$(generate_password)

    local frontend_port="${CUSTOM_PORT:-3000}"
    local site_url; site_url="$(base_url)"

    # Create .env for docker-compose.production.yml (prebuilt GHCR images).
    log_step "Creating configuration..."
    cat > "$app_dir/.env" <<EOF
# PicPeak Configuration — generated by picpeak-setup.sh on $(date)
# Runs docker-compose.production.yml (prebuilt images from GHCR).

# Make every 'docker compose' command in this directory use the production file.
COMPOSE_FILE=docker-compose.production.yml

# Release channel: stable | beta
PICPEAK_CHANNEL=$PICPEAK_CHANNEL
NODE_ENV=production

# Machine secrets (generated; reused by the compose secrets-init service).
JWT_SECRET=$jwt_secret
DB_PASSWORD=$db_password
REDIS_PASSWORD=$redis_password

# Database
DB_HOST=postgres
DB_USER=picpeak
DB_NAME=picpeak

# Host-published ports (frontend is the user-facing one)
FRONTEND_PORT=$frontend_port
BACKEND_PORT=3001

# Host bind-mount paths (required by the production compose)
APP_STORAGE=./storage
APP_DATA=./data
LOGS=./logs

# Admin — the account is created in the browser via a one-time /setup token.
ADMIN_EMAIL=$ADMIN_EMAIL
$(if [[ -n "$ADMIN_PASSWORD" ]]; then printf 'ADMIN_PASSWORD=%s\n' "$ADMIN_PASSWORD"; fi)
# Public URLs
FRONTEND_URL=$site_url
ADMIN_URL=$site_url

# Auth cookie behavior — 'auto' emits Secure on HTTPS, omits it on HTTP so a
# first HTTP install (before a reverse proxy) does not silently fail login (#427).
COOKIE_SECURE=auto

# Email (optional; can also be configured later in the admin panel)
SMTP_HOST=$SMTP_HOST
SMTP_PORT=$SMTP_PORT
SMTP_USER=$SMTP_USER
SMTP_PASS=$SMTP_PASS
EMAIL_FROM=${SMTP_USER:-noreply@localhost}
EOF

    # Ensure bind mounts are writable by the invoking user (the container
    # self-heals ownership on boot via wait-for-db.sh, this just lets the
    # operator manage the files afterwards).
    chown -R "$host_uid":"$host_gid" "$app_dir"/storage "$app_dir"/logs "$app_dir"/backup "$app_dir"/data 2>/dev/null || true

    # HTTPS for Docker has no built-in cert automation. When a domain is set we
    # assume the operator terminates TLS with their own reverse proxy.
    if [[ -n "$DOMAIN_NAME" && "$HTTPS_MODE" == "proxy" ]]; then
        log_info "Point your reverse proxy at http://127.0.0.1:${frontend_port} and terminate TLS for ${DOMAIN_NAME} there."
    fi

    # Clean up the legacy picpeak-workers container from prior installs
    # (workers are now in-process).
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

    # Admin access. Two paths:
    #   - Seeded (ADMIN_PASSWORD set, or --force-admin-password-reset): the
    #     migration/reset script writes ADMIN_CREDENTIALS.txt — copy it to the host.
    #   - Browser-first (default): the backend writes a one-time /setup token to
    #     data/SETUP_TOKEN (already on the host via the ./data mount). The final
    #     instructions are printed by print_success_message.
    if [[ "$FORCE_ADMIN_PASSWORD_RESET" == "true" ]]; then
        log_step "Resetting admin credentials..."
        docker compose exec -T backend node scripts/reset-admin-password.js --force --credentials-file data/ADMIN_CREDENTIALS.txt \
            || log_warn "Automatic admin password reset failed; run reset-admin-password.js inside the backend container."
    fi
    if [[ -n "$ADMIN_PASSWORD" || "$FORCE_ADMIN_PASSWORD_RESET" == "true" ]]; then
        if docker compose cp backend:/app/data/ADMIN_CREDENTIALS.txt "$app_dir/data/ADMIN_CREDENTIALS.txt" 2>/dev/null; then
            chown "$host_uid":"$host_gid" "$app_dir/data/ADMIN_CREDENTIALS.txt" 2>/dev/null || true
            chmod 600 "$app_dir/data/ADMIN_CREDENTIALS.txt" 2>/dev/null || true
        fi
    fi

    log_success "Docker installation completed!"
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

# Admin — created in the browser via a one-time /setup token unless a password
# is seeded here (--admin-password).
ADMIN_USERNAME=admin
ADMIN_EMAIL=$ADMIN_EMAIL
$(if [[ -n "$ADMIN_PASSWORD" ]]; then printf 'ADMIN_PASSWORD=%s\n' "$ADMIN_PASSWORD"; fi)

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

    # Seeded-admin path only: reset/secure the credentials file. When no
    # password was seeded, the admin is created in the browser via the /setup
    # token (surfaced by print_success_message). The migration only writes
    # ADMIN_CREDENTIALS.txt when ADMIN_PASSWORD is set.
    if [[ "$FORCE_ADMIN_PASSWORD_RESET" == "true" ]]; then
        log_step "Resetting admin credentials..."
        if ! run_as_user "node scripts/reset-admin-password.js --force --credentials-file data/ADMIN_CREDENTIALS.txt"; then
            log_warn "Automatic admin password reset failed; please run reset-admin-password.js manually."
        fi
    fi
    local creds_path="$NATIVE_APP_DIR/app/backend/data/ADMIN_CREDENTIALS.txt"
    [[ -f "$creds_path" ]] && chmod 600 "$creds_path" 2>/dev/null || true

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
    local app_dir site_url token_file
    site_url="$(base_url)"

    if [[ "$INSTALL_METHOD" == "docker" ]]; then
        app_dir="$(docker_default_dir)"
        token_file="$app_dir/data/SETUP_TOKEN"
    else
        app_dir="$NATIVE_APP_DIR"
        token_file="$NATIVE_APP_DIR/app/backend/data/SETUP_TOKEN"
    fi

    print_header "🎉 Installation Complete!"

    echo -e "${GREEN}PicPeak has been successfully installed!${NC}\n"

    echo "📍 Access Information:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "Admin Panel: ${CYAN}${site_url}/admin${NC}"
    echo -e "Gallery URL: ${CYAN}${site_url}${NC}"

    echo
    echo "🔐 First Login:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    local cred_file="$app_dir/data/ADMIN_CREDENTIALS.txt"
    [[ "$INSTALL_METHOD" == "native" ]] && cred_file="$NATIVE_APP_DIR/app/backend/data/ADMIN_CREDENTIALS.txt"

    if [[ -n "$ADMIN_PASSWORD" || "$FORCE_ADMIN_PASSWORD_RESET" == "true" ]] && [[ -f "$cred_file" ]]; then
        # Seeded-admin path: the credentials file holds email + password.
        local email_line pass_line
        email_line=$(grep -m1 '^Email:' "$cred_file" || true)
        pass_line=$(grep -m1 '^Password:' "$cred_file" || true)
        echo -e "Email:    ${CYAN}${email_line#Email: }${NC}"
        echo -e "Password: ${CYAN}${pass_line#Password: }${NC}"
        echo -e "Saved to: ${cred_file} ${YELLOW}(delete after recording)${NC}"
        echo -e "${YELLOW}⚠️  Change this password on first login.${NC}"
    else
        # Browser-first path: create the admin in the browser via a one-time token.
        local token=""
        # The token file appears once the backend has booted; wait briefly.
        for _ in $(seq 1 10); do [[ -s "$token_file" ]] && break; sleep 1; done
        [[ -s "$token_file" ]] && token=$(tr -d '\r\n' < "$token_file" 2>/dev/null || true)
        echo "Create your admin account in the browser:"
        echo -e "  1. Open ${CYAN}${site_url}/admin${NC}"
        echo "  2. Enter your email and a password."
        if [[ -n "$token" ]]; then
            echo "  3. When prompted, paste this one-time setup token:"
            echo -e "     ${CYAN}${token}${NC}"
        elif [[ "$INSTALL_METHOD" == "docker" ]]; then
            echo "  3. Get the one-time setup token from the logs:"
            echo -e "     ${CYAN}cd $app_dir && docker compose logs backend | grep -i 'setup token'${NC}"
        else
            echo "  3. Get the one-time setup token from the logs:"
            echo -e "     ${CYAN}sudo journalctl -u picpeak-backend | grep -i 'setup token'${NC}"
        fi
        echo -e "  (Also saved to ${token_file}.)"
    fi

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
        echo "Update:       cd $app_dir && git pull && docker compose pull && docker compose up -d"
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
    echo "Setup Guide:  https://github.com/PicPeak/picpeak/blob/main/SIMPLE_SETUP.md"
    echo "Full Docs:    https://github.com/PicPeak/picpeak"
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
    
    # Pull latest code (new compose file / defaults) and refresh the images.
    git pull

    # Production compose uses prebuilt GHCR images, so pull rather than build.
    # COMPOSE_FILE in .env points every command at docker-compose.production.yml.
    docker compose down
    docker compose pull

    # Clean up the legacy picpeak-workers container if it exists
    # (workers are now in-process). Best-effort: ignore if absent.
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
            --admin-password)
                ADMIN_PASSWORD="$2"
                shift 2
                ;;
            --install-dir)
                INSTALL_DIR="$2"
                shift 2
                ;;
            --channel)
                PICPEAK_CHANNEL="$2"
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

Run with no options for the interactive step-by-step wizard, or pass
--unattended plus the options below to install without any prompts.

Options:
  --unattended        Run without prompts (uses defaults + the flags below)
  --domain DOMAIN     Domain name (enables HTTPS URLs)
  --email EMAIL       Admin email address (default: admin@example.com)
  --admin-password P  Seed the admin account with this password (headless).
                      Omit to create the admin in the browser via a one-time
                      /setup token (recommended).
  --install-dir DIR   Install directory (Docker; default: ~/picpeak)
  --channel CHANNEL   Image channel for Docker: stable (default) or beta
  --smtp-host HOST    SMTP server hostname
  --smtp-port PORT    SMTP server port
  --smtp-user USER    SMTP username
  --smtp-pass PASS    SMTP password
  --force-admin-password-reset  Regenerate admin credentials after setup
  --enable-ssl        Native only: provision HTTPS via Caddy (needs --domain)
  --port PORT         Custom user-facing port
  --update            Update existing installation
  --uninstall         Remove PicPeak installation
  --help              Show this help message

Examples:
  # Interactive wizard (asks every question, then confirms)
  sudo $0

  # Unattended Docker install, admin created in the browser afterwards
  sudo $0 --docker --unattended --email admin@example.com

  # Unattended Docker install behind your own reverse proxy, seeded admin
  sudo $0 --docker --unattended --domain photos.example.com \\
    --email admin@example.com --admin-password 'S0me-Str0ng-Pass'

  # Native install on a Raspberry Pi with automatic HTTPS via Caddy
  sudo $0 --native --domain photos.example.com --enable-ssl

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

    # Gather configuration: full wizard when interactive, flag-driven otherwise.
    if [[ "$UNATTENDED" == "true" ]]; then
        validate_unattended
    else
        run_wizard
    fi

    # Check system requirements (now that the install method is known)
    check_system_requirements

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

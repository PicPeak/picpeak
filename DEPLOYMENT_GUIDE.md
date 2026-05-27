# 🚀 PicPeak Deployment Guide

This guide covers multiple deployment options for PicPeak, from simple local setups to production-ready configurations.

## 📋 Table of Contents

- [Quick Start](#-quick-start)
- [Prerequisites](#prerequisites)
- [Configuration](#-configuration)
- [Deployment](#-deployment)
- [First Login](#-first-login)
- [Release Channels](#-release-channels)
- [Reverse Proxy Setup](#-reverse-proxy-setup)
- [External Media Library](#-external-media-library)
- [Maintenance](#-maintenance)
- [Troubleshooting](#-troubleshooting)

## 🚀 Quick Start

### Option 1: Automated Setup Script (Easiest)

For the simplest installation, use our unified setup script:

```bash
curl -fsSL https://raw.githubusercontent.com/the-luap/picpeak/main/scripts/picpeak-setup.sh -o picpeak-setup.sh && \
chmod +x picpeak-setup.sh && \
sudo ./picpeak-setup.sh
```

This script handles Docker/Native installation choice, OS detection, dependencies, database setup, and optional SSL.

👉 **See [SIMPLE_SETUP.md](./SIMPLE_SETUP.md) for detailed instructions.**

### Option 2: Docker with Pre-built Images (Recommended)

```bash
# Clone repository for configuration files
git clone https://github.com/the-luap/picpeak.git
cd picpeak

# Copy and configure environment
cp .env.example .env
nano .env  # Edit with your values

# Create required directories
mkdir -p events/active events/archived data logs backup storage
chmod -R 755 events data logs backup storage

# Deploy using pre-built images
docker compose -f docker-compose.production.yml up -d

# Check logs
docker compose -f docker-compose.production.yml logs -f
```

**Available image tags:**
| Channel | Tags | Description |
|---------|------|-------------|
| Stable | `stable`, `latest`, `v2.3.0` | Production-ready releases |
| Beta | `beta`, `v2.3.0-beta.1` | Early access to new features |
| Branch | `main`, `beta` | Latest from each branch |

To select a channel, set `PICPEAK_CHANNEL` in your `.env` file (see [Release Channels](#release-channels) section)

### Option 3: Build from Source

```bash
git clone https://github.com/the-luap/picpeak.git
cd picpeak
cp .env.example .env
nano .env  # Edit with your values

mkdir -p events/active events/archived data logs backup storage
chmod -R 755 events data logs backup storage

docker compose build
docker compose up -d
```

## Prerequisites

- Docker and Docker Compose installed
- Domain name (for production)
- SMTP server credentials for emails
- At least 2GB RAM and 20GB storage

## 🔧 Configuration

### Essential Environment Variables

Generate secure values:
```bash
# JWT Secret
openssl rand -base64 64

# Database Password (avoid $ character - see warning below)
openssl rand -base64 32 | tr -d '$'

# Redis Password (avoid $ character - see warning below)
openssl rand -base64 32 | tr -d '$'
```

⚠️ **PASSWORD WARNING**: Docker Compose interprets `$` as variable substitution. Either:
- Avoid `$` in passwords (recommended - use the commands above)
- Escape `$` as `$$` (e.g., `Pass$$word` instead of `Pass$word`)
- Quote the entire value: `DB_PASSWORD='Pass$word'` (less reliable)

### Public Landing Page

- `npm run migrate` now seeds three general settings: `general_public_site_enabled`, `general_public_site_html`, and `general_public_site_custom_css` so existing installs stay disabled by default.
- Configure the feature from **Admin → CMS Pages**. The landing page panel exposes the toggle, HTML editor, optional CSS overrides, preview, and a reset-to-default action.
- All HTML and CSS submitted through the UI is sanitized server-side. Scripts, inline event handlers, disallowed attributes, `@import` rules, and `javascript:` URLs are stripped before content is cached or rendered.
- Resetting via the UI (or calling `POST /api/admin/settings/public-site/reset`) restores the bundled template and clears custom CSS.
- The landing page response is cached in-memory. Override the default 60s cache window by setting `PUBLIC_SITE_CACHE_TTL_MS` (milliseconds) in your environment if you need faster cache busting.
- When the toggle is off PicPeak continues to serve the SPA/login redirect at `/`, preserving legacy behaviour until you explicitly enable the feature.

### Backend Configuration (.env)
Update `.env` with:
- `JWT_SECRET` - Authentication secret (REQUIRED - generate a secure random value)
- `DB_PASSWORD` - PostgreSQL password
- `REDIS_PASSWORD` - Redis password
- `SMTP_*` - Email configuration
- **URL Configuration** (for backend CORS):
  - `FRONTEND_URL` - Frontend origin (use full URL with scheme, no trailing slash)
    - Example (Docker): `http://localhost:3000`
- `ADMIN_URL` - Admin origin (same as `FRONTEND_URL` for Docker; full URL, no trailing slash)
  - Example (Docker): `http://localhost:3000`
  
  Notes:
  - Do not include trailing `/` (e.g., use `http://host:3000`, not `http://host:3000/`).
  - Always include the scheme (`http://` or `https://`).
  - The backend compares origins strictly for CORS; malformed values will cause login requests to fail with 500.

#### Authentication Security
- Configure login attempt thresholds from **Admin → Settings → Security**. Defaults are 5 failed attempts per IP within 15 minutes, resulting in a 30 minute lockout.

#### External Database Example
To use an external PostgreSQL instead of the bundled container, set the following in `.env` and ensure the `postgres` service is disabled or removed:

```env
DB_HOST=db.example.com
DB_PORT=5432
DB_USER=picpeak
DB_PASSWORD=change_me
DB_NAME=picpeak_prod
```

Compose uses these values via `env_file: .env`. The backend service also defaults `DB_HOST=${DB_HOST:-postgres}` so if you don’t set `DB_HOST` it will use the bundled `postgres` container.

### Frontend Configuration (frontend/.env)
Create `frontend/.env` from `frontend/.env.example`:
```bash
cp frontend/.env.example frontend/.env
```

Update `frontend/.env` with:
- `VITE_API_URL` - Backend API URL
  - Docker (pre-built images) and production behind reverse proxy: `/api` (recommended; avoids CORS and matches the frontend Nginx proxy in the image)
  - Local dev (Vite): `http://localhost:3001` or `/api` if proxying through a dev proxy

Note: When using pre-built frontend images, runtime container env does not change the already-built JS. Prefer the default `/api` and let the frontend Nginx proxy forward to the backend.

⚠️ **IMPORTANT PORT CONFIGURATION**: 
- The frontend runs on port **3000** in Docker (exposed via nginx)
- The backend API runs on port **3001**
- The frontend `.env` file MUST point to the correct backend port (3001)
- Default `.env.example` is configured for Docker deployment

### Email Configuration Examples

#### Gmail
```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-specific-password
```

#### SendGrid
```env
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=apikey
SMTP_PASS=your-sendgrid-api-key
```

## 📦 Deployment

### Using Pre-built Images (Fastest)

```bash
# Pull latest images from GitHub Container Registry
docker pull ghcr.io/the-luap/picpeak/backend:latest
docker pull ghcr.io/the-luap/picpeak/frontend:latest

# Start services using production compose file
docker compose -f docker-compose.production.yml up -d

# View running containers
docker compose ps
```

### Building from Source (For Customization)

```bash
# Build images locally
docker compose build

# Or build with no cache for clean build
docker compose build --no-cache

# Start all services
docker compose up -d

# View running containers
docker compose ps
```

### Access Points

By default, services are exposed on:
- Frontend (UI + Admin): http://localhost:3000 (admin at `/admin`)
- Backend/API: http://localhost:3001 (API only; no UI routes)
- PostgreSQL: localhost:5432 (if needed)
- Redis: localhost:6379 (if needed)

### Initial Admin Setup

When deploying for the first time, an admin account is automatically created with a secure, randomly generated password. This password is displayed in the Docker logs during initialization and **must be changed** on first login.

#### Finding the Auto-Generated Admin Password

The admin password is automatically generated during the first startup and displayed in the backend container logs. Here's how to find it:

**Option 1: Search Docker logs for admin password** (recommended)
```bash
# Find the auto-generated admin password in logs
docker compose logs backend | grep "Admin password"
```

You should see output like:
```
✅ Admin password generated: BraveTiger6231!
```

**Option 2: View the complete initialization logs**
```bash
# View the complete admin setup logs
docker compose logs backend | grep -A 10 "Admin user created"
```

**Option 3: Check the saved credentials file**
```bash
# The password is also saved in the backend container
docker exec picpeak-backend cat data/ADMIN_CREDENTIALS.txt
```

**Option 4: Use the helper script**
```bash
# Show current admin username and email (password is hidden)
docker exec picpeak-backend node scripts/show-admin-credentials.js

# Reset the admin password to a new random password (displays new password in console)
docker exec picpeak-backend node scripts/show-admin-credentials.js --reset
```

> **Note:** When using `--reset`, the new password will be displayed in the console output. Save it immediately - it will not be shown again!

#### Important Security Notes

- **Login requires the email address**, not username
- When resetting password, the new password is displayed once in the console - save it immediately
- **Password change is MANDATORY** on first login - the system will force you to change it
- If you lose the password before first login, use the `--reset` option to generate a new one
- New password requirements: minimum 12 characters, mixed case, numbers, and special characters

## 🔐 First Login

After deployment, you must complete the first login process which includes mandatory password change for security.

### Step 1: Locate Your Admin Password

1. **Find the auto-generated password** from the credentials file:
   ```bash
   # Docker deployment
   docker compose exec backend cat /app/data/ADMIN_CREDENTIALS.txt
   
   # Or directly from the host (if you have access)
   cat data/ADMIN_CREDENTIALS.txt
   ```

2. **Note the admin email** (default: `admin@example.com` unless customized)

### Step 2: Access Admin Panel

1. Navigate to your frontend domain and open the admin section:
   - `http://your-domain.com/admin` (behind reverse proxy)
   - `http://localhost:3000/admin` (Docker local)
   
   The backend at `:3001` serves API only and does not serve the admin UI.
2. Login using:
   - **Email**: `admin@example.com` (or your custom admin email)
   - **Password**: The auto-generated password from the logs

### Step 3: Mandatory Password Change

Upon first login, the system will **automatically redirect** you to change your password:

1. **You cannot skip this step** - it's enforced for security
2. Enter the current auto-generated password
3. Create a new secure password meeting these requirements:
   - Minimum 12 characters
   - At least one uppercase letter
   - At least one lowercase letter
   - At least one number
   - At least one special character (!@#$%^&*)

### Security Best Practices for New Password

- **Use a unique password** not used elsewhere
- **Consider a password manager** for generation and storage
- **Include mixed characters**: `MySecureP@ssw0rd2024!`
- **Avoid personal information** (names, dates, etc.)
- **Save securely** - you cannot recover this password easily

### If You Lose Access

If you lose your admin credentials after the first login, you'll need to manually reset the password in the database or create a new admin user through the database.

**Note**: The credentials file (`ADMIN_CREDENTIALS.txt`) is only created during initial deployment and contains the first admin password. After changing the password, this file becomes outdated but is kept for reference. If you need to regenerate the password and file during a reinstall, re-run the installer with the `--force-admin-password-reset` flag:

```bash
# Native reinstall example
sudo ./picpeak-setup.sh --native --force-admin-password-reset

# Docker reinstall example
sudo ./picpeak-setup.sh --docker --force-admin-password-reset
```

The flag calls `scripts/reset-admin-password.js` in non-interactive mode, writes a fresh random password into `data/ADMIN_CREDENTIALS.txt`, and prints the new credentials at the end of the installer run.

#### Configuring Admin Email

By default, the admin email is `admin@example.com`. To use a different email address, set it in your `.env` file before first deployment:

```env
# .env
ADMIN_EMAIL=your-email@yourdomain.com
```

**Note**: This only works on first deployment. To change the admin email after deployment, you'll need to update it in the database or create a new admin user through the admin panel.

## 🔄 Release Channels

PicPeak offers two release channels for different needs:

### Stable Channel (Recommended)
- Production-ready releases
- Thoroughly tested before release
- Docker tags: `stable`, `latest`, or specific version like `v2.3.0`

### Beta Channel
- Early access to new features
- May contain bugs or incomplete functionality
- Docker tags: `beta` or specific version like `v2.3.0-beta.1`

### Configuring Your Channel

Set the `PICPEAK_CHANNEL` environment variable in your `.env` file:

```bash
# For stable releases (default)
PICPEAK_CHANNEL=stable

# For beta releases
PICPEAK_CHANNEL=beta

# For a specific version
PICPEAK_CHANNEL=v2.3.0
```

The `docker-compose.production.yml` uses this variable for both backend and frontend images:
```yaml
image: ghcr.io/the-luap/picpeak/backend:${PICPEAK_CHANNEL:-stable}
```

### Switching Channels

To switch between channels:

```bash
# Edit your .env file
nano .env
# Change PICPEAK_CHANNEL=stable to PICPEAK_CHANNEL=beta (or vice versa)

# Pull the new images and restart
docker compose -f docker-compose.production.yml pull
docker compose -f docker-compose.production.yml up -d
```

### Update Notifications

The admin dashboard automatically notifies you when updates are available for your channel. This feature:
- Checks GitHub releases hourly (cached to avoid rate limits)
- Shows updates relevant to your current channel (stable or beta)
- Can be disabled by setting `UPDATE_CHECK_ENABLED=false` in your `.env`

## 🔒 Reverse Proxy Setup

For production deployments, you should use a reverse proxy for SSL/HTTPS. The application exposes ports directly, allowing you to use any reverse proxy solution.

### Routing Schema

PicPeak consists of two services that need to be routed correctly:

| Path | Service | Port | Description |
|------|---------|------|-------------|
| `/api/*` | Backend | 3001 | All API endpoints |
| `/photos/*` | Backend | 3001 | Protected photo files |
| `/thumbnails/*` | Backend | 3001 | Protected thumbnail files |
| `/uploads/*` | Backend | 3001 | Upload files |
| `/*` (everything else) | Frontend | 3000 | React SPA (including `/admin/*`, `/gallery/*`) |

> **Important:** The `/admin/*` routes are served by the frontend (React SPA), NOT the backend. The backend only handles `/api/admin/*` requests.

### Option 1: Nginx

Install nginx and create `/etc/nginx/sites-available/picpeak`:

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # Backend: API endpoints
    location /api/ {
        proxy_pass http://localhost:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Backend: Protected media files
    location ~ ^/(photos|thumbnails|uploads)/ {
        proxy_pass http://localhost:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Frontend: Everything else (React SPA)
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable the site:
```bash
sudo ln -s /etc/nginx/sites-available/picpeak /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### Option 2: Traefik

Add labels to `docker-compose.override.yml`:

```yaml
version: '3.8'

services:
  frontend:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.picpeak.rule=Host(`your-domain.com`)"
      - "traefik.http.routers.picpeak.entrypoints=websecure"
      - "traefik.http.routers.picpeak.tls.certresolver=letsencrypt"
      - "traefik.http.services.picpeak.loadbalancer.server.port=80"

  backend:
    labels:
      - "traefik.enable=true"
      # API endpoints
      - "traefik.http.routers.picpeak-api.rule=Host(`your-domain.com`) && PathPrefix(`/api`)"
      - "traefik.http.routers.picpeak-api.entrypoints=websecure"
      - "traefik.http.routers.picpeak-api.tls.certresolver=letsencrypt"
      - "traefik.http.services.picpeak-api.loadbalancer.server.port=3001"
      # Protected media files
      - "traefik.http.routers.picpeak-media.rule=Host(`your-domain.com`) && (PathPrefix(`/photos`) || PathPrefix(`/thumbnails`) || PathPrefix(`/uploads`))"
      - "traefik.http.routers.picpeak-media.entrypoints=websecure"
      - "traefik.http.routers.picpeak-media.tls.certresolver=letsencrypt"
      - "traefik.http.services.picpeak-media.loadbalancer.server.port=3001"
```

### Option 3: Caddy

Create a `Caddyfile`:

```caddyfile
your-domain.com {
    # Backend: API endpoints
    handle /api/* {
        reverse_proxy localhost:3001
    }

    # Backend: Protected media files
    handle /photos/* {
        reverse_proxy localhost:3001
    }

    handle /thumbnails/* {
        reverse_proxy localhost:3001
    }

    handle /uploads/* {
        reverse_proxy localhost:3001
    }

    # Frontend: Everything else (React SPA including /admin/*, /gallery/*)
    handle {
        reverse_proxy localhost:3000
    }
}
```

### SSL Certificates

For any reverse proxy, you can use Let's Encrypt:

```bash
# With Certbot
sudo certbot certonly --webroot -w /var/www/certbot -d your-domain.com

# Or use your reverse proxy's built-in ACME support
```

## 📂 External Media Library

The External Media Library allows events to reference photos stored directly on your host filesystem instead of uploading them through the admin UI. This is useful for photographers who already have organized photo libraries and want to share them without re-uploading.

### How It Works

- **Managed mode** (default): Photos are uploaded through the admin UI and stored inside PicPeak's storage directory.
- **Reference mode**: Photos remain on your host filesystem. PicPeak reads them directly and generates thumbnails on demand.

Each event can use either mode. Reference mode events point to a folder under the configured external media root.

### Configuration

Add the following to your `.env` file:

```bash
# Path where your photo library is stored on the host
EXTERNAL_MEDIA_ROOT=/path/to/your/photos
```

Then mount this path into the backend container in your `docker-compose.yml` or `docker-compose.production.yml`:

```yaml
services:
  backend:
    environment:
      - EXTERNAL_MEDIA_ROOT=/external-media
    volumes:
      - /path/to/your/photos:/external-media:ro  # read-only is recommended
```

> **Permissions**: Ensure the container user (`PUID`/`PGID`) has read access to the mounted directory. If thumbnails fail to generate, this is usually a permissions issue.

### Folder Structure

Organize your photos with subdirectories for each event. Within each event folder, use `individual/` and `collages/` subdirectories to classify photos:

```
/path/to/your/photos/
├── wedding-smith-2026/
│   ├── individual/
│   │   ├── IMG_0001.jpg
│   │   ├── IMG_0002.jpg
│   │   └── ...
│   └── collages/
│       ├── group-photo.jpg
│       └── ...
├── corporate-event/
│   ├── individual/
│   │   └── ...
│   └── collages/
│       └── ...
```

Supported file formats: `.jpg`, `.jpeg`, `.png`, `.webp`

### Usage

1. **Create an event** in the admin panel as usual (name, date, email, etc.).

2. **Switch source mode** to "Reference external folder" in the event details under Source Mode.

3. **Browse and select** the external folder using the folder picker that appears. Navigate to the event's directory.

4. **Import photos** by clicking "Import from External Folder" in the Photos tab. PicPeak will:
   - Recursively scan the selected folder
   - Classify photos by subfolder name (`individual/` or `collages/`)
   - Deduplicate by filename (keeps the largest file if duplicates exist)
   - Extract image dimensions for gallery layout
   - Register the photos in the database

5. **Thumbnails** are generated on demand when a guest first views the gallery. There is no upfront processing delay.

### Limitations

- **Images only** — video files are not supported for external media.
- **Read-only** — PicPeak does not modify or delete files in the external media directory.
- **No automatic sync** — If you add new photos to the external folder, you need to re-import from the admin UI.
- **Backup caveat** — External media originals are excluded from PicPeak's built-in backup system. Only thumbnails and database records are backed up. You are responsible for backing up the source files separately.

### Troubleshooting

| Problem | Solution |
|---------|----------|
| Folder picker shows empty directory | Check that the volume is mounted correctly and `EXTERNAL_MEDIA_ROOT` matches the container path |
| "Permission denied" errors | Ensure `PUID`/`PGID` in `.env` match the owner of the external media files on the host |
| Thumbnails not generating | Verify the backend container can read the files: `docker exec picpeak-backend ls /external-media/your-folder/` |
| Import finds 0 photos | Only `.jpg`, `.jpeg`, `.png`, `.webp` files are supported. Check file extensions. |

## 🔧 Maintenance

### Viewing Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f backend
docker compose logs -f frontend
```

### Backup

#### Manual Backup
```bash
# Database backup
docker exec picpeak-postgres pg_dump -U picpeak picpeak_prod > backup/db_$(date +%Y%m%d_%H%M%S).sql

# Files backup
tar -czf backup/photos_$(date +%Y%m%d_%H%M%S).tar.gz events/
```

#### Automated Backup
The application includes a built-in backup service. Configure it in the admin panel:
1. Login to admin panel
2. Go to Settings → Backup
3. Configure destination and schedule
4. Enable backup service

### Updates

#### Method 1: Using Pre-built Images (Recommended)

```bash
# Pull latest changes (for configuration updates)
git pull

# Pull latest images from GitHub Container Registry
docker compose -f docker-compose.production.yml pull

# Restart with new images
docker compose -f docker-compose.production.yml down
docker compose -f docker-compose.production.yml up -d

# Verify services are healthy
docker compose -f docker-compose.production.yml ps
```

#### Method 2: Building from Source

```bash
# Pull latest changes
git pull

# Rebuild and restart
docker compose down
docker compose build --no-cache
docker compose up -d

# Verify services are healthy
docker compose ps
```

#### Specific Version or Channel Updates

To use a specific version or switch channels, update your `.env` file:

```bash
# Edit .env to change the channel or pin to a specific version
nano .env

# Options for PICPEAK_CHANNEL:
# - stable    (recommended, production-ready)
# - beta      (early access to new features)
# - v2.3.0    (pin to specific stable version)
# - v2.3.0-beta.1  (pin to specific beta version)

# Then pull and restart
docker compose -f docker-compose.production.yml pull
docker compose -f docker-compose.production.yml up -d
```

The admin dashboard will notify you when updates are available for your configured channel.

### Database Migrations

Migrations run automatically on startup, but you can run them manually:

```bash
docker exec picpeak-backend npm run migrate
```

## 🚨 Troubleshooting

### Common Issues

#### 502 Bad Gateway / Login Failures
**This is the most common deployment issue!** Usually caused by misconfigured URLs or network problems:

1. **CORS Configuration Errors**:
   ```bash
   # WRONG - Missing port will cause CORS errors
   FRONTEND_URL=http://10.0.252.12
   
   # CORRECT - Include the port you're accessing from
   FRONTEND_URL=http://10.0.252.12:3000
   ```
   
   The backend validates Origin headers against `FRONTEND_URL` for CORS. If they don't match exactly, you'll get 500 errors on login.

2. **After Container Restarts**:
   - Nginx may have cached old container IPs
   - Solution: `docker restart picpeak-frontend`
   - Always wait 30-60 seconds for health checks

3. **Backend Not Starting After Migrations**:
   - The logs may only show migrations completed
   - Check if server is actually running: `docker exec picpeak-backend ps aux | grep node`
   - Should see `node server.js` process

4. **Login After Fresh Install**:
   - Check backend logs for auto-generated admin password: `docker compose logs backend | grep "Admin password"`
   - Email: `admin@example.com` (or your custom admin email from .env)
   - Password: Auto-generated and shown in logs (e.g., `BraveTiger6231!`)
   - Remember: Password MUST be changed on first login

5. **Complete Fix Sequence**:
   ```bash
   # 1. Fix your .env file URLs
   # 2. Full restart
   docker-compose down
   docker-compose up -d
   
   # 3. Wait for healthy status
   sleep 60
   docker ps  # All should show (healthy)
   
   # 4. Test backend directly
   curl http://localhost:3001/health
   
   # 5. Test through frontend
   curl http://localhost:3000/api/public/settings
   ```

#### Port Already in Use
```bash
# Check what's using the port
sudo lsof -i :3000
sudo lsof -i :3001

# Change ports in .env
FRONTEND_PORT=3002
BACKEND_PORT=3003
```

#### Docker Compose Variable Substitution Errors
If you see warnings like:
```
WARN[0000] The "fgbf" variable is not set. Defaulting to a blank string.
```

This means your password contains `$` which Docker Compose interprets as a variable. Solutions:
1. **Best**: Generate passwords without `$`: `openssl rand -base64 32 | tr -d '$'`
2. **Alternative**: Escape `$` as `$$` in your .env file
3. **Example**: `DB_PASSWORD=Pass@#$$fgbf` instead of `DB_PASSWORD=Pass@#$fgbf`

#### Permission Errors
```bash
# Fix ownership
sudo chown -R 1000:1000 events data logs backup storage
chmod -R 755 events data logs backup storage
```

#### Database Connection Issues
```bash
# Check if database is running
docker compose ps
docker compose logs postgres

# Test connection
docker exec picpeak-postgres pg_isready
```

#### Email Not Sending
- Verify SMTP settings in .env
- Check email queue: `docker exec picpeak-backend psql -U picpeak -d picpeak_prod -c "SELECT * FROM email_queue ORDER BY created_at DESC LIMIT 10;"`
- For Gmail, use app-specific password
- Check logs: `docker compose logs backend | grep email`

### Health Checks

```bash
# Backend health
curl http://localhost:3001/api/health

# Frontend health
curl http://localhost:3000

# Database health
docker exec picpeak-postgres pg_isready
```

### Useful Commands

```bash
# Enter backend container
docker exec -it picpeak-backend sh

# Enter database
docker exec -it picpeak-postgres psql -U picpeak picpeak_prod

# Reset admin password
docker exec picpeak-backend node scripts/show-admin-credentials.js --reset

# Check disk usage
df -h
du -sh events/ storage/ backup/

# View running processes
docker compose top
```

## Security Recommendations

1. **Use HTTPS**: Always use a reverse proxy with SSL in production
2. **Firewall**: Only expose necessary ports (80, 443)
3. **Secure passwords**: Use strong, unique passwords for all services
4. **Regular updates**: Keep Docker images and system packages updated
5. **Backup strategy**: Set up automated backups and test restoration
6. **Monitor logs**: Regularly check logs for suspicious activity
7. **Rate limiting**: The app includes built-in rate limiting, configure as needed

## Support

For issues and questions:
- Check logs first: `docker compose logs`
- Review documentation in the repository
- Check existing issues on GitHub
- Create a new issue with:
  - Error messages
  - Log output
  - Environment details (without secrets)
  - Steps to reproduce

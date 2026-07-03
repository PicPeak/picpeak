# 🚀 PicPeak Simple Setup Guide

This guide provides easy installation instructions for PicPeak on Linux servers with both Docker and non-Docker options.

## 📋 Quick Start

### One-Line Installation

```bash
# Download and run the unified setup script
curl -fsSL https://raw.githubusercontent.com/PicPeak/picpeak/main/scripts/picpeak-setup.sh -o picpeak-setup.sh && \
chmod +x picpeak-setup.sh && \
sudo ./picpeak-setup.sh
```

The script will automatically detect your environment and recommend the best installation method.

## 🎯 Installation Methods

### Method 1: Docker Installation (Recommended)
Best for: Most users, easy updates, isolated environment

```bash
sudo ./picpeak-setup.sh --docker
```

**Pros:**
- ✅ Easier installation and updates
- ✅ Better isolation from system
- ✅ Consistent environment across platforms
- ✅ Built-in PostgreSQL and Redis

**Cons:**
- ❌ Requires more resources (~4GB RAM recommended)
- ❌ Additional Docker overhead

### Method 2: Native Installation
Best for: Resource-constrained systems, Raspberry Pi, direct control

```bash
sudo ./picpeak-setup.sh --native
```

**Pros:**
- ✅ Lower resource usage (~1GB RAM minimum)
- ✅ Direct system control
- ✅ No Docker overhead
- ✅ Better for ARM devices

**Cons:**
- ❌ More complex setup
- ❌ System dependencies required
- ❌ Manual update process

## 📋 System Requirements

### Minimum Requirements
- **OS**: Ubuntu 20.04+, Debian 11+, Fedora 38+, RHEL/CentOS 8+, Raspberry Pi OS
- **RAM**: 
  - Docker: 2GB minimum (4GB recommended)
  - Native: 1GB minimum (2GB recommended)
- **Storage**: 2GB for application + space for photos
- **Network**: Port 3001 (or 80/443 with proxy)

### Supported Platforms
- ✅ Ubuntu 20.04, 22.04, 24.04
- ✅ Debian 11, 12
- ✅ Raspberry Pi OS (32-bit and 64-bit)
- ✅ Fedora 38, 39, 40
- ✅ RHEL/CentOS/Rocky/AlmaLinux 8, 9

## 🛠️ Installation Options

### Interactive Mode (Default)
```bash
sudo ./picpeak-setup.sh
```

The script will prompt you to choose:
1. Installation method (Docker or Native)
2. Admin email and password
3. Domain configuration (optional)
4. Email server settings (optional)
5. SSL/HTTPS setup (optional)

### Unattended Installation

#### Docker with full configuration:
```bash
sudo ./picpeak-setup.sh --docker --unattended \
  --domain photos.example.com \
  --email admin@example.com \
  --admin-password SecurePass123 \
  --smtp-host smtp.gmail.com \
  --smtp-port 587 \
  --smtp-user your-email@gmail.com \
  --smtp-pass your-app-password \
  --enable-ssl
```

#### Native with minimal configuration:
```bash
sudo ./picpeak-setup.sh --native --unattended \
  --email admin@example.com \
  --admin-password SecurePass123
```

### Command Line Options

| Option | Description | Example |
|--------|-------------|---------|
| `--docker` | Use Docker installation | `--docker` |
| `--native` | Use native installation | `--native` |
| `--unattended` | Run without prompts | `--unattended` |
| `--domain` | Domain for HTTPS setup | `--domain photos.example.com` |
| `--email` | Admin email address | `--email admin@example.com` |
| `--admin-password` | Set admin password | `--admin-password MySecurePass` |
| `--smtp-host` | SMTP server hostname | `--smtp-host smtp.gmail.com` |
| `--smtp-port` | SMTP server port | `--smtp-port 587` |
| `--smtp-user` | SMTP username | `--smtp-user user@gmail.com` |
| `--smtp-pass` | SMTP password | `--smtp-pass app-password` |
| `--enable-ssl` | Enable HTTPS with Let's Encrypt | `--enable-ssl` |
| `--port` | Custom port (native only) | `--port 8080` |
| `--update` | Update existing installation | `--update` |
| `--uninstall` | Remove installation | `--uninstall` |
| `--help` | Show help message | `--help` |

## 🏗️ What Gets Installed

### Docker Installation
```
~/picpeak/                    # Or custom directory
├── docker-compose.yml        # Service definitions
├── .env                      # Configuration
├── storage/
│   └── events/              # Photo storage
│       ├── active/          # Current galleries
│       └── archived/        # Expired galleries
├── logs/                    # Application logs
└── backup/                  # Backup directory
```

**Services:**
- PicPeak Backend (Node.js application)
- PostgreSQL Database
- Redis Cache
- Nginx Reverse Proxy (optional)
- Background Workers

### Native Installation
```
/opt/picpeak/                # Installation directory
├── backend/                 # Application code
├── events/                  # Photo storage
│   ├── active/             # Current galleries
│   └── archived/           # Expired galleries
├── logs/                   # Application logs
└── config/                 # Configuration files
```

**Services (systemd):**
- `picpeak-backend` - Main application
- `picpeak-workers` - Background workers
- `caddy` - Web server (optional)

## 🔑 First Login — Create Your Admin

If you installed with `picpeak-setup.sh` and gave an `--admin-password`, your admin account already exists — log in at `/admin` with that email and password.

If you started PicPeak **without** setting `ADMIN_PASSWORD` (e.g. a plain `docker compose up`), there's **no admin yet** and you create it in the browser:

1. Open `http://your-server:3000/admin` — you'll land on a setup screen.
2. Get the **one-time setup token** from the backend logs (also saved to `data/SETUP_TOKEN`):
   ```bash
   docker compose logs backend | grep -i "setup token"
   ```
3. Paste it, set your admin email + password. The token is single-use and the screen closes once an admin exists.

## 🌐 Access Methods

### Direct Access (Simplest)
- Docker: `http://your-server:3000` (frontend and admin at `/admin`)
- Backend/API: `http://your-server:3001` (API only; no UI routes)
  
For native installs, serve the built frontend (e.g., with nginx or Caddy) and access the admin at `/admin` on the frontend domain.

### With Domain & HTTPS
If configured during setup:
- `https://your-domain.com` - Gallery frontend
- `https://your-domain.com/admin` - Admin panel

### Behind Existing Proxy
Add to your Nginx/Apache configuration (split frontend vs backend):
```nginx
# Frontend (UI + /admin/*)
location / {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_cache_bypass $http_upgrade;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

# Backend API and protected resources
location /api {
    proxy_pass http://localhost:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_cache_bypass $http_upgrade;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 100M;
}
location ~ ^/(photos|thumbnails|uploads) {
    proxy_pass http://localhost:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## 📁 Managing Galleries

### Creating a Gallery

#### Via Admin Panel
1. Login to admin panel at `/admin`
2. Click "Create New Event"
3. Configure settings (name, date, password, customer email)
4. Upload photos via drag & drop in the Photos tab
5. Publish the gallery when ready

#### Adding Photos via File System

> **Important:** You must first create the event in the admin panel. The file watcher only detects new photos for events that already exist in the database. You cannot create a gallery by copying files alone.

Once an event exists, you can add photos by copying them into the event's folder. PicPeak's built-in file watcher will automatically detect the new files, create database records, and generate thumbnails.

```bash
# Docker installation — copy photos into an existing event's folder
cp /path/to/photos/*.jpg ~/picpeak/storage/events/active/<event-slug>/

# Native installation
sudo cp /path/to/photos/*.jpg /opt/picpeak/events/active/<event-slug>/
sudo chown -R picpeak:picpeak /opt/picpeak/events/active/<event-slug>
```

The event slug is visible in the admin panel URL or share link (e.g. `wedding-smith-2024`). Supported formats: `.jpg`, `.jpeg`, `.png`, `.webp`. The file watcher has a 2-second stability delay before processing new files.

### Gallery Structure
```
<event-slug>/
├── collages/        # Group photos (optional subfolder)
├── individual/      # Individual photos (optional subfolder)
└── photo.jpg        # Photos at root level also work
```

## 🔧 Service Management

### Docker Installation

```bash
cd ~/picpeak

# Check status
docker compose ps

# View logs
docker compose logs -f

# Stop services
docker compose down

# Start services
docker compose up -d

# Restart services
docker compose restart

# Update PicPeak
docker compose pull
docker compose up -d
```

### Native Installation

```bash
# Check status
sudo systemctl status picpeak-backend
sudo systemctl status picpeak-workers

# View logs
sudo journalctl -u picpeak-backend -f
sudo journalctl -u picpeak-workers -f

# Start services
sudo systemctl start picpeak-backend picpeak-workers

# Stop services
sudo systemctl stop picpeak-backend picpeak-workers

# Restart services
sudo systemctl restart picpeak-backend picpeak-workers

# Update PicPeak
# (reruns migrations to pick up schema fixes for native installs)
sudo ./picpeak-setup.sh --update
```

## ⚙️ Configuration

### Docker Configuration
Edit `~/picpeak/.env`:
```bash
nano ~/picpeak/.env
docker compose restart
```

### Native Configuration
Edit `/opt/picpeak/app/backend/.env`:
```bash
sudo nano /opt/picpeak/app/backend/.env
sudo systemctl restart picpeak-backend
```

### Key Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `JWT_SECRET` | Token signing secret | Auto-generated |
| `ADMIN_EMAIL` | Admin email | admin@example.com |
| `ADMIN_PASSWORD` | Admin password | Auto-generated |
| `PHOTOS_DIR` | Photo storage path | Varies by method |
| `SMTP_ENABLED` | Email notifications | false |
| `DEFAULT_EXPIRY_DAYS` | Gallery expiration | 30 |

## 📧 Email Configuration

### Gmail Setup
1. Enable 2-Factor Authentication
2. Generate App Password
3. Configure:
```env
SMTP_ENABLED=true
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=noreply@yourdomain.com
```

### SendGrid Setup
1. Sign up at sendgrid.com (100 emails/day free)
2. Create API key
3. Configure:
```env
SMTP_ENABLED=true
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=your-sendgrid-api-key
SMTP_FROM=verified-sender@yourdomain.com
```

## 🔄 Maintenance

### Backups

#### Docker:
```bash
# Backup script included
cd ~/picpeak
./backup.sh

# Manual backup
docker exec picpeak-postgres pg_dump -U picpeak picpeak > backup.sql
tar -czf photos-backup.tar.gz storage/events/
```

#### Native:
```bash
# Database backup
sudo cp /opt/picpeak/app/backend/data/photo_sharing.db /backup/database-$(date +%Y%m%d).sqlite

# Photos backup
sudo tar -czf /backup/photos-$(date +%Y%m%d).tar.gz /opt/picpeak/events/
```

### Updates

```bash
# Docker
cd ~/picpeak
docker compose pull
docker compose up -d

# Native
sudo ./picpeak-setup.sh --update
```

### Uninstall

```bash
# Will prompt for confirmation and data removal options
sudo ./picpeak-setup.sh --uninstall
```

## 🐛 Troubleshooting

### Common Issues

#### Service Won't Start
```bash
# Docker
docker compose logs backend
docker compose down && docker compose up -d

# Native
sudo journalctl -u picpeak-backend -n 50
sudo systemctl restart picpeak-backend
```

#### Can't Access Admin Panel
1. Check firewall:
```bash
# Ubuntu/Debian
sudo ufw allow 3001

# RHEL/CentOS
sudo firewall-cmd --add-port=3001/tcp --permanent
sudo firewall-cmd --reload
```

2. Verify service:
```bash
# Docker
curl http://localhost:3001/api/health

# Native
sudo systemctl is-active picpeak-backend
```

#### Photos Not Showing
```bash
# Check permissions (Native)
sudo chown -R picpeak:picpeak /opt/picpeak/events/
sudo chmod -R 755 /opt/picpeak/events/

# Check permissions (Docker)
ls -la ~/picpeak/storage/events/
```

#### Reset Admin Password

```bash
# Docker
docker exec picpeak-backend node scripts/reset-admin-password.js

# Native
cd /opt/picpeak/app/backend
sudo -u picpeak node scripts/reset-admin-password.js
```

> **Note:** The new password will be displayed in the console output and saved to `ADMIN_PASSWORD_RESET.txt`. Save it immediately!

### Getting Help

1. **Check logs:**
   - Docker: `docker compose logs -f`
   - Native: `sudo journalctl -u picpeak-backend -f`
   - Installation: `/tmp/picpeak-setup-*.log`

2. **Documentation:**
   - [Full Documentation](https://docs.picpeak.app)
   - [Deployment Guide](https://docs.picpeak.app/deployment)

3. **Support:**
   - [GitHub Issues](https://github.com/PicPeak/picpeak/issues)
   - Include: Error messages, system info (`uname -a`), installation method

## 🔒 Security Best Practices

### Essential Security
1. **Change default admin password immediately**
2. **Use HTTPS for production** (Let's Encrypt included)
3. **Configure firewall** (only open necessary ports)
4. **Regular updates** (system and PicPeak)
5. **Automated backups** (configure in admin panel)

### Advanced Security
- Use VPN for admin panel access
- Configure fail2ban for brute force protection
- Enable audit logging
- Regular security scans
- Implement IP whitelisting

## 📊 Performance Optimization

### Docker Optimization
```yaml
# Adjust in docker-compose.yml
services:
  backend:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
```

### Native Optimization
```bash
# Increase Node.js memory
echo "NODE_OPTIONS=--max-old-space-size=2048" >> /opt/picpeak/app/backend/.env
sudo systemctl restart picpeak-backend
```

## 🎯 Quick Setup Examples

### Home/Office Network
```bash
# Simple local setup without domain
sudo ./picpeak-setup.sh --native --email admin@local.com
```

### Public Website with HTTPS
```bash
# Full production setup
sudo ./picpeak-setup.sh --docker \
  --domain photos.company.com \
  --email admin@company.com \
  --enable-ssl
```

### Raspberry Pi Setup
```bash
# Optimized for ARM devices
sudo ./picpeak-setup.sh --native \
  --port 8080 \
  --email pi@local.com
```

## ✅ Post-Installation Checklist

- [ ] Admin password changed
- [ ] Email configuration tested
- [ ] First test gallery created
- [ ] Backup schedule configured
- [ ] Firewall rules applied
- [ ] SSL certificate working (if applicable)
- [ ] Monitoring setup
- [ ] Documentation bookmarked

---

**PicPeak Setup v1.0** | [Documentation](https://github.com/PicPeak/picpeak) | [Support](https://github.com/PicPeak/picpeak/issues)

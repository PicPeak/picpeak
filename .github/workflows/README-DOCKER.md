# Docker Build and Push Workflow

This GitHub Actions workflow automatically builds and pushes Docker images for the backend, the frontend, the all-in-one image and the optional ML sidecar to GitHub Container Registry (ghcr.io). On the canonical org repo every one of them is mirrored to Docker Hub as `docker.io/picpeak/{backend,frontend,aio,ml}`; forks build the same images GHCR-only.

The **all-in-one image** (`<repo>/aio`, built from `Dockerfile.aio` at the repo root, #1042) bundles the backend and the built frontend into a single container with SQLite as the default engine — one `docker run`, no compose. It follows the same per-arch build → digest-merge → per-version tag scheme as the other two images, is mirrored to Docker Hub (`docker.io/picpeak/aio`) alongside GHCR on the canonical org repo, and every PR additionally runs a `smoke-aio` job that boots the image and asserts the SPA shell, brand-title rendering, immutable asset caching, and the SQLite engine resolution.

## Features

- 🔧 **Automatic builds** on push to main/develop branches, PRs, and releases
- 🏗️ **Multi-architecture support** (linux/amd64 and linux/arm64)
- 🏷️ **Smart tagging** based on branches, versions, and commits
- 🔒 **Security scanning** with Trivy vulnerability scanner
- 💾 **Build caching** for faster subsequent builds
- 📊 **Build summaries** in GitHub Actions UI
- 📝 **Docker Hub pages** for `aio` and `ml` synced from `.github/dockerhub/*.md` on every `main` merge (`dockerhub-descriptions` job). `backend` and `frontend` pages are still hand-maintained in the Hub UI — add `.github/dockerhub/{backend,frontend}.md` with their current text before putting them under the same job.

## Authentication

The workflow uses the built-in `GITHUB_TOKEN` for authentication with GitHub Container Registry. No additional setup or personal access tokens are required.

### Required Permissions

The workflow automatically sets the necessary permissions:
- `contents: read` - To checkout the repository
- `packages: write` - To push images to ghcr.io
- `security-events: write` - To upload security scan results

## Image Tags

Images are automatically tagged based on the trigger event:

| Event | Tags Generated |
|-------|---------------|
| Push to main | `latest`, `main`, `main-<short-sha>` |
| Push to develop | `develop`, `develop-<short-sha>` |
| Pull Request | `pr-<number>` |
| Release (v1.2.3) | `1.2.3`, `1.2`, `1`, `latest` |
| Manual trigger | Based on branch + optional push |

## Usage

### Pull Images

Once published, images can be pulled using:

```bash
# Pull backend image
docker pull ghcr.io/picpeak/picpeak/backend:latest

# Pull frontend image
docker pull ghcr.io/picpeak/picpeak/frontend:latest

# Pull specific version
docker pull ghcr.io/picpeak/picpeak/backend:v1.0.0

# Pull for specific architecture
docker pull --platform linux/arm64 ghcr.io/picpeak/picpeak/backend:latest

# The same images on Docker Hub (identical tags, identical digests)
docker pull picpeak/backend:latest
docker pull picpeak/aio:stable
docker pull picpeak/ml:stable
```

### Using in Docker Compose

```yaml
version: '3.8'

services:
  backend:
    image: ghcr.io/picpeak/picpeak/backend:latest
    environment:
      - NODE_ENV=production
    ports:
      - "3001:3000"

  frontend:
    image: ghcr.io/picpeak/picpeak/frontend:latest
    ports:
      - "80:80"
```

### Using in Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: picpeak-backend
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: backend
        image: ghcr.io/picpeak/picpeak/backend:latest
        imagePullPolicy: Always
```

## Manual Workflow Trigger

You can manually trigger the workflow from the Actions tab:

1. Go to Actions → "Build and Push Docker Images"
2. Click "Run workflow"
3. Select branch and whether to push images
4. Click "Run workflow"

## Security Scanning

The workflow includes Trivy vulnerability scanning that:
- Scans for CRITICAL and HIGH severity vulnerabilities
- Uploads results to GitHub Security tab
- Available under Security → Code scanning alerts

## Build Optimization

The workflow uses several optimization techniques:

1. **GitHub Actions Cache**: Speeds up builds by caching layers
2. **Multi-stage builds**: Reduces final image size
3. **Parallel builds**: Backend and frontend build simultaneously
4. **Smart rebuilds**: Only rebuilds changed components

## Troubleshooting

### Permission Denied Errors

If you encounter permission errors when pushing images:

1. **First-time setup**: The first push creates a private package. You may need to:
   - Go to your package settings at `https://github.com/users/YOUR_USERNAME/packages`
   - Link the package to your repository
   - Set package visibility (public/private)

2. **Organization repositories**: Ensure the organization allows GitHub Actions to create packages

### Build Failures

Check the workflow logs in the Actions tab for detailed error messages. Common issues:
- Missing dependencies in package.json
- Dockerfile syntax errors
- Network issues during package installation

### Image Not Found

If images aren't visible after successful push:
- Check package visibility settings
- Ensure you're authenticated to pull private images:
  ```bash
  echo $GITHUB_TOKEN | docker login ghcr.io -u YOUR_USERNAME --password-stdin
  ```

## Package Management

### View Packages

Your Docker images are available at:
- Backend: `https://github.com/orgs/PicPeak/packages/container/package/picpeak%2Fbackend`
- Frontend: `https://github.com/orgs/PicPeak/packages/container/package/picpeak%2Ffrontend`

### Delete Old Versions

To save storage, you can delete old versions:
1. Go to package settings
2. Click on "Manage versions"
3. Select versions to delete
4. Click "Delete selected versions"

### Set Retention Policy

Configure automatic cleanup in package settings:
1. Go to package settings
2. Click on "Manage Actions access"
3. Set retention days for untagged versions

## Best Practices

1. **Use semantic versioning** for releases (e.g., v1.2.3)
2. **Test images locally** before pushing to production
3. **Monitor security alerts** from Trivy scans
4. **Clean up old images** regularly to save storage
5. **Use specific tags** in production (avoid `latest`)

## Advanced Configuration

### Custom Registry

To use a different registry, update the workflow:

```yaml
env:
  REGISTRY: docker.io  # or your custom registry
  BACKEND_IMAGE_NAME: yourusername/picpeak-backend
```

### Additional Platforms

To build for more platforms:

```yaml
platforms: linux/amd64,linux/arm64,linux/arm/v7
```

### Custom Build Arguments

Add build arguments in the workflow:

```yaml
build-args: |
  NODE_VERSION=20
  API_URL=${{ secrets.API_URL }}
```

## Related Documentation

- [GitHub Container Registry Docs](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [Docker Build Action](https://github.com/docker/build-push-action)
- [Trivy Security Scanner](https://github.com/aquasecurity/trivy)
- [Multi-platform Builds](https://docs.docker.com/build/building/multi-platform/)
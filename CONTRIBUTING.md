# Contributing to PicPeak

First off, thank you for considering contributing to PicPeak! It's people like you that make PicPeak such a great tool for photographers worldwide.

## 🤝 Code of Conduct

This project and everyone participating in it is governed by the [PicPeak Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## 🎯 How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check the existing issues as you might find out that you don't need to create one. When you are creating a bug report, please include as many details as possible:

* **Use a clear and descriptive title**
* **Describe the exact steps to reproduce the problem**
* **Provide specific examples to demonstrate the steps**
* **Describe the behavior you observed and what you expected**
* **Include screenshots if possible**
* **Include your environment details** (OS, browser, Docker version, etc.)

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion, please include:

* **Use a clear and descriptive title**
* **Provide a detailed description of the suggested enhancement**
* **Provide specific examples to demonstrate the enhancement**
* **Describe the current behavior and expected behavior**
* **Explain why this enhancement would be useful**

### Your First Code Contribution

Unsure where to begin? You can start by looking through these issues:

* [Good first issues](https://github.com/PicPeak/picpeak/labels/good%20first%20issue) - issues which should only require a few lines of code
* [Help wanted issues](https://github.com/PicPeak/picpeak/labels/help%20wanted) - issues which need extra attention

### Pull Requests

1. **Fork the repo** and create your branch from `main` (active development)
2. **Install dependencies**:
   ```bash
   cd backend && npm install
   cd ../frontend && npm install
   ```
3. **Make your changes** and ensure:
   - Code follows the existing style
   - Tests pass: `npm test`
   - Linting passes: `npm run lint`
4. **Write tests** if you've added code
5. **Update documentation** if needed
6. **Attach a screenshot for any UI change** (see below)
7. **Create a Pull Request**

> **📸 Screenshots are required for UI changes.** Any PR that changes a user-facing surface — a component, page, layout, style, or in-app copy — must include at least one screenshot of the result in the PR description, showing before/after where it helps reviewers see the difference. PRs that touch the UI without a screenshot will be asked to add one before review. Backend-only or otherwise non-visual changes don't need one.

## 💻 Development Setup

### Prerequisites

- Node.js 18+
- Docker & Docker Compose
- Git

### Local Development

```bash
# Clone your fork
git clone https://github.com/your-username/picpeak.git
cd picpeak

# Install dependencies
cd backend && npm install
cd ../frontend && npm install

# Set up environment
cp .env.example .env
# Edit .env with your settings

# Start development servers
docker-compose -f docker-compose.dev.yml up
```

**After pulling changes that touch `backend/package.json` / `backend/package-lock.json` (or the frontend equivalents)**, rebuild the affected image so the live-mounted source can `require()` the new deps:

```bash
docker compose -f docker-compose.dev.yml up -d --build backend
# (or `frontend`, or both)
```

The dev compose bakes `node_modules` into the image while live-mounting `./backend/src` and `./frontend/src` from disk. A dep added on disk won't be picked up until the image is rebuilt — typical symptom is a `MODULE_NOT_FOUND` restart loop on the affected container.

### Running Tests

```bash
# Backend tests
cd backend && npm test

# Frontend tests
cd frontend && npm test

# E2E tests
npm run test:e2e
```

## 📝 Styleguides

### Git Commit Messages

* Use the present tense ("Add feature" not "Added feature")
* Use the imperative mood ("Move cursor to..." not "Moves cursor to...")
* Limit the first line to 72 characters or less
* Reference issues and pull requests liberally after the first line
* Consider starting the commit message with an applicable emoji:
  * 🎨 `:art:` when improving the format/structure of the code
  * 🐛 `:bug:` when fixing a bug
  * 🔥 `:fire:` when removing code or files
  * 📝 `:memo:` when writing docs
  * 🚀 `:rocket:` when improving performance
  * ✨ `:sparkles:` when adding a new feature

### JavaScript/TypeScript Styleguide

* Use ES6+ features
* Prefer async/await over promises
* Use meaningful variable names
* Add JSDoc comments for functions
* Follow ESLint rules

### React Styleguide

* Use functional components with hooks
* Keep components small and focused
* Use TypeScript for type safety
* Follow the existing folder structure
* Write tests for new components

## 📦 Project Structure

```
picpeak/
├── backend/
│   ├── src/
│   │   ├── routes/      # API endpoints
│   │   ├── services/    # Business logic
│   │   ├── middleware/  # Express middleware
│   │   └── utils/       # Utilities
│   └── migrations/      # Database migrations
├── frontend/
│   ├── src/
│   │   ├── components/  # Reusable components
│   │   ├── pages/       # Page components
│   │   ├── services/    # API services
│   │   └── hooks/       # Custom hooks
│   └── public/          # Static assets
```

## 🌿 Branch model

PicPeak runs on two long-lived branches:

| Branch | Role | What targets it |
|---|---|---|
| **`main`** | Active development. The next release is being assembled here. | Feature PRs. Most bugfix PRs. |
| **`stable`** | Curated release channel. Production-recommended. | Urgent bugfix backports only — small, surgical PRs that land cleanly without dragging in unrelated changes. |

### Which branch should my PR target?

- **New feature** → target `main`.
- **Bugfix that ONLY affects active dev** → target `main`.
- **Bugfix that current stable users need** → open a small PR against `main`, AND a separate small PR against `stable` with the same change. Keep both surgical so each lands cleanly.

**Hard rule on PR scope**: bugfix PRs against `stable` must be small enough to backport without conflict. Omnibus PRs (e.g. five unrelated sub-features) are fine for `main`, but never for `stable` — they make the next `main → stable` merge painful and break the "stable is always shippable" invariant.

If you're not sure which branch to target, default to `main` and a maintainer will retarget during review.

## 🔄 Release Process

Releases are cut independently from `main` (pre-release versions for the active channel) and `stable` (semver releases for the curated channel). `release-please` handles version bumps, changelog generation, and Docker image publication automatically — contributors don't update `package.json` or `CHANGELOG.md` by hand.

Periodic `main → stable` merges promote a batch of `main` work to the stable channel. The maintainer chooses when (typically every ~4 weeks, sooner if a hot bug demands it).

See [RELEASING.md](RELEASING.md) for the full operational doc (promotion criteria, conflict-resolution checklist for the `main → stable` merge, hotfix backport path, versioning rules).

## 📮 Contact

- Create an [issue](https://github.com/PicPeak/picpeak/issues) for bugs or features
- Join [discussions](https://github.com/PicPeak/picpeak/discussions) for questions
- Security issues: Open a [security issue](https://github.com/PicPeak/picpeak/issues/new?labels=security) on GitHub

Thank you for contributing! 🎉
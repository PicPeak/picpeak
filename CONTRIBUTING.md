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

* [Good first issues](https://github.com/the-luap/picpeak/labels/good%20first%20issue) - issues which should only require a few lines of code
* [Help wanted issues](https://github.com/the-luap/picpeak/labels/help%20wanted) - issues which need extra attention

### Pull Requests

1. **Fork the repo** and create your branch from `beta`
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
6. **Create a Pull Request**

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

## 🔄 Release Process

1. Update version numbers in package.json files
2. Update CHANGELOG.md
3. Create a new release on GitHub
4. Docker images are automatically built and published

## 📮 Contact

- Create an [issue](https://github.com/the-luap/picpeak/issues) for bugs or features
- Join [discussions](https://github.com/the-luap/picpeak/discussions) for questions
- Security issues: Open a [security issue](https://github.com/the-luap/picpeak/issues/new?labels=security) on GitHub

Thank you for contributing! 🎉
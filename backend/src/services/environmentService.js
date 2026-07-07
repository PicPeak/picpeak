/**
 * Environment Detection Service
 * Detects the deployment environment and generates update instructions accordingly.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

/**
 * Detect the current deployment environment
 * @returns {Object} Environment information
 */
async function detectEnvironment() {
  // Check for Docker environment
  const isDocker = fs.existsSync('/.dockerenv') ||
                   process.env.DOCKER_CONTAINER === 'true';

  // Determine project root (services -> src -> backend)
  const projectRoot = path.join(__dirname, '../../..');

  // Check for git repository
  const isGit = fs.existsSync(path.join(projectRoot, '.git'));

  // Check for docker-compose files
  const hasDockerCompose = fs.existsSync(path.join(projectRoot, 'docker-compose.yml')) ||
                           fs.existsSync(path.join(projectRoot, 'docker-compose.yaml'));

  // Get app version
  let appVersion = '0.0.0';
  try {
    const packagePath = path.join(__dirname, '../../package.json');
    const packageContent = fs.readFileSync(packagePath, 'utf8');
    const packageJson = JSON.parse(packageContent);
    appVersion = packageJson.version || '0.0.0';
  } catch (err) {
    logger.warn('Could not read package.json for version:', err.message);
  }

  // Determine environment type
  let type;
  if (isDocker) {
    type = 'docker';
  } else if (isGit) {
    type = 'git';
  } else {
    type = 'standalone';
  }

  return {
    type,
    isDocker,
    isGit,
    hasDockerCompose,
    platform: process.platform,
    nodeVersion: process.version,
    appVersion
  };
}

/**
 * Generate environment-specific update instructions
 * @param {Object} env - Environment info from detectEnvironment()
 * @param {string} targetVersion - Target version to update to
 * @returns {Object} Update instructions with pre-checks, steps, and post-checks
 */
function generateUpdateInstructions(env, targetVersion) {
  const instructions = {
    preChecks: [
      {
        id: 'backup',
        text: 'I have backed up my database',
        required: true
      },
      {
        id: 'no-uploads',
        text: 'No uploads are currently in progress',
        required: true
      },
      {
        id: 'downtime-aware',
        text: 'I understand the application will restart during update',
        required: false
      }
    ],
    steps: [],
    postChecks: [
      'Verify the application starts correctly',
      'Check the version in Admin -> System',
      'Review release notes for any breaking changes or required actions'
    ],
    warnings: []
  };

  if (env.isDocker) {
    instructions.environmentName = 'Docker';
    instructions.steps = [
      {
        description: 'Pull latest images',
        command: 'docker compose pull',
        note: 'Downloads the new version images'
      },
      {
        description: 'Recreate containers with new images',
        command: 'docker compose up -d',
        note: 'Restarts containers with new version'
      },
      {
        description: 'Watch logs for startup (optional)',
        command: 'docker compose logs -f backend',
        note: 'Press Ctrl+C to exit logs',
        optional: true
      }
    ];
    instructions.warnings.push('Make sure you are in the directory containing your docker-compose.yml file');
  } else if (env.isGit) {
    instructions.environmentName = 'Git (Development)';
    instructions.steps = [
      {
        description: 'Fetch latest changes',
        command: 'git fetch origin',
        note: 'Downloads references from remote'
      },
      {
        description: 'Switch to new version tag',
        command: `git checkout v${targetVersion}`,
        note: 'Switches to the release version'
      },
      {
        description: 'Install backend dependencies',
        command: 'cd backend && npm install',
        note: 'Updates npm packages'
      },
      {
        description: 'Build frontend',
        command: 'cd frontend && npm install && npm run build',
        note: 'Compiles the frontend application'
      },
      {
        description: 'Run database migrations',
        command: 'cd backend && npm run migrate',
        note: 'Updates database schema'
      },
      {
        description: 'Restart application',
        command: '# Restart your application (pm2, systemd, etc.)',
        note: 'Method depends on your setup - e.g., pm2 restart picpeak'
      }
    ];
    instructions.warnings.push('Adjust the restart command based on your process manager (pm2, systemd, etc.)');
  } else {
    instructions.environmentName = 'Standalone';
    instructions.steps = [
      {
        description: 'Download release archive',
        command: `# Download v${targetVersion} from GitHub Releases`,
        note: `https://github.com/PicPeak/picpeak/releases/tag/v${targetVersion}`
      },
      {
        description: 'Backup current installation',
        command: '# Create backup of current files',
        note: 'Keep a copy of your current installation'
      },
      {
        description: 'Extract and replace application files',
        command: '# Extract release archive to installation directory',
        note: 'Preserve your .env file and storage directory'
      },
      {
        description: 'Install dependencies',
        command: 'cd backend && npm install --production',
        note: 'Updates npm packages'
      },
      {
        description: 'Run database migrations',
        command: 'cd backend && npm run migrate',
        note: 'Updates database schema'
      },
      {
        description: 'Restart application',
        command: '# Restart your application service',
        note: 'Method depends on your setup'
      }
    ];
    instructions.warnings.push('Make sure to preserve your .env file and storage directory when updating');
    instructions.warnings.push('Consider creating a full backup before updating');
  }

  return instructions;
}

module.exports = {
  detectEnvironment,
  generateUpdateInstructions
};

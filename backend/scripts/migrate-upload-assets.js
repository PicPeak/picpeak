#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const fsp = fs.promises;

async function pathExists(location) {
  try {
    await fsp.access(location);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function moveFile(source, destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fsp.rename(source, destination);
  } catch (error) {
    if (error.code === 'EXDEV') {
      await fsp.copyFile(source, destination);
      await fsp.unlink(source);
    } else if (error.code === 'EEXIST') {
      console.warn(`Destination already exists, leaving original in place: ${destination}`);
      return;
    } else {
      throw error;
    }
  }
}

async function migrate() {
  const backendRoot = path.resolve(__dirname, '..');
  const defaultStorage = path.resolve(backendRoot, '../storage');
  const targetStorage = path.resolve(process.env.STORAGE_PATH || defaultStorage);
  const legacyUploadsRoot = path.resolve(backendRoot, 'storage/uploads');
  const targetUploadsRoot = path.join(targetStorage, 'uploads');

  if (legacyUploadsRoot === targetUploadsRoot) {
    console.log('Legacy uploads directory already matches target STORAGE_PATH. Nothing to migrate.');
    return;
  }

  if (!fs.existsSync(legacyUploadsRoot)) {
    console.log(`Legacy uploads directory not found at ${legacyUploadsRoot}. Nothing to migrate.`);
    return;
  }

  const categories = ['logos', 'favicons'];
  let migratedCounter = 0;

  for (const category of categories) {
    const legacyDir = path.join(legacyUploadsRoot, category);
    if (!fs.existsSync(legacyDir)) {
      continue;
    }

    const targetDir = path.join(targetUploadsRoot, category);
    await fsp.mkdir(targetDir, { recursive: true });

    const entries = await fsp.readdir(legacyDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const sourcePath = path.join(legacyDir, entry.name);
      const destinationPath = path.join(targetDir, entry.name);

      if (await pathExists(destinationPath)) {
        console.warn(`Skipping ${sourcePath} because ${destinationPath} already exists.`);
        continue;
      }

      await moveFile(sourcePath, destinationPath);
      migratedCounter += 1;
    }

    const remaining = await fsp.readdir(legacyDir);
    if (remaining.length === 0) {
      await fsp.rm(legacyDir, { recursive: true, force: true });
    }
  }

  if (migratedCounter === 0) {
    console.log('No legacy logo or favicon files needed migration.');
    return;
  }

  console.log(`Migrated ${migratedCounter} files into ${targetUploadsRoot}.`);
  console.log('If the database still references legacy absolute paths, they will be cleaned up automatically on the next upload.');
}

migrate().catch((error) => {
  console.error('Migration failed:', error);
  process.exitCode = 1;
});

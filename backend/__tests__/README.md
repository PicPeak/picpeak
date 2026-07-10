# Enhanced Backup System Test Suite

This directory contains comprehensive tests for the enhanced backup system with S3 support.

## Test Structure

### Unit Tests
- `services/backupService.enhanced.test.js` - Unit tests for the enhanced backup service
  - Configuration management
  - S3 backup functionality
  - Manifest generation
  - Error handling and recovery
  - Backward compatibility (local and rsync)
  - Service lifecycle management

### Integration Tests
- `integration/backup-s3.test.js` - Integration tests for S3 backups
  - Real S3/MinIO connection tests
  - Full backup process with actual files
  - Incremental backup verification
  - Manifest storage and retrieval
  - Error recovery scenarios

### Manual Integration Test Script
- `../scripts/test-backup-integration.js` - Comprehensive manual testing script
  - Can test against MinIO, AWS S3, or any S3-compatible service
  - Tests all backup types (S3, local, rsync)
  - Performance testing with large files
  - Detailed progress reporting

## Running Tests

### Prerequisites

1. **For Unit Tests**: No special setup required, all dependencies are mocked.

2. **For Integration Tests**: Requires a running S3-compatible service (MinIO recommended)
   ```bash
   # Start MinIO using Docker
   docker run -d \
     -p 9000:9000 \
     -p 9001:9001 \
     --name minio-test \
     -e MINIO_ROOT_USER=minioadmin \
     -e MINIO_ROOT_PASSWORD=minioadmin \
     minio/minio server /data --console-address ":9001"
   ```

3. **Environment Variables** (for integration tests):
   ```bash
   # Optional - defaults work with local MinIO
   export TEST_S3_ENDPOINT=http://localhost:9000
   export TEST_S3_ACCESS_KEY=minioadmin
   export TEST_S3_SECRET_KEY=minioadmin
   
   # Skip S3 tests if no S3 service available
   export SKIP_S3_TESTS=true
   ```

### Running Unit Tests

```bash
# Run all backup service tests
npm test -- __tests__/services/backupService.enhanced.test.js

# Run specific test suite
npm test -- __tests__/services/backupService.enhanced.test.js -t "S3 Backup Functionality"

# Run with coverage
npm test -- --coverage __tests__/services/backupService.enhanced.test.js
```

### Running Integration Tests

```bash
# Ensure MinIO is running first!

# Run S3 integration tests
npm test -- __tests__/integration/backup-s3.test.js

# Run with verbose output
npm test -- __tests__/integration/backup-s3.test.js --verbose

# Skip S3 tests if needed
SKIP_S3_TESTS=true npm test -- __tests__/integration/backup-s3.test.js
```

### Running Manual Integration Tests

```bash
# Test with local MinIO (default)
node scripts/test-backup-integration.js

# Test with AWS S3
node scripts/test-backup-integration.js \
  --endpoint https://s3.amazonaws.com \
  --access-key YOUR_ACCESS_KEY \
  --secret-key YOUR_SECRET_KEY \
  --bucket your-test-bucket

# Test local backup
node scripts/test-backup-integration.js --type local

# Test with cleanup after completion
node scripts/test-backup-integration.js --cleanup

# Verbose output
node scripts/test-backup-integration.js --verbose
```

## Test Coverage

The test suite covers:

### Configuration
- ✅ Database configuration retrieval
- ✅ JSON parsing and error handling
- ✅ Configuration validation
- ✅ Required field validation

### S3 Functionality
- ✅ S3 client initialization
- ✅ Connection testing
- ✅ File upload with progress tracking
- ✅ Large file handling (multipart upload)
- ✅ Metadata and custom headers
- ✅ Error handling and retries

### Backup Process
- ✅ Full backup execution
- ✅ Incremental backup (changed files only)
- ✅ File checksum calculation and comparison
- ✅ Database backup inclusion
- ✅ Archive inclusion toggle
- ✅ File size limits

### Manifest Generation
- ✅ Full manifest generation
- ✅ Incremental manifest with parent reference
- ✅ JSON and YAML format support
- ✅ Manifest validation
- ✅ S3 manifest storage and retrieval
- ✅ Checksum verification

### Error Handling
- ✅ S3 connection failures
- ✅ File read errors
- ✅ Individual file failure recovery
- ✅ Retry logic with exponential backoff
- ✅ Email notifications on failure
- ✅ Concurrent backup prevention

### Backward Compatibility
- ✅ Local directory backup
- ✅ Rsync backup
- ✅ Existing manifest format support

### Service Management
- ✅ Cron job scheduling
- ✅ Service start/stop
- ✅ Manual backup triggering
- ✅ Backup history and status

## Mock Setup

The unit tests use comprehensive mocking:

```javascript
// Database mocking
jest.mock('../../src/database/db');

// S3 client mocking
jest.mock('../../src/services/storage/s3Storage');

// File system mocking
const mockFs = require('mock-fs');

// Cron job mocking
jest.mock('node-cron');
```

## CI/CD Integration

To run tests in CI/CD pipeline:

```yaml
# Example GitHub Actions
- name: Run Unit Tests
  run: npm test -- __tests__/services/backupService.enhanced.test.js

- name: Start MinIO
  run: |
    docker run -d \
      -p 9000:9000 \
      --name minio-test \
      -e MINIO_ROOT_USER=minioadmin \
      -e MINIO_ROOT_PASSWORD=minioadmin \
      minio/minio server /data

- name: Run Integration Tests
  run: npm test -- __tests__/integration/backup-s3.test.js
```

## Debugging Tests

```bash
# Run tests in debug mode
node --inspect-brk ./node_modules/.bin/jest __tests__/services/backupService.enhanced.test.js

# Run single test with console output
npm test -- __tests__/services/backupService.enhanced.test.js -t "should perform S3 backup" --verbose
```

## Performance Considerations

- Integration tests create real files and S3 objects
- Each test run creates a unique S3 bucket to avoid conflicts
- Cleanup is automatic but can be disabled for debugging
- Large file tests (10MB+) are included but can be slow

## Adding New Tests

When adding new backup features:

1. Add unit tests to `backupService.enhanced.test.js`
2. Add integration tests to `backup-s3.test.js` if S3-specific
3. Update manual test script for comprehensive testing
4. Ensure mocks are properly configured
5. Document any new environment requirements
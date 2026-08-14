const S3StorageAdapter = require('../s3Storage');
const { S3Client, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const fs = require('fs');
const stream = require('stream');

// Mock AWS SDK
jest.mock('@aws-sdk/client-s3');
jest.mock('@aws-sdk/lib-storage');
jest.mock('@aws-sdk/s3-request-presigner');

describe('S3StorageAdapter', () => {
  let mockS3Client;
  let mockSend;
  let s3Storage;
  
  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    
    // Mock S3Client
    mockSend = jest.fn();
    mockS3Client = {
      send: mockSend
    };
    S3Client.mockImplementation(() => mockS3Client);

    HeadBucketCommand.mockImplementation((input) => ({ input }));
    HeadObjectCommand.mockImplementation((input) => ({ input }));
    ListObjectsV2Command.mockImplementation((input) => ({ input }));
    
    // Create adapter instance
    s3Storage = new S3StorageAdapter({
      bucket: 'test-bucket',
      region: 'us-east-1',
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret'
    });
  });
  
  describe('constructor', () => {
    it('should initialize with required config', () => {
      expect(s3Storage.bucket).toBe('test-bucket');
      expect(s3Storage.config.region).toBe('us-east-1');
    });
    
    it('should throw error if bucket is not provided', () => {
      expect(() => {
        new S3StorageAdapter({ region: 'us-east-1' });
      }).toThrow('S3 bucket name is required');
    });
    
    it('should configure for MinIO with path style', () => {
      const minioStorage = new S3StorageAdapter({
        bucket: 'test-bucket',
        endpoint: 'http://localhost:9000',
        forcePathStyle: true,
        sslEnabled: false
      });
      
      expect(S3Client).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'http://localhost:9000',
          forcePathStyle: true
        })
      );
    });

    it('should configure connection and socket-inactivity timeouts by default', () => {
      expect(S3Client).toHaveBeenCalledWith(
        expect.objectContaining({
          requestHandler: {
            connectionTimeout: 120000,
            socketTimeout: 60000
          }
        })
      );
    });

    it('should keep connectionTimeout generous enough to survive socket-pool queuing', () => {
      // connectionTimeout starts at request creation and only clears once a
      // socket is assigned AND connected, so waiting for a free socket from
      // the agent pool counts against it. A short value (e.g. 10s) fails
      // every read under concurrent upload load. These timeouts bound an
      // infinite hang; they are not latency targets.
      const [[config]] = S3Client.mock.calls;
      expect(config.requestHandler.connectionTimeout).toBeGreaterThanOrEqual(60000);
      expect(config.requestHandler.socketTimeout).toBeGreaterThanOrEqual(30000);
    });

    it('should not set requestTimeout, which caps total duration and only warns', () => {
      // requestTimeout would abort legitimate large uploads (it is a
      // total-duration cap, not inactivity) and by default only logs a
      // warning — it needs throwOnRequestTimeout to abort at all.
      const [[config]] = S3Client.mock.calls;
      expect(config.requestHandler).not.toHaveProperty('requestTimeout');
    });

    it('should allow overriding timeouts via config', () => {
      new S3StorageAdapter({
        bucket: 'test-bucket',
        connectionTimeout: 5000,
        socketTimeout: 30000
      });

      expect(S3Client).toHaveBeenLastCalledWith(
        expect.objectContaining({
          requestHandler: {
            connectionTimeout: 5000,
            socketTimeout: 30000
          }
        })
      );
    });
  });
  
  describe('testConnection', () => {
    it('should successfully test connection', async () => {
      mockSend.mockResolvedValueOnce({});
      
      const result = await s3Storage.testConnection();
      
      expect(result).toBe(true);
      expect(HeadBucketCommand).toHaveBeenCalledWith({ Bucket: 'test-bucket' });
    });
    
    it('should throw error on connection failure', async () => {
      mockSend.mockRejectedValueOnce(new Error('Access Denied'));
      
      await expect(s3Storage.testConnection()).rejects.toThrow('S3 connection test failed');
    });
  });
  
  describe('upload', () => {
    let mockUpload;
    let mockDone;
    
    beforeEach(() => {
      mockDone = jest.fn().mockResolvedValue({
        Location: 'https://test-bucket.s3.amazonaws.com/test-key',
        ETag: '"test-etag"'
      });
      
      mockUpload = {
        on: jest.fn().mockReturnThis(),
        done: mockDone
      };
      
      Upload.mockImplementation(() => mockUpload);
      
      // Mock fs.stat
      jest.spyOn(fs.promises, 'stat').mockResolvedValue({
        size: 1024
      });
      
      // Mock fs.createReadStream
      jest.spyOn(fs, 'createReadStream').mockReturnValue(new stream.Readable());
    });
    
    afterEach(() => {
      jest.restoreAllMocks();
    });
    
    it('should upload file successfully', async () => {
      const result = await s3Storage.upload('/path/to/file.jpg', 'test-key');
      
      expect(result.Location).toBe('https://test-bucket.s3.amazonaws.com/test-key');
      expect(Upload).toHaveBeenCalledWith(
        expect.objectContaining({
          client: mockS3Client,
          params: expect.objectContaining({
            Bucket: 'test-bucket',
            Key: 'test-key',
            ContentType: 'application/octet-stream'
          })
        })
      );
    });
    
    it('should track upload progress', async () => {
      const onProgress = jest.fn();
      Upload.mockImplementation(() => {
        const uploadInstance = {
          on: jest.fn((event, handler) => {
            if (event === 'httpUploadProgress') {
              handler({ loaded: 512, total: 1024 });
            }
            return uploadInstance;
          }),
          done: mockDone
        };
        return uploadInstance;
      });

      const uploadPromise = s3Storage.upload('/path/to/file.jpg', 'test-key', {
        onProgress
      });

      await uploadPromise;

      expect(onProgress).toHaveBeenCalledWith(512, 1024);
    });
    
    it('should emit upload events', async () => {
      const uploadStartSpy = jest.fn();
      const uploadCompleteSpy = jest.fn();
      
      s3Storage.on('uploadStart', uploadStartSpy);
      s3Storage.on('uploadComplete', uploadCompleteSpy);
      
      await s3Storage.upload('/path/to/file.jpg', 'test-key');
      
      expect(uploadStartSpy).toHaveBeenCalledWith({ key: 'test-key', size: 1024 });
      expect(uploadCompleteSpy).toHaveBeenCalledWith({
        key: 'test-key',
        location: 'https://test-bucket.s3.amazonaws.com/test-key'
      });
    });
  });
  
  describe('exists', () => {
    it('should return true if object exists', async () => {
      mockSend.mockResolvedValueOnce({});
      
      const result = await s3Storage.exists('test-key');
      
      expect(result).toBe(true);
      expect(HeadObjectCommand).toHaveBeenCalledWith({
        Bucket: 'test-bucket',
        Key: 'test-key'
      });
    });
    
    it('should return false if object does not exist', async () => {
      const error = new Error('Not Found');
      error.name = 'NotFound';
      error.$metadata = { httpStatusCode: 404 };
      mockSend.mockRejectedValueOnce(error);
      
      const result = await s3Storage.exists('test-key');
      
      expect(result).toBe(false);
    });
  });
  
  describe('generateKey', () => {
    it('should generate unique key with timestamp and random string', () => {
      const key = s3Storage.generateKey('photo.jpg');
      
      expect(key).toMatch(/^\d+_[a-f0-9]{16}_photo\.jpg$/);
    });
    
    it('should add prefix if provided', () => {
      const key = s3Storage.generateKey('photo.jpg', 'events/wedding');
      
      expect(key).toMatch(/^events\/wedding\/\d+_[a-f0-9]{16}_photo\.jpg$/);
    });
    
    it('should sanitize filename', () => {
      const key = s3Storage.generateKey('my photo (1).jpg');
      
      expect(key).toMatch(/^\d+_[a-f0-9]{16}_my_photo__1_\.jpg$/);
    });
  });
  
  describe('retry logic', () => {
    it('should retry on retryable errors', async () => {
      const retryableError = new Error('Connection reset');
      retryableError.code = 'ECONNRESET';

      const operation = jest.fn()
        .mockRejectedValueOnce(retryableError)
        .mockResolvedValueOnce('success');

      const originalRandom = Math.random;
      const originalDelay = s3Storage.config.retryDelay;
      Math.random = jest.fn(() => 0);
      s3Storage.config.retryDelay = 0;

      const result = await s3Storage._retryOperation(operation);

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);

      Math.random = originalRandom;
      s3Storage.config.retryDelay = originalDelay;
    });
    
    it('should retry when the request handler times out a dead connection', async () => {
      // @smithy/node-http-handler rejects with name 'TimeoutError' for both
      // its connection-timeout and socket-inactivity timeouts
      const timeoutError = new Error('Connection timed out after 10000ms');
      timeoutError.name = 'TimeoutError';

      const operation = jest.fn()
        .mockRejectedValueOnce(timeoutError)
        .mockResolvedValueOnce('success');

      const originalRandom = Math.random;
      const originalDelay = s3Storage.config.retryDelay;
      Math.random = jest.fn(() => 0);
      s3Storage.config.retryDelay = 0;

      const result = await s3Storage._retryOperation(operation);

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);

      Math.random = originalRandom;
      s3Storage.config.retryDelay = originalDelay;
    });

    it('should not retry on non-retryable errors', async () => {
      const nonRetryableError = new Error('Invalid credentials');
      nonRetryableError.code = 'InvalidCredentials';
      
      const operation = jest.fn().mockRejectedValueOnce(nonRetryableError);

      await expect(s3Storage._retryOperation(operation)).rejects.toThrow('Invalid credentials');
      expect(operation).toHaveBeenCalledTimes(1);
    });
    
    it('should stop retrying after max attempts', async () => {
      const retryableError = new Error('Service unavailable');
      retryableError.code = 'ServiceUnavailable';
      
      const operation = jest.fn().mockRejectedValue(retryableError);

      const originalRandom = Math.random;
      const originalDelay = s3Storage.config.retryDelay;
      Math.random = jest.fn(() => 0);
      s3Storage.config.retryDelay = 0;

      await expect(s3Storage._retryOperation(operation)).rejects.toThrow('Service unavailable');
      expect(operation).toHaveBeenCalledTimes(4); // initial + 3 retries

      Math.random = originalRandom;
      s3Storage.config.retryDelay = originalDelay;
    });
  });
  
  describe('getStats', () => {
    it('should calculate storage statistics', async () => {
      mockSend.mockResolvedValueOnce({
        Contents: [
          { Key: 'file1.jpg', Size: 1024 },
          { Key: 'file2.jpg', Size: 2048 }
        ],
        NextContinuationToken: 'token123'
      }).mockResolvedValueOnce({
        Contents: [
          { Key: 'file3.jpg', Size: 3072 }
        ]
      });
      
      const stats = await s3Storage.getStats('events/');
      
      expect(stats).toEqual({
        totalSize: 6144,
        totalCount: 3,
        totalSizeFormatted: '6 KB'
      });
    });
  });
  
  describe('_formatBytes', () => {
    it('should format bytes correctly', () => {
      expect(s3Storage._formatBytes(0)).toBe('0 Bytes');
      expect(s3Storage._formatBytes(1024)).toBe('1 KB');
      expect(s3Storage._formatBytes(1048576)).toBe('1 MB');
      expect(s3Storage._formatBytes(1073741824)).toBe('1 GB');
      expect(s3Storage._formatBytes(1536, 1)).toBe('1.5 KB');
    });
  });
});

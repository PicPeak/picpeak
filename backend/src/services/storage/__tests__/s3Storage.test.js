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
      new S3StorageAdapter({
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

    it('should validate response checksums only when required', () => {
      // The default (WHEN_SUPPORTED) Body wrapper never closes the response
      // when destroyed, leaking a pool socket per abandoned download; see
      // s3Storage.socketRelease.test.js.
      const [[config]] = S3Client.mock.calls;
      expect(config.responseChecksumValidation).toBe('WHEN_REQUIRED');
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
  
  it('cancels real upload requests and waits for multipart cleanup before rejecting', async () => {
    const { PutObjectCommand, AbortMultipartUploadCommand } = require('@aws-sdk/client-s3');
    const controller = new AbortController(), input = new stream.PassThrough(); input.on('error', () => {});
    let entered, finish, settled = false;
    const started = new Promise(resolve => { entered = resolve; });
    mockSend.mockImplementation((command, options) => {
      if (command instanceof AbortMultipartUploadCommand) {
        expect(options.abortSignal).toBeUndefined();
        return new Promise(resolve => { finish = resolve; });
      }
      expect(options.abortSignal).toBe(controller.signal); entered();
      return new Promise((_resolve, reject) => options.abortSignal.addEventListener('abort', () => reject(options.abortSignal.reason), { once: true }));
    });
    Upload.mockImplementation(({ client }) => ({ on() {}, done: async () => {
      try { return await client.send(new PutObjectCommand({})); }
      catch (error) { await client.send(new AbortMultipartUploadCommand({})); throw error; }
    } }));
    const task = s3Storage.uploadStream(input, 'cancelled', { signal: controller.signal }).finally(() => { settled = true; });
    const failure = expect(task).rejects.toMatchObject({ name: 'AbortError' });
    await started; controller.abort(); await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false); expect(input.destroyed).toBe(true);
    finish({}); await failure;
  });
  it('lets multipart completion settle when cancellation arrives in the final phase', async () => {
    const { CompleteMultipartUploadCommand } = require('@aws-sdk/client-s3');
    const controller = new AbortController(), input = new stream.PassThrough(); input.on('error', () => {});
    let entered, finish, settled = false;
    const started = new Promise(resolve => { entered = resolve; });
    mockSend.mockImplementation((command, options) => {
      expect(command).toBeInstanceOf(CompleteMultipartUploadCommand);
      expect(options.abortSignal).toBeUndefined(); entered();
      return new Promise(resolve => { finish = resolve; });
    });
    Upload.mockImplementation(({ client }) => ({ on() {}, done: () => client.send(new CompleteMultipartUploadCommand({})) }));
    const task = s3Storage.uploadStream(input, 'finishing', { signal: controller.signal }).finally(() => { settled = true; });
    const failure = expect(task).rejects.toMatchObject({ name: 'AbortError' });
    await started; controller.abort(); await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false); finish({ Location: 'finished' });
    await failure;
  });
  it.each(['upload', 'uploadStream'])('never repeats done() on one single-use %s Upload', async method => {
    const error = Object.assign(new Error('SDK request retries exhausted'), { code: 'ServiceUnavailable' });
    const done = jest.fn().mockRejectedValueOnce(error).mockRejectedValue(new Error('Upload already used'));
    Upload.mockImplementation(() => ({ on() {}, done }));
    const input = stream.Readable.from('file');
    const read = jest.spyOn(fs, 'createReadStream').mockReturnValue(input);
    const stat = jest.spyOn(fs.promises, 'stat').mockResolvedValue({ size: 4 });
    try {
      await expect(s3Storage[method](method === 'upload' ? '/fixture' : stream.Readable.from('file'), 'key')).rejects.toBe(error);
      expect(done).toHaveBeenCalledTimes(1);
      if (method === 'upload') expect(input.destroyed).toBe(true);
    } finally { read.mockRestore(); stat.mockRestore(); }
  });

});

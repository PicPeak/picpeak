const { S3Client, HeadBucketCommand, HeadObjectCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, CopyObjectCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const logger = require('../../utils/logger');
const {
  S3EndpointError, policyApplies, assertLiteralEndpointAllowed, assertS3EndpointAllowed, s3EndpointAgents,
} = require('../../utils/s3EndpointPolicy');

/**
 * S3 Storage Adapter for handling file uploads to S3 and S3-compatible services
 * 
 * Features:
 * - Support for S3 and S3-compatible services (MinIO, DigitalOcean Spaces, etc.)
 * - Multipart upload via @aws-sdk/lib-storage
 * - Progress callbacks
 * - Retry logic with exponential backoff
 * - Stream support for memory efficiency
 * - Path-style URL support for MinIO
 * - Connection testing
 * - Comprehensive error handling
 * 
 * @class S3StorageAdapter
 */
class S3StorageAdapter {
  /**
   * Creates an instance of S3StorageAdapter
   * 
   * @param {Object} config - Configuration object
   * @param {string} config.bucket - S3 bucket name
   * @param {string} [config.region='us-east-1'] - AWS region
   * @param {string} [config.endpoint] - Custom endpoint URL for S3-compatible services
   * @param {string} [config.accessKeyId] - AWS access key ID
   * @param {string} [config.secretAccessKey] - AWS secret access key
   * @param {boolean} [config.forcePathStyle=false] - Force path-style URLs (required for MinIO)
   * @param {boolean} [config.sslEnabled=true] - Enable SSL for connections
   * @param {number} [config.partSize=10485760] - Part size for multipart upload (default 10MB)
   * @param {number} [config.maxRetries=3] - Maximum number of retry attempts
   * @param {number} [config.retryDelay=1000] - Initial retry delay in milliseconds
   * @param {number} [config.connectionTimeout=120000] - Ms to acquire+establish a socket
   * @param {number} [config.socketTimeout=60000] - Ms of socket inactivity before a request fails
   * @param {http.Agent} [config.httpAgent] - Pre-built http.Agent to pin connections to a
   *   DNS-resolved address set (see utils/pinnedRequest). Opt-in; when omitted the SDK's
   *   default agent (its own DNS resolution) is used, matching prior behavior.
   * @param {https.Agent} [config.httpsAgent] - Same as httpAgent, for TLS connections.
   * @param {boolean} [config.allowPrivateEndpoint=false] - A Super Admin approved this exact
   *   private endpoint origin (backup_s3_private_endpoint_approval). Production only.
   */
  constructor(config) {
    // Validate required config
    if (!config.bucket) {
      throw new Error('S3 bucket name is required');
    }
    
    // Set defaults
    this.config = {
      region: 'us-east-1',
      forcePathStyle: false,
      sslEnabled: true,
      partSize: 10 * 1024 * 1024, // 10MB
      maxRetries: 3,
      retryDelay: 1000,
      connectionTimeout: 120000,
      socketTimeout: 60000,
      ...config
    };
    
    // Initialize S3 client
    const s3Config = {
      region: this.config.region,
      forcePathStyle: this.config.forcePathStyle,
      // Without timeouts a silently dropped connection leaves the request —
      // and with it every queued upload — hanging forever.
      //
      // socketTimeout, NOT requestTimeout, is the right knob here:
      // requestTimeout is a total-duration cap that would kill legitimate
      // large uploads, and by default it only logs a warning (it needs
      // throwOnRequestTimeout to abort at all). socketTimeout fires on
      // socket INACTIVITY and destroys the request with a TimeoutError, so
      // an active transfer of any size is safe and only a dead line trips.
      //
      // Both values are deliberately GENEROUS. connectionTimeout starts
      // when the request object is created and only clears once a socket
      // is both assigned and connected — so time spent queuing for a free
      // socket from the agent pool (maxSockets 50) counts against it. A
      // 10s value looks reasonable and is not: under concurrent uploads
      // it expires while merely waiting in line, and every read (photo
      // download, thumbnail, background thumbnailing) fails with
      // TimeoutError. These timeouts exist to convert an INFINITE hang
      // into a bounded failure, not to enforce latency targets.
      requestHandler: {
        connectionTimeout: this.config.connectionTimeout,
        socketTimeout: this.config.socketTimeout,
        // Opt-in DNS pinning (see utils/pinnedRequest): only set when a
        // caller explicitly passes agents built from a resolved address
        // set. Every other caller leaves these undefined and gets the
        // SDK's default agent behavior, unchanged.
        ...(this.config.httpAgent && { httpAgent: this.config.httpAgent }),
        ...(this.config.httpsAgent && { httpsAgent: this.config.httpsAgent })
      },
      // Validate response checksums only when the caller asks for one.
      // The SDK default (WHEN_SUPPORTED) wraps every GetObject Body in a
      // ChecksumStream that pipes the real response into itself and has no
      // _destroy, so destroying a half-read Body (a cancelled zip build, a
      // client that disconnects) pauses the response but never closes it.
      // Its socket stays checked out of the pool for good, socketTimeout
      // does not reclaim it (the handler clears that timer once headers
      // arrive), and after 50 of them every S3 call waits forever. Fixed in
      // @smithy/core 3.27.0 (client-s3 >= 3.1076.0); this setting keeps any
      // older resolution safe. Uploads keep their request checksums.
      // See s3Storage.socketRelease.test.js.
      responseChecksumValidation: 'WHEN_REQUIRED'
    };
    
    // Add credentials if provided
    if (this.config.accessKeyId && this.config.secretAccessKey) {
      s3Config.credentials = {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey
      };
    }
    
    // Add custom endpoint if provided (for S3-compatible services)
    if (this.config.endpoint) {
      let endpoint = this.config.endpoint;

      // Only add protocol if endpoint doesn't already have one
      const hasProtocol = endpoint.startsWith('http://') || endpoint.startsWith('https://');
      if (!hasProtocol) {
        // Add protocol based on sslEnabled setting
        endpoint = this.config.sslEnabled ? `https://${endpoint}` : `http://${endpoint}`;
      }

      // SSRF protection, production only (dev points at localhost MinIO
      // deliberately). A private endpoint needs allowPrivateEndpoint, which
      // callers set only when a Super Admin approved this exact origin
      // (utils/s3EndpointPolicy). IP literals and internal names are decided
      // here; hostnames by the agents below, on every connection, so a DNS
      // answer that changes after this point cannot reach an internal address.
      if (policyApplies()) {
        const policy = { sslEnabled: this.config.sslEnabled, allowPrivate: this.config.allowPrivateEndpoint === true };
        assertLiteralEndpointAllowed(endpoint, policy);
        if (!this.config.httpAgent && !this.config.httpsAgent) {
          Object.assign(s3Config.requestHandler, s3EndpointAgents(endpoint, policy));
        }
      }

      s3Config.endpoint = endpoint;

      // For S3-compatible services with custom endpoints, force path style
      // This is required for MinIO and when using IP addresses
      if (!s3Config.forcePathStyle) {
        s3Config.forcePathStyle = true;
        logger.info('Automatically enabling forcePathStyle for custom S3 endpoint');
      }
    }
    
    this.s3Client = new S3Client(s3Config);
    this.bucket = this.config.bucket;
    
    // Bind methods to preserve context
    this.upload = this.upload.bind(this);
    this.uploadStream = this.uploadStream.bind(this);
    this.download = this.download.bind(this);
    this.downloadStream = this.downloadStream.bind(this);
    this.delete = this.delete.bind(this);
    this.exists = this.exists.bind(this);
    this.list = this.list.bind(this);
    this.copy = this.copy.bind(this);
    this.getSignedUrl = this.getSignedUrl.bind(this);
    this.testConnection = this.testConnection.bind(this);
  }
  
  /**
   * Test connection to S3 bucket
   * 
   * @returns {Promise<boolean>} - True if connection successful
   * @throws {Error} - If connection fails
   */
  async testConnection() {
    try {
      // Resolve-and-vet the custom endpoint before the network round-trip
      // (the constructor's literal check can't catch a public-looking
      // hostname that resolves to an internal IP). Prod-only, matching the
      // constructor gate — dev points at localhost MinIO deliberately.
      await assertS3EndpointAllowed(this.config.endpoint, {
        sslEnabled: this.config.sslEnabled,
        allowPrivate: this.config.allowPrivateEndpoint === true,
      });
      await this.s3Client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      logger.info(`Successfully connected to S3 bucket: ${this.bucket}`);
      return true;
    } catch (error) {
      logger.error(`Failed to connect to S3 bucket ${this.bucket}:`, error);
      const wrapped = new Error(`S3 connection test failed: ${error.message}`);
      // Keep the policy's stable code for callers that answer with it.
      if (error instanceof S3EndpointError) wrapped.code = error.code;
      throw wrapped;
    }
  }
  
  /**
   * Upload a file to S3 with automatic multipart for large files
   * 
   * @param {string} localPath - Local file path to upload
   * @param {string} s3Key - S3 object key (path in bucket)
   * @param {Object} [options={}] - Additional options
   * @param {Object} [options.metadata] - Object metadata
   * @param {string} [options.contentType] - Content type
   * @param {string} [options.cacheControl] - Cache control header
   * @param {Function} [options.onProgress] - Progress callback function(loaded, total)
   * @returns {Promise<Object>} - Upload result with Location, ETag, etc.
   */
  async upload(localPath, s3Key, options = {}) {
    let fileStream;
    try {
      // Fails on a missing file before the upload starts.
      await fsPromises.stat(localPath);
      
      // Create file stream
      fileStream = fs.createReadStream(localPath);
      
      // Prepare upload parameters
      const uploadParams = {
        Bucket: this.bucket,
        Key: s3Key,
        Body: fileStream,
        ContentType: options.contentType || 'application/octet-stream',
        ContentDisposition: options.contentDisposition,
        Metadata: options.metadata || {},
        CacheControl: options.cacheControl
      };
      
      // Remove undefined values
      Object.keys(uploadParams).forEach(key => uploadParams[key] === undefined && delete uploadParams[key]);
      
      // Use AWS SDK v3 Upload for automatic multipart handling
      const parallelUploads3 = new Upload({
        client: this.s3Client,
        params: uploadParams,
        queueSize: 4, // Optional: concurrent uploads
        partSize: this.config.partSize,
        leavePartsOnError: false
      });
      
      // Track upload progress
      parallelUploads3.on('httpUploadProgress', (progress) => {
        if (options.onProgress) {
          options.onProgress(progress.loaded, progress.total);
        }
      });
      
      // Upload is single-use; the SDK retries its individual requests.
      return await parallelUploads3.done();
    } catch (error) {
      logger.error(`Failed to upload file ${localPath} to S3:`, error);
      throw error;
    } finally { fileStream?.destroy(); }
  }
  
  /**
   * Upload a stream to S3
   * 
   * @param {stream.Readable} readStream - Readable stream to upload
   * @param {string} s3Key - S3 object key
   * @param {Object} [options={}] - Additional options
   * @returns {Promise<Object>} - Upload result
   */
  async uploadStream(readStream, s3Key, options = {}) {
    options.signal?.throwIfAborted();
    let client = this.s3Client;
    if (options.signal) {
      // Abort the real requests, not Upload.done()'s early-rejecting abort
      // race. done() must await the producers and multipart cleanup first.
      client = Object.create(this.s3Client);
      client.send = (command, sendOptions = {}) => this.s3Client.send(command, {
        ...sendOptions, ...(command instanceof AbortMultipartUploadCommand || command instanceof CompleteMultipartUploadCommand
          ? {} : { abortSignal: options.signal }),
      });
    }
    const uploadParams = {
      Bucket: this.bucket,
      Key: s3Key,
      Body: readStream,
      ContentType: options.contentType || 'application/octet-stream',
      ContentDisposition: options.contentDisposition,
      Metadata: options.metadata || {},
      CacheControl: options.cacheControl
    };
    
    // Remove undefined values
    Object.keys(uploadParams).forEach(key => uploadParams[key] === undefined && delete uploadParams[key]);
    
    const parallelUploads3 = new Upload({
      client,
      params: uploadParams,
      queueSize: 4,
      partSize: this.config.partSize,
      leavePartsOnError: false
    });
    
    // Track progress if callback provided
    if (options.onProgress) {
      parallelUploads3.on('httpUploadProgress', (progress) => {
        options.onProgress(progress.loaded, progress.total);
      });
    }
    
    const abort = () => readStream.destroy(options.signal.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      options.signal?.throwIfAborted();
      const result = await parallelUploads3.done();
      options.signal?.throwIfAborted();
      return result;
    } finally { options.signal?.removeEventListener('abort', abort); }
  }
  
  /**
   * Download a file from S3
   * 
   * @param {string} s3Key - S3 object key
   * @param {string} localPath - Local file path to save to
   * @param {Object} [options={}] - Additional options
   * @param {Function} [options.onProgress] - Progress callback
   * @returns {Promise<void>}
   */
  async download(s3Key, localPath, options = {}) {
    try {
      // Ensure directory exists
      await fsPromises.mkdir(path.dirname(localPath), { recursive: true });
      
      // Get object metadata first for progress tracking
      const headResult = await this._retryOperation(() => 
        this.s3Client.send(new HeadObjectCommand({ 
          Bucket: this.bucket, 
          Key: s3Key 
        }))
      );
      
      const fileSize = headResult.ContentLength;
      
      // Get object
      const getObjectResult = await this._retryOperation(() =>
        this.s3Client.send(new GetObjectCommand({
          Bucket: this.bucket,
          Key: s3Key
        }))
      );
      
      // Create write stream
      const writeStream = fs.createWriteStream(localPath);
      
      // Download with progress tracking
      await new Promise((resolve, reject) => {
        let downloaded = 0;
        
        const bodyStream = getObjectResult.Body;
        
        bodyStream.on('data', (chunk) => {
          downloaded += chunk.length;
          if (options.onProgress) {
            options.onProgress(downloaded, fileSize);
          }
        });
        
        bodyStream.on('error', reject);
        writeStream.on('error', reject);
        writeStream.on('finish', resolve);
        
        bodyStream.pipe(writeStream);
      });
    } catch (error) {
      logger.error(`Failed to download file ${s3Key} from S3:`, error);
      throw error;
    }
  }
  
  /**
   * Get a download stream from S3
   * 
   * @param {string} s3Key - S3 object key
   * @param {Object} [options={}] - Additional options
   * @param {string} [options.range] - Byte range to download (e.g., 'bytes=0-1023')
   * @returns {Promise<stream.Readable>} - Readable stream
   */
  async downloadStream(s3Key, options = {}) {
    const params = {
      Bucket: this.bucket,
      Key: s3Key,
      Range: options.range,
      IfMatch: options.ifMatch,
      VersionId: options.versionId
    };
    
    // Remove undefined values
    Object.keys(params).forEach(key => params[key] === undefined && delete params[key]);
    
    const result = await this.s3Client.send(new GetObjectCommand(params), ...(options.signal ? [{ abortSignal: options.signal }] : []));
    return result.Body;
  }
  
  /**
   * Delete a file from S3
   * 
   * @param {string} s3Key - S3 object key
   * @returns {Promise<void>}
   */
  async delete(s3Key) {
    return await this._retryOperation(() =>
      this.s3Client.send(new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: s3Key
      }))
    );
  }
  
  /**
   * Delete multiple files from S3
   * 
   * @param {string[]} s3Keys - Array of S3 object keys
   * @returns {Promise<Object>} - Delete result
   */
  async deleteMany(s3Keys) {
    if (!s3Keys || s3Keys.length === 0) {
      return { Deleted: [], Errors: [] };
    }
    
    // S3 deleteObjects has a limit of 1000 keys per request
    const chunks = [];
    for (let i = 0; i < s3Keys.length; i += 1000) {
      chunks.push(s3Keys.slice(i, i + 1000));
    }
    
    const results = await Promise.all(
      chunks.map(chunk => 
        this._retryOperation(() =>
          this.s3Client.send(new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: {
              Objects: chunk.map(key => ({ Key: key })),
              Quiet: false
            }
          }))
        )
      )
    );
    
    // Combine results
    return {
      Deleted: results.flatMap(r => r.Deleted || []),
      Errors: results.flatMap(r => r.Errors || [])
    };
  }
  
  /**
   * Check if a file exists in S3
   * 
   * @param {string} s3Key - S3 object key
   * @returns {Promise<boolean>} - True if exists
   */
  async exists(s3Key) {
    try {
      await this.s3Client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: s3Key
      }));
      return true;
    } catch (error) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw error;
    }
  }
  
  /**
   * List files in S3
   * 
   * @param {string} prefix - S3 prefix to list
   * @param {Object} [options={}] - Additional options
   * @param {number} [options.maxKeys=1000] - Maximum number of keys to return
   * @param {string} [options.continuationToken] - Continuation token for pagination
   * @returns {Promise<Object>} - List result with Contents array and NextContinuationToken
   */
  async list(prefix, options = {}) {
    const params = {
      Bucket: this.bucket,
      Prefix: prefix,
      MaxKeys: options.maxKeys || 1000,
      ContinuationToken: options.continuationToken
    };
    
    return await this._retryOperation(() =>
      this.s3Client.send(new ListObjectsV2Command(params))
    );
  }
  
  /**
   * Copy a file within S3
   * 
   * @param {string} sourceKey - Source S3 object key
   * @param {string} targetKey - Target S3 object key
   * @param {Object} [options={}] - Additional options
   * @returns {Promise<Object>} - Copy result
   */
  async copy(sourceKey, targetKey, options = {}) {
    const copySource = `${this.bucket}/${sourceKey}`;
    
    const params = {
      Bucket: this.bucket,
      CopySource: copySource,
      Key: targetKey,
      MetadataDirective: options.metadata ? 'REPLACE' : 'COPY',
      Metadata: options.metadata,
      ContentType: options.contentType,
      CacheControl: options.cacheControl
    };
    
    // Remove undefined values
    Object.keys(params).forEach(key => params[key] === undefined && delete params[key]);
    
    return await this._retryOperation(() =>
      this.s3Client.send(new CopyObjectCommand(params))
    );
  }
  
  /**
   * Get a pre-signed URL for downloading or uploading
   * 
   * @param {string} operation - Operation type ('getObject' or 'putObject')
   * @param {string} s3Key - S3 object key
   * @param {Object} [options={}] - Additional options
   * @param {number} [options.expiresIn=3600] - URL expiration in seconds
   * @param {Object} [options.params] - Additional parameters for the operation
   * @returns {Promise<string>} - Pre-signed URL
   */
  async getSignedUrl(operation, s3Key, options = {}) {
    const params = {
      Bucket: this.bucket,
      Key: s3Key,
      ...options.params
    };
    
    let command;
    switch (operation.toLowerCase()) {
    case 'getobject':
      command = new GetObjectCommand(params);
      break;
    case 'putobject':
      command = new PutObjectCommand(params);
      break;
    default:
      throw new Error(`Unsupported operation: ${operation}`);
    }
    
    return await getSignedUrl(this.s3Client, command, {
      expiresIn: options.expiresIn || 3600
    });
  }
  
  /**
   * Get object metadata
   * 
   * @param {string} s3Key - S3 object key
   * @returns {Promise<Object>} - Object metadata
   */
  async getMetadata(s3Key) {
    return await this._retryOperation(() =>
      this.s3Client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: s3Key
      }))
    );
  }
  
  /**
   * Retry operation with exponential backoff
   * @private
   */
  async _retryOperation(operation, retryCount = 0) {
    try {
      return await operation();
    } catch (error) {
      if (retryCount >= this.config.maxRetries) {
        throw error;
      }
      
      // Check if error is retryable
      // 'TimeoutError' is what @smithy/node-http-handler names both its
      // connection-timeout and socket-inactivity rejections.
      const retryableErrors = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ESOCKETTIMEDOUT', 'RequestTimeout', 'TimeoutError', 'SlowDown', 'ServiceUnavailable', 'InternalError'];
      const isRetryable = retryableErrors.some(code => 
        error.code === code || 
        error.name === code || 
        error.$metadata?.httpStatusCode === 503 ||
        error.$metadata?.httpStatusCode === 500
      );
      
      if (!isRetryable) {
        throw error;
      }
      
      // Calculate delay with exponential backoff and jitter
      const delay = Math.min(
        this.config.retryDelay * Math.pow(2, retryCount) + Math.random() * 1000,
        30000 // Max 30 seconds
      );
      
      logger.warn(`Retrying operation after ${delay}ms (attempt ${retryCount + 1}/${this.config.maxRetries}):`, error.message);
      
      await new Promise(resolve => setTimeout(resolve, delay));
      
      return this._retryOperation(operation, retryCount + 1);
    }
  }
}

module.exports = S3StorageAdapter;

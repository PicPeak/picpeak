const { S3Client, HeadBucketCommand, HeadObjectCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, CopyObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const stream = require('stream');
const crypto = require('crypto');
const logger = require('../../utils/logger');

/**
 * S3 Storage Adapter for handling file uploads to S3 and S3-compatible services
 * 
 * Features:
 * - Support for S3 and S3-compatible services (MinIO, DigitalOcean Spaces, etc.)
 * - Multipart upload for large files (>100MB)
 * - Progress tracking with event emitter
 * - Retry logic with exponential backoff
 * - Stream support for memory efficiency
 * - Path-style URL support for MinIO
 * - Connection testing
 * - Comprehensive error handling
 * 
 * @class S3StorageAdapter
 */
class S3StorageAdapter extends stream.EventEmitter {
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
   * @param {number} [config.multipartThreshold=104857600] - Threshold for multipart upload (default 100MB)
   * @param {number} [config.partSize=10485760] - Part size for multipart upload (default 10MB)
   * @param {number} [config.maxRetries=3] - Maximum number of retry attempts
   * @param {number} [config.retryDelay=1000] - Initial retry delay in milliseconds
   */
  constructor(config) {
    super();
    
    // Validate required config
    if (!config.bucket) {
      throw new Error('S3 bucket name is required');
    }
    
    // Set defaults
    this.config = {
      region: 'us-east-1',
      forcePathStyle: false,
      sslEnabled: true,
      multipartThreshold: 100 * 1024 * 1024, // 100MB
      partSize: 10 * 1024 * 1024, // 10MB
      maxRetries: 3,
      retryDelay: 1000,
      ...config
    };
    
    // Initialize S3 client
    const s3Config = {
      region: this.config.region,
      forcePathStyle: this.config.forcePathStyle
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

      // SSRF protection: block private/internal S3 endpoints in production
      // Local endpoints (e.g. MinIO on localhost) are allowed in development
      if (process.env.NODE_ENV === 'production') {
        const { validateExternalUrl } = require('../../utils/networkValidation');
        const urlCheck = validateExternalUrl(endpoint);
        if (!urlCheck.valid) {
          throw new Error(`Invalid S3 endpoint: ${urlCheck.error}`);
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
    this.move = this.move.bind(this);
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
      await this.s3Client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      logger.info(`Successfully connected to S3 bucket: ${this.bucket}`);
      return true;
    } catch (error) {
      logger.error(`Failed to connect to S3 bucket ${this.bucket}:`, error);
      throw new Error(`S3 connection test failed: ${error.message}`);
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
    try {
      const stats = await fsPromises.stat(localPath);
      const fileSize = stats.size;
      
      // Emit upload start event
      this.emit('uploadStart', { key: s3Key, size: fileSize });
      
      // Create file stream
      const fileStream = fs.createReadStream(localPath);
      
      // Prepare upload parameters
      const uploadParams = {
        Bucket: this.bucket,
        Key: s3Key,
        Body: fileStream,
        ContentType: options.contentType || 'application/octet-stream',
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
        this.emit('uploadProgress', { key: s3Key, loaded: progress.loaded, total: progress.total });
      });
      
      // Perform upload with retry
      const result = await this._retryOperation(() => parallelUploads3.done());
      
      this.emit('uploadComplete', { key: s3Key, location: result.Location });
      return result;
    } catch (error) {
      logger.error(`Failed to upload file ${localPath} to S3:`, error);
      this.emit('uploadError', { key: s3Key, error });
      throw error;
    }
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
    const uploadParams = {
      Bucket: this.bucket,
      Key: s3Key,
      Body: readStream,
      ContentType: options.contentType || 'application/octet-stream',
      Metadata: options.metadata || {},
      CacheControl: options.cacheControl
    };
    
    // Remove undefined values
    Object.keys(uploadParams).forEach(key => uploadParams[key] === undefined && delete uploadParams[key]);
    
    const parallelUploads3 = new Upload({
      client: this.s3Client,
      params: uploadParams,
      queueSize: 4,
      partSize: this.config.partSize,
      leavePartsOnError: false
    });
    
    // Track progress if callback provided
    if (options.onProgress) {
      parallelUploads3.on('httpUploadProgress', (progress) => {
        options.onProgress(progress.loaded, progress.total);
        this.emit('uploadProgress', { key: s3Key, ...progress });
      });
    }
    
    return await this._retryOperation(() => parallelUploads3.done());
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
      this.emit('downloadStart', { key: s3Key, size: fileSize });
      
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
          this.emit('downloadProgress', { key: s3Key, loaded: downloaded, total: fileSize });
        });
        
        bodyStream.on('error', reject);
        writeStream.on('error', reject);
        writeStream.on('finish', resolve);
        
        bodyStream.pipe(writeStream);
      });
      
      this.emit('downloadComplete', { key: s3Key });
    } catch (error) {
      logger.error(`Failed to download file ${s3Key} from S3:`, error);
      this.emit('downloadError', { key: s3Key, error });
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
      Range: options.range
    };
    
    // Remove undefined values
    Object.keys(params).forEach(key => params[key] === undefined && delete params[key]);
    
    const result = await this.s3Client.send(new GetObjectCommand(params));
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
   * Move a file within S3 (copy then delete)
   * 
   * @param {string} sourceKey - Source S3 object key
   * @param {string} targetKey - Target S3 object key
   * @param {Object} [options={}] - Additional options
   * @returns {Promise<Object>} - Move result
   */
  async move(sourceKey, targetKey, options = {}) {
    // First copy the object
    const copyResult = await this.copy(sourceKey, targetKey, options);
    
    // Then delete the original
    await this.delete(sourceKey);
    
    return copyResult;
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
   * Update object metadata
   * 
   * @param {string} s3Key - S3 object key
   * @param {Object} metadata - New metadata
   * @returns {Promise<Object>} - Update result
   */
  async updateMetadata(s3Key, metadata) {
    // S3 requires copying the object to itself to update metadata
    return await this.copy(s3Key, s3Key, { metadata });
  }
  
  /**
   * Manual multipart upload for advanced use cases
   * 
   * @param {string} localPath - Local file path
   * @param {string} s3Key - S3 object key
   * @param {number} fileSize - File size in bytes
   * @param {Object} options - Upload options
   * @returns {Promise<Object>} - Upload result
   * @private
   */
  async _manualMultipartUpload(localPath, s3Key, fileSize, options) {
    logger.info(`Starting manual multipart upload for ${s3Key} (${fileSize} bytes)`);
    
    // Initiate multipart upload
    const multipartParams = {
      Bucket: this.bucket,
      Key: s3Key,
      ContentType: options.contentType || 'application/octet-stream',
      Metadata: options.metadata || {},
      CacheControl: options.cacheControl
    };
    
    // Remove undefined values
    Object.keys(multipartParams).forEach(key => multipartParams[key] === undefined && delete multipartParams[key]);
    
    const multipart = await this._retryOperation(() =>
      this.s3Client.send(new CreateMultipartUploadCommand(multipartParams))
    );
    
    const uploadId = multipart.UploadId;
    const partSize = this.config.partSize;
    const numParts = Math.ceil(fileSize / partSize);
    
    let uploaded = 0;
    const parts = [];
    
    try {
      // Upload parts
      for (let partNum = 1; partNum <= numParts; partNum++) {
        const start = (partNum - 1) * partSize;
        const end = Math.min(start + partSize, fileSize);
        
        const partStream = fs.createReadStream(localPath, {
          start,
          end: end - 1
        });
        
        const partParams = {
          Bucket: this.bucket,
          Key: s3Key,
          PartNumber: partNum,
          UploadId: uploadId,
          Body: partStream
        };
        
        // Upload part with retry
        const partResult = await this._retryOperation(() =>
          this.s3Client.send(new UploadPartCommand(partParams))
        );
        
        parts.push({
          ETag: partResult.ETag,
          PartNumber: partNum
        });
        
        uploaded += (end - start);
        
        if (options.onProgress) {
          options.onProgress(uploaded, fileSize);
        }
        this.emit('uploadProgress', { key: s3Key, loaded: uploaded, total: fileSize });
        
        logger.info(`Uploaded part ${partNum}/${numParts} for ${s3Key}`);
      }
      
      // Complete multipart upload
      const completeParams = {
        Bucket: this.bucket,
        Key: s3Key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts }
      };
      
      const result = await this._retryOperation(() =>
        this.s3Client.send(new CompleteMultipartUploadCommand(completeParams))
      );
      
      this.emit('uploadComplete', { key: s3Key, location: result.Location });
      logger.info(`Completed multipart upload for ${s3Key}`);
      
      return result;
    } catch (error) {
      // Abort multipart upload on error
      logger.error(`Multipart upload failed for ${s3Key}, aborting:`, error);
      
      try {
        await this.s3Client.send(new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: s3Key,
          UploadId: uploadId
        }));
      } catch (abortError) {
        logger.error(`Failed to abort multipart upload:`, abortError);
      }
      
      throw error;
    }
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
      const retryableErrors = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ESOCKETTIMEDOUT', 'RequestTimeout', 'SlowDown', 'ServiceUnavailable', 'InternalError'];
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
  
  /**
   * Generate a unique S3 key for a file
   * 
   * @param {string} originalName - Original filename
   * @param {string} [prefix=''] - Optional prefix for the key
   * @returns {string} - Generated S3 key
   */
  generateKey(originalName, prefix = '') {
    const timestamp = Date.now();
    const randomStr = crypto.randomBytes(8).toString('hex');
    const ext = path.extname(originalName);
    const basename = path.basename(originalName, ext);
    
    // Sanitize basename
    const safeName = basename.replace(/[^a-zA-Z0-9-_]/g, '_');
    
    const key = `${timestamp}_${randomStr}_${safeName}${ext}`;
    
    return prefix ? path.posix.join(prefix, key) : key;
  }
  
  /**
   * Get storage statistics
   * 
   * @param {string} [prefix=''] - Optional prefix to filter
   * @returns {Promise<Object>} - Storage statistics
   */
  async getStats(prefix = '') {
    let totalSize = 0;
    let totalCount = 0;
    let continuationToken;
    
    do {
      const result = await this.list(prefix, { continuationToken });
      
      if (result.Contents) {
        totalCount += result.Contents.length;
        totalSize += result.Contents.reduce((sum, obj) => sum + (obj.Size || 0), 0);
      }
      
      continuationToken = result.NextContinuationToken;
    } while (continuationToken);
    
    return {
      totalSize,
      totalCount,
      totalSizeFormatted: this._formatBytes(totalSize)
    };
  }
  
  /**
   * Format bytes to human readable format
   * @private
   */
  _formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }
}

module.exports = S3StorageAdapter;
/**
 * Example usage of the S3StorageAdapter
 * 
 * This file demonstrates how to use the S3 storage adapter for various operations
 */

const S3StorageAdapter = require('./s3Storage');

// Example 1: Basic AWS S3 Configuration
const s3Storage = new S3StorageAdapter({
  bucket: 'my-photo-bucket',
  region: 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

// Example 2: MinIO Configuration (S3-compatible)
const minioStorage = new S3StorageAdapter({
  bucket: 'photo-storage',
  endpoint: 'http://localhost:9000', // MinIO endpoint
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin',
  forcePathStyle: true, // Required for MinIO
  sslEnabled: false // For local development
});

// Example 3: DigitalOcean Spaces Configuration
const spacesStorage = new S3StorageAdapter({
  bucket: 'my-space-name',
  endpoint: 'https://nyc3.digitaloceanspaces.com',
  region: 'nyc3',
  accessKeyId: process.env.DO_SPACES_KEY,
  secretAccessKey: process.env.DO_SPACES_SECRET
});

// Usage Examples
async function examples() {
  try {
    // Test connection
    await s3Storage.testConnection();
    console.log('Connection successful!');
    
    // Upload a file with progress tracking
    const uploadResult = await s3Storage.upload(
      '/path/to/local/photo.jpg',
      'events/wedding-2024/photo.jpg',
      {
        contentType: 'image/jpeg',
        metadata: {
          event: 'wedding-2024',
          photographer: 'John Doe'
        },
        onProgress: (loaded, total) => {
          const percentage = Math.round((loaded / total) * 100);
          console.log(`Upload progress: ${percentage}%`);
        }
      }
    );
    console.log('Upload complete:', uploadResult.Location);
    
    // Upload from stream
    const readStream = fs.createReadStream('/path/to/large-video.mp4');
    await s3Storage.uploadStream(readStream, 'events/wedding-2024/video.mp4', {
      contentType: 'video/mp4',
      onProgress: (loaded, total) => {
        console.log(`Streamed ${loaded} of ${total} bytes`);
      }
    });
    
    // Download a file
    await s3Storage.download(
      'events/wedding-2024/photo.jpg',
      '/path/to/downloaded/photo.jpg',
      {
        onProgress: (loaded, total) => {
          const percentage = Math.round((loaded / total) * 100);
          console.log(`Download progress: ${percentage}%`);
        }
      }
    );
    
    // Get a download stream
    const downloadStream = await s3Storage.downloadStream('events/wedding-2024/photo.jpg');
    downloadStream.pipe(fs.createWriteStream('/path/to/output.jpg'));
    
    // List files
    const listing = await s3Storage.list('events/wedding-2024/');
    console.log(`Found ${listing.Contents.length} files`);
    listing.Contents.forEach(file => {
      console.log(`- ${file.Key} (${file.Size} bytes)`);
    });
    
    // Generate pre-signed URL for temporary access
    const downloadUrl = await s3Storage.getSignedUrl('getObject', 'events/wedding-2024/photo.jpg', {
      expiresIn: 3600 // 1 hour
    });
    console.log('Pre-signed download URL:', downloadUrl);
    
    // Generate pre-signed upload URL
    const uploadUrl = await s3Storage.getSignedUrl('putObject', 'events/wedding-2024/new-photo.jpg', {
      expiresIn: 1800, // 30 minutes
      params: {
        ContentType: 'image/jpeg'
      }
    });
    console.log('Pre-signed upload URL:', uploadUrl);
    
    // Check if file exists
    const exists = await s3Storage.exists('events/wedding-2024/photo.jpg');
    console.log('File exists:', exists);
    
    // Get metadata
    const metadata = await s3Storage.getMetadata('events/wedding-2024/photo.jpg');
    console.log('File metadata:', metadata);
    
    // Copy file
    await s3Storage.copy(
      'events/wedding-2024/photo.jpg',
      'events/wedding-2024/photo-copy.jpg'
    );
    
    // Move file
    await s3Storage.move(
      'events/wedding-2024/photo-copy.jpg',
      'events/wedding-2024/archived/photo.jpg'
    );
    
    // Delete file
    await s3Storage.delete('events/wedding-2024/temp-photo.jpg');
    
    // Delete multiple files
    const deleteResult = await s3Storage.deleteMany([
      'events/wedding-2024/temp1.jpg',
      'events/wedding-2024/temp2.jpg',
      'events/wedding-2024/temp3.jpg'
    ]);
    console.log(`Deleted ${deleteResult.Deleted.length} files`);
    
    // Get storage statistics
    const stats = await s3Storage.getStats('events/');
    console.log(`Total files: ${stats.totalCount}`);
    console.log(`Total size: ${stats.totalSizeFormatted}`);
    
    // Listen to events
    s3Storage.on('uploadProgress', (data) => {
      console.log(`Uploading ${data.key}: ${data.loaded}/${data.total}`);
    });
    
    s3Storage.on('uploadComplete', (data) => {
      console.log(`Upload completed: ${data.key}`);
    });
    
    s3Storage.on('uploadError', (data) => {
      console.error(`Upload failed for ${data.key}:`, data.error);
    });
    
  } catch (error) {
    console.error('Error:', error);
  }
}

// Integration with existing photo upload workflow
async function integrateWithPhotoUpload(eventId, files) {
  const storage = new S3StorageAdapter({
    bucket: process.env.S3_BUCKET,
    region: process.env.AWS_REGION,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  });
  
  const uploadedPhotos = [];
  
  for (const file of files) {
    try {
      // Generate unique S3 key
      const s3Key = storage.generateKey(file.originalname, `events/${eventId}`);
      
      // Upload to S3
      const result = await storage.upload(file.path, s3Key, {
        contentType: file.mimetype,
        metadata: {
          eventId: eventId,
          originalName: file.originalname,
          uploadedAt: new Date().toISOString()
        }
      });
      
      uploadedPhotos.push({
        filename: s3Key,
        originalName: file.originalname,
        size: file.size,
        mimeType: file.mimetype,
        s3Location: result.Location,
        s3Key: s3Key
      });
      
      // Clean up local temp file
      await fs.promises.unlink(file.path);
      
    } catch (error) {
      console.error(`Failed to upload ${file.originalname}:`, error);
      throw error;
    }
  }
  
  return uploadedPhotos;
}

// Environment variables needed:
// AWS_ACCESS_KEY_ID=your-access-key
// AWS_SECRET_ACCESS_KEY=your-secret-key
// AWS_REGION=us-east-1
// S3_BUCKET=your-bucket-name

// For MinIO:
// MINIO_ENDPOINT=http://localhost:9000
// MINIO_ACCESS_KEY=minioadmin
// MINIO_SECRET_KEY=minioadmin
// MINIO_BUCKET=photo-storage

module.exports = { examples, integrateWithPhotoUpload };
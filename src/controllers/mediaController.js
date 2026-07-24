import { minioClient, BUCKET_NAME } from '../services/minioClient.js';
import path from 'path';
import crypto from 'crypto';

/**
 * Takes a photo from the request, dumps it into MinIO, and returns the public URL to mobile.
 */
export const uploadMedia = async (c) => {
  try {
    // 1. Parse multipart form data from Hono request
    const body = await c.req.parseBody();
    const file = body.file; // Expecting key name 'file' in Postman/mobile request

    if (!file || typeof file === 'string') {
      return c.json({ success: false, message: 'No valid file provided' }, 400);
    }

    // 2. Generate a unique filename to prevent overwriting
    const fileExtension = path.extname(file.name) || '.jpg';
    const uniqueFileName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${fileExtension}`;

    // 3. Convert Hono File object to Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 4. Dump to MinIO
    await minioClient.putObject(
      BUCKET_NAME,
      uniqueFileName,
      buffer,
      buffer.length,
      { 'Content-Type': file.type || 'image/jpeg' }
    );

    // 5. Construct the public URL using MINIO_PUBLIC_URL (e.g., http://192.168.1.X:9000)
    const baseUrl = process.env.MINIO_PUBLIC_URL || 'http://localhost:9000';
    const publicUrl = `${baseUrl}/${BUCKET_NAME}/${uniqueFileName}`;

    // 6. Send the URL directly back to mobile
    return c.json({
      success: true,
      message: 'Image uploaded successfully',
      url: publicUrl,
    }, 200);

  } catch (error) {
    console.error('❌ MinIO Upload Controller Error:', error);
    return c.json({ 
      success: false, 
      message: 'Failed to upload media to MinIO', 
      error: error.message 
    }, 500);
  }
};
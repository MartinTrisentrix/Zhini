// services/r2.service.js
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const accountId = process.env.R2_ACCOUNT_ID;

export const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
  },
});

export const uploadToR2 = async (file, folder = "shop-images") => {
  if (!file || !(file instanceof File)) return null;

  const fileExtension = file.name.split(".").pop() || "jpg";
  const fileName = `${folder}/${Date.now()}-${Math.random().toString(36).substring(2, 8)}.${fileExtension}`;

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME || "app-images",
    Key: fileName,
    Body: buffer,
    ContentType: file.type || "image/jpeg",
  });

  await r2Client.send(command);

  const publicBaseUrl = process.env.R2_PUBLIC_URL;
  return `${publicBaseUrl}/${fileName}`;
};
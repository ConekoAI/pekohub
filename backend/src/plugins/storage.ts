import fp from 'fastify-plugin';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { FastifyInstance } from 'fastify';

export interface StorageService {
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  getSignedGetUrl(key: string, expiresIn?: number): Promise<string>;
  getSignedPutUrl(key: string, expiresIn?: number): Promise<string>;
}

async function storagePlugin(fastify: FastifyInstance) {
  const config = fastify.config;

  const client = new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY,
      secretAccessKey: config.S3_SECRET_KEY,
    },
    forcePathStyle: config.S3_FORCE_PATH_STYLE === 'true',
  });

  const bucket = config.S3_BUCKET;

  const storage: StorageService = {
    async put(key, body, contentType = 'application/octet-stream') {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        })
      );
    },

    async get(key) {
      const response = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key })
      );
      const chunks: Buffer[] = [];
      for await (const chunk of response.Body as AsyncIterable<Buffer>) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },

    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch {
        return false;
      }
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    async getSignedGetUrl(key, expiresIn = 3600) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn,
      });
    },

    async getSignedPutUrl(key, expiresIn = 3600) {
      return getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn,
      });
    },
  };

  fastify.decorate('storage', storage);
}

export default fp(storagePlugin);

declare module 'fastify' {
  interface FastifyInstance {
    storage: StorageService;
  }
}

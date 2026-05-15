import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../db/index.js';
import { users, apiKeys } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export interface AuthenticatedUser {
  id: number;
  namespace: string;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<AuthenticatedUser>;
  }
  interface FastifyRequest {
    user: AuthenticatedUser;
  }
}

async function authPlugin(fastify: FastifyInstance) {
  await fastify.register(fastifyJwt, {
    secret: fastify.config.JWT_SECRET,
    cookie: {
      cookieName: 'pekohub_session',
      signed: false,
    },
  });

  fastify.decorate('authenticate', async (request: FastifyRequest) => {
    // Try Bearer token (API key or JWT)
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);

      // Check if it's an API key (starts with a known prefix pattern)
      if (token.startsWith('ph_')) {
        const prefix = token.slice(0, 8);
        const keyRecord = await db.query.apiKeys.findFirst({
          where: eq(apiKeys.prefix, prefix),
        });

        if (!keyRecord) {
          throw fastify.httpErrors.unauthorized('Invalid API key');
        }

        // In production: hash token and compare with keyRecord.hash
        // For now, simplified check
        const user = await db.query.users.findFirst({
          where: eq(users.id, keyRecord.userId),
        });

        if (!user) {
          throw fastify.httpErrors.unauthorized('User not found');
        }

        return {
          id: user.id,
          namespace: user.namespace,
          displayName: user.displayName,
          email: user.email,
          avatarUrl: user.avatarUrl,
        };
      }

      // Otherwise treat as JWT
      const decoded = await request.jwtVerify<{ sub: string; namespace: string }>();
      const user = await db.query.users.findFirst({
        where: eq(users.id, Number(decoded.sub)),
      });

      if (!user) {
        throw fastify.httpErrors.unauthorized('User not found');
      }

      return {
        id: user.id,
        namespace: user.namespace,
        displayName: user.displayName,
        email: user.email,
        avatarUrl: user.avatarUrl,
      };
    }

    throw fastify.httpErrors.unauthorized('Missing or invalid authorization');
  });
}

export default fp(authPlugin);

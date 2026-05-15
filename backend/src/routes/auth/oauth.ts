import type { FastifyInstance } from 'fastify';
import { GitHub, Google } from 'arctic';
import { db } from '../../db/index.js';
import { users } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * OAuth 2.0 login flow
 * GET /api/v1/auth/:provider/authorize
 * GET /api/v1/auth/:provider/callback
 */
export default async function oauthRoutes(fastify: FastifyInstance) {
  const github = fastify.config.GITHUB_CLIENT_ID
    ? new GitHub(
        fastify.config.GITHUB_CLIENT_ID,
        fastify.config.GITHUB_CLIENT_SECRET!,
        `${fastify.config.REGISTRY_BASE_URL}/api/v1/auth/github/callback`
      )
    : null;

  const google = fastify.config.GOOGLE_CLIENT_ID
    ? new Google(
        fastify.config.GOOGLE_CLIENT_ID,
        fastify.config.GOOGLE_CLIENT_SECRET!,
        `${fastify.config.REGISTRY_BASE_URL}/api/v1/auth/google/callback`
      )
    : null;

  // Initiate OAuth flow
  fastify.get('/:provider/authorize', async (request, reply) => {
    const { provider } = request.params as { provider: string };
    const state = crypto.randomUUID();

    let url: URL;
    if (provider === 'github' && github) {
      url = await github.createAuthorizationURL(state, 'read:user');
    } else if (provider === 'google' && google) {
      url = await google.createAuthorizationURL(state, 'openid email profile');
    } else {
      return reply.status(400).send({ error: 'Unsupported or unconfigured provider' });
    }

    reply.setCookie('oauth_state', state, {
      path: '/',
      httpOnly: true,
      secure: fastify.config.NODE_ENV === 'production',
      maxAge: 600, // 10 minutes
    });

    return reply.redirect(url.toString());
  });

  // OAuth callback
  fastify.get('/:provider/callback', async (request, reply) => {
    const { provider } = request.params as { provider: string };
    const { code, state } = request.query as { code: string; state: string };
    const cookieState = request.cookies.oauth_state;

    if (!code || !state || state !== cookieState) {
      return reply.status(400).send({ error: 'Invalid OAuth state' });
    }

    let userInfo: { id: string; namespace: string; name: string; email?: string; avatar?: string };

    if (provider === 'github' && github) {
      const tokens = await github.validateAuthorizationCode(code);
      const response = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });
      const data = await response.json() as { id: number; login: string; name?: string; email?: string; avatar_url?: string };
      userInfo = {
        id: `github:${data.id}`,
        namespace: data.login,
        name: data.name ?? data.login,
        email: data.email,
        avatar: data.avatar_url,
      };
    } else if (provider === 'google' && google) {
      const tokens = await google.validateAuthorizationCode(code);
      const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });
      const data = await response.json() as { sub: string; name: string; email?: string; picture?: string };
      userInfo = {
        id: `google:${data.sub}`,
        namespace: data.email?.split('@')[0] ?? data.sub,
        name: data.name,
        email: data.email,
        avatar: data.picture,
      };
    } else {
      return reply.status(400).send({ error: 'Unsupported provider' });
    }

    // Upsert user
    let user = await db.query.users.findFirst({
      where: eq(users.externalId, userInfo.id),
    });

    if (!user) {
      const [inserted] = await db.insert(users).values({
        externalId: userInfo.id,
        provider,
        namespace: userInfo.namespace,
        displayName: userInfo.name,
        email: userInfo.email,
        avatarUrl: userInfo.avatar,
      }).returning();
      user = inserted;
    }

    // Issue JWT
    const token = await reply.jwtSign({
      sub: String(user.id),
      namespace: user.namespace,
    });

    reply.setCookie('pekohub_session', token, {
      path: '/',
      httpOnly: true,
      secure: fastify.config.NODE_ENV === 'production',
      maxAge: 86400, // 24 hours
    });

    // Redirect to frontend
    return reply.redirect(`${fastify.config.REGISTRY_BASE_URL}/auth/callback?token=${token}`);
  });
}

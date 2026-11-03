import fp from "fastify-plugin";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";

/** The Swagger UI at `/docs`, registered only when `API_DOCS=true`. */
export default fp(async (fastify: FastifyInstance) => {
  await fastify.register(swagger, {
    openapi: {
      info: {
        title: "PekoHub API",
        description:
          "The directory of people and pekos, the seed registry, sign-in for Peko clients (OAuth), and the relay runtimes connect to (`/v1/tunnel`).",
        version: "0.1.0",
      },
      servers: [{ url: fastify.config.PUBLIC_ORIGIN }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
          },
        },
      },
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
    },
  });
});

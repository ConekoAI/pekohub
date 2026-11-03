import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

/**
 * The API's error handler. A 4xx carries its message: it tells the caller
 * what to change. A 5xx says only that the server failed — its message can
 * be a driver error, a query or a path — and the detail goes to the log
 * (and, in development, the response).
 */
export function apiErrorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const status = error.statusCode ?? 500;
  if (status < 500) {
    return reply.status(status).send({ error: error.message });
  }
  request.log.error(error);
  return reply.status(status).send({
    error: "Internal Server Error",
    ...(process.env.NODE_ENV === "development"
      ? { message: error.message, stack: error.stack }
      : {}),
  });
}

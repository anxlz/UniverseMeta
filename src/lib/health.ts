/**
 * Liveness endpoint for the host/uptime monitor. Intentionally reports Discord gateway
 * readiness rather than just "process is up" — a bot that is running but disconnected is
 * not healthy.
 */

import { logger } from "./logger";

export interface HealthState {
  ready: () => boolean;
  wsPing: () => number;
}

export function startHealthServer(port: number, state: HealthState) {
  const startedAt = Date.now();

  const server = Bun.serve({
    port,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/health" && url.pathname !== "/") {
        return new Response("Not Found", { status: 404 });
      }
      const ready = state.ready();
      return Response.json(
        {
          status: ready ? "ok" : "degraded",
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          gatewayPingMs: state.wsPing(),
        },
        { status: ready ? 200 : 503 },
      );
    },
  });

  logger.info("health server listening", { port });
  return server;
}

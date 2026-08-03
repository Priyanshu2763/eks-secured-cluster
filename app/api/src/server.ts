import { createApp } from "./app.js";
import { config } from "./config.js";
import { destroyAwsClients } from "./lib/aws.js";
import { logger } from "./logger.js";

const app = createApp();

const server = app.listen(config.PORT, () => {
  logger.info(
    {
      port: config.PORT,
      env: config.NODE_ENV,
      region: config.AWS_REGION,
      crossAccountDynamo: Boolean(config.DDB_ROLE_ARN),
    },
    "mediavault-api listening",
  );
});

/**
 * Graceful shutdown.
 *
 * When a container is replaced, the orchestrator sends SIGTERM and then waits
 * a grace period before SIGKILL. Exiting immediately would cut off in-flight
 * requests and show users errors during what should be a zero-downtime
 * rollout, so we stop accepting new connections and let existing ones finish.
 *
 * The hard timeout matters as much as the graceful path: if a long-lived
 * connection never closes, the process would hang until SIGKILL and the
 * deployment would stall. Forcing exit slightly BEFORE the platform's grace
 * period means we control the shutdown rather than being killed mid-write.
 */
const SHUTDOWN_TIMEOUT_MS = 10_000;
let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");

  const force = setTimeout(() => {
    logger.error("graceful shutdown timed out; forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  force.unref();

  server.close((err) => {
    if (err) {
      logger.error({ err }, "error closing server");
      process.exit(1);
    }
    destroyAwsClients();
    logger.info("shutdown complete");
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

/**
 * An unhandled rejection means some promise path has no error handling at all.
 * The process is in an unknown state, so the honest response is to log loudly
 * and let the orchestrator restart a clean one rather than continue serving
 * from a process we can no longer reason about.
 */
process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason }, "unhandled promise rejection");
  shutdown("unhandledRejection");
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception");
  shutdown("uncaughtException");
});

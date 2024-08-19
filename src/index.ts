import {
  buildProfilerServer,
  isProdEnv,
  logger,
  registerShutdownConfig,
} from '@hirosystems/api-toolkit';
import { buildApiServer, buildPromServer } from './api/init';
import { startOrdhookServer } from './ordhook/server';
import { ENV } from './env';
import { ApiMetrics } from './metrics/metrics';
import { PgStore } from './pg/pg-store';

async function initBackgroundServices(db: PgStore) {
  logger.info('Initializing background services...');
  const server = await startOrdhookServer({ db });
  registerShutdownConfig({
    name: 'Ordhook Server',
    forceKillable: false,
    handler: async () => {
      await server.close();
    },
  });
}

async function initApiService(db: PgStore) {
  logger.info('Initializing API service...');
  const fastify = await buildApiServer({ db });
  registerShutdownConfig({
    name: 'API Server',
    forceKillable: false,
    handler: async () => {
      await fastify.close();
    },
  });

  await fastify.listen({ host: ENV.API_HOST, port: ENV.API_PORT });

  if (isProdEnv) {
    const promServer = await buildPromServer({ metrics: fastify.metrics });
    registerShutdownConfig({
      name: 'Prometheus Server',
      forceKillable: false,
      handler: async () => {
        await promServer.close();
      },
    });

    ApiMetrics.configure(db);
    await promServer.listen({ host: ENV.API_HOST, port: 9153 });
  }
}

async function initApp() {
  logger.info(`Initializing in ${ENV.RUN_MODE} run mode...`);
  const db = await PgStore.connect({ skipMigrations: ENV.RUN_MODE === 'readonly' });

  if (['default', 'writeonly'].includes(ENV.RUN_MODE)) {
    await initBackgroundServices(db);
  }
  if (['default', 'readonly'].includes(ENV.RUN_MODE)) {
    await initApiService(db);
  }

  const profilerServer = await buildProfilerServer();
  registerShutdownConfig({
    name: 'Profiler Server',
    forceKillable: false,
    handler: async () => {
      await profilerServer.close();
    },
  });
  await profilerServer.listen({ host: ENV.API_HOST, port: ENV.PROFILER_PORT });

  registerShutdownConfig({
    name: 'DB',
    forceKillable: false,
    handler: async () => {
      await db.close();
    },
  });
}

registerShutdownConfig();
initApp()
  .then(() => {
    logger.info('App initialized');
  })
  .catch(error => {
    logger.error(error, `App failed to start`);
    process.exit(1);
  });

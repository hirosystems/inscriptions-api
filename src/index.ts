import { buildApiServer } from './api/init';
import { InscriptionsImporter } from './bitcoin/inscriptions-importer';
import { ENV } from './env';
import { logger } from './logger';
import { PgStore } from './pg/pg-store';
import { registerShutdownConfig } from './shutdown-handler';

async function initBackgroundServices(db: PgStore) {
  logger.info('Initializing background services...');
  const importer = new InscriptionsImporter({ db });
  registerShutdownConfig({
    name: 'Inscriptions Importer',
    forceKillable: false,
    handler: async () => {
      await importer.close();
    },
  });

  await importer.import();
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
}

async function initApp() {
  const db = await PgStore.connect({ skipMigrations: false });

  await initBackgroundServices(db);
  await initApiService(db);

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

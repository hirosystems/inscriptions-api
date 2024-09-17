import { randomUUID } from 'crypto';
import { ENV } from '../env';
import { PgStore } from '../pg/pg-store';
import {
  BitcoinPayload,
  ChainhookEventObserver,
  ChainhookNodeOptions,
  Payload,
  ServerOptions,
  ServerPredicate,
} from '@hirosystems/chainhook-client';
import { logger, shutdown } from '@hirosystems/api-toolkit';

export const ORDHOOK_BASE_PATH = `http://${ENV.ORDHOOK_NODE_RPC_HOST}:${ENV.ORDHOOK_NODE_RPC_PORT}`;
export const PREDICATE_UUID = randomUUID();

/**
 * Starts the Ordhook event observer.
 * @param args - DB
 * @returns ChainhookEventObserver instance
 */
export async function startOrdhookServer(args: { db: PgStore }): Promise<ChainhookEventObserver> {
  const predicates: ServerPredicate[] = [];
  if (ENV.ORDHOOK_AUTO_PREDICATE_REGISTRATION) {
    const blockHeight = await args.db.getChainTipBlockHeight();
    logger.info(`Ordinals predicate starting from block ${blockHeight}...`);
    predicates.push({
      uuid: PREDICATE_UUID,
      name: 'inscription_feed',
      version: 1,
      chain: 'bitcoin',
      networks: {
        mainnet: {
          start_block: blockHeight,
          if_this: {
            scope: 'ordinals_protocol',
            operation: 'inscription_feed',
            meta_protocols: ['brc-20'],
          },
        },
      },
    });
  }

  const serverOpts: ServerOptions = {
    hostname: ENV.API_HOST,
    port: ENV.EVENT_PORT,
    auth_token: ENV.ORDHOOK_NODE_AUTH_TOKEN ?? '',
    external_base_url: `http://${ENV.EXTERNAL_HOSTNAME}`,
    wait_for_chainhook_node: ENV.ORDHOOK_AUTO_PREDICATE_REGISTRATION,
    validate_chainhook_payloads: false,
    validate_token_authorization: ENV.ORDHOOK_NODE_AUTH_TOKEN != undefined,
    body_limit: ENV.EVENT_SERVER_BODY_LIMIT,
    node_type: 'ordhook',
  };
  const ordhookOpts: ChainhookNodeOptions = {
    base_url: ORDHOOK_BASE_PATH,
  };
  const server = new ChainhookEventObserver(serverOpts, ordhookOpts);
  await server.start(predicates, async (uuid: string, payload: Payload) => {
    const streamed = payload.chainhook.is_streaming_blocks;
    if (
      ENV.ORDHOOK_INGESTION_MODE === 'replay' &&
      ENV.ORDHOOK_REPLAY_INGESTION_MODE_AUTO_SHUTDOWN &&
      streamed
    ) {
      logger.info(`OrdhookServer finished replaying blocks, shutting down`);
      return shutdown();
    }
    logger.info(
      `OrdhookServer received ${streamed ? 'streamed' : 'replay'} payload from predicate ${uuid}`
    );
    await args.db.updateInscriptions(payload as BitcoinPayload);
  });
  const chainTip = await args.db.getChainTipBlockHeight();
  logger.info(`OrdhookServer chain tip is at ${chainTip}`);
  return server;
}

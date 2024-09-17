/**
 * Ordhook Debug Server
 * ---
 *
 * This file provides a quick way to start an Ordhook event server that only saves received payloads
 * to local text files instead of attempting to process them into the Ordinals API database.
 *
 * You can use this tool to debug an Ordhook payload that is not being processed correctly into the
 * API.
 */
import {
  ChainhookEventObserver,
  ChainhookNodeOptions,
  Payload,
  ServerOptions,
} from '@hirosystems/chainhook-client';
import { ENV } from '../src/env';
import { ORDHOOK_BASE_PATH } from '../src/ordhook/server';
import { logger } from '@hirosystems/api-toolkit';
import * as fs from 'fs';
import * as path from 'path';

const serverOpts: ServerOptions = {
  hostname: ENV.API_HOST,
  port: ENV.EVENT_PORT,
  auth_token: ENV.ORDHOOK_NODE_AUTH_TOKEN ?? '',
  external_base_url: `http://${ENV.EXTERNAL_HOSTNAME}`,
  wait_for_chainhook_node: false,
  validate_chainhook_payloads: false,
  validate_token_authorization: false,
  body_limit: ENV.EVENT_SERVER_BODY_LIMIT,
  node_type: 'ordhook',
};
const ordhookOpts: ChainhookNodeOptions = {
  base_url: ORDHOOK_BASE_PATH,
};
const dirPath = path.join(__dirname, '../tmp/debug-server/');
fs.mkdirSync(dirPath, { recursive: true });
logger.info(`DebugServer saving outputs to ${dirPath}`);

const server = new ChainhookEventObserver(serverOpts, ordhookOpts);
server
  .start([], async (uuid: string, payload: Payload) => {
    logger.info(`DebugServer received payload from predicate ${uuid}`);
    const filePath = path.join(dirPath, `${payload.apply[0].block_identifier.index}.txt`);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
    return Promise.resolve();
  })
  .catch(err => logger.error(err));

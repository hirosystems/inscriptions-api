import { logger } from '../logger';
import { PgStore } from '../pg/pg-store';
import { BitcoinRpcClient } from './bitcoin-rpc-client';
import { findVinInscriptionGenesis, getTransactionFee } from './helpers';
// import { getTransactionInscriptions } from './helpers';
import { Block } from './types';

/** First mainnet block height with inscriptions */
const STARTING_BLOCK_HEIGHT = 767430;

/**
 * xc
 */
export class InscriptionsImporter {
  private readonly db: PgStore;
  private readonly client: BitcoinRpcClient;

  constructor(args: { db: PgStore }) {
    this.db = args.db;
    this.client = new BitcoinRpcClient();
  }

  async import() {
    logger.info(`InscriptionsImporter starting at height ${STARTING_BLOCK_HEIGHT}...`);
    const startBlockHash = await this.client.getBlockHash({ height: STARTING_BLOCK_HEIGHT });

    let nextBlockHash = startBlockHash;
    while (true) {
      const block = await this.client.getBlock({ hash: nextBlockHash });
      await this.scanBlock(block);
      if (!block.nextblockhash) break;
      nextBlockHash = block.nextblockhash;
    }
  }

  async close() {
    //
  }

  private async scanBlock(block: Block) {
    logger.info(`InscriptionsImporter scanning for inscriptions at block ${block.height}`);
    // Skip coinbase tx, process all others to track inscription flow.
    for (const txId of block.tx.slice(1)) {
      const tx = await this.client.getTransaction({ txId, blockHash: block.hash });
      let txFee: number | undefined;

      let genesisIndex = 0;
      let offset = 0;
      for (const vin of tx.vin) {
        // Does this UTXO have a new inscription?
        const genesis = findVinInscriptionGenesis(vin);
        if (genesis) {
          if (!txFee) {
            txFee = await getTransactionFee(this.client, tx);
          }
          await this.db.insertInscriptionGenesis({
            inscription: {
              genesis_id: `${tx.hash}i${genesisIndex++}`,
              mime_type: genesis.contentType.split(';')[0],
              content_type: genesis.contentType,
              content_length: genesis.content.byteLength,
              content: genesis.content,
              fee: txFee,
            },
            location: {
              inscription_id: 0, // TBD once inscription insert is done
              block_height: block.height,
              block_hash: block.hash,
              tx_id: tx.hash,
              address: tx.vout[0].scriptPubKey.address,
              output: `${tx.hash}:0`,
              offset: 0,
              value: tx.vout[0].value,
              timestamp: block.time,
              genesis: true,
              current: true,
            },
          });
          continue;
        }
        // Is it a UTXO that previously held an inscription?
        const prevLocation = await this.db.getInscriptionLocation({
          output: `${vin.txid}:${vin.vout}`,
        });
        if (prevLocation) {
          await this.db.updateInscriptionLocation({
            location: {
              inscription_id: prevLocation.inscription_id,
              block_height: block.height,
              block_hash: block.hash,
              tx_id: tx.hash,
              address: tx.vout[0].scriptPubKey.address,
              output: `${tx.hash}:0`,
              offset: offset,
              value: tx.vout[0].value,
              timestamp: block.time,
              genesis: false,
              current: true,
            },
          });
          offset += prevLocation.value;
        }
      }
    }
  }
}

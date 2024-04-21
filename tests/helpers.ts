import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  BitcoinBrc20Operation,
  BitcoinEvent,
  BitcoinInscriptionRevealed,
  BitcoinInscriptionTransferred,
  BitcoinPayload,
  BitcoinTransaction,
} from '@hirosystems/chainhook-client';
import { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { IncomingMessage, Server, ServerResponse } from 'http';
import { PgStore } from '../src/pg/pg-store';

export type TestFastifyServer = FastifyInstance<
  Server,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  TypeBoxTypeProvider
>;

export class TestChainhookPayloadBuilder {
  private payload: BitcoinPayload = {
    apply: [],
    rollback: [],
    chainhook: {
      uuid: 'test',
      predicate: {
        scope: 'ordinals_protocol',
        operation: 'inscription_feed',
        meta_protocols: ['brc-20'],
      },
      is_streaming_blocks: true,
    },
  };
  private action: 'apply' | 'rollback' = 'apply';
  private get lastBlock(): BitcoinEvent {
    return this.payload[this.action][this.payload[this.action].length - 1] as BitcoinEvent;
  }
  private get lastBlockTx(): BitcoinTransaction {
    return this.lastBlock.transactions[this.lastBlock.transactions.length - 1];
  }
  private txIndex = 0;

  streamingBlocks(streaming: boolean): this {
    this.payload.chainhook.is_streaming_blocks = streaming;
    return this;
  }

  apply(): this {
    this.action = 'apply';
    return this;
  }

  rollback(): this {
    this.action = 'rollback';
    return this;
  }

  block(args: { height: number; hash?: string; timestamp?: number }): this {
    this.payload[this.action].push({
      block_identifier: {
        index: args.height,
        hash: args.hash ?? '0x163de66dc9c0949905bfe8e148bde04600223cf88d19f26fdbeba1d6e6fa0f88',
      },
      parent_block_identifier: {
        index: args.height - 1,
        hash: '0x117374e7078440835a744b6b1b13dd2c48c4eff8c58dde07162241a8f15d1e03',
      },
      timestamp: args.timestamp ?? 1677803510,
      transactions: [],
      metadata: {},
    } as BitcoinEvent);
    return this;
  }

  transaction(args: { hash: string }): this {
    this.lastBlock.transactions.push({
      transaction_identifier: {
        hash: args.hash,
      },
      operations: [],
      metadata: {
        ordinal_operations: [],
        proof: null,
        index: this.txIndex++,
      },
    });
    return this;
  }

  inscriptionRevealed(args: BitcoinInscriptionRevealed): this {
    this.lastBlockTx.metadata.ordinal_operations.push({ inscription_revealed: args });
    return this;
  }

  inscriptionTransferred(args: BitcoinInscriptionTransferred): this {
    this.lastBlockTx.metadata.ordinal_operations.push({ inscription_transferred: args });
    return this;
  }

  brc20(args: BitcoinBrc20Operation): this {
    this.lastBlockTx.metadata.brc20_operation = args;
    return this;
  }

  build(): BitcoinPayload {
    return this.payload;
  }
}

export function rollBack(payload: BitcoinPayload) {
  return {
    ...payload,
    apply: [],
    rollback: payload.apply,
  };
}

/** Generate a random hash like string for testing */
export const randomHash = () =>
  [...Array(64)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

/** Generator for incrementing numbers */
export function* incrementing(
  start: number = 0,
  step: number = 1
): Generator<number, number, 'next'> {
  let current = start;

  while (true) {
    yield current;
    current += step;
  }
}

export const BRC20_GENESIS_BLOCK = 779832;
export const BRC20_SELF_MINT_ACTIVATION_BLOCK = 837090;

export async function deployAndMintPEPE(db: PgStore, address: string) {
  await db.updateInscriptions(
    new TestChainhookPayloadBuilder()
      .apply()
      .block({
        height: BRC20_GENESIS_BLOCK,
        hash: '00000000000000000002a90330a99f67e3f01eb2ce070b45930581e82fb7a91d',
      })
      .transaction({
        hash: '38c46a8bf7ec90bc7f6b797e7dc84baa97f4e5fd4286b92fe1b50176d03b18dc',
      })
      .brc20({
        deploy: {
          tick: 'PEPE',
          max: '250000',
          dec: '18',
          lim: '250000',
          inscription_id: '38c46a8bf7ec90bc7f6b797e7dc84baa97f4e5fd4286b92fe1b50176d03b18dci0',
          address,
          self_mint: false,
        },
      })
      .build()
  );
  await db.updateInscriptions(
    new TestChainhookPayloadBuilder()
      .apply()
      .block({
        height: BRC20_GENESIS_BLOCK + 1,
        hash: '0000000000000000000098d8f2663891d439f6bb7de230d4e9f6bcc2e85452bf',
      })
      .transaction({
        hash: '3b55f624eaa4f8de6c42e0c490176b67123a83094384f658611faf7bfb85dd0f',
      })
      .brc20({
        mint: {
          tick: 'PEPE',
          amt: '10000',
          inscription_id: '3b55f624eaa4f8de6c42e0c490176b67123a83094384f658611faf7bfb85dd0fi0',
          address,
        },
      })
      .build()
  );
}

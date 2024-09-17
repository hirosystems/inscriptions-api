import { PREDICATE_UUID, startOrdhookServer } from '../../src/ordhook/server';
import { ENV } from '../../src/env';
import { MIGRATIONS_DIR, PgStore } from '../../src/pg/pg-store';
import { TestChainhookPayloadBuilder, TestFastifyServer } from '../helpers';
import {
  BadPayloadRequestError,
  BitcoinInscriptionRevealed,
  BitcoinInscriptionTransferred,
  ChainhookEventObserver,
} from '@hirosystems/chainhook-client';
import { buildApiServer } from '../../src/api/init';
import { runMigrations } from '@hirosystems/api-toolkit';

describe('EventServer', () => {
  let db: PgStore;
  let server: ChainhookEventObserver;
  let fastify: TestFastifyServer;

  beforeEach(async () => {
    await runMigrations(MIGRATIONS_DIR, 'up');
    ENV.ORDHOOK_AUTO_PREDICATE_REGISTRATION = false;
    db = await PgStore.connect({ skipMigrations: true });
    server = await startOrdhookServer({ db });
    fastify = await buildApiServer({ db });
  });

  afterEach(async () => {
    await server.close();
    await fastify.close();
    await db.close();
    await runMigrations(MIGRATIONS_DIR, 'down');
  });

  describe('parser', () => {
    test('parses inscription_reveal apply and rollback', async () => {
      const reveal: BitcoinInscriptionRevealed = {
        content_bytes: '0x303030303030303030303030',
        content_type: 'text/plain;charset=utf-8',
        content_length: 12,
        inscription_number: { classic: 0, jubilee: 0 },
        inscription_fee: 3425,
        inscription_output_value: 10000,
        inscription_id: '0268dd9743c862d80ab02cb1d0228036cfe172522850eb96be60cfee14b31fb8i0',
        inscriber_address: 'bc1p3cyx5e2hgh53w7kpxcvm8s4kkega9gv5wfw7c4qxsvxl0u8x834qf0u2td',
        ordinal_number: 125348773618236,
        ordinal_block_height: 566462,
        ordinal_offset: 0,
        satpoint_post_inscription:
          '0x0268dd9743c862d80ab02cb1d0228036cfe172522850eb96be60cfee14b31fb8:0:0',
        inscription_input_index: 0,
        transfers_pre_inscription: 0,
        tx_index: 0,
        curse_type: null,
        inscription_pointer: null,
        delegate: null,
        metaprotocol: null,
        metadata: null,
        parent: null,
      };

      // Apply
      const payload1 = new TestChainhookPayloadBuilder()
        .apply()
        .block({
          height: 767430,
          hash: '0x163de66dc9c0949905bfe8e148bde04600223cf88d19f26fdbeba1d6e6fa0f88',
          timestamp: 1676913207,
        })
        .transaction({
          hash: '0x0268dd9743c862d80ab02cb1d0228036cfe172522850eb96be60cfee14b31fb8',
        })
        .inscriptionRevealed(reveal)
        .build();
      const response = await server['fastify'].inject({
        method: 'POST',
        url: `/payload`,
        headers: { authorization: `Bearer ${ENV.ORDHOOK_NODE_AUTH_TOKEN}` },
        payload: payload1,
      });
      expect(response.statusCode).toBe(200);

      const query = await db.getInscriptions(
        {
          limit: 1,
          offset: 0,
        },
        { genesis_id: ['0268dd9743c862d80ab02cb1d0228036cfe172522850eb96be60cfee14b31fb8i0'] }
      );
      const inscr = query.results[0];
      expect(inscr).not.toBeUndefined();
      expect(inscr.address).toBe('bc1p3cyx5e2hgh53w7kpxcvm8s4kkega9gv5wfw7c4qxsvxl0u8x834qf0u2td');
      expect(inscr.content_length).toBe('12');
      expect(inscr.content_type).toBe('text/plain;charset=utf-8');
      expect(inscr.genesis_address).toBe(
        'bc1p3cyx5e2hgh53w7kpxcvm8s4kkega9gv5wfw7c4qxsvxl0u8x834qf0u2td'
      );
      expect(inscr.genesis_block_hash).toBe(
        '163de66dc9c0949905bfe8e148bde04600223cf88d19f26fdbeba1d6e6fa0f88'
      );
      expect(inscr.genesis_block_height).toBe('767430');
      expect(inscr.genesis_fee).toBe('3425');
      expect(inscr.genesis_id).toBe(
        '0268dd9743c862d80ab02cb1d0228036cfe172522850eb96be60cfee14b31fb8i0'
      );
      expect(inscr.genesis_timestamp.toISOString()).toBe('2023-02-20T17:13:27.000Z');
      expect(inscr.genesis_tx_id).toBe(
        '0268dd9743c862d80ab02cb1d0228036cfe172522850eb96be60cfee14b31fb8'
      );
      expect(inscr.mime_type).toBe('text/plain');
      expect(inscr.number).toBe('0');
      expect(inscr.offset).toBe('0');
      expect(inscr.output).toBe(
        '0268dd9743c862d80ab02cb1d0228036cfe172522850eb96be60cfee14b31fb8:0'
      );
      expect(inscr.sat_coinbase_height).toBe('25069');
      expect(inscr.sat_ordinal).toBe('125348773618236');
      expect(inscr.sat_rarity).toBe('common');
      expect(inscr.timestamp.toISOString()).toBe('2023-02-20T17:13:27.000Z');
      expect(inscr.value).toBe('10000');
      let count = await db.counts.getAddressCount([
        'bc1p3cyx5e2hgh53w7kpxcvm8s4kkega9gv5wfw7c4qxsvxl0u8x834qf0u2td',
      ]);
      expect(count).toBe(1);

      // Rollback
      const payload2 = new TestChainhookPayloadBuilder()
        .rollback()
        .block({
          height: 767430,
          hash: '0x163de66dc9c0949905bfe8e148bde04600223cf88d19f26fdbeba1d6e6fa0f88',
          timestamp: 1676913207,
        })
        .transaction({
          hash: '0x0268dd9743c862d80ab02cb1d0228036cfe172522850eb96be60cfee14b31fb8',
        })
        .inscriptionRevealed(reveal)
        .build();
      const response2 = await server['fastify'].inject({
        method: 'POST',
        url: `/payload`,
        headers: { authorization: `Bearer ${ENV.ORDHOOK_NODE_AUTH_TOKEN}` },
        payload: payload2,
      });
      expect(response2.statusCode).toBe(200);
      const c1 = await db.sql<{ count: number }[]>`SELECT COUNT(*)::int FROM inscriptions`;
      expect(c1[0].count).toBe(0);
      const c2 = await db.sql<{ count: number }[]>`SELECT COUNT(*)::int FROM locations`;
      expect(c2[0].count).toBe(0);
      count = await db.counts.getAddressCount([
        'bc1p3cyx5e2hgh53w7kpxcvm8s4kkega9gv5wfw7c4qxsvxl0u8x834qf0u2td',
      ]);
      expect(count).toBe(0);
    });

    test('parses inscription_transferred apply and rollback', async () => {
      await db.updateInscriptions(
        new TestChainhookPayloadBuilder()
          .apply()
          .block({
            height: 775617,
            hash: '0x00000000000000000002a90330a99f67e3f01eb2ce070b45930581e82fb7a91d',
            timestamp: 1676913207,
          })
          .transaction({
            hash: '0x38c46a8bf7ec90bc7f6b797e7dc84baa97f4e5fd4286b92fe1b50176d03b18dc',
          })
          .inscriptionRevealed({
            content_bytes: '0x48656C6C6F',
            content_type: 'image/png',
            content_length: 5,
            inscription_number: { classic: 0, jubilee: 0 },
            inscription_fee: 2805,
            inscription_id: '38c46a8bf7ec90bc7f6b797e7dc84baa97f4e5fd4286b92fe1b50176d03b18dci0',
            inscription_output_value: 10000,
            inscriber_address: 'bc1p3cyx5e2hgh53w7kpxcvm8s4kkega9gv5wfw7c4qxsvxl0u8x834qf0u2td',
            ordinal_number: 5,
            ordinal_block_height: 0,
            ordinal_offset: 0,
            satpoint_post_inscription:
              '38c46a8bf7ec90bc7f6b797e7dc84baa97f4e5fd4286b92fe1b50176d03b18dc:0:0',
            inscription_input_index: 0,
            transfers_pre_inscription: 0,
            tx_index: 0,
            curse_type: null,
            inscription_pointer: null,
            delegate: null,
            metaprotocol: null,
            metadata: null,
            parent: null,
          })
          .build()
      );
      await expect(db.getChainTipBlockHeight()).resolves.toBe(775617);

      const transfer: BitcoinInscriptionTransferred = {
        ordinal_number: 5,
        destination: {
          type: 'transferred',
          value: 'bc1p3cyx5e2hgh53w7kpxcvm8s4kkega9gv5wfw7c4qxsvxl0u8x834qf00000',
        },
        satpoint_pre_transfer:
          '38c46a8bf7ec90bc7f6b797e7dc84baa97f4e5fd4286b92fe1b50176d03b18dc:0:0',
        satpoint_post_transfer:
          '0268dd9743c862d80ab02cb1d0228036cfe172522850eb96be60cfee14b31fb8:0:5000',
        post_transfer_output_value: 10000,
        tx_index: 0,
      };

      // Apply
      const payload1 = new TestChainhookPayloadBuilder()
        .apply()
        .block({
          height: 775618,
          hash: '0x163de66dc9c0949905bfe8e148bde04600223cf88d19f26fdbeba1d6e6fa0f88',
          timestamp: 1676913207,
        })
        .transaction({
          hash: '0x0268dd9743c862d80ab02cb1d0228036cfe172522850eb96be60cfee14b31fb8',
        })
        .inscriptionTransferred(transfer)
        .build();
      const response = await server['fastify'].inject({
        method: 'POST',
        url: `/payload`,
        headers: { authorization: `Bearer ${ENV.ORDHOOK_NODE_AUTH_TOKEN}` },
        payload: payload1,
      });
      expect(response.statusCode).toBe(200);
      await expect(db.getChainTipBlockHeight()).resolves.toBe(775618);
      const query = await db.getInscriptions(
        {
          limit: 1,
          offset: 0,
        },
        { genesis_id: ['38c46a8bf7ec90bc7f6b797e7dc84baa97f4e5fd4286b92fe1b50176d03b18dci0'] }
      );
      const inscr = query.results[0];
      expect(inscr).not.toBeUndefined();
      expect(inscr.address).toBe('bc1p3cyx5e2hgh53w7kpxcvm8s4kkega9gv5wfw7c4qxsvxl0u8x834qf00000');
      expect(inscr.content_length).toBe('5');
      expect(inscr.content_type).toBe('image/png');
      expect(inscr.genesis_address).toBe(
        'bc1p3cyx5e2hgh53w7kpxcvm8s4kkega9gv5wfw7c4qxsvxl0u8x834qf0u2td'
      );
      expect(inscr.genesis_block_hash).toBe(
        '00000000000000000002a90330a99f67e3f01eb2ce070b45930581e82fb7a91d'
      );
      expect(inscr.genesis_block_height).toBe('775617');
      expect(inscr.genesis_fee).toBe('2805');
      expect(inscr.genesis_id).toBe(
        '38c46a8bf7ec90bc7f6b797e7dc84baa97f4e5fd4286b92fe1b50176d03b18dci0'
      );
      expect(inscr.genesis_timestamp.toISOString()).toBe('2023-02-20T17:13:27.000Z');
      expect(inscr.genesis_tx_id).toBe(
        '38c46a8bf7ec90bc7f6b797e7dc84baa97f4e5fd4286b92fe1b50176d03b18dc'
      );
      expect(inscr.mime_type).toBe('image/png');
      expect(inscr.number).toBe('0');
      expect(inscr.offset).toBe('5000');
      expect(inscr.output).toBe(
        '0268dd9743c862d80ab02cb1d0228036cfe172522850eb96be60cfee14b31fb8:0'
      );
      expect(inscr.sat_coinbase_height).toBe('0');
      expect(inscr.sat_ordinal).toBe('5');
      expect(inscr.sat_rarity).toBe('common');
      expect(inscr.timestamp.toISOString()).toBe('2023-02-20T17:13:27.000Z');
      expect(inscr.value).toBe('10000');
      let count = await db.counts.getAddressCount([
        'bc1p3cyx5e2hgh53w7kpxcvm8s4kkega9gv5wfw7c4qxsvxl0u8x834qf0u2td',
      ]);
      expect(count).toBe(0);
      count = await db.counts.getAddressCount([
        'bc1p3cyx5e2hgh53w7kpxcvm8s4kkega9gv5wfw7c4qxsvxl0u8x834qf00000',
      ]);
      expect(count).toBe(1);

      // Rollback
      const payload2 = new TestChainhookPayloadBuilder()
        .rollback()
        .block({
          height: 775618,
          hash: '0x163de66dc9c0949905bfe8e148bde04600223cf88d19f26fdbeba1d6e6fa0f88',
          timestamp: 1676913207,
        })
        .transaction({
          hash: '0x0268dd9743c862d80ab02cb1d0228036cfe172522850eb96be60cfee14b31fb8',
        })
        .inscriptionTransferred(transfer)
        .build();
      const response2 = await server['fastify'].inject({
        method: 'POST',
        url: `/payload`,
        headers: { authorization: `Bearer ${ENV.ORDHOOK_NODE_AUTH_TOKEN}` },
        payload: payload2,
      });
      expect(response2.statusCode).toBe(200);
      const c1 = await db.sql<{ count: number }[]>`SELECT COUNT(*)::int FROM inscriptions`;
      expect(c1[0].count).toBe(1);
      const c2 = await db.sql<{ count: number }[]>`SELECT COUNT(*)::int FROM locations`;
      expect(c2[0].count).toBe(1);
      await expect(db.getChainTipBlockHeight()).resolves.toBe(775617);
      count = await db.counts.getAddressCount([
        'bc1p3cyx5e2hgh53w7kpxcvm8s4kkega9gv5wfw7c4qxsvxl0u8x834qf0u2td',
      ]);
      expect(count).toBe(1);
      count = await db.counts.getAddressCount([
        'bc1p3cyx5e2hgh53w7kpxcvm8s4kkega9gv5wfw7c4qxsvxl0u8x834qf00000',
      ]);
      expect(count).toBe(0);
    });

    test('multiple inscription pointers on the same block are compared correctly', async () => {
      const address = 'bc1q92zytmqgczsrg4xuhpc2asz6h4h7ke5hagw8k6';
      const address2 = 'bc1qtpm0fsaawxjsthfdrxhmrzunnpjx0g9hncgvp7';
      await db.updateInscriptions(
        new TestChainhookPayloadBuilder()
          .apply()
          .block({
            height: 808382,
            hash: '00000000000000000002b14f0c5dde0b2fc74d022e860696bd64f1f652756674',
          })
          .transaction({
            hash: '6046f17804eb8396285567a20c09598ae1273b6f744b23700ba95593c380ce02',
          })
          .inscriptionRevealed({
            content_bytes: '0x48656C6C6F',
            content_type: 'image/png',
            content_length: 5,
            inscription_number: { classic: 0, jubilee: 0 },
            inscription_fee: 2805,
            inscription_id: '6046f17804eb8396285567a20c09598ae1273b6f744b23700ba95593c380ce02i0',
            inscription_output_value: 10000,
            inscriber_address: address,
            ordinal_number: 5,
            ordinal_block_height: 0,
            ordinal_offset: 0,
            satpoint_post_inscription:
              '6046f17804eb8396285567a20c09598ae1273b6f744b23700ba95593c380ce02:0:0',
            inscription_input_index: 0,
            transfers_pre_inscription: 0,
            tx_index: 995,
            curse_type: null,
            inscription_pointer: null,
            delegate: null,
            metaprotocol: null,
            metadata: null,
            parent: null,
          })
          .transaction({
            hash: '7edaa48337a94da327b6262830505f116775a32db5ad4ad46e87ecea33f21bac',
          })
          .inscriptionTransferred({
            ordinal_number: 5,
            destination: { type: 'transferred', value: address2 },
            satpoint_pre_transfer:
              '6046f17804eb8396285567a20c09598ae1273b6f744b23700ba95593c380ce02:0:0',
            satpoint_post_transfer:
              '7edaa48337a94da327b6262830505f116775a32db5ad4ad46e87ecea33f21bac:0:0',
            post_transfer_output_value: null,
            tx_index: 1019, // '1019' is less than '995' when compared as a string
          })
          .build()
      );
      const response = await fastify.inject({
        method: 'GET',
        url: `/ordinals/inscriptions/6046f17804eb8396285567a20c09598ae1273b6f744b23700ba95593c380ce02i0`,
      });
      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.genesis_address).toBe(address);
    });

    test('inscriptions revealed and immediately transferred in the same block', async () => {
      await db.updateInscriptions(
        new TestChainhookPayloadBuilder()
          .apply()
          .block({
            height: 832574,
            hash: '000000000000000000020c8145de25b1e1e0a6312e377827a3015e15fdd574cd',
          })
          .transaction({
            hash: '53957f47697096cef4ad24dae6357b3d7ffe1e3eb9216ce0bb01d6b6a2c8cf4a',
          })
          .inscriptionRevealed({
            content_bytes:
              '0x7b2270223a226272632d3230222c226f70223a227472616e73666572222c227469636b223a224d544d54222c22616d74223a2231303030227d',
            content_length: 57,
            content_type: 'text/plain;charset=utf-8',
            curse_type: null,
            delegate: '',
            inscriber_address: 'bc1pgfkgsz2gv8cy42csdfgnuepx5g2sm0y3nsccvehjpjnev8990pms7jp9n5',
            inscription_fee: 11322,
            inscription_id: '53957f47697096cef4ad24dae6357b3d7ffe1e3eb9216ce0bb01d6b6a2c8cf4ai0',
            inscription_input_index: 0,
            inscription_number: {
              classic: 0,
              jubilee: 0,
            },
            inscription_output_value: 8834,
            inscription_pointer: 0,
            metadata: null,
            metaprotocol: '',
            ordinal_block_height: 149412,
            ordinal_number: 747064132806533,
            ordinal_offset: 4132806533,
            parent: '',
            satpoint_post_inscription:
              '53957f47697096cef4ad24dae6357b3d7ffe1e3eb9216ce0bb01d6b6a2c8cf4a:0:0',
            transfers_pre_inscription: 0,
            tx_index: 2613,
          })
          .transaction({
            hash: '5252157e270d1d405fa5d58249832ca3aa706b84e4dad2a31e7f52373aec2b7b',
          })
          .inscriptionTransferred({
            destination: {
              type: 'transferred',
              value: 'bc1p80sw4ug55q7p4ha5gsk40d2tszqy7cendt9yksmf4nswzzrq58msp6t7qe',
            },
            ordinal_number: 747064132806533,
            post_transfer_output_value: 546,
            satpoint_post_transfer:
              '5252157e270d1d405fa5d58249832ca3aa706b84e4dad2a31e7f52373aec2b7b:0:0',
            satpoint_pre_transfer:
              '53957f47697096cef4ad24dae6357b3d7ffe1e3eb9216ce0bb01d6b6a2c8cf4a:0:0',
            tx_index: 2614,
          })
          .build()
      );
      const response = await fastify.inject({
        method: 'GET',
        url: `/ordinals/inscriptions/53957f47697096cef4ad24dae6357b3d7ffe1e3eb9216ce0bb01d6b6a2c8cf4ai0/transfers`,
      });
      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.total).toBe(2);
      expect(json.results).toStrictEqual([
        {
          address: 'bc1p80sw4ug55q7p4ha5gsk40d2tszqy7cendt9yksmf4nswzzrq58msp6t7qe',
          block_hash: '000000000000000000020c8145de25b1e1e0a6312e377827a3015e15fdd574cd',
          block_height: 832574,
          location: '5252157e270d1d405fa5d58249832ca3aa706b84e4dad2a31e7f52373aec2b7b:0:0',
          offset: '0',
          output: '5252157e270d1d405fa5d58249832ca3aa706b84e4dad2a31e7f52373aec2b7b:0',
          timestamp: 1677803510000,
          tx_id: '5252157e270d1d405fa5d58249832ca3aa706b84e4dad2a31e7f52373aec2b7b',
          value: '546',
        },
        {
          address: 'bc1pgfkgsz2gv8cy42csdfgnuepx5g2sm0y3nsccvehjpjnev8990pms7jp9n5',
          block_hash: '000000000000000000020c8145de25b1e1e0a6312e377827a3015e15fdd574cd',
          block_height: 832574,
          location: '53957f47697096cef4ad24dae6357b3d7ffe1e3eb9216ce0bb01d6b6a2c8cf4a:0:0',
          offset: '0',
          output: '53957f47697096cef4ad24dae6357b3d7ffe1e3eb9216ce0bb01d6b6a2c8cf4a:0',
          timestamp: 1677803510000,
          tx_id: '53957f47697096cef4ad24dae6357b3d7ffe1e3eb9216ce0bb01d6b6a2c8cf4a',
          value: '8834',
        },
      ]);
    });

    test('inscriptions revealed as fee', async () => {
      await db.updateInscriptions(
        new TestChainhookPayloadBuilder()
          .apply()
          .block({
            height: 832574,
            hash: '000000000000000000020c8145de25b1e1e0a6312e377827a3015e15fdd574cd',
          })
          .transaction({
            hash: '53957f47697096cef4ad24dae6357b3d7ffe1e3eb9216ce0bb01d6b6a2c8cf4a',
          })
          .inscriptionRevealed({
            content_bytes:
              '0x7b2270223a226272632d3230222c226f70223a226d696e74222c227469636b223a22656f7262222c22616d74223a223130227d',
            content_length: 51,
            content_type: 'text/plain',
            curse_type: null,
            delegate: '',
            inscriber_address: '',
            inscription_fee: 3210,
            inscription_id: '53957f47697096cef4ad24dae6357b3d7ffe1e3eb9216ce0bb01d6b6a2c8cf4ai0',
            inscription_input_index: 0,
            inscription_number: {
              classic: 0,
              jubilee: 0,
            },
            inscription_output_value: 0,
            inscription_pointer: 1,
            metadata: null,
            metaprotocol: '',
            ordinal_block_height: 203651,
            ordinal_number: 1018259086681705,
            ordinal_offset: 4086681705,
            parent: '',
            satpoint_post_inscription:
              '53957f47697096cef4ad24dae6357b3d7ffe1e3eb9216ce0bb01d6b6a2c8cf4a:0:665136296',
            transfers_pre_inscription: 0,
            tx_index: 2486,
          })
          .build()
      );
      const response = await fastify.inject({
        method: 'GET',
        url: `/ordinals/inscriptions/53957f47697096cef4ad24dae6357b3d7ffe1e3eb9216ce0bb01d6b6a2c8cf4ai0`,
      });
      expect(response.statusCode).toBe(200);
      const status = await db.sql<{ transfer_type: string }[]>`
        SELECT transfer_type
        FROM locations
        INNER JOIN inscriptions USING (ordinal_number)
        WHERE genesis_id = '53957f47697096cef4ad24dae6357b3d7ffe1e3eb9216ce0bb01d6b6a2c8cf4ai0'
      `;
      expect(status[0].transfer_type).toBe('spent_in_fees');
    });

    test('inscriptions revealed as burnt', async () => {
      await db.updateInscriptions(
        new TestChainhookPayloadBuilder()
          .apply()
          .block({
            height: 832574,
            hash: '000000000000000000020c8145de25b1e1e0a6312e377827a3015e15fdd574cd',
          })
          .transaction({
            hash: '53957f47697096cef4ad24dae6357b3d7ffe1e3eb9216ce0bb01d6b6a2c8cf4a',
          })
          .inscriptionRevealed({
            content_bytes:
              '0x7b2270223a226272632d3230222c226f70223a226d696e74222c227469636b223a22656f7262222c22616d74223a223130227d',
            content_length: 51,
            content_type: 'text/plain',
            curse_type: null,
            delegate: '',
            inscriber_address: '',
            inscription_fee: 3210,
            inscription_id: '53957f47697096cef4ad24dae6357b3d7ffe1e3eb9216ce0bb01d6b6a2c8cf4ai0',
            inscription_input_index: 0,
            inscription_number: {
              classic: 0,
              jubilee: 0,
            },
            inscription_output_value: 1000,
            inscription_pointer: 0,
            metadata: null,
            metaprotocol: '',
            ordinal_block_height: 203651,
            ordinal_number: 1018259086681705,
            ordinal_offset: 4086681705,
            parent: '',
            satpoint_post_inscription:
              '53957f47697096cef4ad24dae6357b3d7ffe1e3eb9216ce0bb01d6b6a2c8cf4a:0:665136296',
            transfers_pre_inscription: 0,
            tx_index: 2486,
          })
          .build()
      );
      const response = await fastify.inject({
        method: 'GET',
        url: `/ordinals/inscriptions/53957f47697096cef4ad24dae6357b3d7ffe1e3eb9216ce0bb01d6b6a2c8cf4ai0`,
      });
      expect(response.statusCode).toBe(200);
      const status = await db.sql<{ transfer_type: string }[]>`
        SELECT transfer_type
        FROM locations
        INNER JOIN inscriptions USING (ordinal_number)
        WHERE genesis_id = '53957f47697096cef4ad24dae6357b3d7ffe1e3eb9216ce0bb01d6b6a2c8cf4ai0'
      `;
      expect(status[0].transfer_type).toBe('burnt');
    });
  });

  describe('gap detection', () => {
    test('server rejects payload with first inscription gap when streaming', async () => {
      await db.updateInscriptions(
        new TestChainhookPayloadBuilder()
          .streamingBlocks(false)
          .apply()
          .block({
            height: 778575,
            hash: '0x00000000000000000002a90330a99f67e3f01eb2ce070b45930581e82fb7a91d',
            timestamp: 1676913207,
          })
          .transaction({
            hash: '9f4a9b73b0713c5da01c0a47f97c6c001af9028d6bdd9e264dfacbc4e6790201',
          })
          .inscriptionRevealed({
            content_bytes: '0x48656C6C6F',
            content_type: 'text/plain;charset=utf-8',
            content_length: 5,
            inscription_number: { classic: 0, jubilee: 0 },
            inscription_fee: 705,
            inscription_id: '9f4a9b73b0713c5da01c0a47f97c6c001af9028d6bdd9e264dfacbc4e6790201i0',
            inscription_output_value: 10000,
            inscriber_address: 'bc1pscktlmn99gyzlvymvrezh6vwd0l4kg06tg5rvssw0czg8873gz5sdkteqj',
            ordinal_number: 257418248345364,
            ordinal_block_height: 650000,
            ordinal_offset: 0,
            satpoint_post_inscription:
              '9f4a9b73b0713c5da01c0a47f97c6c001af9028d6bdd9e264dfacbc4e6790201:0:0',
            inscription_input_index: 0,
            transfers_pre_inscription: 0,
            tx_index: 0,
            curse_type: null,
            inscription_pointer: null,
            delegate: null,
            metaprotocol: null,
            metadata: null,
            parent: null,
          })
          .build()
      );
      const errorPayload1 = new TestChainhookPayloadBuilder()
        .streamingBlocks(false)
        .apply()
        .block({
          height: 778576,
          hash: '00000000000000000002a90330a99f67e3f01eb2ce070b45930581e82fb7a91d',
          timestamp: 1676913207,
        })
        .transaction({
          hash: '38c46a8bf7ec90bc7f6b797e7dc84baa97f4e5fd4286b92fe1b50176d03b18dc',
        })
        .inscriptionRevealed({
          content_bytes: '0x48656C6C6F',
          content_type: 'text/plain;charset=utf-8',
          content_length: 5,
          inscription_number: { classic: 5, jubilee: 5 }, // Gap at 5 but block is not streamed
          inscription_fee: 705,
          inscription_id: '38c46a8bf7ec90bc7f6b797e7dc84baa97f4e5fd4286b92fe1b50176d03b18dci0',
          inscription_output_value: 10000,
          inscriber_address: 'bc1p3cyx5e2hgh53w7kpxcvm8s4kkega9gv5wfw7c4qxsvxl0u8x834qf0u2td',
          ordinal_number: 1050000000000000,
          ordinal_block_height: 650000,
          ordinal_offset: 0,
          satpoint_post_inscription:
            '38c46a8bf7ec90bc7f6b797e7dc84baa97f4e5fd4286b92fe1b50176d03b18dc:0:0',
          inscription_input_index: 0,
          transfers_pre_inscription: 0,
          tx_index: 0,
          curse_type: null,
          inscription_pointer: null,
          delegate: null,
          metaprotocol: null,
          metadata: null,
          parent: null,
        })
        .build();
      // Not streamed, accepts block.
      await expect(db.updateInscriptions(errorPayload1)).resolves.not.toThrow(
        BadPayloadRequestError
      );

      const errorPayload2 = new TestChainhookPayloadBuilder()
        .streamingBlocks(true)
        .apply()
        .block({
          height: 778579,
          hash: '00000000000000000002a90330a99f67e3f01eb2ce070b45930581e82fb7a91d',
          timestamp: 1676913207,
        })
        .transaction({
          hash: '38c46a8bf7ec90bc7f6b797e7dc84baa97f4e5fd4286b92fe1b50176d03b18dc',
        })
        .inscriptionRevealed({
          content_bytes: '0x48656C6C6F',
          content_type: 'text/plain;charset=utf-8',
          content_length: 5,
          inscription_number: { classic: 10, jubilee: 10 }, // Gap at 10
          inscription_fee: 705,
          inscription_id: '38c46a8bf7ec90bc7f6b797e7dc84baa97f4e5fd4286b92fe1b50176d03b18dci0',
          inscription_output_value: 10000,
          inscriber_address: 'bc1p3cyx5e2hgh53w7kpxcvm8s4kkega9gv5wfw7c4qxsvxl0u8x834qf0u2td',
          ordinal_number: 1050000000000000,
          ordinal_block_height: 650000,
          ordinal_offset: 0,
          satpoint_post_inscription:
            '38c46a8bf7ec90bc7f6b797e7dc84baa97f4e5fd4286b92fe1b50176d03b18dc:0:0',
          inscription_input_index: 0,
          transfers_pre_inscription: 0,
          tx_index: 0,
          curse_type: null,
          inscription_pointer: null,
          delegate: null,
          metaprotocol: null,
          metadata: null,
          parent: null,
        })
        .build();
      await expect(db.updateInscriptions(errorPayload2)).rejects.toThrow(BadPayloadRequestError);
      const response = await server['fastify'].inject({
        method: 'POST',
        url: `/payload`,
        headers: { authorization: `Bearer ${ENV.ORDHOOK_NODE_AUTH_TOKEN}` },
        payload: errorPayload2,
      });
      expect(response.statusCode).toBe(400);
    });

    test('server ignores past blocks', async () => {
      const payload = new TestChainhookPayloadBuilder()
        .apply()
        .block({
          height: 778575,
          hash: '0x00000000000000000002a90330a99f67e3f01eb2ce070b45930581e82fb7a91d',
          timestamp: 1676913207,
        })
        .transaction({
          hash: '9f4a9b73b0713c5da01c0a47f97c6c001af9028d6bdd9e264dfacbc4e6790201',
        })
        .inscriptionRevealed({
          content_bytes: '0x48656C6C6F',
          content_type: 'text/plain;charset=utf-8',
          content_length: 5,
          inscription_number: { classic: 0, jubilee: 0 },
          inscription_fee: 705,
          inscription_id: '9f4a9b73b0713c5da01c0a47f97c6c001af9028d6bdd9e264dfacbc4e6790201i0',
          inscription_output_value: 10000,
          inscriber_address: 'bc1pscktlmn99gyzlvymvrezh6vwd0l4kg06tg5rvssw0czg8873gz5sdkteqj',
          ordinal_number: 257418248345364,
          ordinal_block_height: 650000,
          ordinal_offset: 0,
          satpoint_post_inscription:
            '9f4a9b73b0713c5da01c0a47f97c6c001af9028d6bdd9e264dfacbc4e6790201:0:0',
          inscription_input_index: 0,
          transfers_pre_inscription: 0,
          tx_index: 0,
          curse_type: null,
          inscription_pointer: null,
          delegate: null,
          metaprotocol: null,
          metadata: null,
          parent: null,
        })
        .build();
      await db.updateInscriptions(payload);

      const response = await server['fastify'].inject({
        method: 'POST',
        url: `/payload`,
        headers: { authorization: `Bearer ${ENV.ORDHOOK_NODE_AUTH_TOKEN}` },
        payload: payload,
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('jubilee', () => {
    test('supports multiple inscriptions on the same sat', async () => {
      await expect(
        db.updateInscriptions(
          new TestChainhookPayloadBuilder()
            .apply()
            .block({
              height: 778575,
              hash: '0x00000000000000000002a90330a99f67e3f01eb2ce070b45930581e82fb7a91d',
              timestamp: 1676913207,
            })
            .transaction({
              hash: '9f4a9b73b0713c5da01c0a47f97c6c001af9028d6bdd9e264dfacbc4e6790201',
            })
            .inscriptionRevealed({
              content_bytes: '0x48656C6C6F',
              content_type: 'text/plain;charset=utf-8',
              content_length: 5,
              inscription_number: { classic: 0, jubilee: 0 },
              inscription_fee: 705,
              inscription_id: '9f4a9b73b0713c5da01c0a47f97c6c001af9028d6bdd9e264dfacbc4e6790201i0',
              inscription_output_value: 10000,
              inscriber_address: 'bc1pscktlmn99gyzlvymvrezh6vwd0l4kg06tg5rvssw0czg8873gz5sdkteqj',
              ordinal_number: 257418248345364,
              ordinal_block_height: 650000,
              ordinal_offset: 0,
              satpoint_post_inscription:
                '9f4a9b73b0713c5da01c0a47f97c6c001af9028d6bdd9e264dfacbc4e6790201:0:0',
              inscription_input_index: 0,
              transfers_pre_inscription: 0,
              tx_index: 0,
              curse_type: null,
              inscription_pointer: null,
              delegate: null,
              metaprotocol: null,
              metadata: { tag: 'x' },
              parent: null,
            })
            .inscriptionRevealed({
              content_bytes: '0x48656C6C6F',
              content_type: 'text/plain;charset=utf-8',
              content_length: 5,
              inscription_number: { classic: -1, jubilee: 1 }, // Would have been cursed
              inscription_fee: 705,
              inscription_id: '9f4a9b73b0713c5da01c0a47f97c6c001af9028d6bdd9e264dfacbc4e6790201i1',
              inscription_output_value: 10000,
              inscriber_address: 'bc1pscktlmn99gyzlvymvrezh6vwd0l4kg06tg5rvssw0czg8873gz5sdkteqj',
              ordinal_number: 257418248345364, // Same sat
              ordinal_block_height: 650000,
              ordinal_offset: 0,
              // Same satpoint
              satpoint_post_inscription:
                '9f4a9b73b0713c5da01c0a47f97c6c001af9028d6bdd9e264dfacbc4e6790201:0:0',
              inscription_input_index: 0,
              transfers_pre_inscription: 0,
              tx_index: 0,
              curse_type: null,
              inscription_pointer: null,
              delegate: null,
              metaprotocol: null,
              metadata: null,
              parent: null,
            })
            .build()
        )
      ).resolves.not.toThrow();
      await expect(
        db.updateInscriptions(
          new TestChainhookPayloadBuilder()
            .apply()
            .block({
              height: 778576,
              hash: '0x00000000000000000002173ce6af911021497679237eb4527757f90bd8b8c645',
              timestamp: 1676913207,
            })
            .transaction({
              hash: 'ccff45c1f320d75228527ed92c27e5c20f973b73bc9641226009fc8156302051',
            })
            .inscriptionTransferred({
              ordinal_number: 257418248345364,
              tx_index: 0,
              destination: {
                value: '3DPjniGQeJwm8dm76F8oRD1EYvc93KfVKf',
                type: 'transferred',
              },
              satpoint_pre_transfer:
                '9f4a9b73b0713c5da01c0a47f97c6c001af9028d6bdd9e264dfacbc4e6790201:0:0',
              satpoint_post_transfer:
                'ccff45c1f320d75228527ed92c27e5c20f973b73bc9641226009fc8156302051:0:0',
              post_transfer_output_value: 9000,
            })
            .build()
        )
      ).resolves.not.toThrow();
    });
  });
});

import {
  BasePgStore,
  PgConnectionVars,
  PgSqlClient,
  PgSqlQuery,
  batchIterate,
  connectPostgres,
  logger,
  runMigrations,
  stopwatch,
} from '@hirosystems/api-toolkit';
import { BitcoinEvent, BitcoinPayload } from '@hirosystems/chainhook-client';
import * as path from 'path';
import * as postgres from 'postgres';
import { Order, OrderBy } from '../api/schemas';
import { ENV } from '../env';
import { Brc20PgStore } from './brc20/brc20-pg-store';
import { CountsPgStore } from './counts/counts-pg-store';
import { getIndexResultCountType } from './counts/helpers';
import { BlockCache } from './helpers';
import {
  DbFullyLocatedInscriptionResult,
  DbInscriptionContent,
  DbInscriptionCountPerBlock,
  DbInscriptionCountPerBlockFilters,
  DbInscriptionIndexFilters,
  DbInscriptionIndexOrder,
  DbInscriptionIndexPaging,
  DbInscriptionLocationChange,
  DbLocation,
  DbLocationPointer,
  DbLocationPointerInsert,
  DbPaginatedResult,
  InscriptionEventData,
  LOCATIONS_COLUMNS,
  InscriptionInsert,
  LocationInsert,
  LocationData,
} from './types';
import { normalizedHexString } from '../api/util/helpers';

export const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');
export const ORDINALS_GENESIS_BLOCK = 767430;
export const INSERT_BATCH_SIZE = 4000;

type InscriptionIdentifier = { genesis_id: string } | { number: number };

export class PgStore extends BasePgStore {
  readonly brc20: Brc20PgStore;
  readonly counts: CountsPgStore;

  static async connect(opts?: { skipMigrations: boolean }): Promise<PgStore> {
    const pgConfig: PgConnectionVars = {
      host: ENV.PGHOST,
      port: ENV.PGPORT,
      user: ENV.PGUSER,
      password: ENV.PGPASSWORD,
      database: ENV.PGDATABASE,
    };
    const sql = await connectPostgres({
      usageName: 'ordinals-pg-store',
      connectionArgs: pgConfig,
      connectionConfig: {
        poolMax: ENV.PG_CONNECTION_POOL_MAX,
        idleTimeout: ENV.PG_IDLE_TIMEOUT,
        maxLifetime: ENV.PG_MAX_LIFETIME,
        statementTimeout: ENV.PG_STATEMENT_TIMEOUT,
      },
    });
    if (opts?.skipMigrations !== true) {
      await runMigrations(MIGRATIONS_DIR, 'up');
    }
    return new PgStore(sql);
  }

  constructor(sql: PgSqlClient) {
    super(sql);
    this.brc20 = new Brc20PgStore(this);
    this.counts = new CountsPgStore(this);
  }

  /**
   * Inserts inscription genesis and transfers from Ordhook events. Also handles rollbacks from
   * chain re-orgs.
   * @param args - Apply/Rollback Ordhook events
   */
  async updateInscriptions(payload: BitcoinPayload): Promise<void> {
    await this.sqlWriteTransaction(async sql => {
      const streamed = payload.chainhook.is_streaming_blocks;
      for (const event of payload.rollback) {
        logger.info(`PgStore rolling back block ${event.block_identifier.index}`);
        const time = stopwatch();
        await this.updateInscriptionsEvent(sql, event, 'rollback', streamed);
        await this.brc20.updateBrc20Operations(sql, event, 'rollback');
        logger.info(
          `PgStore rolled back block ${
            event.block_identifier.index
          } in ${time.getElapsedSeconds()}s`
        );
      }
      for (const event of payload.apply) {
        if (await this.isBlockIngested(event)) {
          logger.warn(`PgStore skipping previously seen block ${event.block_identifier.index}`);
          continue;
        }
        logger.info(`PgStore applying block ${event.block_identifier.index}`);
        const time = stopwatch();
        await this.updateInscriptionsEvent(sql, event, 'apply', streamed);
        await this.brc20.updateBrc20Operations(sql, event, 'apply');
        await this.updateChainTipBlockHeight(sql, event.block_identifier.index);
        logger.info(
          `PgStore applied block ${event.block_identifier.index} in ${time.getElapsedSeconds()}s`
        );
      }
    });
  }

  private async updateInscriptionsEvent(
    sql: PgSqlClient,
    event: BitcoinEvent,
    direction: 'apply' | 'rollback',
    streamed: boolean = false
  ) {
    const block_height = event.block_identifier.index;
    const block_hash = normalizedHexString(event.block_identifier.hash);
    const timestamp = event.timestamp;
    const cache = new BlockCache();
    for (const tx of event.transactions) {
      const tx_id = normalizedHexString(tx.transaction_identifier.hash);
      for (const operation of tx.metadata.ordinal_operations) {
        if (operation.inscription_revealed) {
          cache.reveal(operation.inscription_revealed, block_height, block_hash, tx_id, timestamp);
        }
        if (operation.inscription_transferred)
          cache.transfer(
            operation.inscription_transferred,
            block_height,
            block_hash,
            tx_id,
            timestamp
          );
      }
    }
    switch (direction) {
      case 'apply':
        await this.applyInscriptions(sql, cache, streamed);
        break;
      case 'rollback':
        await this.rollBackInscriptions(sql, cache, streamed);
        break;
    }
  }

  private async applyInscriptions(
    sql: PgSqlClient,
    cache: BlockCache,
    streamed: boolean
  ): Promise<void> {
    if (cache.satoshis.length)
      for await (const batch of batchIterate(cache.satoshis, INSERT_BATCH_SIZE))
        await sql`
          INSERT INTO satoshis ${sql(batch)}
          ON CONFLICT (ordinal_number) DO NOTHING
        `;
    if (cache.inscriptions.length) {
      const entries = cache.inscriptions.map(i => ({
        ...i,
        timestamp: sql`TO_TIMESTAMP(${i.timestamp})`,
      }));
      for await (const batch of batchIterate(entries, INSERT_BATCH_SIZE))
        await sql`
          INSERT INTO inscriptions ${sql(batch)}
          ON CONFLICT (genesis_id) DO NOTHING
        `;
    }
    if (cache.locations.length) {
      const entries = cache.locations.map(l => ({
        ...l,
        timestamp: sql`TO_TIMESTAMP(${l.timestamp})`,
      }));
      for await (const batch of batchIterate(entries, INSERT_BATCH_SIZE))
        await sql`
          INSERT INTO locations ${sql(batch)}
          ON CONFLICT (ordinal_number, block_height, tx_index) DO NOTHING
        `;
    }
    if (cache.currentLocations.size) {
      const entries = [...cache.currentLocations.values()];
      for await (const batch of batchIterate(entries, INSERT_BATCH_SIZE))
        await sql`
          INSERT INTO current_locations ${sql(batch)}
          ON CONFLICT (ordinal_number) DO UPDATE SET
            block_height = EXCLUDED.block_height,
            tx_index = EXCLUDED.tx_index,
            address = EXCLUDED.address
          WHERE
            EXCLUDED.block_height > current_locations.block_height OR
            (EXCLUDED.block_height = current_locations.block_height AND
              EXCLUDED.tx_index > current_locations.tx_index)
        `;
      if (streamed)
        for await (const batch of batchIterate(
          [...cache.currentLocations.keys()],
          INSERT_BATCH_SIZE
        ))
          await sql`
            UPDATE inscriptions
            SET updated_at = NOW()
            WHERE ordinal_number IN ${sql(batch)}
          `;
    }
  }

  private async rollBackInscriptions(
    sql: PgSqlClient,
    cache: BlockCache,
    streamed: boolean
  ): Promise<void> {
    if (cache.currentLocations.size)
      // We will recalculate in a bit.
      for (const ordinal_number of cache.currentLocations.keys())
        await sql`
          DELETE FROM current_locations WHERE ordinal_number = ${ordinal_number}
        `;
    if (cache.locations.length)
      for (const location of cache.locations)
        await sql`
          DELETE FROM locations
          WHERE ordinal_number = ${location.ordinal_number}
            AND block_height = ${location.block_height}
            AND tx_index = ${location.tx_index}
        `;
    if (cache.inscriptions.length)
      for (const inscription of cache.inscriptions)
        await sql`
          DELETE FROM inscriptions WHERE genesis_id = ${inscription.genesis_id}
        `;
    if (cache.satoshis.length)
      for (const satoshi of cache.satoshis)
        await sql`
          DELETE FROM satoshis
          WHERE ordinal_number = ${satoshi.ordinal_number} AND NOT EXISTS (
            SELECT genesis_id FROM inscriptions WHERE ordinal_number = ${satoshi.ordinal_number}
          )
        `;
    // Recalculate current locations for affected inscriptions.
    if (cache.currentLocations.size) {
      for (const ordinal_number of cache.currentLocations.keys()) {
        await sql`
          INSERT INTO current_locations (ordinal_number, block_height, tx_index, address)
          (
            SELECT ordinal_number, block_height, tx_index, address
            FROM locations
            WHERE ordinal_number = ${ordinal_number}
            ORDER BY block_height DESC, tx_index DESC
            LIMIT 1
          )
        `;
      }
      if (streamed)
        for await (const batch of batchIterate(
          [...cache.currentLocations.keys()],
          INSERT_BATCH_SIZE
        ))
          await sql`
            UPDATE inscriptions
            SET updated_at = NOW()
            WHERE ordinal_number IN ${sql(batch)}
          `;
    }
  }

  private async isBlockIngested(event: BitcoinEvent): Promise<boolean> {
    const currentBlockHeight = await this.getChainTipBlockHeight();
    if (
      event.block_identifier.index <= currentBlockHeight &&
      event.block_identifier.index !== ORDINALS_GENESIS_BLOCK
    ) {
      return true;
    }
    return false;
  }

  private async updateChainTipBlockHeight(sql: PgSqlClient, block_height: number): Promise<void> {
    await sql`UPDATE chain_tip SET block_height = ${block_height}`;
  }

  async getChainTipBlockHeight(): Promise<number> {
    const result = await this.sql<{ block_height: string }[]>`SELECT block_height FROM chain_tip`;
    return parseInt(result[0].block_height);
  }

  async getMaxInscriptionNumber(): Promise<number | undefined> {
    const result = await this.sql<{ max: string }[]>`
      SELECT MAX(number) FROM inscriptions WHERE number >= 0
    `;
    if (result[0].max) {
      return parseInt(result[0].max);
    }
  }

  async getMaxCursedInscriptionNumber(): Promise<number | undefined> {
    const result = await this.sql<{ min: string }[]>`
      SELECT MIN(number) FROM inscriptions WHERE number < 0
    `;
    if (result[0].min) {
      return parseInt(result[0].min);
    }
  }

  async getInscriptionsIndexETag(): Promise<string> {
    const result = await this.sql<{ etag: string }[]>`
      SELECT date_part('epoch', MAX(updated_at))::text AS etag FROM inscriptions
    `;
    return result[0].etag;
  }

  async getInscriptionsPerBlockETag(): Promise<string> {
    const result = await this.sql<{ block_hash: string; inscription_count: string }[]>`
      SELECT block_hash, inscription_count
      FROM inscriptions_per_block
      ORDER BY block_height DESC
      LIMIT 1
    `;
    return `${result[0].block_hash}:${result[0].inscription_count}`;
  }

  async getInscriptionContent(
    args: InscriptionIdentifier
  ): Promise<DbInscriptionContent | undefined> {
    const result = await this.sql<DbInscriptionContent[]>`
      SELECT content, content_type, content_length
      FROM inscriptions
      WHERE ${
        'genesis_id' in args
          ? this.sql`genesis_id = ${args.genesis_id}`
          : this.sql`number = ${args.number}`
      }
    `;
    if (result.count > 0) {
      return result[0];
    }
  }

  async getInscriptionETag(args: InscriptionIdentifier): Promise<string | undefined> {
    const result = await this.sql<{ etag: string }[]>`
      SELECT date_part('epoch', updated_at)::text AS etag
      FROM inscriptions
      WHERE ${
        'genesis_id' in args
          ? this.sql`genesis_id = ${args.genesis_id}`
          : this.sql`number = ${args.number}`
      }
    `;
    if (result.count > 0) {
      return result[0].etag;
    }
  }

  async getInscriptions(
    page: DbInscriptionIndexPaging,
    filters?: DbInscriptionIndexFilters,
    sort?: DbInscriptionIndexOrder
  ): Promise<DbPaginatedResult<DbFullyLocatedInscriptionResult>> {
    return await this.sqlTransaction(async sql => {
      const order = sort?.order === Order.asc ? sql`ASC` : sql`DESC`;
      let orderBy = sql`i.number ${order}`;
      switch (sort?.order_by) {
        case OrderBy.genesis_block_height:
          orderBy = sql`i.block_height ${order}, i.tx_index ${order}`;
          break;
        case OrderBy.ordinal:
          orderBy = sql`i.ordinal_number ${order}`;
          break;
        case OrderBy.rarity:
          orderBy = sql`ARRAY_POSITION(ARRAY['common','uncommon','rare','epic','legendary','mythic'], s.rarity) ${order}, i.number DESC`;
          break;
      }
      // This function will generate a query to be used for getting results or total counts.
      const query = (
        columns: postgres.PendingQuery<postgres.Row[]>,
        sorting: postgres.PendingQuery<postgres.Row[]>
      ) => sql`
        SELECT ${columns}
        FROM inscriptions AS i
        INNER JOIN current_locations AS cur ON cur.ordinal_number = i.ordinal_number
        INNER JOIN locations AS cur_l ON cur_l.ordinal_number = cur.ordinal_number AND cur_l.block_height = cur.block_height AND cur_l.tx_index = cur.tx_index
        INNER JOIN locations AS gen_l ON gen_l.ordinal_number = cur.ordinal_number AND gen_l.block_height = cur.block_height AND gen_l.tx_index = cur.tx_index
        INNER JOIN satoshis AS s ON s.ordinal_number = i.ordinal_number
        WHERE TRUE
          ${
            filters?.genesis_id?.length
              ? sql`AND i.genesis_id IN ${sql(filters.genesis_id)}`
              : sql``
          }
          ${
            filters?.genesis_block_height
              ? sql`AND i.block_height = ${filters.genesis_block_height}`
              : sql``
          }
          ${
            filters?.genesis_block_hash
              ? sql`AND gen_l.block_hash = ${filters.genesis_block_hash}`
              : sql``
          }
          ${
            filters?.from_genesis_block_height
              ? sql`AND i.block_height >= ${filters.from_genesis_block_height}`
              : sql``
          }
          ${
            filters?.to_genesis_block_height
              ? sql`AND i.block_height <= ${filters.to_genesis_block_height}`
              : sql``
          }
          ${
            filters?.from_sat_coinbase_height
              ? sql`AND s.coinbase_height >= ${filters.from_sat_coinbase_height}`
              : sql``
          }
          ${
            filters?.to_sat_coinbase_height
              ? sql`AND s.coinbase_height <= ${filters.to_sat_coinbase_height}`
              : sql``
          }
          ${
            filters?.from_genesis_timestamp
              ? sql`AND i.timestamp >= to_timestamp(${filters.from_genesis_timestamp})`
              : sql``
          }
          ${
            filters?.to_genesis_timestamp
              ? sql`AND i.timestamp <= to_timestamp(${filters.to_genesis_timestamp})`
              : sql``
          }
          ${
            filters?.from_sat_ordinal
              ? sql`AND i.ordinal_number >= ${filters.from_sat_ordinal}`
              : sql``
          }
          ${
            filters?.to_sat_ordinal ? sql`AND i.ordinal_number <= ${filters.to_sat_ordinal}` : sql``
          }
          ${filters?.number?.length ? sql`AND i.number IN ${sql(filters.number)}` : sql``}
          ${
            filters?.from_number !== undefined ? sql`AND i.number >= ${filters.from_number}` : sql``
          }
          ${filters?.to_number !== undefined ? sql`AND i.number <= ${filters.to_number}` : sql``}
          ${filters?.address?.length ? sql`AND cur.address IN ${sql(filters.address)}` : sql``}
          ${filters?.mime_type?.length ? sql`AND i.mime_type IN ${sql(filters.mime_type)}` : sql``}
          ${filters?.output ? sql`AND cur_l.output = ${filters.output}` : sql``}
          ${filters?.sat_rarity?.length ? sql`AND s.rarity IN ${sql(filters.sat_rarity)}` : sql``}
          ${filters?.sat_ordinal ? sql`AND i.ordinal_number = ${filters.sat_ordinal}` : sql``}
          ${filters?.recursive !== undefined ? sql`AND i.recursive = ${filters.recursive}` : sql``}
          ${filters?.cursed === true ? sql`AND i.number < 0` : sql``}
          ${filters?.cursed === false ? sql`AND i.number >= 0` : sql``}
          ${
            filters?.genesis_address?.length
              ? sql`AND i.address IN ${sql(filters.genesis_address)}`
              : sql``
          }
        ${sorting}
      `;
      const results = await sql<DbFullyLocatedInscriptionResult[]>`${query(
        sql`
          i.genesis_id,
          i.number,
          i.mime_type,
          i.content_type,
          i.content_length,
          i.fee AS genesis_fee,
          i.curse_type,
          i.ordinal_number AS sat_ordinal,
          s.rarity AS sat_rarity,
          s.coinbase_height AS sat_coinbase_height,
          i.recursive,
          (
            SELECT STRING_AGG(ir.ref_genesis_id, ',')
            FROM inscription_recursions AS ir
            WHERE ir.genesis_id = i.genesis_id
          ) AS recursion_refs,
          i.block_height AS genesis_block_height,
          gen_l.block_hash AS genesis_block_hash,
          gen_l.tx_id AS genesis_tx_id,
          i.timestamp AS genesis_timestamp,
          i.address AS genesis_address,
          cur_l.tx_id,
          cur.address,
          cur_l.output,
          cur_l.offset,
          cur_l.timestamp,
          cur_l.value
        `,
        sql`ORDER BY ${orderBy} LIMIT ${page.limit} OFFSET ${page.offset}`
      )}`;
      // Do we need a filtered `COUNT(*)`? If so, try to use the pre-calculated counts we have in
      // cached tables to speed up these queries.
      const countType = getIndexResultCountType(filters);
      let total = await this.counts.fromResults(countType, filters);
      if (total === undefined) {
        // If the count is more complex, attempt it with a separate query.
        const count = await sql<{ total: number }[]>`${query(sql`COUNT(*) AS total`, sql``)}`;
        total = count[0].total;
      }
      return {
        total,
        results: results ?? [],
      };
    });
  }

  async getInscriptionLocations(
    args: InscriptionIdentifier & { limit: number; offset: number }
  ): Promise<DbPaginatedResult<DbLocation>> {
    const results = await this.sql<({ total: number } & DbLocation)[]>`
      SELECT ${this.sql(LOCATIONS_COLUMNS)}, COUNT(*) OVER() as total
      FROM locations
      WHERE genesis_id = (
        SELECT genesis_id FROM inscriptions
        WHERE ${
          'number' in args
            ? this.sql`number = ${args.number}`
            : this.sql`genesis_id = ${args.genesis_id}`
        }
        LIMIT 1
      )
      ORDER BY block_height DESC, tx_index DESC
      LIMIT ${args.limit}
      OFFSET ${args.offset}
    `;
    return {
      total: results[0]?.total ?? 0,
      results: results ?? [],
    };
  }

  async getTransfersPerBlock(
    args: { block_height?: number; block_hash?: string } & DbInscriptionIndexPaging
  ): Promise<DbPaginatedResult<DbInscriptionLocationChange>> {
    const results = await this.sql<({ total: number } & DbInscriptionLocationChange)[]>`
      WITH max_transfer_index AS (
        SELECT MAX(block_transfer_index) FROM locations WHERE ${
          'block_height' in args
            ? this.sql`block_height = ${args.block_height}`
            : this.sql`block_hash = ${args.block_hash}`
        } AND block_transfer_index IS NOT NULL
      ),
      transfers AS (
        SELECT
          i.id AS inscription_id,
          i.genesis_id,
          i.number,
          l.id AS to_id,
          (
            SELECT id
            FROM locations AS ll
            WHERE
              ll.inscription_id = i.id
              AND (
                ll.block_height < l.block_height OR
                (ll.block_height = l.block_height AND ll.tx_index < l.tx_index)
              )
            ORDER BY ll.block_height DESC
            LIMIT 1
          ) AS from_id
        FROM locations AS l
        INNER JOIN inscriptions AS i ON l.inscription_id = i.id
        WHERE
          ${
            'block_height' in args
              ? this.sql`l.block_height = ${args.block_height}`
              : this.sql`l.block_hash = ${args.block_hash}`
          }
          AND l.block_transfer_index IS NOT NULL
          AND l.block_transfer_index <= ((SELECT max FROM max_transfer_index) - ${args.offset}::int)
          AND l.block_transfer_index >
            ((SELECT max FROM max_transfer_index) - (${args.offset}::int + ${args.limit}::int))
      )
      SELECT
        t.genesis_id,
        t.number,
        (SELECT max FROM max_transfer_index) + 1 AS total,
        ${this.sql.unsafe(LOCATIONS_COLUMNS.map(c => `lf.${c} AS from_${c}`).join(','))},
        ${this.sql.unsafe(LOCATIONS_COLUMNS.map(c => `lt.${c} AS to_${c}`).join(','))}
      FROM transfers AS t
      INNER JOIN locations AS lf ON t.from_id = lf.id
      INNER JOIN locations AS lt ON t.to_id = lt.id
      ORDER BY lt.block_transfer_index DESC
    `;
    return {
      total: results[0]?.total ?? 0,
      results: results ?? [],
    };
  }

  async getInscriptionCountPerBlock(
    filters: DbInscriptionCountPerBlockFilters
  ): Promise<DbInscriptionCountPerBlock[]> {
    const fromCondition = filters.from_block_height
      ? this.sql`block_height >= ${filters.from_block_height}`
      : this.sql``;

    const toCondition = filters.to_block_height
      ? this.sql`block_height <= ${filters.to_block_height}`
      : this.sql``;

    const where =
      filters.from_block_height && filters.to_block_height
        ? this.sql`WHERE ${fromCondition} AND ${toCondition}`
        : this.sql`WHERE ${fromCondition}${toCondition}`;

    return await this.sql<DbInscriptionCountPerBlock[]>`
      SELECT *
      FROM inscriptions_per_block
      ${filters.from_block_height || filters.to_block_height ? where : this.sql``}
      ORDER BY block_height DESC
      LIMIT 5000
    `; // roughly 35 days of blocks, assuming 10 minute block times on a full database
  }

  private async normalizeInscriptionCount(args: { min_block_height: number }): Promise<void> {
    await this.sqlWriteTransaction(async sql => {
      await sql`
        DELETE FROM inscriptions_per_block
        WHERE block_height >= ${args.min_block_height}
      `;
      // - gets highest total for a block < min_block_height
      // - calculates new totals for all blocks >= min_block_height
      // - inserts new totals
      await sql`
        WITH previous AS (
          SELECT *
          FROM inscriptions_per_block
          WHERE block_height < ${args.min_block_height}
          ORDER BY block_height DESC
          LIMIT 1
        ), updated_blocks AS (
          SELECT
            l.block_height,
            MIN(l.block_hash),
            COUNT(*) AS inscription_count,
            COALESCE((SELECT previous.inscription_count_accum FROM previous), 0) + (SUM(COUNT(*)) OVER (ORDER BY l.block_height ASC)) AS inscription_count_accum,
            MIN(l.timestamp)
          FROM locations AS l
          INNER JOIN genesis_locations AS g ON g.location_id = l.id
          WHERE l.block_height >= ${args.min_block_height}
          GROUP BY l.block_height
          ORDER BY l.block_height ASC
        )
        INSERT INTO inscriptions_per_block
        SELECT * FROM updated_blocks
        ON CONFLICT (block_height) DO UPDATE SET
          block_hash = EXCLUDED.block_hash,
          inscription_count = EXCLUDED.inscription_count,
          inscription_count_accum = EXCLUDED.inscription_count_accum,
          timestamp = EXCLUDED.timestamp;
      `;
    });
  }
}

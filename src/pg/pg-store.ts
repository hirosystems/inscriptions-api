import {
  BasePgStore,
  PgConnectionVars,
  PgSqlClient,
  batchIterate,
  connectPostgres,
  logger,
  runMigrations,
  stopwatch,
} from '@hirosystems/api-toolkit';
import {
  BadPayloadRequestError,
  BitcoinEvent,
  BitcoinPayload,
} from '@hirosystems/chainhook-client';
import * as path from 'path';
import * as postgres from 'postgres';
import { Order, OrderBy } from '../api/schemas';
import { ENV } from '../env';
import { Brc20PgStore } from './brc20/brc20-pg-store';
import { CountsPgStore } from './counts/counts-pg-store';
import { getIndexResultCountType } from './counts/helpers';
import {
  DbFullyLocatedInscriptionResult,
  DbInscriptionContent,
  DbInscriptionIndexFilters,
  DbInscriptionIndexOrder,
  DbInscriptionIndexPaging,
  DbInscriptionLocationChange,
  DbLocation,
  DbPaginatedResult,
} from './types';
import { normalizedHexString } from '../api/util/helpers';
import { BlockCache } from './block-cache';

export const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');
const ORDINALS_GENESIS_BLOCK = 767430;
export const INSERT_BATCH_SIZE = 4000;

type InscriptionIdentifier = { genesis_id: string } | { number: number };

class BlockAlreadyIngestedError extends Error {}

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
        logger.info(`PgStore rollback block ${event.block_identifier.index}`);
        const time = stopwatch();
        await this.updateInscriptionsEvent(sql, event, 'rollback', streamed);
        await this.brc20.updateBrc20Operations(sql, event, 'rollback');
        await this.updateChainTipBlockHeight(sql, event.block_identifier.index - 1);
        logger.info(
          `PgStore rollback block ${
            event.block_identifier.index
          } finished in ${time.getElapsedSeconds()}s`
        );
      }
      for (const event of payload.apply) {
        logger.info(`PgStore apply block ${event.block_identifier.index}`);
        const time = stopwatch();
        try {
          await this.updateInscriptionsEvent(sql, event, 'apply', streamed);
          await this.brc20.updateBrc20Operations(sql, event, 'apply');
        } catch (error) {
          if (error instanceof BlockAlreadyIngestedError) {
            logger.warn(error);
            continue;
          } else throw error;
        }
        await this.updateChainTipBlockHeight(sql, event.block_identifier.index);
        logger.info(
          `PgStore apply block ${
            event.block_identifier.index
          } finished in ${time.getElapsedSeconds()}s`
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
    const cache = new BlockCache(
      event.block_identifier.index,
      normalizedHexString(event.block_identifier.hash),
      event.timestamp
    );
    if (direction === 'apply') await this.assertNextBlockIsNotIngested(sql, event);
    for (const tx of event.transactions) {
      const tx_id = normalizedHexString(tx.transaction_identifier.hash);
      for (const operation of tx.metadata.ordinal_operations) {
        if (operation.inscription_revealed) {
          cache.reveal(operation.inscription_revealed, tx_id);
          logger.info(
            `PgStore ${direction} reveal inscription #${operation.inscription_revealed.inscription_number.jubilee} (${operation.inscription_revealed.inscription_id}) at block ${cache.blockHeight}`
          );
        }
        if (operation.inscription_transferred) {
          cache.transfer(operation.inscription_transferred, tx_id);
          logger.info(
            `PgStore ${direction} transfer satoshi ${operation.inscription_transferred.ordinal_number} to ${operation.inscription_transferred.destination.value} at block ${cache.blockHeight}`
          );
        }
      }
    }
    switch (direction) {
      case 'apply':
        if (streamed) await this.assertNextBlockIsContiguous(sql, event, cache);
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
      // Insert block transfers.
      let block_transfer_index = 0;
      const transferEntries = [];
      for (const transfer of cache.locations) {
        const transferred = await sql<{ genesis_id: string; number: string }[]>`
          SELECT genesis_id, number FROM inscriptions
          WHERE ordinal_number = ${transfer.ordinal_number} AND (
            block_height < ${transfer.block_height}
            OR (block_height = ${transfer.block_height} AND tx_index < ${transfer.tx_index})
          )
        `;
        for (const inscription of transferred)
          transferEntries.push({
            genesis_id: inscription.genesis_id,
            number: inscription.number,
            ordinal_number: transfer.ordinal_number,
            block_height: transfer.block_height,
            block_hash: transfer.block_hash,
            tx_index: transfer.tx_index,
            block_transfer_index: block_transfer_index++,
          });
      }
      for await (const batch of batchIterate(transferEntries, INSERT_BATCH_SIZE))
        await sql`
          INSERT INTO inscription_transfers ${sql(batch)}
          ON CONFLICT (block_height, block_transfer_index) DO NOTHING
        `;
    }
    if (cache.recursiveRefs.size)
      for (const [genesis_id, refs] of cache.recursiveRefs) {
        const entries = refs.map(r => ({ genesis_id, ref_genesis_id: r }));
        await sql`
          INSERT INTO inscription_recursions ${sql(entries)}
          ON CONFLICT (genesis_id, ref_genesis_id) DO NOTHING
        `;
      }
    if (cache.currentLocations.size) {
      // Deduct counts from previous owners
      const moved_sats = [...cache.currentLocations.keys()];
      const prevOwners = await sql<{ address: string; count: number }[]>`
        SELECT address, COUNT(*) AS count
        FROM current_locations
        WHERE ordinal_number IN ${sql(moved_sats)}
        GROUP BY address
      `;
      for (const owner of prevOwners)
        await sql`
          UPDATE counts_by_address
          SET count = count - ${owner.count}
          WHERE address = ${owner.address}
        `;
      // Insert locations
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
      // Update owner counts
      await sql`
        WITH new_owners AS (
          SELECT address, COUNT(*) AS count
          FROM current_locations
          WHERE ordinal_number IN ${sql(moved_sats)}
          GROUP BY address
        )
        INSERT INTO counts_by_address (address, count)
        (SELECT address, count FROM new_owners)
        ON CONFLICT (address) DO UPDATE SET count = counts_by_address.count + EXCLUDED.count
      `;
      if (streamed)
        for await (const batch of batchIterate(moved_sats, INSERT_BATCH_SIZE))
          await sql`
            UPDATE inscriptions
            SET updated_at = NOW()
            WHERE ordinal_number IN ${sql(batch)}
          `;
    }
    await this.counts.applyCounts(sql, cache);
  }

  private async rollBackInscriptions(
    sql: PgSqlClient,
    cache: BlockCache,
    streamed: boolean
  ): Promise<void> {
    await this.counts.rollBackCounts(sql, cache);
    const moved_sats = [...cache.currentLocations.keys()];
    // Delete old current owners first.
    if (cache.currentLocations.size) {
      const prevOwners = await sql<{ address: string; count: number }[]>`
        SELECT address, COUNT(*) AS count
        FROM current_locations
        WHERE ordinal_number IN ${sql(moved_sats)}
        GROUP BY address
      `;
      for (const owner of prevOwners)
        await sql`
          UPDATE counts_by_address
          SET count = count - ${owner.count}
          WHERE address = ${owner.address}
        `;
      await sql`
        DELETE FROM current_locations WHERE ordinal_number IN ${sql(moved_sats)}
      `;
    }
    if (cache.locations.length)
      for (const location of cache.locations)
        await sql`
          DELETE FROM locations
          WHERE ordinal_number = ${location.ordinal_number}
            AND block_height = ${location.block_height}
            AND tx_index = ${location.tx_index}
        `;
    if (cache.inscriptions.length)
      // This will also delete recursive refs.
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
      for (const ordinal_number of moved_sats) {
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
      await sql`
        WITH new_owners AS (
          SELECT address, COUNT(*) AS count
          FROM current_locations
          WHERE ordinal_number IN ${sql(moved_sats)}
          GROUP BY address
        )
        INSERT INTO counts_by_address (address, count)
        (SELECT address, count FROM new_owners)
        ON CONFLICT (address) DO UPDATE SET count = counts_by_address.count + EXCLUDED.count
      `;
      if (streamed)
        for await (const batch of batchIterate(moved_sats, INSERT_BATCH_SIZE))
          await sql`
            UPDATE inscriptions
            SET updated_at = NOW()
            WHERE ordinal_number IN ${sql(batch)}
          `;
    }
  }

  private async assertNextBlockIsNotIngested(sql: PgSqlClient, event: BitcoinEvent) {
    const result = await sql<{ block_height: number }[]>`
      SELECT block_height::int FROM chain_tip
    `;
    if (!result.count) return false;
    const currentHeight = result[0].block_height;
    if (
      event.block_identifier.index <= currentHeight &&
      event.block_identifier.index !== ORDINALS_GENESIS_BLOCK
    ) {
      throw new BlockAlreadyIngestedError(
        `Block ${event.block_identifier.index} is already ingested, chain tip is at ${currentHeight}`
      );
    }
  }

  private async assertNextBlockIsContiguous(
    sql: PgSqlClient,
    event: BitcoinEvent,
    cache: BlockCache
  ) {
    if (!cache.revealedNumbers.length) {
      // TODO: How do we check blocks with only transfers?
      return;
    }
    const result = await sql<{ max: number | null; block_height: number }[]>`
      WITH tip AS (SELECT block_height::int FROM chain_tip)
      SELECT MAX(number)::int AS max, (SELECT block_height FROM tip)
      FROM inscriptions WHERE number >= 0
    `;
    if (!result.count) return;
    const data = result[0];
    const firstReveal = cache.revealedNumbers.sort()[0];
    if (data.max === null && firstReveal === 0) return;
    if ((data.max ?? 0) + 1 != firstReveal)
      throw new BadPayloadRequestError(
        `Streamed block ${event.block_identifier.index} is non-contiguous, attempting to reveal #${firstReveal} when current max is #${data.max} at block height ${data.block_height}`
      );
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
      FROM counts_by_block
      ORDER BY block_height DESC
      LIMIT 1
    `;
    return `${result[0].block_hash}:${result[0].inscription_count}`;
  }

  async getInscriptionContent(
    args: InscriptionIdentifier
  ): Promise<DbInscriptionContent | undefined> {
    const result = await this.sql<DbInscriptionContent[]>`
      WITH content_id AS (
        SELECT
          CASE
            WHEN delegate IS NOT NULL THEN delegate
            ELSE genesis_id
          END AS genesis_id
        FROM inscriptions
        WHERE ${
          'genesis_id' in args
            ? this.sql`genesis_id = ${args.genesis_id}`
            : this.sql`number = ${args.number}`
        }
      )
      SELECT content, content_type, content_length
      FROM inscriptions
      WHERE genesis_id = (SELECT genesis_id FROM content_id)
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
        INNER JOIN locations AS gen_l ON gen_l.ordinal_number = i.ordinal_number AND gen_l.block_height = i.block_height AND gen_l.tx_index = i.tx_index
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
          i.parent,
          i.metadata,
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
      SELECT l.*, COUNT(*) OVER() as total
      FROM locations AS l
      INNER JOIN inscriptions AS i ON i.ordinal_number = l.ordinal_number
      WHERE ${
        'number' in args
          ? this.sql`i.number = ${args.number}`
          : this.sql`i.genesis_id = ${args.genesis_id}`
      }
        AND (
          (l.block_height > i.block_height)
          OR (l.block_height = i.block_height AND l.tx_index >= i.tx_index)
        )
      ORDER BY l.block_height DESC, l.tx_index DESC
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
      WITH transfer_total AS (
        SELECT MAX(block_transfer_index) AS total FROM inscription_transfers WHERE ${
          'block_height' in args
            ? this.sql`block_height = ${args.block_height}`
            : this.sql`block_hash = ${args.block_hash}`
        }
      ),
      transfer_data AS (
        SELECT
          t.number,
          t.genesis_id,
          t.ordinal_number,
          t.block_height,
          t.tx_index,
          t.block_transfer_index,
          (
            SELECT l.block_height || ',' || l.tx_index
            FROM locations AS l
            WHERE l.ordinal_number = t.ordinal_number AND (
              l.block_height < t.block_height OR
              (l.block_height = t.block_height AND l.tx_index < t.tx_index)
            )
            ORDER BY l.block_height DESC, l.tx_index DESC
            LIMIT 1
          ) AS from_data
        FROM inscription_transfers AS t
        WHERE
          ${
            'block_height' in args
              ? this.sql`t.block_height = ${args.block_height}`
              : this.sql`t.block_hash = ${args.block_hash}`
          }
          AND t.block_transfer_index <= ((SELECT total FROM transfer_total) - ${args.offset}::int)
          AND t.block_transfer_index >
            ((SELECT total FROM transfer_total) - (${args.offset}::int + ${args.limit}::int))
      )
      SELECT
        td.genesis_id,
        td.number,
        lf.block_height AS from_block_height,
        lf.block_hash AS from_block_hash,
        lf.tx_id AS from_tx_id,
        lf.address AS from_address,
        lf.output AS from_output,
        lf.offset AS from_offset,
        lf.value AS from_value,
        lf.timestamp AS from_timestamp,
        lt.block_height AS to_block_height,
        lt.block_hash AS to_block_hash,
        lt.tx_id AS to_tx_id,
        lt.address AS to_address,
        lt.output AS to_output,
        lt.offset AS to_offset,
        lt.value AS to_value,
        lt.timestamp AS to_timestamp,
        (SELECT total FROM transfer_total) + 1 AS total
      FROM transfer_data AS td
      INNER JOIN locations AS lf ON td.ordinal_number = lf.ordinal_number AND lf.block_height = SPLIT_PART(td.from_data, ',', 1)::int AND lf.tx_index = SPLIT_PART(td.from_data, ',', 2)::int
      INNER JOIN locations AS lt ON td.ordinal_number = lt.ordinal_number AND td.block_height = lt.block_height AND td.tx_index = lt.tx_index
      ORDER BY td.block_height DESC, td.block_transfer_index DESC
    `;
    return {
      total: results[0]?.total ?? 0,
      results: results ?? [],
    };
  }
}

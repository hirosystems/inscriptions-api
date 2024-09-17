import { BasePgStoreModule, PgSqlClient, batchIterate, logger } from '@hirosystems/api-toolkit';
import { DbInscriptionIndexPaging, DbPaginatedResult } from '../types';
import {
  DbBrc20Activity,
  DbBrc20Balance,
  DbBrc20Holder,
  DbBrc20Token,
  DbBrc20TokenWithSupply,
} from './types';
import { Brc20TokenOrderBy } from '../../api/schemas';
import { objRemoveUndefinedValues } from '../helpers';
import { BitcoinEvent } from '@hirosystems/chainhook-client';
import { sqlOr } from './helpers';
import { INSERT_BATCH_SIZE } from '../pg-store';
import { Brc20BlockCache } from './brc20-block-cache';

export class Brc20PgStore extends BasePgStoreModule {
  async updateBrc20Operations(
    sql: PgSqlClient,
    event: BitcoinEvent,
    direction: 'apply' | 'rollback'
  ): Promise<void> {
    const block_height = event.block_identifier.index;
    const cache = new Brc20BlockCache(block_height);
    for (const tx of event.transactions) {
      const tx_id = tx.transaction_identifier.hash;
      const tx_index = tx.metadata.index;
      if (tx.metadata.brc20_operation) {
        const operation = tx.metadata.brc20_operation;
        if ('deploy' in operation) {
          cache.deploy(operation, tx_id, tx_index);
          logger.info(
            `Brc20PgStore ${direction} deploy ${operation.deploy.tick} by ${operation.deploy.address} at height ${block_height}`
          );
        } else if ('mint' in operation) {
          cache.mint(operation, tx_index);
          logger.info(
            `Brc20PgStore ${direction} mint ${operation.mint.tick} ${operation.mint.amt} by ${operation.mint.address} at height ${block_height}`
          );
        } else if ('transfer' in operation) {
          cache.transfer(operation, tx_index);
          logger.info(
            `Brc20PgStore ${direction} transfer ${operation.transfer.tick} ${operation.transfer.amt} by ${operation.transfer.address} at height ${block_height}`
          );
        } else if ('transfer_send' in operation) {
          cache.transferSend(operation, tx_index);
          logger.info(
            `Brc20PgStore ${direction} transfer_send ${operation.transfer_send.tick} ${operation.transfer_send.amt} from ${operation.transfer_send.sender_address} to ${operation.transfer_send.receiver_address} at height ${block_height}`
          );
        }
      }
    }
    switch (direction) {
      case 'apply':
        await this.applyOperations(sql, cache);
        break;
      case 'rollback':
        await this.rollBackOperations(sql, cache);
        break;
    }
  }

  private async applyOperations(sql: PgSqlClient, cache: Brc20BlockCache) {
    if (cache.tokens.length)
      for await (const batch of batchIterate(cache.tokens, INSERT_BATCH_SIZE))
        await sql`
          INSERT INTO brc20_tokens ${sql(batch)}
          ON CONFLICT (ticker) DO NOTHING
        `;
    if (cache.operations.length)
      for await (const batch of batchIterate(cache.operations, INSERT_BATCH_SIZE))
        await sql`
          INSERT INTO brc20_operations ${sql(batch)}
          ON CONFLICT (genesis_id, operation) DO NOTHING
        `;
    for (const [inscription_id, to_address] of cache.transferReceivers)
      await sql`
        UPDATE brc20_operations SET to_address = ${to_address}
        WHERE genesis_id = ${inscription_id} AND operation = 'transfer_send'
      `;
    for (const [ticker, amount] of cache.tokenMintSupplies)
      await sql`
        UPDATE brc20_tokens SET minted_supply = minted_supply + ${amount.toString()}
        WHERE ticker = ${ticker}
      `;
    for (const [ticker, num] of cache.tokenTxCounts)
      await sql`
        UPDATE brc20_tokens SET tx_count = tx_count + ${num} WHERE ticker = ${ticker}
      `;
    if (cache.operationCounts.size) {
      const entries = [];
      for (const [operation, count] of cache.operationCounts) entries.push({ operation, count });
      for await (const batch of batchIterate(entries, INSERT_BATCH_SIZE))
        await sql`
          INSERT INTO brc20_counts_by_operation ${sql(batch)}
          ON CONFLICT (operation) DO UPDATE SET
            count = brc20_counts_by_operation.count + EXCLUDED.count
        `;
    }
    if (cache.addressOperationCounts.size) {
      const entries = [];
      for (const [address, map] of cache.addressOperationCounts)
        for (const [operation, count] of map) entries.push({ address, operation, count });
      for await (const batch of batchIterate(entries, INSERT_BATCH_SIZE))
        await sql`
          INSERT INTO brc20_counts_by_address_operation ${sql(batch)}
          ON CONFLICT (address, operation) DO UPDATE SET
            count = brc20_counts_by_address_operation.count + EXCLUDED.count
        `;
    }
    if (cache.totalBalanceChanges.size) {
      const entries = [];
      for (const [address, map] of cache.totalBalanceChanges)
        for (const [ticker, values] of map)
          entries.push({
            ticker,
            address,
            avail_balance: values.avail.toString(),
            trans_balance: values.trans.toString(),
            total_balance: values.total.toString(),
          });
      for await (const batch of batchIterate(entries, INSERT_BATCH_SIZE))
        await sql`
          INSERT INTO brc20_total_balances ${sql(batch)}
          ON CONFLICT (ticker, address) DO UPDATE SET
            avail_balance = brc20_total_balances.avail_balance + EXCLUDED.avail_balance,
            trans_balance = brc20_total_balances.trans_balance + EXCLUDED.trans_balance,
            total_balance = brc20_total_balances.total_balance + EXCLUDED.total_balance
        `;
    }
  }

  private async rollBackOperations(sql: PgSqlClient, cache: Brc20BlockCache) {
    if (cache.totalBalanceChanges.size) {
      for (const [address, map] of cache.totalBalanceChanges)
        for (const [ticker, values] of map)
          await sql`
            UPDATE brc20_total_balances SET
              avail_balance = avail_balance - ${values.avail},
              trans_balance = trans_balance - ${values.trans},
              total_balance = total_balance - ${values.total}
            WHERE address = ${address} AND ticker = ${ticker}
          `;
    }
    if (cache.addressOperationCounts.size) {
      for (const [address, map] of cache.addressOperationCounts)
        for (const [operation, count] of map)
          await sql`
            UPDATE brc20_counts_by_address_operation
            SET count = count - ${count}
            WHERE address = ${address} AND operation = ${operation}
          `;
    }
    if (cache.operationCounts.size) {
      for (const [operation, count] of cache.operationCounts)
        await sql`
          UPDATE brc20_counts_by_operation
          SET count = count - ${count}
          WHERE operation = ${operation}
        `;
    }
    for (const [ticker, amount] of cache.tokenMintSupplies)
      await sql`
        UPDATE brc20_tokens SET minted_supply = minted_supply - ${amount.toString()}
        WHERE ticker = ${ticker}
      `;
    for (const [ticker, num] of cache.tokenTxCounts)
      await sql`
        UPDATE brc20_tokens SET tx_count = tx_count - ${num} WHERE ticker = ${ticker}
      `;
    for (const [inscription_id, _] of cache.transferReceivers)
      await sql`
        UPDATE brc20_operations SET to_address = NULL
        WHERE genesis_id = ${inscription_id} AND operation = 'transfer_send'
      `;
    if (cache.operations.length) {
      const blockHeights = cache.operations.map(o => o.block_height);
      for await (const batch of batchIterate(blockHeights, INSERT_BATCH_SIZE))
        await sql`
          DELETE FROM brc20_operations WHERE block_height IN ${sql(batch)}
        `;
    }
    if (cache.tokens.length) {
      const tickers = cache.tokens.map(t => t.ticker);
      for await (const batch of batchIterate(tickers, INSERT_BATCH_SIZE))
        await sql`
          DELETE FROM brc20_tokens WHERE ticker IN ${sql(batch)}
        `;
    }
  }

  async getTokens(
    args: { ticker?: string[]; order_by?: Brc20TokenOrderBy } & DbInscriptionIndexPaging
  ): Promise<DbPaginatedResult<DbBrc20Token>> {
    const tickerPrefixCondition = sqlOr(
      this.sql,
      args.ticker?.map(t => this.sql`d.ticker LIKE LOWER(${t}) || '%'`)
    );
    const orderBy =
      args.order_by === Brc20TokenOrderBy.tx_count
        ? this.sql`d.tx_count DESC` // tx_count
        : this.sql`i.block_height DESC, i.tx_index DESC`; // default: `index`
    const results = await this.sql<(DbBrc20Token & { total: number })[]>`
      ${
        args.ticker === undefined
          ? this.sql`WITH global_count AS (
              SELECT COALESCE(count, 0) AS count
              FROM brc20_counts_by_operation
              WHERE operation = 'deploy'
            )`
          : this.sql``
      }
      SELECT
        d.*, i.number, i.timestamp,
        ${
          args.ticker ? this.sql`COUNT(*) OVER()` : this.sql`(SELECT count FROM global_count)`
        } AS total
      FROM brc20_tokens AS d
      INNER JOIN inscriptions AS i ON i.genesis_id = d.genesis_id
      ${tickerPrefixCondition ? this.sql`WHERE ${tickerPrefixCondition}` : this.sql``}
      ORDER BY ${orderBy}
      OFFSET ${args.offset}
      LIMIT ${args.limit}
    `;
    return {
      total: results[0]?.total ?? 0,
      results: results ?? [],
    };
  }

  async getBalances(
    args: {
      address: string;
      ticker?: string[];
      block_height?: number;
    } & DbInscriptionIndexPaging
  ): Promise<DbPaginatedResult<DbBrc20Balance>> {
    const ticker = sqlOr(
      this.sql,
      args.ticker?.map(t => this.sql`d.ticker LIKE LOWER(${t}) || '%'`)
    );
    // Change selection table depending if we're filtering by block height or not.
    const results = await this.sql<(DbBrc20Balance & { total: number })[]>`
      ${
        args.block_height
          ? this.sql`
              SELECT
                d.ticker, d.decimals,
                SUM(b.avail_balance) AS avail_balance,
                SUM(b.trans_balance) AS trans_balance,
                SUM(b.avail_balance + b.trans_balance) AS total_balance,
                COUNT(*) OVER() as total
              FROM brc20_operations AS b
              INNER JOIN brc20_tokens AS d ON d.ticker = b.ticker
              WHERE
                b.address = ${args.address}
                AND b.block_height <= ${args.block_height}
                ${ticker ? this.sql`AND ${ticker}` : this.sql``}
              GROUP BY d.ticker, d.decimals
              HAVING SUM(b.avail_balance + b.trans_balance) > 0
            `
          : this.sql`
              SELECT d.ticker, d.decimals, b.avail_balance, b.trans_balance, b.total_balance, COUNT(*) OVER() as total
              FROM brc20_total_balances AS b
              INNER JOIN brc20_tokens AS d ON d.ticker = b.ticker
              WHERE
                b.total_balance > 0
                AND b.address = ${args.address}
                ${ticker ? this.sql`AND ${ticker}` : this.sql``}
            `
      }
      LIMIT ${args.limit}
      OFFSET ${args.offset}
    `;
    return {
      total: results[0]?.total ?? 0,
      results: results ?? [],
    };
  }

  async getToken(args: { ticker: string }): Promise<DbBrc20TokenWithSupply | undefined> {
    const result = await this.sql<DbBrc20TokenWithSupply[]>`
      WITH token AS (
        SELECT
          d.*, i.number, i.genesis_id, i.timestamp
        FROM brc20_tokens AS d
        INNER JOIN inscriptions AS i ON i.genesis_id = d.genesis_id
        WHERE d.ticker = LOWER(${args.ticker})
      ),
      holders AS (
        SELECT COUNT(*) AS count
        FROM brc20_total_balances
        WHERE ticker = (SELECT ticker FROM token) AND total_balance > 0
      )
      SELECT *, COALESCE((SELECT count FROM holders), 0) AS holders
      FROM token
    `;
    if (result.count) return result[0];
  }

  async getTokenHolders(
    args: {
      ticker: string;
    } & DbInscriptionIndexPaging
  ): Promise<DbPaginatedResult<DbBrc20Holder> | undefined> {
    return await this.sqlTransaction(async sql => {
      const token = await sql<{ id: string; decimals: number }[]>`
        SELECT ticker FROM brc20_tokens WHERE ticker = LOWER(${args.ticker})
      `;
      if (token.count === 0) return;
      const results = await sql<(DbBrc20Holder & { total: number })[]>`
        SELECT
          b.address, d.decimals, b.total_balance, COUNT(*) OVER() AS total
        FROM brc20_total_balances AS b
        INNER JOIN brc20_tokens AS d USING (ticker)
        WHERE b.ticker = LOWER(${args.ticker})
        ORDER BY b.total_balance DESC
        LIMIT ${args.limit}
        OFFSET ${args.offset}
      `;
      return {
        total: results[0]?.total ?? 0,
        results: results ?? [],
      };
    });
  }

  async getActivity(
    page: DbInscriptionIndexPaging,
    filters: {
      ticker?: string[];
      block_height?: number;
      operation?: string[];
      address?: string;
    }
  ): Promise<DbPaginatedResult<DbBrc20Activity>> {
    // Do we need a specific result count such as total activity or activity per address?
    objRemoveUndefinedValues(filters);
    const filterLength = Object.keys(filters).length;
    const needsGlobalEventCount =
      filterLength === 0 ||
      (filterLength === 1 && filters.operation && filters.operation.length > 0);
    const needsAddressEventCount =
      (filterLength === 1 && filters.address != undefined && filters.address != '') ||
      (filterLength === 2 &&
        filters.operation &&
        filters.operation.length > 0 &&
        filters.address != undefined &&
        filters.address != '');
    const needsTickerCount = filterLength === 1 && filters.ticker && filters.ticker.length > 0;
    const operationsFilter = filters.operation?.filter(i => i !== 'transfer_receive');

    return this.sqlTransaction(async sql => {
      const results = await sql<(DbBrc20Activity & { total: number })[]>`
        WITH event_count AS (${
          needsGlobalEventCount
            ? sql`
                SELECT COALESCE(SUM(count), 0) AS count
                FROM brc20_counts_by_operation
                ${operationsFilter ? sql`WHERE operation IN ${sql(operationsFilter)}` : sql``}
              `
            : needsAddressEventCount
            ? sql`
                SELECT SUM(count) AS count
                FROM brc20_counts_by_address_operation
                WHERE address = ${filters.address}
                ${operationsFilter ? sql`AND operation IN ${sql(operationsFilter)}` : sql``}
              `
            : needsTickerCount && filters.ticker !== undefined
            ? sql`
                SELECT COALESCE(SUM(tx_count), 0) AS count
                FROM brc20_tokens AS d
                WHERE ticker IN ${sql(filters.ticker)}
              `
            : sql`SELECT NULL AS count`
        }),
        operations AS (
          SELECT
            e.operation,
            e.avail_balance,
            e.trans_balance,
            e.address,
            e.to_address,
            e.ticker,
            e.genesis_id AS inscription_id,
            d.max AS deploy_max,
            d.limit AS deploy_limit,
            d.decimals AS deploy_decimals,
            i.ordinal_number,
            e.block_height,
            e.tx_index,
            ${
              needsGlobalEventCount || needsAddressEventCount || needsTickerCount
                ? sql`(SELECT count FROM event_count)`
                : sql`COUNT(*) OVER()`
            } AS total
          FROM brc20_operations AS e
          INNER JOIN brc20_tokens AS d ON d.ticker = e.ticker
          INNER JOIN inscriptions AS i ON i.genesis_id = e.genesis_id
          WHERE TRUE
            ${
              operationsFilter
                ? sql`AND e.operation IN ${sql(operationsFilter)}`
                : sql`AND e.operation <> 'transfer_receive'`
            }
            ${filters.ticker ? sql`AND e.ticker IN ${sql(filters.ticker)}` : sql``}
            ${filters.block_height ? sql`AND e.block_height = ${filters.block_height}` : sql``}
            ${
              filters.address
                ? sql`AND (e.address = ${filters.address} OR e.to_address = ${filters.address})`
                : sql``
            }
          ORDER BY e.block_height DESC, e.tx_index DESC
          LIMIT ${page.limit}
          OFFSET ${page.offset}
        )
        SELECT o.*, l.block_hash, l.tx_id, l.timestamp, l.output, l.offset
        FROM operations AS o
        INNER JOIN locations AS l USING (ordinal_number, block_height, tx_index)
        ORDER BY o.block_height DESC, o.tx_index DESC
      `;
      return {
        total: results[0]?.total ?? 0,
        results: results ?? [],
      };
    });
  }
}

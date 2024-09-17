/* eslint-disable @typescript-eslint/naming-convention */
import { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export function up(pgm: MigrationBuilder): void {
  pgm.createTable('inscription_transfers', {
    genesis_id: {
      type: 'text',
      notNull: true,
    },
    number: {
      type: 'bigint',
      notNull: true,
    },
    ordinal_number: {
      type: 'numeric',
      notNull: true,
    },
    block_height: {
      type: 'bigint',
      notNull: true,
    },
    tx_index: {
      type: 'bigint',
      notNull: true,
    },
    block_hash: {
      type: 'text',
      notNull: true,
    },
    block_transfer_index: {
      type: 'int',
      notNull: true,
    },
  });
  pgm.createConstraint('inscription_transfers', 'inscription_transfers_pkey', {
    primaryKey: ['block_height', 'block_transfer_index'],
  });
  pgm.createIndex('inscription_transfers', ['genesis_id']);
  pgm.createIndex('inscription_transfers', ['number']);
}

/* eslint-disable @typescript-eslint/naming-convention */
import { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export function up(pgm: MigrationBuilder): void {
  pgm.createType('transfer_type', ['transferred', 'spent_in_fees', 'burnt']);
  pgm.createTable('locations', {
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
    tx_id: {
      type: 'text',
      notNull: true,
    },
    block_hash: {
      type: 'text',
      notNull: true,
    },
    address: {
      type: 'text',
      notNull: true,
    },
    output: {
      type: 'text',
      notNull: true,
    },
    offset: {
      type: 'numeric',
    },
    prev_output: {
      type: 'text',
    },
    prev_offset: {
      type: 'numeric',
    },
    value: {
      type: 'numeric',
    },
    transfer_type: {
      type: 'transfer_type',
      notNull: true,
    },
    timestamp: {
      type: 'timestamptz',
      notNull: true,
    },
  });
  pgm.createConstraint('locations', 'locations_pkey', {
    primaryKey: ['ordinal_number', 'block_height', 'tx_index'],
  });
  pgm.createIndex('locations', ['output', 'offset']);
  pgm.createIndex('locations', ['timestamp']);
  pgm.createIndex('locations', [
    { name: 'block_height', sort: 'DESC' },
    { name: 'tx_index', sort: 'DESC' },
  ]);
}

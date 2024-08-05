/* eslint-disable @typescript-eslint/naming-convention */
import { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export function up(pgm: MigrationBuilder): void {
  pgm.createTable('inscriptions', {
    genesis_id: {
      type: 'text',
      primaryKey: true,
    },
    ordinal_number: {
      type: 'numeric',
      notNull: true,
    },
    number: {
      type: 'bigint',
      notNull: true,
    },
    classic_number: {
      type: 'bigint',
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
    address: {
      type: 'text',
    },
    mime_type: {
      type: 'text',
      notNull: true,
    },
    content_type: {
      type: 'text',
      notNull: true,
    },
    content_length: {
      type: 'bigint',
      notNull: true,
    },
    content: {
      type: 'bytea',
      notNull: true,
    },
    fee: {
      type: 'numeric',
      notNull: true,
    },
    curse_type: {
      type: 'text',
    },
    recursive: {
      type: 'boolean',
      default: false,
    },
    input_index: {
      type: 'bigint',
      notNull: true,
    },
    pointer: {
      type: 'bigint',
    },
    metadata: {
      type: 'text',
    },
    metaprotocol: {
      type: 'text',
    },
    parent: {
      type: 'text',
    },
    delegate: {
      type: 'text',
    },
    timestamp: {
      type: 'timestamptz',
      notNull: true,
    },
    updated_at: {
      type: 'timestamptz',
      default: pgm.func('(NOW())'),
      notNull: true,
    },
  });
  pgm.createConstraint('inscriptions', 'inscriptions_number_unique', 'UNIQUE(number)');
  pgm.createConstraint(
    'inscriptions',
    'inscriptions_ordinal_number_fk',
    'FOREIGN KEY(ordinal_number) REFERENCES satoshis(ordinal_number) ON DELETE CASCADE'
  );
  pgm.createIndex('inscriptions', ['mime_type']);
  pgm.createIndex('inscriptions', ['recursive']);
  pgm.createIndex('inscriptions', [
    { name: 'block_height', sort: 'DESC' },
    { name: 'tx_index', sort: 'DESC' },
  ]);
  pgm.createIndex('inscriptions', ['address']);
  pgm.createIndex('inscriptions', [{ name: 'updated_at', sort: 'DESC' }]);
}

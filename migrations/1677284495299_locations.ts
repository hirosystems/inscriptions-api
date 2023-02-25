/* eslint-disable @typescript-eslint/naming-convention */
import { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export function up(pgm: MigrationBuilder): void {
  pgm.createTable('locations', {
    id: {
      type: 'serial',
      primaryKey: true,
    },
    inscription_id: {
      type: 'int',
      notNull: true,
    },
    block_height: {
      type: 'int',
      notNull: true,
    },
    block_hash: {
      type: 'text',
      notNull: true,
    },
    tx_id: {
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
      type: 'int',
      notNull: true,
    },
    value: {
      type: 'int',
      notNull: true,
    },
    timestamp: {
      type: 'timestamptz',
      notNull: true,
    },
    genesis: {
      type: 'boolean',
      default: true,
      notNull: true,
    },
    current: {
      type: 'boolean',
      default: true,
      notNull: true,
    },
  });
  pgm.createConstraint(
    'locations',
    'locations_inscription_id_fk',
    'FOREIGN KEY(inscription_id) REFERENCES inscriptions(id) ON DELETE CASCADE'
  );
  pgm.createConstraint(
    'locations',
    'locations_inscription_id_block_hash_unique',
    'UNIQUE(inscription_id, block_hash)'
  );
  pgm.createIndex('inscriptions', [{ name: 'block_height', sort: 'DESC' }]);
  pgm.createIndex('inscriptions', ['block_hash']);
  pgm.createIndex('inscriptions', ['address']);
  pgm.createIndex('inscriptions', ['mime_type']);
}

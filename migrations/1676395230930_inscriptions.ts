/* eslint-disable @typescript-eslint/naming-convention */
import { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export function up(pgm: MigrationBuilder): void {
  pgm.createTable('inscriptions', {
    id: {
      type: 'serial',
      primaryKey: true,
    },
    genesis_id: {
      type: 'text',
      notNull: true,
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
      type: 'int',
      notNull: true,
    },
    content: {
      type: 'bytea',
      notNull: true,
    },
    fee: {
      type: 'int',
      notNull: true,
    },
  });
  pgm.createConstraint(
    'inscriptions',
    'inscriptions_inscription_id_unique',
    'UNIQUE(inscription_id)'
  );
  // pgm.createIndex('inscriptions', [{ name: 'block_height', sort: 'DESC' }]);
  // pgm.createIndex('inscriptions', ['block_hash']);
  // pgm.createIndex('inscriptions', ['address']);
  pgm.createIndex('inscriptions', ['genesis_id']);
  pgm.createIndex('inscriptions', ['mime_type']);
}

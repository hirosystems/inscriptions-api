/* eslint-disable @typescript-eslint/naming-convention */
import { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export function up(pgm: MigrationBuilder): void {
  pgm.createTable('current_locations', {
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
    address: {
      type: 'text',
      notNull: true,
    },
  });
  pgm.createIndex('current_locations', ['ordinal_number'], { unique: true });
  pgm.createIndex('current_locations', ['address']);
  pgm.createIndex('current_locations', ['block_height', 'tx_index']);
}

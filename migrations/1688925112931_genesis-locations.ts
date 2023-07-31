/* eslint-disable @typescript-eslint/naming-convention */
import { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export function up(pgm: MigrationBuilder): void {
  pgm.createTable('genesis_locations', {
    inscription_id: {
      type: 'bigint',
      notNull: true,
      primaryKey: true,
    },
    location_id: {
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
  });
  pgm.createConstraint(
    'genesis_locations',
    'genesis_locations_inscription_id_fk',
    'FOREIGN KEY(inscription_id) REFERENCES inscriptions(id) ON DELETE CASCADE'
  );
  pgm.createConstraint(
    'genesis_locations',
    'genesis_locations_location_id_fk',
    'FOREIGN KEY(location_id) REFERENCES locations(id) ON DELETE CASCADE'
  );
  pgm.createIndex('genesis_locations', ['location_id']);
  pgm.createIndex('genesis_locations', ['block_height']);
  pgm.createIndex('genesis_locations', ['address']);
}

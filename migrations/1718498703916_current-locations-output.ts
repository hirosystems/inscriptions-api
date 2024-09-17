/* eslint-disable @typescript-eslint/naming-convention */
import { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export function up(pgm: MigrationBuilder): void {
  pgm.addColumn('current_locations', {
    output: {
      type: 'text',
    },
  });
  pgm.sql(`
    UPDATE current_locations SET output = (
      SELECT output FROM locations AS l
      WHERE l.ordinal_number = ordinal_number
        AND l.block_height = block_height
        AND l.tx_index = tx_index
      LIMIT 1
    )  
  `);
  pgm.alterColumn('current_locations', 'output', { notNull: true });
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropColumn('current_locations', 'output');
}

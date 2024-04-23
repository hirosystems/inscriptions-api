/* eslint-disable @typescript-eslint/naming-convention */
import { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export function up(pgm: MigrationBuilder): void {
  pgm.createTable('counts_by_genesis_address', {
    address: {
      type: 'text',
      primaryKey: true,
    },
    count: {
      type: 'int',
      default: 0,
    },
  });
}

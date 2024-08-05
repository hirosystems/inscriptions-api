import { toEnumValue } from '@hirosystems/api-toolkit';
import {
  BitcoinInscriptionRevealed,
  BitcoinInscriptionTransferred,
} from '@hirosystems/chainhook-client';
import { parseSatPoint } from '../api/util/helpers';
import { OrdinalSatoshi } from '../api/util/ordinal-satoshi';
import { getInscriptionRecursion, getTransferType, removeNullBytes } from './helpers';
import {
  DbSatoshiInsert,
  DbInscriptionInsert,
  DbLocationInsert,
  DbCurrentLocationInsert,
  DbLocationTransferType,
} from './types';

/**
 * Keeps an in-memory cache of all inscription activities received in an Ordhook block so they can
 * be written into the DB later.
 */
export class BlockCache {
  blockHeight: number;
  blockHash: string;
  timestamp: number;

  satoshis: DbSatoshiInsert[] = [];
  inscriptions: DbInscriptionInsert[] = [];
  locations: DbLocationInsert[] = [];
  currentLocations = new Map<string, DbCurrentLocationInsert>();
  recursiveRefs = new Map<string, string[]>();
  revealedNumbers: number[] = [];

  mimeTypeCounts = new Map<string, number>();
  satRarityCounts = new Map<string, number>();
  inscriptionTypeCounts = new Map<string, number>();
  genesisAddressCounts = new Map<string, number>();
  recursiveCounts = new Map<boolean, number>();

  constructor(blockHeight: number, blockHash: string, timestamp: number) {
    this.blockHeight = blockHeight;
    this.blockHash = blockHash;
    this.timestamp = timestamp;
  }

  reveal(reveal: BitcoinInscriptionRevealed, tx_id: string) {
    const satoshi = new OrdinalSatoshi(reveal.ordinal_number);
    const ordinal_number = reveal.ordinal_number.toString();
    this.satoshis.push({
      ordinal_number,
      rarity: satoshi.rarity,
      coinbase_height: satoshi.blockHeight,
    });
    const satpoint = parseSatPoint(reveal.satpoint_post_inscription);
    const recursive_refs = getInscriptionRecursion(reveal.content_bytes);
    const content_type = removeNullBytes(reveal.content_type);
    const mime_type = content_type.split(';')[0];
    this.inscriptions.push({
      genesis_id: reveal.inscription_id,
      mime_type,
      content_type,
      content_length: reveal.content_length,
      block_height: this.blockHeight,
      tx_index: reveal.tx_index,
      address: reveal.inscriber_address,
      number: reveal.inscription_number.jubilee,
      classic_number: reveal.inscription_number.classic,
      content: removeNullBytes(reveal.content_bytes),
      fee: reveal.inscription_fee.toString(),
      curse_type: reveal.curse_type ? JSON.stringify(reveal.curse_type) : null,
      ordinal_number,
      recursive: recursive_refs.length > 0,
      metadata: reveal.metadata ? JSON.stringify(reveal.metadata) : null,
      parent: reveal.parent,
      delegate: reveal.delegate,
      input_index: reveal.inscription_input_index,
      pointer: reveal.inscription_pointer,
      metaprotocol: reveal.metaprotocol,
      timestamp: this.timestamp,
    });
    this.revealedNumbers.push(reveal.inscription_number.jubilee);
    this.increaseMimeTypeCount(mime_type);
    this.increaseSatRarityCount(satoshi.rarity);
    this.increaseInscriptionTypeCount(reveal.inscription_number.classic < 0 ? 'cursed' : 'blessed');
    this.increaseGenesisAddressCount(reveal.inscriber_address);
    this.increaseRecursiveCount(recursive_refs.length > 0);
    this.locations.push({
      block_hash: this.blockHash,
      block_height: this.blockHeight,
      tx_id,
      tx_index: reveal.tx_index,
      ordinal_number,
      address: reveal.inscriber_address,
      output: `${satpoint.tx_id}:${satpoint.vout}`,
      offset: satpoint.offset ?? null,
      prev_output: null,
      prev_offset: null,
      value: reveal.inscription_output_value.toString(),
      timestamp: this.timestamp,
      transfer_type: getTransferType(reveal),
    });
    this.updateCurrentLocation(ordinal_number, {
      ordinal_number,
      block_height: this.blockHeight,
      tx_index: reveal.tx_index,
      address: reveal.inscriber_address,
    });
    if (recursive_refs.length > 0) this.recursiveRefs.set(reveal.inscription_id, recursive_refs);
  }

  transfer(transfer: BitcoinInscriptionTransferred, tx_id: string) {
    const satpoint = parseSatPoint(transfer.satpoint_post_transfer);
    const prevSatpoint = parseSatPoint(transfer.satpoint_pre_transfer);
    const ordinal_number = transfer.ordinal_number.toString();
    const address = transfer.destination.value ?? null;
    this.locations.push({
      block_hash: this.blockHash,
      block_height: this.blockHeight,
      tx_id,
      tx_index: transfer.tx_index,
      ordinal_number,
      address,
      output: `${satpoint.tx_id}:${satpoint.vout}`,
      offset: satpoint.offset ?? null,
      prev_output: `${prevSatpoint.tx_id}:${prevSatpoint.vout}`,
      prev_offset: prevSatpoint.offset ?? null,
      value: transfer.post_transfer_output_value
        ? transfer.post_transfer_output_value.toString()
        : null,
      timestamp: this.timestamp,
      transfer_type:
        toEnumValue(DbLocationTransferType, transfer.destination.type) ??
        DbLocationTransferType.transferred,
    });
    this.updateCurrentLocation(ordinal_number, {
      ordinal_number,
      block_height: this.blockHeight,
      tx_index: transfer.tx_index,
      address,
    });
  }

  private updateCurrentLocation(ordinal_number: string, data: DbCurrentLocationInsert) {
    const current = this.currentLocations.get(ordinal_number);
    if (
      current === undefined ||
      (current &&
        (data.block_height > current.block_height ||
          (data.block_height === current.block_height && data.tx_index > current.tx_index)))
    ) {
      this.currentLocations.set(ordinal_number, data);
    }
  }

  private increaseMimeTypeCount(mime_type: string) {
    const current = this.mimeTypeCounts.get(mime_type);
    if (current == undefined) {
      this.mimeTypeCounts.set(mime_type, 1);
    } else {
      this.mimeTypeCounts.set(mime_type, current + 1);
    }
  }

  private increaseSatRarityCount(rarity: string) {
    const current = this.satRarityCounts.get(rarity);
    if (current == undefined) {
      this.satRarityCounts.set(rarity, 1);
    } else {
      this.satRarityCounts.set(rarity, current + 1);
    }
  }

  private increaseInscriptionTypeCount(type: string) {
    const current = this.inscriptionTypeCounts.get(type);
    if (current == undefined) {
      this.inscriptionTypeCounts.set(type, 1);
    } else {
      this.inscriptionTypeCounts.set(type, current + 1);
    }
  }

  private increaseGenesisAddressCount(address: string | null) {
    if (!address) return;
    const current = this.genesisAddressCounts.get(address);
    if (current == undefined) {
      this.genesisAddressCounts.set(address, 1);
    } else {
      this.genesisAddressCounts.set(address, current + 1);
    }
  }

  private increaseRecursiveCount(recursive: boolean) {
    const current = this.recursiveCounts.get(recursive);
    if (current == undefined) {
      this.recursiveCounts.set(recursive, 1);
    } else {
      this.recursiveCounts.set(recursive, current + 1);
    }
  }
}

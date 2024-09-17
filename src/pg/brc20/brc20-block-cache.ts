import BigNumber from 'bignumber.js';
import { DbBrc20TokenInsert, DbBrc20OperationInsert, DbBrc20Operation } from './types';
import {
  BitcoinBrc20DeployOperation,
  BitcoinBrc20MintOperation,
  BitcoinBrc20TransferOperation,
  BitcoinBrc20TransferSendOperation,
} from '@hirosystems/chainhook-client';

interface AddressBalanceData {
  avail: BigNumber;
  trans: BigNumber;
  total: BigNumber;
}

/**
 * In-memory cache for an Ordhook block's BRC-20 activities.
 */
export class Brc20BlockCache {
  blockHeight: number;

  tokens: DbBrc20TokenInsert[] = [];
  operations: DbBrc20OperationInsert[] = [];
  tokenMintSupplies = new Map<string, BigNumber>();
  tokenTxCounts = new Map<string, number>();
  operationCounts = new Map<DbBrc20Operation, number>();
  addressOperationCounts = new Map<string, Map<DbBrc20Operation, number>>();
  totalBalanceChanges = new Map<string, Map<string, AddressBalanceData>>();
  transferReceivers = new Map<string, string>();

  constructor(blockHeight: number) {
    this.blockHeight = blockHeight;
  }

  deploy(operation: BitcoinBrc20DeployOperation, tx_id: string, tx_index: number) {
    const zero = BigNumber('0');
    this.tokens.push({
      block_height: this.blockHeight,
      genesis_id: operation.deploy.inscription_id,
      tx_id,
      address: operation.deploy.address,
      ticker: operation.deploy.tick,
      max: BigNumber(operation.deploy.max).toString(),
      limit: BigNumber(operation.deploy.lim).toString(),
      decimals: operation.deploy.dec,
      self_mint: operation.deploy.self_mint,
    });
    this.operations.push({
      block_height: this.blockHeight,
      tx_index,
      genesis_id: operation.deploy.inscription_id,
      ticker: operation.deploy.tick,
      address: operation.deploy.address,
      avail_balance: zero.toString(),
      trans_balance: zero.toString(),
      operation: DbBrc20Operation.deploy,
    });
    this.increaseOperationCount(DbBrc20Operation.deploy);
    this.increaseAddressOperationCount(operation.deploy.address, DbBrc20Operation.deploy);
    this.increaseTokenTxCount(operation.deploy.tick);
  }

  mint(operation: BitcoinBrc20MintOperation, tx_index: number) {
    const zero = BigNumber('0');
    const amt = BigNumber(operation.mint.amt).abs();
    this.operations.push({
      block_height: this.blockHeight,
      tx_index,
      genesis_id: operation.mint.inscription_id,
      ticker: operation.mint.tick,
      address: operation.mint.address,
      avail_balance: amt.toString(),
      trans_balance: zero.toString(),
      operation: DbBrc20Operation.mint,
    });
    this.increaseTokenMintedSupply(operation.mint.tick, amt);
    this.increaseTokenTxCount(operation.mint.tick);
    this.increaseOperationCount(DbBrc20Operation.mint);
    this.increaseAddressOperationCount(operation.mint.address, DbBrc20Operation.mint);
    this.updateAddressBalance(operation.mint.tick, operation.mint.address, amt, zero, amt);
  }

  transfer(operation: BitcoinBrc20TransferOperation, tx_index: number) {
    const zero = BigNumber('0');
    const amt = BigNumber(operation.transfer.amt).abs();
    this.operations.push({
      block_height: this.blockHeight,
      tx_index,
      genesis_id: operation.transfer.inscription_id,
      ticker: operation.transfer.tick,
      address: operation.transfer.address,
      avail_balance: amt.negated().toString(),
      trans_balance: amt.toString(),
      operation: DbBrc20Operation.transfer,
    });
    this.increaseOperationCount(DbBrc20Operation.transfer);
    this.increaseTokenTxCount(operation.transfer.tick);
    this.increaseAddressOperationCount(operation.transfer.address, DbBrc20Operation.transfer);
    this.updateAddressBalance(
      operation.transfer.tick,
      operation.transfer.address,
      amt.negated(),
      amt,
      zero
    );
  }

  transferSend(operation: BitcoinBrc20TransferSendOperation, tx_index: number) {
    const amt = BigNumber(operation.transfer_send.amt).abs();
    const zero = BigNumber('0');
    this.operations.push({
      block_height: this.blockHeight,
      tx_index,
      genesis_id: operation.transfer_send.inscription_id,
      ticker: operation.transfer_send.tick,
      address: operation.transfer_send.sender_address,
      avail_balance: zero.toString(),
      trans_balance: amt.negated().toString(),
      operation: DbBrc20Operation.transferSend,
    });
    this.transferReceivers.set(
      operation.transfer_send.inscription_id,
      operation.transfer_send.receiver_address
    );
    this.operations.push({
      block_height: this.blockHeight,
      tx_index,
      genesis_id: operation.transfer_send.inscription_id,
      ticker: operation.transfer_send.tick,
      address: operation.transfer_send.receiver_address,
      avail_balance: amt.toString(),
      trans_balance: '0',
      operation: DbBrc20Operation.transferReceive,
    });
    this.increaseOperationCount(DbBrc20Operation.transferSend);
    this.increaseTokenTxCount(operation.transfer_send.tick);
    this.increaseAddressOperationCount(
      operation.transfer_send.sender_address,
      DbBrc20Operation.transferSend
    );
    if (operation.transfer_send.sender_address != operation.transfer_send.receiver_address) {
      this.increaseAddressOperationCount(
        operation.transfer_send.receiver_address,
        DbBrc20Operation.transferSend
      );
    }
    this.updateAddressBalance(
      operation.transfer_send.tick,
      operation.transfer_send.sender_address,
      zero,
      amt.negated(),
      amt.negated()
    );
    this.updateAddressBalance(
      operation.transfer_send.tick,
      operation.transfer_send.receiver_address,
      amt,
      zero,
      amt
    );
  }

  private increaseOperationCount(operation: DbBrc20Operation) {
    this.increaseOperationCountInternal(this.operationCounts, operation);
  }
  private increaseOperationCountInternal(
    map: Map<DbBrc20Operation, number>,
    operation: DbBrc20Operation
  ) {
    const current = map.get(operation);
    if (current == undefined) {
      map.set(operation, 1);
    } else {
      map.set(operation, current + 1);
    }
  }

  private increaseTokenMintedSupply(ticker: string, amount: BigNumber) {
    const current = this.tokenMintSupplies.get(ticker);
    if (current == undefined) {
      this.tokenMintSupplies.set(ticker, amount);
    } else {
      this.tokenMintSupplies.set(ticker, current.plus(amount));
    }
  }

  private increaseTokenTxCount(ticker: string) {
    const current = this.tokenTxCounts.get(ticker);
    if (current == undefined) {
      this.tokenTxCounts.set(ticker, 1);
    } else {
      this.tokenTxCounts.set(ticker, current + 1);
    }
  }

  private increaseAddressOperationCount(address: string, operation: DbBrc20Operation) {
    const current = this.addressOperationCounts.get(address);
    if (current == undefined) {
      const opMap = new Map<DbBrc20Operation, number>();
      this.increaseOperationCountInternal(opMap, operation);
      this.addressOperationCounts.set(address, opMap);
    } else {
      this.increaseOperationCountInternal(current, operation);
    }
  }

  private updateAddressBalance(
    ticker: string,
    address: string,
    availBalance: BigNumber,
    transBalance: BigNumber,
    totalBalance: BigNumber
  ) {
    const current = this.totalBalanceChanges.get(address);
    if (current === undefined) {
      const opMap = new Map<string, AddressBalanceData>();
      opMap.set(ticker, { avail: availBalance, trans: transBalance, total: totalBalance });
      this.totalBalanceChanges.set(address, opMap);
    } else {
      const currentTick = current.get(ticker);
      if (currentTick === undefined) {
        current.set(ticker, { avail: availBalance, trans: transBalance, total: totalBalance });
      } else {
        current.set(ticker, {
          avail: availBalance.plus(currentTick.avail),
          trans: transBalance.plus(currentTick.trans),
          total: totalBalance.plus(currentTick.total),
        });
      }
    }
  }
}

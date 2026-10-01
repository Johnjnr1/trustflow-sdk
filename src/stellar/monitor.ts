import { fetchAccountInfo, AccountInfo } from './account';
import { StellarNetwork } from './network';
import { logger } from '../utils/logger';

/**
 * Configuration options for the Stellar account balance monitor.
 */
export interface AccountMonitorConfig {
  /** The Stellar public key address (G...) to monitor. */
  address: string;
  /** Network to query against. Defaults to 'TESTNET'. */
  network?: StellarNetwork;
  /** Minimum balance threshold in XLM below which alerts are emitted. Defaults to 10 XLM. */
  minBalanceXLM?: string | number;
  /** Polling interval in milliseconds. Defaults to 30,000ms (30 seconds). */
  pollIntervalMs?: number;
  /** Optional webhook endpoint URL to notify upon detecting a low balance. */
  webhookUrl?: string;
  /** Optional HTTP headers to include with webhook POST requests (e.g. auth headers). */
  webhookHeaders?: Record<string, string>;
  /** Optional custom account fetch function for testing or custom RPC endpoints. */
  fetchFn?: (address: string, network: StellarNetwork) => Promise<AccountInfo>;
}

/**
 * Event payload emitted when an account's balance falls below the configured threshold.
 */
export interface LowBalanceAlert {
  address: string;
  currentBalanceXLM: string;
  thresholdXLM: string;
  network: StellarNetwork;
  timestamp: number;
}

/**
 * Event payload emitted on every successful balance polling cycle.
 */
export interface BalanceUpdate {
  address: string;
  balanceXLM: string;
  previousBalanceXLM?: string;
  network: StellarNetwork;
  sequenceNumber: string;
  isActive: boolean;
  timestamp: number;
}

export type AccountMonitorEventHandler<T> = (data: T) => void | Promise<void>;

/**
 * Utility for monitoring platform and operator Stellar account balances,
 * alerting on low XLM balances, and sending webhook notifications.
 */
export class AccountBalanceMonitor {
  private readonly address: string;
  private readonly network: StellarNetwork;
  private readonly minBalanceXLM: number;
  private readonly pollIntervalMs: number;
  private readonly webhookUrl?: string;
  private readonly webhookHeaders?: Record<string, string>;
  private readonly fetchFn: (address: string, network: StellarNetwork) => Promise<AccountInfo>;

  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private lastBalance?: string;

  private lowBalanceHandlers = new Set<AccountMonitorEventHandler<LowBalanceAlert>>();
  private updateHandlers = new Set<AccountMonitorEventHandler<BalanceUpdate>>();
  private errorHandlers = new Set<AccountMonitorEventHandler<unknown>>();

  constructor(config: AccountMonitorConfig) {
    if (!config.address) {
      throw new Error('Account address is required for monitoring');
    }
    this.address = config.address;
    this.network = config.network ?? 'TESTNET';
    this.minBalanceXLM =
      typeof config.minBalanceXLM === 'number'
        ? config.minBalanceXLM
        : parseFloat(config.minBalanceXLM ?? '10');
    this.pollIntervalMs = config.pollIntervalMs ?? 30_000;
    this.webhookUrl = config.webhookUrl;
    this.webhookHeaders = config.webhookHeaders;
    this.fetchFn = config.fetchFn ?? fetchAccountInfo;
  }

  /**
   * Registers an event handler for account monitor events.
   */
  on(event: 'low_balance', handler: AccountMonitorEventHandler<LowBalanceAlert>): this;
  on(event: 'balance_update', handler: AccountMonitorEventHandler<BalanceUpdate>): this;
  on(event: 'error', handler: AccountMonitorEventHandler<unknown>): this;
  on(event: string, handler: AccountMonitorEventHandler<any>): this {
    if (event === 'low_balance') this.lowBalanceHandlers.add(handler);
    else if (event === 'balance_update') this.updateHandlers.add(handler);
    else if (event === 'error') this.errorHandlers.add(handler);
    return this;
  }

  /**
   * Unregisters an event handler.
   */
  off(event: 'low_balance', handler: AccountMonitorEventHandler<LowBalanceAlert>): this;
  off(event: 'balance_update', handler: AccountMonitorEventHandler<BalanceUpdate>): this;
  off(event: 'error', handler: AccountMonitorEventHandler<unknown>): this;
  off(event: string, handler: AccountMonitorEventHandler<any>): this {
    if (event === 'low_balance') this.lowBalanceHandlers.delete(handler);
    else if (event === 'balance_update') this.updateHandlers.delete(handler);
    else if (event === 'error') this.errorHandlers.delete(handler);
    return this;
  }

  /**
   * Starts periodic background monitoring.
   */
  start(): this {
    if (this.running) return this;
    this.running = true;
    void this.checkNow();
    this.timer = setInterval(() => {
      void this.checkNow();
    }, this.pollIntervalMs);
    return this;
  }

  /**
   * Stops background polling.
   */
  stop(): this {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    return this;
  }

  /**
   * Returns whether the monitor is actively running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Immediately triggers a single balance check cycle.
   */
  async checkNow(): Promise<BalanceUpdate | null> {
    try {
      const info = await this.fetchFn(this.address, this.network);
      const prev = this.lastBalance;
      this.lastBalance = info.balanceXLM;

      const update: BalanceUpdate = {
        address: this.address,
        balanceXLM: info.balanceXLM,
        previousBalanceXLM: prev,
        network: this.network,
        sequenceNumber: info.sequenceNumber,
        isActive: info.isActive,
        timestamp: Date.now(),
      };

      for (const h of this.updateHandlers) {
        try {
          await h(update);
        } catch (err) {
          logger.error('Error in balance_update handler', { err });
        }
      }

      const balanceNum = parseFloat(info.balanceXLM);
      if (info.isActive && !isNaN(balanceNum) && balanceNum < this.minBalanceXLM) {
        const alert: LowBalanceAlert = {
          address: this.address,
          currentBalanceXLM: info.balanceXLM,
          thresholdXLM: String(this.minBalanceXLM),
          network: this.network,
          timestamp: Date.now(),
        };

        for (const h of this.lowBalanceHandlers) {
          try {
            await h(alert);
          } catch (err) {
            logger.error('Error in low_balance handler', { err });
          }
        }

        if (this.webhookUrl) {
          await this.sendWebhook(alert);
        }
      }

      return update;
    } catch (err) {
      for (const h of this.errorHandlers) {
        try {
          await h(err);
        } catch (e) {
          logger.error('Error in error handler', { e });
        }
      }
      return null;
    }
  }

  private async sendWebhook(alert: LowBalanceAlert): Promise<void> {
    try {
      if (typeof fetch !== 'undefined' && this.webhookUrl) {
        await fetch(this.webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...this.webhookHeaders,
          },
          body: JSON.stringify({
            event: 'account.low_balance',
            data: alert,
          }),
        });
      }
    } catch (webhookErr) {
      logger.error('Failed to send low balance webhook notification', { webhookErr });
    }
  }
}

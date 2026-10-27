import type { Broker, Fill, OrderRequest } from './broker';

/**
 * Wraps the real broker when live money is on. It cannot make a bad strategy good; it limits how much
 * damage a bug or a runaway loop can do: no entry above the approved order size, and no more than a
 * set number of orders per hour. Exits are never blocked, only counted.
 */
export class GuardedBroker implements Broker {
  readonly mode: Broker['mode'];
  private recent: number[] = [];

  constructor(
    private inner: Broker,
    private limits: { maxOrderUsd: number; maxOrdersPerHour: number },
  ) {
    this.mode = inner.mode;
  }

  async marketOrder(req: OrderRequest): Promise<Fill> {
    const now = Date.now();
    this.recent = this.recent.filter((t) => now - t < 3_600_000);
    if (!req.closing) {
      const notional = req.qty * req.refPrice;
      if (notional > this.limits.maxOrderUsd * 1.02) {
        throw new Error(`order exceeds live cap: $${notional.toFixed(0)} > $${this.limits.maxOrderUsd}`);
      }
      if (this.recent.length >= this.limits.maxOrdersPerHour) {
        throw new Error(`order exceeds live cap: ${this.limits.maxOrdersPerHour} orders in the last hour`);
      }
    }
    this.recent.push(now);
    return this.inner.marketOrder(req);
  }
}

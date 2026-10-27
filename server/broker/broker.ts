/**
 * Execution boundary. Everything that would touch a real exchange goes through
 * this interface, so swapping PaperBroker for a live adapter is a single change
 * in ecosystem.ts. There is intentionally no live implementation yet: paper
 * results should earn that first.
 */
export interface OrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  refPrice: number;
  /** True when this order exits an open position, so a venue can close the real position exactly. */
  closing?: boolean;
  /** True for stops and forced exits, which must leave now. Calm exits and entries may rest as limit orders. */
  urgent?: boolean;
}

export interface Fill {
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  fee: number;
  time: number;
}

export interface Broker {
  readonly mode: 'paper' | 'live';
  marketOrder(req: OrderRequest): Promise<Fill>;
}

export class PaperBroker implements Broker {
  readonly mode = 'paper' as const;

  constructor(
    private feeRate: number,
    private slippage: number,
    /** Per-symbol override: thin markets cost more to trade. */
    private slippageFor?: (symbol: string) => number,
  ) {}

  async marketOrder(req: OrderRequest): Promise<Fill> {
    if (!(req.qty > 0) || !Number.isFinite(req.qty)) throw new Error(`paper broker: invalid qty ${req.qty}`);
    if (!(req.refPrice > 0) || !Number.isFinite(req.refPrice)) throw new Error(`paper broker: invalid price ${req.refPrice}`);
    const slip = this.slippageFor ? this.slippageFor(req.symbol) : this.slippage;
    const price = req.side === 'buy' ? req.refPrice * (1 + slip) : req.refPrice * (1 - slip);
    return {
      symbol: req.symbol,
      side: req.side,
      qty: req.qty,
      price,
      fee: price * req.qty * this.feeRate,
      time: Date.now(),
    };
  }
}

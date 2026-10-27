import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assess, loadEvidence, type Verdict } from './verdict';

/**
 * The only door to real money. Live trading starts only if a signed-off approval file exists, and
 * the file can only be created when the paper evidence says PASSING. It carries a capital cap, a
 * per-order cap and a loss limit, expires, and is re-checked while running, so the fund unplugs
 * itself when the evidence turns.
 *
 * Nothing here imports the app config, so the config can call it while it loads.
 */

export type LiveVenue = 'alpaca' | 'okx';

export interface LiveApproval {
  venue: LiveVenue;
  approvedAt: number;
  expiresAt: number;
  /** Most the agents may ever commit, in USD. */
  capUsd: number;
  /** Largest single entry order, in USD. */
  maxOrderUsd: number;
  /** Fraction of the capital that, once lost, halts everything. */
  maxLossPct: number;
  /** Where the paper evidence lives, and what it showed. */
  evidenceDir: string;
  evidenceSeasonStartedAt: number;
  evidenceTrades: number;
  evidenceReturnPct: number;
  note: string;
}

export const DEFAULT_APPROVAL_FILE = './LIVE_APPROVAL.json';
const APPROVAL_DAYS = 30;
/** The words the user must type, so approval is never an accident. */
export function confirmationPhrase(capUsd: number): string {
  return `I ACCEPT THE RISK OF LOSING UP TO $${capUsd}`;
}

export function readApproval(file: string): LiveApproval | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as LiveApproval;
  } catch {
    return null;
  }
}

/** Throws unless live trading is currently allowed. Returns the approval. */
export function checkLiveApproval(opts: { file?: string; venue: LiveVenue; dataDir: string; now?: number }): LiveApproval {
  const file = path.resolve(opts.file ?? DEFAULT_APPROVAL_FILE);
  const now = opts.now ?? Date.now();
  const a = readApproval(file);
  const how = 'Real money is off until the paper evidence says PASSING and you run: npm run approve-live';
  if (!a) throw new Error(`live trading refused: no approval file at ${file}. ${how}`);
  if (a.venue !== opts.venue) throw new Error(`live trading refused: the approval is for ${a.venue}, not ${opts.venue}`);
  if (!(a.capUsd > 0) || !(a.maxOrderUsd > 0) || !(a.maxLossPct > 0 && a.maxLossPct < 1)) throw new Error('live trading refused: the approval file has invalid limits');
  if (now > a.expiresAt) throw new Error(`live trading refused: the approval expired on ${new Date(a.expiresAt).toISOString().slice(0, 10)}. Renew it with npm run approve-live`);
  // The live fund must keep its own books, apart from the paper fund that earned the approval.
  if (path.resolve(opts.dataDir) === path.resolve(a.evidenceDir)) throw new Error('live trading refused: DATA_DIR is the paper evidence directory. Use a separate one such as ./data-live');
  const ev = loadEvidence(a.evidenceDir);
  if (!ev) throw new Error(`live trading refused: cannot read the paper evidence in ${a.evidenceDir}`);
  const v = assess(ev, { provenOnly: true });
  if (v.code === 'NOT_PROFITABLE') throw new Error(`live trading refused: the paper evidence has turned. ${v.text}`);
  return a;
}

export interface ApprovalRequest {
  venue: LiveVenue;
  capUsd: number;
  maxOrderUsd?: number;
  maxLossPct?: number;
  evidenceDir: string;
  typed: string;
  file?: string;
  note?: string;
  now?: number;
}

/** Evidence the user is shown before deciding. */
export function evidenceFor(dir: string): { verdict: Verdict; days: number; seasonStartedAt: number } | null {
  const ev = loadEvidence(dir);
  if (!ev) return null;
  return { verdict: assess(ev, { provenOnly: true }), days: ev.days, seasonStartedAt: ev.seasonStartedAt };
}

/** Writes the approval file, but only for PASSING evidence and the exact confirmation phrase. */
export function createApproval(r: ApprovalRequest): LiveApproval {
  const now = r.now ?? Date.now();
  const ev = evidenceFor(r.evidenceDir);
  if (!ev) throw new Error(`no paper evidence found in ${r.evidenceDir}`);
  if (ev.verdict.code !== 'PASSING') throw new Error(`refused: the paper evidence is not PASSING. ${ev.verdict.text}`);
  if (!(r.capUsd >= 50)) throw new Error('refused: the capital cap must be at least $50');
  if (r.typed.trim() !== confirmationPhrase(r.capUsd)) throw new Error('refused: the confirmation phrase did not match exactly');
  const a: LiveApproval = {
    venue: r.venue,
    approvedAt: now,
    expiresAt: now + APPROVAL_DAYS * 86_400_000,
    capUsd: r.capUsd,
    maxOrderUsd: r.maxOrderUsd ?? Math.round(r.capUsd * 0.2),
    maxLossPct: r.maxLossPct ?? 0.2,
    evidenceDir: path.resolve(r.evidenceDir),
    evidenceSeasonStartedAt: ev.seasonStartedAt,
    evidenceTrades: ev.verdict.trades,
    evidenceReturnPct: ev.verdict.returnPct,
    note: r.note ?? '',
  };
  const file = path.resolve(r.file ?? DEFAULT_APPROVAL_FILE);
  if (existsSync(file)) writeFileSync(file + '.previous', readFileSync(file));
  writeFileSync(file, JSON.stringify(a, null, 2));
  return a;
}

// Explicit opt-in paper short-hold experiment, isolated from legacy data-hi.
import { highActivityEnvironment } from './profiles/hi-intraday';
Object.assign(process.env, highActivityEnvironment(process.env));

await import('./index');

export {};

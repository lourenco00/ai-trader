import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { auditAccount } from '../server/validation/account-audit';

const MAX_BYTES = 8 * 1024 * 1024;
try {
  if (process.argv.length !== 3) throw new Error('usage');
  const fd = openSync(process.argv[2]!, constants.O_RDONLY | constants.O_NONBLOCK);
  let text: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('size');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (!n) break;
      length += n;
    }
    if (length > MAX_BYTES) throw new Error('size');
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } finally { closeSync(fd); }
  const report = auditAccount(JSON.parse(text));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === 'consistent-observation' ? 0 : 2;
} catch {
  process.stderr.write('Account audit rejected input. Usage: npm run audit:account -- evidence.json (bounded UTF-8 JSON evidence; no credentials).\n');
  process.exitCode = 1;
}

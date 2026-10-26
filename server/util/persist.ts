import { mkdir, readFile, rename, writeFile, appendFile, copyFile } from 'node:fs/promises';
import path from 'node:path';

/** Write JSON atomically: write a temp file then rename, so a crash never leaves a half-written state file. */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data), 'utf8');
  await rename(tmp, file);
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`reading ${file}: ${(err as Error).message}`);
  }
}

export async function appendJsonLine(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(data) + '\n', 'utf8');
}

export async function backupFile(file: string, suffix: string): Promise<string | null> {
  const target = `${file.replace(/\.json$/, '')}-${suffix}.json`;
  try {
    await copyFile(file, target);
    return target;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`backing up ${file}: ${(err as Error).message}`);
  }
}

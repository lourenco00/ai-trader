import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ServerMessage } from '../shared/types';
import { config } from './config';
import { Ecosystem } from './ecosystem';
import { logger } from './util/log';

const log = logger('server');
const distDir = path.resolve('web/dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(data);
}

/** Same-origin check for browsers. Requests without an Origin header (curl, scripts) are allowed. */
function originAllowed(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    return o.host === req.headers.host || ['localhost', '127.0.0.1', '[::1]'].includes(o.hostname);
  } catch {
    return false;
  }
}

async function serveStatic(res: http.ServerResponse, pathname: string): Promise<void> {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end('bad path');
    return;
  }
  const target = path.normalize(path.join(distDir, rel === '/' ? 'index.html' : rel));
  if (target !== distDir && !target.startsWith(distDir + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  let file = target;
  try {
    const st = await stat(file);
    if (st.isDirectory()) file = path.join(file, 'index.html');
  } catch {
    file = path.join(distDir, 'index.html'); // SPA fallback
  }
  try {
    await stat(file);
  } catch {
    res.writeHead(503, { 'content-type': 'text/plain' }).end('UI not built yet. Run "npm run build" (or "npm start"), or use "npm run dev" and open http://localhost:5173');
    return;
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    'x-content-type-options': 'nosniff',
  });
  createReadStream(file).pipe(res);
}

async function main(): Promise<void> {
  const eco = new Ecosystem(config);
  await eco.start();

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
        return serveStatic(res, url.pathname);
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return sendJson(res, 200, eco.snapshot());
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, provider: eco.feed.provider.name, lastData: eco.feed.lastUpdate, stale: eco.feed.isStale() });
      }
      if (req.method === 'POST') {
        // Custom header + origin check: blocks cross-site form posts against this local server.
        if (req.headers['x-valley-action'] !== '1' || !originAllowed(req)) return sendJson(res, 403, { error: 'forbidden' });
        switch (url.pathname) {
          case '/api/halt':
            await eco.halt();
            return sendJson(res, 200, { ok: true });
          case '/api/resume':
            eco.resume();
            return sendJson(res, 200, { ok: true });
          case '/api/resume-llm':
            eco.resumeLlm();
            return sendJson(res, 200, { ok: true });
          case '/api/new-season': {
            const backup = await eco.newSeason();
            return sendJson(res, 200, { ok: true, backup: backup ? path.basename(backup) : null });
          }
        }
      }
      sendJson(res, 404, { error: 'not found' });
    })().catch((err) => {
      log.error(`request ${req.method} ${req.url} failed`, err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    });
  });

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 4096,
    verifyClient: (info: { req: http.IncomingMessage }) => originAllowed(info.req),
  });
  const clients = new Set<WebSocket>();
  const send = (ws: WebSocket, data: string) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  };

  wss.on('connection', (ws) => {
    clients.add(ws);
    send(ws, JSON.stringify({ type: 'snapshot', data: eco.snapshot() } satisfies ServerMessage));
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  eco.subscribe((msg) => {
    if (clients.size === 0) return;
    const data = JSON.stringify(msg);
    for (const ws of clients) send(ws, data);
  });

  const snapTimer = setInterval(() => {
    if (clients.size === 0) return;
    const data = JSON.stringify({ type: 'snapshot', data: eco.snapshot() } satisfies ServerMessage);
    for (const ws of clients) send(ws, data);
  }, 1000);

  server.listen(config.port, config.host, () => {
    log.info(`AI Trader Valley is open at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port} (paper mode)`);
    if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
      log.warn(`listening on ${config.host}: the UI and kill switch have no authentication, keep this off untrusted networks`);
    }
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, saving state...`);
    clearInterval(snapTimer);
    for (const ws of clients) ws.close();
    wss.close();
    server.close();
    await eco.stop();
    log.info('state saved, bye');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => log.error('unhandled rejection', err));
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception, saving and exiting', err);
    void eco.stop().finally(() => process.exit(1));
  });
}

main().catch((err) => {
  log.error('failed to start', err);
  process.exit(1);
});

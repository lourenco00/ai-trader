import { logger } from '../util/log';

const log = logger('news');

export interface Headline {
  title: string;
  summary: string;
  link: string;
  published: number;
  source: string;
}

/** Minimal RSS/Atom extraction. Avoids an XML dependency; good enough for headlines. */
function parseFeed(xml: string, source: string): Headline[] {
  const out: Headline[] = [];
  const itemRe = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) && out.length < 40) {
    const block = m[0];
    const title = decode(pick(block, 'title'));
    if (!title) continue;
    const link = extractLink(block);
    const desc = decode(pick(block, 'description') || pick(block, 'summary') || pick(block, 'content'));
    const dateStr = pick(block, 'pubDate') || pick(block, 'published') || pick(block, 'updated');
    const published = dateStr ? Date.parse(dateStr) : Date.now();
    out.push({
      title,
      summary: stripTags(desc).slice(0, 300),
      link,
      published: Number.isFinite(published) ? published : Date.now(),
      source,
    });
  }
  return out;
}

function pick(block: string, tag: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(block);
  return m ? m[1].trim() : '';
}

function extractLink(block: string): string {
  const href = /<link\b[^>]*href=["']([^"']+)["']/i.exec(block);
  if (href) return href[1];
  return stripTags(pick(block, 'link'));
}

function stripTags(s: string): string {
  return decode(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}

async function fetchFeed(url: string): Promise<Headline[]> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(12_000),
    headers: { 'User-Agent': 'ai-trader-valley/0.2', Accept: 'application/rss+xml, application/atom+xml, text/xml, */*' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  })();
  return parseFeed(await res.text(), host);
}

/** Fetch all feeds, newest first, de-duplicated by title. Failures are logged and skipped. */
export async function fetchAllHeadlines(feeds: string[]): Promise<Headline[]> {
  const settled = await Promise.allSettled(feeds.map(fetchFeed));
  const all: Headline[] = [];
  const seen = new Set<string>();
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      for (const h of r.value) {
        const key = h.title.toLowerCase().slice(0, 80);
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(h);
      }
    } else {
      log.debug(`feed ${feeds[i]} failed: ${String(r.reason).slice(0, 100)}`);
    }
  });
  return all.sort((a, b) => b.published - a.published);
}

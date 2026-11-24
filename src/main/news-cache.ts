import { net } from 'electron';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { NEWS_FEEDS } from '../shared/services.js';
import type { NewsFeedResult, NewsItem } from '../shared/ipc.js';

const CACHE_TTL_MS = 15 * 60 * 1000;
/** Google News answers with 429 when the same client asks too often; we back off instead of hammering it. */
const RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;
const MAX_ITEMS = 40;
const REQUEST_TIMEOUT_MS = 12_000;

interface CacheEntry {
  fetchedAt: number;
  items: NewsItem[];
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

function pickTag(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return match?.[1] ? decodeEntities(match[1]).trim() : '';
}

export function parseRssItems(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const block of blocks.slice(0, MAX_ITEMS)) {
    const title = pickTag(block, 'title');
    const link = pickTag(block, 'link');
    if (!title || !/^https?:\/\//i.test(link)) continue;
    const source = pickTag(block, 'source') || 'Google News';
    const publishedAt = pickTag(block, 'pubDate');
    items.push({ title, source, publishedAt, link });
  }
  return items;
}

export class NewsCache {
  private readonly dir: string;
  private readonly memory = new Map<string, CacheEntry>();
  private readonly blockedUntil = new Map<string, number>();

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(this.dir, { recursive: true });
  }

  private fileFor(feedId: string): string {
    return join(this.dir, `${createHash('sha1').update(feedId).digest('hex')}.json`);
  }

  private readDisk(feedId: string): CacheEntry | null {
    try {
      const parsed = JSON.parse(readFileSync(this.fileFor(feedId), 'utf8')) as CacheEntry;
      if (Array.isArray(parsed.items) && typeof parsed.fetchedAt === 'number') return parsed;
    } catch {
      /* cache miss */
    }
    return null;
  }

  private writeDisk(feedId: string, entry: CacheEntry): void {
    try {
      writeFileSync(this.fileFor(feedId), JSON.stringify(entry), 'utf8');
    } catch (error) {
      console.error('[news] cannot persist cache:', (error as Error).message);
    }
  }

  private async fetchFeed(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await net.fetch(url, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
          'User-Agent': 'NTFitnessTouch/0.2 (+rss reader prototype)',
        },
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`) as Error & { status?: number };
        error.status = response.status;
        throw error;
      }
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }

  async get(feedId: string): Promise<NewsFeedResult> {
    const feed = NEWS_FEEDS.find((candidate) => candidate.id === feedId);
    if (!feed) {
      return { feedId, status: 'error', fetchedAt: new Date().toISOString(), items: [], message: 'Không có chuyên mục này.' };
    }

    const now = Date.now();
    const cached = this.memory.get(feed.id) ?? this.readDisk(feed.id);
    if (cached) this.memory.set(feed.id, cached);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      return { feedId: feed.id, status: 'ok', fetchedAt: new Date(cached.fetchedAt).toISOString(), items: cached.items };
    }
    if ((this.blockedUntil.get(feed.id) ?? 0) > now) {
      return this.staleOrError(feed.id, cached, 'Google News đang giới hạn tần suất tải. Đang dùng bản lưu.');
    }

    try {
      const xml = await this.fetchFeed(feed.url);
      const items = parseRssItems(xml);
      if (items.length === 0) throw new Error('RSS rỗng hoặc không đúng định dạng.');
      const entry: CacheEntry = { fetchedAt: now, items };
      this.memory.set(feed.id, entry);
      this.writeDisk(feed.id, entry);
      return { feedId: feed.id, status: 'ok', fetchedAt: new Date(now).toISOString(), items };
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 429) this.blockedUntil.set(feed.id, now + RATE_LIMIT_BACKOFF_MS);
      const reason = status === 429 ? 'Google News đang giới hạn tần suất tải.' : `Không tải được RSS (${(error as Error).message}).`;
      return this.staleOrError(feed.id, cached, reason);
    }
  }

  private staleOrError(feedId: string, cached: CacheEntry | null, message: string): NewsFeedResult {
    if (cached) {
      return { feedId, status: 'stale', fetchedAt: new Date(cached.fetchedAt).toISOString(), items: cached.items, message };
    }
    return { feedId, status: 'error', fetchedAt: new Date().toISOString(), items: [], message };
  }

  clear(): void {
    this.memory.clear();
    this.blockedUntil.clear();
    try {
      rmSync(this.dir, { recursive: true, force: true });
      mkdirSync(this.dir, { recursive: true });
    } catch {
      /* best effort */
    }
  }
}

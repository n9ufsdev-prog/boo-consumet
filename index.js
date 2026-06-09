/**
 * Boo Consumet API - Render Deployment
 * 
 * This server provides Consumet-compatible endpoints for Boo anime streaming.
 * Deploy on Render.com for a different IP that bypasses Gogoanime's Cloudflare.
 * 
 * How it works:
 * 1. Search & Info: Uses Anilist GraphQL (reliable, no scraping needed)
 * 2. Streaming: Scrapes Gogoanime directly for m3u8 HLS streams
 * 3. Fallback: If scraping fails, returns empty so frontend uses iframe
 * 
 * Render Free Tier Notes:
 * - Service sleeps after 15min inactivity
 * - First request after sleep takes ~30s
 * - Add a cron ping every 10min to keep it alive
 */

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ========== CONFIGURATION ==========

const ANILIST_GQL = 'https://graphql.anilist.co';

const GOGO_BASES = [
  'https://anitaku.bz',
  'https://gogoanime3.co',
  'https://gogoanime.cl',
  'https://gogoanime.lu',
  'https://gogoanime.hu',
  'https://gogoanime.vet',
  'https://gogoanime.wiki',
];

let activeBase = null;
let lastBaseCheck = 0;
const BASE_CHECK_INTERVAL = 30 * 60 * 1000;

// Cache
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < CACHE_TTL) return entry.data;
  cache.delete(key);
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, time: Date.now() });
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.time > CACHE_TTL) cache.delete(k);
    }
  }
}

// ========== GOGOANIME SCRAPER ==========

async function findActiveBase() {
  if (activeBase && Date.now() - lastBaseCheck < BASE_CHECK_INTERVAL) {
    return activeBase;
  }

  for (const base of GOGO_BASES) {
    try {
      const res = await fetch(base, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(8000),
        redirect: 'follow',
      });
      if (res.ok) {
        const text = await res.text();
        if (text.length > 1000 && !text.includes('Loading...')) {
          activeBase = base;
          lastBaseCheck = Date.now();
          console.log(`[Consumet] Active mirror: ${base}`);
          return activeBase;
        }
      }
    } catch (e) {
      console.log(`[Consumet] Mirror down: ${base}`);
    }
  }

  if (!activeBase) activeBase = GOGO_BASES[0];
  return activeBase;
}

async function gogoFetch(path) {
  const base = await findActiveBase();
  const url = path.startsWith('http') ? path : `${base}${path}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Referer': base,
    },
    signal: AbortSignal.timeout(15000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Gogoanime returned ${res.status}`);
  return res.text();
}

// ========== ANILIST GRAPHQL ==========

async function anilistQuery(query, variables = {}) {
  const res = await fetch(ANILIST_GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Anilist returned ${res.status}`);
  return res.json();
}

// ========== ENDPOINTS ==========

// Search anime
app.get('/anime/gogoanime/:query', async (req, res) => {
  try {
    const query = req.params.query;
    const page = parseInt(String(req.query.page || '1'));
    const perPage = 15;

    const gqlRes = await anilistQuery(`
      query ($search: String, $page: Int, $perPage: Int) {
        Page(page: $page, perPage: $perPage) {
          pageInfo { hasNextPage currentPage }
          media(search: $search, type: ANIME, isAdult: false) {
            id
            title { english romaji userPreferred }
            coverImage { large }
            startDate { year }
            status
            episodes
          }
        }
      }
    `, { search: query, page, perPage });

    const pageData = gqlRes.data.Page;
    const results = pageData.media.map((m) => ({
      id: String(m.id),
      title: m.title.english || m.title.romaji || m.title.userPreferred || '',
      image: m.coverImage?.large || '',
      releaseDate: m.startDate?.year ? String(m.startDate.year) : '',
      subOrDub: 'sub',
      episodes: m.episodes,
    }));

    res.json({ currentPage: page, hasNextPage: pageData.pageInfo.hasNextPage, results });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: String(error), results: [] });
  }
});

// Anime info + episodes
app.get('/anime/gogoanime/info/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const cached = getCached(`info:${id}`);
    if (cached) return res.json(cached);

    const gqlRes = await anilistQuery(`
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          id
          title { english romaji userPreferred }
          coverImage { large }
          description
          episodes
          status
          startDate { year }
          genres
        }
      }
    `, { id: parseInt(id) });

    const m = gqlRes.data.Media;
    const totalEp = m.episodes || 0;
    const romaji = m.title.romaji || m.title.english || '';
    
    const episodes = [];
    for (let i = 1; i <= totalEp; i++) {
      const slug = romaji.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .trim();
      episodes.push({ id: `${slug}-episode-${i}`, number: i, title: `Episode ${i}` });
    }

    const result = {
      id: String(m.id),
      title: m.title.english || m.title.romaji || '',
      image: m.coverImage?.large || '',
      description: (m.description || '').replace(/<[^>]*>/g, ''),
      totalEpisodes: totalEp,
      episodes,
    };

    setCache(`info:${id}`, result);
    res.json(result);
  } catch (error) {
    console.error('Info error:', error);
    res.status(500).json({ error: String(error), episodes: [] });
  }
});

// Streaming sources - THE KEY ENDPOINT
app.get('/anime/gogoanime/watch/:episodeId', async (req, res) => {
  try {
    const episodeId = decodeURIComponent(req.params.episodeId);
    const cached = getCached(`watch:${episodeId}`);
    if (cached) return res.json(cached);

    console.log(`[Consumet] Watch request: ${episodeId}`);

    // Try Gogoanime scraping
    const sources = [];
    const subtitles = [];

    try {
      const html = await gogoFetch(`/${episodeId}`);
      
      // Check if page loaded properly (not Cloudflare blocked)
      if (html.includes('Loading...') && html.length < 1000) {
        throw new Error('Cloudflare challenge page');
      }

      // Extract m3u8 URLs from scripts
      const m3u8Regex = /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/g;
      let match;
      while ((match = m3u8Regex.exec(html)) !== null) {
        sources.push({ url: match[0].replace(/['";,\s]/g, ''), quality: 'default', isM3U8: true });
      }

      // Extract embed/video URLs
      const embedRegex = /(?:src|data-video|data-src)\s*=\s*["']([^"']*(?:streamani|gogoplay|playgo|vidstream|embed)[^"']*)/gi;
      while ((match = embedRegex.exec(html)) !== null) {
        let url = match[1];
        if (url.startsWith('//')) url = `https:${url}`;
        
        try {
          const embedSources = await resolveEmbed(url);
          sources.push(...embedSources);
        } catch (e) {
          console.log(`[Consumet] Embed resolve failed: ${e.message}`);
        }
      }

      // Also check for iframe with any URL that might contain video
      const iframeRegex = /<iframe[^>]+src\s*=\s*["']([^"']+)["']/gi;
      while ((match = iframeRegex.exec(html)) !== null) {
        let url = match[1];
        if (url.startsWith('//')) url = `https:${url}`;
        if (url.includes('streamani') || url.includes('gogoplay') || url.includes('playgo') || url.includes('vidstream') || url.includes('ajax')) {
          try {
            const embedSources = await resolveEmbed(url);
            sources.push(...embedSources);
          } catch (e) {
            // Skip
          }
        }
      }

    } catch (scrapeErr) {
      console.error(`[Consumet] Scrape error: ${scrapeErr.message}`);
    }

    // Deduplicate
    const seen = new Set();
    const uniqueSources = sources.filter(s => {
      if (!s.url || seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });

    const result = uniqueSources.length > 0
      ? { headers: { Referer: activeBase }, sources: uniqueSources, subtitles, episodeId, provider: 'gogoanime-scrape' }
      : { sources: [], subtitles: [], episodeId, provider: 'gogoanime-scrape', note: 'No HLS sources found. Frontend should fallback to iframe.' };

    setCache(`watch:${episodeId}`, result);
    res.json(result);
  } catch (error) {
    console.error('Watch error:', error);
    res.status(500).json({ error: String(error), sources: [] });
  }
});

// Resolve embed URL to extract m3u8
async function resolveEmbed(embedUrl) {
  const sources = [];
  try {
    const res = await fetch(embedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': activeBase || 'https://anitaku.bz/',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return sources;
    const html = await res.text();

    // Extract m3u8
    const m3u8Regex = /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/g;
    let match;
    while ((match = m3u8Regex.exec(html)) !== null) {
      sources.push({ url: match[0].replace(/['";,\s]/g, ''), quality: 'default', isM3U8: true });
    }

    // Extract file: "url" patterns
    const fileRegex = /file\s*:\s*["']([^"']*\.m3u8[^"']*)/g;
    while ((match = fileRegex.exec(html)) !== null) {
      sources.push({ url: match[1], quality: 'default', isM3U8: true });
    }

    // Source with quality
    const srcQualityRegex = /\{\s*(?:file|src)\s*:\s*["']([^"']*\.m3u8[^"']*)["']\s*,\s*(?:label|quality)\s*:\s*["']([^"']*)/g;
    while ((match = srcQualityRegex.exec(html)) !== null) {
      sources.push({ url: match[1], quality: match[2] || 'default', isM3U8: true });
    }

    // Reversed order
    const qualitySrcRegex = /\{\s*(?:label|quality)\s*:\s*["']([^"']*)["']\s*,\s*(?:file|src)\s*:\s*["']([^"']*\.m3u8[^"']*)/g;
    while ((match = qualitySrcRegex.exec(html)) !== null) {
      sources.push({ url: match[2], quality: match[1] || 'default', isM3U8: true });
    }

  } catch (error) {
    console.error(`[Consumet] Embed resolve error: ${error.message}`);
  }
  return sources;
}

// ========== HEALTH & KEEP-ALIVE ==========

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    provider: 'anilist + gogoanime-scrape',
    activeMirror: activeBase || 'not checked yet',
    cacheSize: cache.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'Boo Consumet API (Render)',
    version: '1.0.0',
    endpoints: {
      search: 'GET /anime/gogoanime/:query',
      info: 'GET /anime/gogoanime/info/:id',
      watch: 'GET /anime/gogoanime/watch/:episodeId',
      health: 'GET /health',
    },
    activeMirror: activeBase || 'not checked yet',
  });
});

// Start
app.listen(PORT, () => {
  console.log(`[Boo Consumet API] Running on port ${PORT}`);
  findActiveBase().then(base => {
    console.log(`[Boo Consumet API] Mirror: ${base}`);
  });
});

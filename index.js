/**
 * Boo Consumet API - Render Deployment v2
 * 
 * Instead of scraping Gogoanime (blocked by Cloudflare),
 * we resolve anime-sama embed URLs (Vidmoly, Sendvid, Smoothpre) to m3u8.
 * 
 * Flow:
 * 1. Search & Info: Anilist GraphQL (reliable)
 * 2. Stream: Resolve embed URLs from Vidmoly/Sendvid/Smoothpre to .m3u8
 */

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ========== CONFIG ==========

const ANILIST_GQL = 'https://graphql.anilist.co';
const ANIMESAMA_BASE = 'https://anime-sama.fr';

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
  if (cache.size > 300) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.time > CACHE_TTL) cache.delete(k);
    }
  }
}

// ========== ANILIST SEARCH ==========

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

// ========== ANIME INFO ==========

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

// ========== STREAM RESOLUTION ==========

// Resolve Vidmoly embed URL to m3u8
async function resolveVidmoly(embedUrl) {
  const sources = [];
  try {
    const res = await fetch(embedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return sources;
    const html = await res.text();

    // Extract m3u8 from Vidmoly (JW Player)
    const m3u8Regex = /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/g;
    let match;
    while ((match = m3u8Regex.exec(html)) !== null) {
      let url = match[0].replace(/['";,\s]/g, '');
      // Skip thumbnail URLs
      if (url.includes('.jpg') || url.includes('.png')) continue;
      sources.push({ url, quality: 'auto', isM3U8: true });
    }

    // Also check file: pattern in JW Player config
    const fileRegex = /file\s*:\s*["']([^"']*\.m3u8[^"']*)/g;
    while ((match = fileRegex.exec(html)) !== null) {
      sources.push({ url: match[1], quality: 'auto', isM3U8: true });
    }
  } catch (e) {
    console.error('Vidmoly resolve error:', e.message);
  }
  return sources;
}

// Resolve Sendvid embed URL to m3u8
async function resolveSendvid(embedUrl) {
  const sources = [];
  try {
    const res = await fetch(embedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return sources;
    const html = await res.text();

    const m3u8Regex = /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/g;
    let match;
    while ((match = m3u8Regex.exec(html)) !== null) {
      let url = match[0].replace(/['";,\s]/g, '');
      sources.push({ url, quality: 'auto', isM3U8: true });
    }

    // Sendvid uses video source tags
    const sourceRegex = /<source[^>]+src=["']([^"']+)["']/gi;
    while ((match = sourceRegex.exec(html)) !== null) {
      if (match[1].includes('.m3u8')) {
        sources.push({ url: match[1], quality: 'auto', isM3U8: true });
      }
    }
  } catch (e) {
    console.error('Sendvid resolve error:', e.message);
  }
  return sources;
}

// Resolve Smoothpre embed URL to m3u8
async function resolveSmoothpre(embedUrl) {
  const sources = [];
  try {
    const res = await fetch(embedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return sources;
    const html = await res.text();

    const m3u8Regex = /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/g;
    let match;
    while ((match = m3u8Regex.exec(html)) !== null) {
      let url = match[0].replace(/['";,\s]/g, '');
      sources.push({ url, quality: 'auto', isM3U8: true });
    }
  } catch (e) {
    console.error('Smoothpre resolve error:', e.message);
  }
  return sources;
}

// Resolve any embed URL based on domain
async function resolveEmbed(embedUrl) {
  if (embedUrl.includes('vidmoly') || embedUrl.includes('vmoly')) {
    return resolveVidmoly(embedUrl);
  }
  if (embedUrl.includes('sendvid')) {
    return resolveSendvid(embedUrl);
  }
  if (embedUrl.includes('smoothpre') || embedUrl.includes('smooth')) {
    return resolveSmoothpre(embedUrl);
  }
  // Generic resolver for other hosts
  return resolveGeneric(embedUrl);
}

// Generic embed resolver
async function resolveGeneric(embedUrl) {
  const sources = [];
  try {
    const res = await fetch(embedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return sources;
    const html = await res.text();

    const m3u8Regex = /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/g;
    let match;
    while ((match = m3u8Regex.exec(html)) !== null) {
      sources.push({ url: match[0].replace(/['";,\s]/g, ''), quality: 'auto', isM3U8: true });
    }
  } catch (e) {
    console.error('Generic resolve error:', e.message);
  }
  return sources;
}

// ========== WATCH ENDPOINT ==========

app.get('/anime/gogoanime/watch/:episodeId', async (req, res) => {
  try {
    const episodeId = decodeURIComponent(req.params.episodeId);
    const cached = getCached(`watch:${episodeId}`);
    if (cached) return res.json(cached);

    console.log(`[Watch] Request: ${episodeId}`);

    // Extract anime slug from episodeId (format: anime-name-episode-N)
    const epMatch = episodeId.match(/^(.+)-episode-(\d+)$/);
    if (!epMatch) {
      return res.json({ sources: [], subtitles: [], episodeId, note: 'Invalid episode ID format' });
    }

    const animeSlug = epMatch[1];
    const epNum = parseInt(epMatch[2]);

    // Try to get embed URLs from AnimeSama
    const sources = [];
    const subtitles = [];

    try {
      // Fetch episode page from AnimeSama
      const saisonSlug = 'saison1'; // Default, could be improved
      const asUrl = `${ANIMESAMA_BASE}/catalogue/${animeSlug}/${saisonSlug}/vostfr`;
      console.log(`[Watch] Fetching AnimeSama: ${asUrl}`);

      const asRes = await fetch(asUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (asRes.ok) {
        const asHtml = await asRes.text();

        // Parse episode embed URLs from AnimeSama page
        // AnimeSama typically has: data-url="https://vidmoly.biz/embed-xxx.html" for each episode
        const epUrlRegex = /(?:data-url|href)\s*=\s*["']([^"']*(?:vidmoly|sendvid|smoothpre|sibnet)[^"']*)/gi;
        let match;
        const embedUrls = [];
        while ((match = epUrlRegex.exec(asHtml)) !== null) {
          embedUrls.push(match[1]);
        }

        // Also try JSON-LD or script data
        const jsonMatch = asHtml.match(/(?:panneauAnime|episodes|lecteurs)\s*[:=]\s*(\[[\s\S]*?\])/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[1]);
            for (const item of parsed) {
              if (item.url) embedUrls.push(item.url);
            }
          } catch {}
        }

        console.log(`[Watch] Found ${embedUrls.length} embed URLs`);

        // Try resolving each embed URL to get m3u8
        // Prefer Vidmoly (best m3u8 support)
        const vidmolyUrls = embedUrls.filter(u => u.includes('vidmoly'));
        const otherUrls = embedUrls.filter(u => !u.includes('vidmoly'));

        for (const url of vidmolyUrls.slice(0, 3)) {
          const resolved = await resolveVidmoly(url);
          sources.push(...resolved);
        }

        // If no Vidmoly m3u8, try others
        if (sources.length === 0) {
          for (const url of otherUrls.slice(0, 3)) {
            const resolved = await resolveEmbed(url);
            sources.push(...resolved);
          }
        }
      }
    } catch (asErr) {
      console.error(`[Watch] AnimeSama fetch error: ${asErr.message}`);
    }

    // Deduplicate
    const seen = new Set();
    const uniqueSources = sources.filter(s => {
      if (!s.url || seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });

    const result = uniqueSources.length > 0
      ? { headers: { Referer: 'https://vidmoly.biz/' }, sources: uniqueSources, subtitles, episodeId, provider: 'vidmoly-resolve' }
      : { sources: [], subtitles: [], episodeId, provider: 'vidmoly-resolve', note: 'No HLS sources found. Frontend should fallback to iframe.' };

    setCache(`watch:${episodeId}`, result);
    res.json(result);
  } catch (error) {
    console.error('Watch error:', error);
    res.status(500).json({ error: String(error), sources: [] });
  }
});

// ========== HEALTH ==========

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    provider: 'anilist + vidmoly-resolve',
    cacheSize: cache.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'Boo Consumet API v2',
    version: '2.0.0',
    description: 'Consumet API using Vidmoly/Sendvid m3u8 resolution',
    endpoints: {
      search: 'GET /anime/gogoanime/:query',
      info: 'GET /anime/gogoanime/info/:id',
      watch: 'GET /anime/gogoanime/watch/:episodeId',
      health: 'GET /health',
    },
  });
});

app.listen(PORT, () => {
  console.log(`[Boo Consumet API v2] Running on port ${PORT}`);
  console.log(`[Boo Consumet API v2] Using Vidmoly/Sendvid m3u8 resolution`);
});

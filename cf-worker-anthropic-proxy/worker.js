/**
 * BookEase · Anthropic API proxy · Cloudflare Worker
 * ─────────────────────────────────────────────────
 * Purpose: keep ANTHROPIC_KEY server-side · accept fetch requests from
 * BookEase tools · forward to Anthropic Vision API · return response.
 *
 * Why: Anthropic key cannot live in client HTML (would be scraped + abused).
 * This Worker holds the key as an env secret · enforces origin whitelist
 * + per-IP rate limit · sponsors AI cost as part of merchant acquisition.
 *
 * Deploy: see WORKER_SETUP.md (5 min · CF dashboard · paste this code).
 *
 * Cost (typical):
 *   Anthropic Sonnet 4 vision call ≈ $0.04 per image
 *   1 merchant signup ≈ 2 calls (LINE OA + menu) ≈ $0.08
 *   100,000 merchants/year ≈ $8K/year (well within marketing budget)
 *
 * Author: Claude (Atiz BookEase ops · 2026-05-05)
 */

// ────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Origin whitelist · prevents random sites from using our quota
const ALLOWED_ORIGINS = [
  'https://atiz-official.github.io',
  'https://shop.bookease.co',
  'https://shopv3.bookease.co',
  'https://bookease.co',
  // Local dev (uncomment for testing only)
  // 'http://localhost:5173',
  // 'http://localhost:3000',
  // 'null',  // file:// protocol opens
];

// Per-IP daily rate limit · 50 calls/IP/day = ~25 merchant onboards/IP/day
// (each merchant = ~2 calls · LINE OA + menu)
const RATE_LIMIT_PER_DAY = 50;

// Hard cap on token usage per call (Anthropic max is 4096 for Sonnet vision)
const MAX_TOKENS = 2048;

// CORS headers (response to preflight + actual responses)
function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

// ────────────────────────────────────────────────────────────────────
// Rate limiting · uses CF KV namespace 'RATE_LIMIT'
// (Configure in CF dashboard before deploy · or skip rate-limit by
//  removing the KV binding · costs are bounded by Anthropic budget anyway)
// ────────────────────────────────────────────────────────────────────

async function checkRateLimit(env, ip) {
  if (!env.RATE_LIMIT) return { ok: true }; // no KV bound · skip

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const key = `rl:${ip}:${today}`;

  const current = parseInt((await env.RATE_LIMIT.get(key)) || '0');
  if (current >= RATE_LIMIT_PER_DAY) {
    return { ok: false, remaining: 0 };
  }

  // Increment · 25-hour expiry (covers TZ edge cases)
  await env.RATE_LIMIT.put(key, String(current + 1), {
    expirationTtl: 60 * 60 * 25,
  });

  return { ok: true, remaining: RATE_LIMIT_PER_DAY - current - 1 };
}

// ────────────────────────────────────────────────────────────────────
// Main handler
// ────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin),
      });
    }

    // Method check
    if (request.method !== 'POST') {
      return new Response('Only POST allowed', {
        status: 405,
        headers: corsHeaders(origin),
      });
    }

    // Origin check
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return new Response(JSON.stringify({ error: 'origin_forbidden', origin }), {
        status: 403,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      });
    }

    // Env check
    if (!env.ANTHROPIC_KEY) {
      return new Response(JSON.stringify({ error: 'server_misconfigured' }), {
        status: 500,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      });
    }

    // Rate limit per IP
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rl = await checkRateLimit(env, ip);
    if (!rl.ok) {
      return new Response(
        JSON.stringify({
          error: 'rate_limit_exceeded',
          message: 'ใช้บ่อยเกินไป · ลองใหม่พรุ่งนี้',
          limit: RATE_LIMIT_PER_DAY,
        }),
        {
          status: 429,
          headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
        }
      );
    }

    // Forward to Anthropic
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'invalid_json' }), {
        status: 400,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      });
    }

    // Defensive · cap max_tokens to prevent runaway costs
    if (body.max_tokens && body.max_tokens > MAX_TOKENS) {
      body.max_tokens = MAX_TOKENS;
    }

    try {
      const upstream = await fetch(ANTHROPIC_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_KEY,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      });

      const text = await upstream.text();

      return new Response(text, {
        status: upstream.status,
        headers: {
          ...corsHeaders(origin),
          'Content-Type': 'application/json',
          'X-RateLimit-Remaining': String(rl.remaining ?? 'unlimited'),
        },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'upstream_failed', message: String(err) }),
        {
          status: 502,
          headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
        }
      );
    }
  },
};

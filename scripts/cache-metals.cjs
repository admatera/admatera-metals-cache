#!/usr/bin/env node
'use strict';

const fs = require('fs');

const SOURCE = 'metals.dev';
const API_URL = 'https://api.metals.dev/v1/latest?currency=USD';
const TIME_ZONE = 'America/New_York';
const FETCH_TIMEOUT_MS = 90_000;
const RETRY_DELAYS_MS = [0, 20_000, 60_000];

function appendOutput(key, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

function readJson(path, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  fs.writeFileSync(path, JSON.stringify(value, null, 2));
}

function etParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  }).formatToParts(now);

  return Object.fromEntries(
    parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value])
  );
}

function currentSlot(now = new Date()) {
  const p = etParts(now);
  const mins = Number(p.hour) * 60 + Number(p.minute);
  const businessDay = p.weekday !== 'Sat' && p.weekday !== 'Sun';
  const windows = [
    { name: '09:45 ET', key: '0945', start: 9 * 60 + 45, end: 16 * 60 + 30 },
    { name: '16:35 ET', key: '1635', start: 16 * 60 + 31, end: 23 * 60 + 30 }
  ];
  const slot = windows.find(window => mins >= window.start && mins <= window.end);

  if (!businessDay || !slot) {
    return { skip: true, reason: `outside write window; ET ${p.weekday} ${p.hour}:${String(p.minute).padStart(2, '0')}` };
  }

  return {
    skip: false,
    cacheSlotKey: `${p.year}-${p.month}-${p.day}-${slot.key}`,
    marketWindowET: slot.name
  };
}

function previousSuccessFields() {
  const prevStatus = readJson('metals-status.json');
  const prevMetals = readJson('metals.json');
  return {
    lastSuccessfulAt: prevStatus.lastSuccessfulAt || prevMetals.cacheUpdatedAt || prevMetals.updatedAt || null,
    lastMarketUpdatedAt: prevStatus.lastMarketUpdatedAt || prevMetals.marketUpdatedAt || null
  };
}

function statusBase(attemptedAt, slotMeta) {
  const previous = previousSuccessFields();
  return {
    lastAttemptedAt: attemptedAt,
    lastSuccessfulAt: previous.lastSuccessfulAt,
    lastError: null,
    lastErrorAt: null,
    lastSlotKey: slotMeta.cacheSlotKey,
    lastMarketUpdatedAt: previous.lastMarketUpdatedAt,
    marketWindowET: slotMeta.marketWindowET,
    source: SOURCE
  };
}

function writeAttemptStatus(attemptedAt, slotMeta) {
  writeJson('metals-status.json', statusBase(attemptedAt, slotMeta));
}

function writeFailureStatus(attemptedAt, slotMeta, error) {
  const status = statusBase(attemptedAt, slotMeta);
  status.lastError = error instanceof Error ? error.message : String(error || 'Unknown fetch failure');
  status.lastErrorAt = attemptedAt;
  writeJson('metals-status.json', status);
}

function writeSuccessStatus(attemptedAt, slotMeta, cacheUpdatedAt, marketUpdatedAt) {
  writeJson('metals-status.json', {
    lastAttemptedAt: attemptedAt,
    lastSuccessfulAt: cacheUpdatedAt,
    lastError: null,
    lastErrorAt: null,
    lastSlotKey: slotMeta.cacheSlotKey,
    lastMarketUpdatedAt: marketUpdatedAt,
    marketWindowET: slotMeta.marketWindowET,
    source: SOURCE
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 240)}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithRetries(apiKey) {
  let lastError = null;
  const url = `${API_URL}&api_key=${encodeURIComponent(apiKey)}`;

  for (let i = 0; i < RETRY_DELAYS_MS.length; i += 1) {
    const delay = RETRY_DELAYS_MS[i];
    if (delay > 0) await sleep(delay);

    const attempt = i + 1;
    console.log(`Fetch attempt ${attempt}/${RETRY_DELAYS_MS.length} for ${SOURCE}...`);
    try {
      return await fetchWithTimeout(url);
    } catch (error) {
      lastError = error;
      console.log(`Attempt ${attempt} failed: ${error.message}`);
    }
  }

  throw lastError || new Error('Unknown fetch failure');
}

function normalizeMetals(raw, slotMeta) {
  if (!raw || !raw.metals) throw new Error('No metals field in API response');

  const unitMap = {
    toz: { gPerUnit: 31.1035, label: 'USD/oz t' },
    mt: { gPerUnit: 1_000_000, label: 'USD/ton' }
  };
  const metaMap = {
    gold: { s: 'Au', n: 'Gold', u: 'toz' },
    silver: { s: 'Ag', n: 'Silver', u: 'toz' },
    platinum: { s: 'Pt', n: 'Platinum', u: 'toz' },
    palladium: { s: 'Pd', n: 'Palladium', u: 'toz' },
    copper: { s: 'Cu', n: 'Copper', u: 'mt' },
    aluminum: { s: 'Al', n: 'Aluminum', u: 'mt' },
    nickel: { s: 'Ni', n: 'Nickel', u: 'mt' },
    lead: { s: 'Pb', n: 'Lead', u: 'mt' },
    zinc: { s: 'Zn', n: 'Zinc', u: 'mt' }
  };

  const cacheUpdatedAt = new Date().toISOString();
  const marketUpdatedAt = raw?.timestamps?.metal || raw?.timestamp || raw?.date || null;
  const out = {
    updatedAt: cacheUpdatedAt,
    cacheUpdatedAt,
    marketUpdatedAt,
    cacheSlotKey: slotMeta.cacheSlotKey,
    marketWindowET: slotMeta.marketWindowET,
    source: SOURCE,
    items: []
  };

  for (const [code, meta] of Object.entries(metaMap)) {
    const price = raw.metals[code];
    if (price == null) continue;
    const unit = unitMap[meta.u];
    const usdPerGram = price / unit.gPerUnit;
    out.items.push({
      code,
      symbol: meta.s,
      name: meta.n,
      unit: unit.label,
      nativePrice: price,
      usdPerGram: +usdPerGram.toFixed(6)
    });
  }

  if (!out.items.length) throw new Error('No metal prices computed');
  out.items.sort((a, b) => b.usdPerGram - a.usdPerGram);
  return out;
}

async function main() {
  appendOutput('skip', 'false');
  appendOutput('fetch_success', 'false');

  const slot = currentSlot();
  if (slot.skip) {
    console.log(`Skipping metals cache candidate: ${slot.reason}.`);
    appendOutput('skip', 'true');
    return;
  }

  const prevMetals = readJson('metals.json');
  if (prevMetals?.cacheSlotKey === slot.cacheSlotKey) {
    console.log(`Skipping duplicate metals cache slot ${slot.cacheSlotKey}.`);
    appendOutput('skip', 'true');
    return;
  }

  const attemptedAt = new Date().toISOString();
  console.log(`Proceeding with metals cache slot ${slot.cacheSlotKey}.`);
  writeAttemptStatus(attemptedAt, slot);

  try {
    if (!process.env.API_KEY) throw new Error('METALS_API_KEY is missing');

    const raw = await fetchWithRetries(process.env.API_KEY);
    const normalized = normalizeMetals(raw, slot);

    writeJson('metals-raw.json', raw);
    writeJson('metals.json', normalized);
    writeSuccessStatus(attemptedAt, slot, normalized.cacheUpdatedAt, normalized.marketUpdatedAt);
    appendOutput('fetch_success', 'true');
  } catch (error) {
    writeFailureStatus(attemptedAt, slot, error);
    console.error(`Metals fetch failed after bounded retries: ${error.message}`);
  }
}

main().catch(error => {
  const attemptedAt = new Date().toISOString();
  const slot = currentSlot();
  if (!slot.skip) writeFailureStatus(attemptedAt, slot, error);
  console.error(error);
  process.exitCode = 0;
});

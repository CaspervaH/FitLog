#!/usr/bin/env node
// FitLog HQ-WOD scraper: haalt crossfit.com/workout op, parst de dagelijkse
// WOD's en voegt ze samen in hq-wods.json (idempotent, oude data blijft).
// Gebruik:  node scripts/scrape-wods.mjs [--fixture <bestand>] [--out <pad>]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = resolve(ROOT, 'hq-wods.json');
const URL_CF = 'https://www.crossfit.com/workout/';

const args = process.argv.slice(2);
const fixtureIdx = args.indexOf('--fixture');
const outIdx = args.indexOf('--out');
const FIXTURE = fixtureIdx >= 0 ? args[fixtureIdx + 1] : null;
const OUT = outIdx >= 0 ? resolve(args[outIdx + 1]) : DEFAULT_OUT;

const WEEKDAYS_EN_NL = {
  monday: 'maandag', tuesday: 'dinsdag', wednesday: 'woensdag',
  thursday: 'donderdag', friday: 'vrijdag', saturday: 'zaterdag', sunday: 'zondag',
};

// Bewegingswoordenboek: langste eerst, zodat 'clean and jerk' niet als losse
// 'clean' wordt getagd en 'hang power clean' boven 'power clean' wint.
const MOVEMENT_PATTERNS = [
  'sumo deadlift high pull', 'hang power clean', 'hang power snatch', 'hang squat snatch',
  'clean and jerk', 'medicine-ball box step-over', 'lateral burpee box jump-over',
  'shuttle box jump-over', 'bar-facing burpee', 'wall-ball shot', 'wall walk',
  'wall ball', 'box jump-over', 'box step-over', 'box jump', 'rope climb',
  'handstand push-up', 'handstand walk', 'pike push-up', 'push-up', 'pull-up',
  'chest-to-bar pull-up', 'ring row', 'ring dip', 'muscle-up', 'double-under',
  'single-under', 'sit-up', 'back squat', 'front squat', 'overhead squat',
  'air squat', 'goblet squat', 'pistol', 'bench press', 'push press', 'push jerk',
  'split jerk', 'power clean', 'power snatch', 'squat clean', 'hang clean',
  'deadlift', 'kettlebell swing', 'thruster', 'lunge', 'run', 'row', 'burpee',
  'snatch', 'clean', 'jerk', 'shuttle run', 'bear crawl',
];

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&#8217;/g, "'")
    .replace(/&#8212;/g, '—')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<(h[1-6])[^>]*>/gi, '\n\n### ')
      .replace(/<\/(h[1-6])>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Detecteer score-type (zelfde vocabulair als de app: time/amrap/load/reps/other).
function detectType(body) {
  const lower = body.toLowerCase();
  if (/^\s*\*\*rest day/i.test(body) || /^\s*rest day/i.test(body)) return 'rest';
  if (/for load/.test(lower)) return 'load';
  if (/\b1-\d+-\d+-\d+-\d+\b/.test(lower) && /rep/.test(lower) && /post load/.test(lower)) return 'load';
  if (/as many (rounds|reps)?/.test(lower) || /\bamrap\b/.test(lower)) return 'amrap';
  if (/for time/.test(lower) || /post (total )?time/.test(lower)) return 'time';
  if (/post load/.test(lower)) return 'load';
  if (/post rep/.test(lower)) return 'reps';
  if (/every \d+ minutes?/.test(lower)) return 'time';
  return 'other';
}

// Knip de Rx-body los van coaching-/scaling-tekst.
export function cleanBody(rawBody) {
  const lines = rawBody.split('\n');
  const kept = [];
  for (const line of lines) {
    if (/^\*?\*?(Stimulus|Intermediate option|Beginner option|Resources|Find a gym|Compare to)/i.test(line)) break;
    if (/^Post .* to comments/i.test(line)) break;
    kept.push(line);
  }
  return kept.join('\n').replace(/\n{2,}/g, '\n').trim();
}

function extractMovements(text) {
  const found = new Set();
  for (const pat of MOVEMENT_PATTERNS) {
    const re = new RegExp('\\b' + pat.replace(/[-/]/g, '[-/]') + '(?:es|s)?\\b', 'i');
    if (re.test(text)) found.add(pat);
    if (pat === 'clean and jerk' && found.has('clean and jerk')) {
      found.delete('clean');
      found.delete('jerk');
    }
  }
  if (found.has('clean and jerk') || found.has('power clean') || found.has('hang power clean') || found.has('squat clean')) {
    found.delete('clean');
  }
  if (found.has('clean and jerk')) found.delete('jerk');
  if (found.has('hang power clean')) {
    found.delete('power clean');
    found.delete('clean');
  }
  if (found.has('hang power snatch') || found.has('hang squat snatch')) {
    found.delete('power snatch');
    found.delete('snatch');
  }
  return [...found];
}

function extractTimeDomain(body) {
  const m = body.match(/(\d+)\s*(?:-|\s)?minute/i) || body.match(/time cap:\s*(\d+)\s*minutes?/i);
  if (m) return m[1] + ' min';
  return null;
}

export function parseDays(text) {
  const headerRe = /(?:^|\n)#{0,6}\s*(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(\d{6})\s*(?=\n)/gi;
  const matches = [...text.matchAll(headerRe)];
  const days = new Map();
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const yy = m[2].slice(0, 2), mm = m[2].slice(2, 4), dd = m[2].slice(4, 6);
    const id = m[2];
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const rawBody = text.slice(start, end).trim();
    const body = cleanBody(rawBody);
    const rest = /^\s*\**rest day\**\s*$/im.test(rawBody);
    const nameMatch = rawBody.match(/^\s*\*\*(.+?)\*\*\s*\n/);
    const type = rest ? 'rest' : detectType(rawBody);
    const date = `20${yy}-${mm}-${dd}`;
    // Headers staan dubbel in de pagina; de laatste occurrence van een dag
    // heeft de volledige body tot de volgende dag, dus die overschrijft.
    days.set(id, {
      id,
      date,
      weekday: WEEKDAYS_EN_NL[m[1].toLowerCase()],
      name: rest ? null : (nameMatch ? nameMatch[1].trim() : null),
      type,
      text: rest ? 'Rest day' : body,
      movements: rest ? [] : extractMovements(body),
      timeDomain: rest ? null : extractTimeDomain(body),
      source: 'crossfit.com',
    });
  }
  return [...days.values()].sort((a, b) => a.date < b.date ? -1 : 1);
}

async function main() {
  let text;
  if (FIXTURE) {
    text = readFileSync(FIXTURE, 'utf8');
    console.log(`Fixture geladen: ${FIXTURE}`);
  } else {
    const res = await fetch(URL_CF, { headers: { 'user-agent': 'FitLog-WOD-updater/1.0' } });
    if (!res.ok) throw new Error(`crossfit.com gaf HTTP ${res.status}`);
    text = htmlToText(await res.text());
    console.log(`Opgehaald: ${URL_CF} (${text.length} tekens na conversie)`);
  }

  const parsed = parseDays(text);
  console.log(`Gevonden dagen: ${parsed.length}`);
  for (const d of parsed) {
    console.log(`  ${d.date} (${d.weekday}) type=${d.type} name=${d.name ?? '—'} movements=${d.movements.join(', ') || '—'}`);
  }

  let existing = { generated: null, wods: [] };
  if (existsSync(OUT)) {
    try {
      const cur = JSON.parse(readFileSync(OUT, 'utf8'));
      if (Array.isArray(cur.wods)) existing = cur;
    } catch { /* corrupt bestand: opnieuw opbouwen */ }
  }
  const byId = new Map(existing.wods.map(w => [w.id, w]));
  for (const d of parsed) byId.set(d.id, d);
  const merged = [...byId.values()].sort((a, b) => a.date < b.date ? -1 : 1);

  const out = { generated: new Date().toISOString(), wods: merged };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`Geschreven: ${OUT} (${merged.length} WOD's)`);
}

// Parse een enkele dagpagina (crossfit.com/workout/jjjj/mm/dd). De header
// op zo'n pagina is '### <code>' gevolgd door '### Workout of the Day'.
export function parseDayPage(text, code) {
  const re = new RegExp('###\\s+workout of the day\\s*\\n([\\s\\S]*?)(?=\\n### |$)', 'i');
  const m = text.match(re);
  if (!m) return null;
  const raw = m[1];
  if (/^\\s*\\*?\\*?rest day/i.test(raw)) return { id: code, type: 'rest', text: 'Rest day', movements: [], timeDomain: null };
  const body = cleanBody(raw);
  if (!body) return null;
  return { id: code, type: detectType(raw), text: body, movements: extractMovements(body), timeDomain: extractTimeDomain(body) };
}

// Alleen direct uitvoeren (niet bij import vanuit csv-to-fitlog.mjs).
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main().catch(e => { console.error(e); process.exit(1); });

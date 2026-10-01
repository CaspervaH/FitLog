#!/usr/bin/env node
// Zet een SugarWOD-achtige CSV-export om naar het fitlog-backupformaat.
// Gebruik: node csv-to-fitlog.mjs <input.csv> <output.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { cleanBody } from './scrape-wods.mjs';

const URL_CF_DAY = 'https://www.crossfit.com/workout/';

// Datumcodes (bv. '240924' of '241229 / 251229') verwijzen naar de HQ-WOD
// van crossfit.com van die datum. Haal de omschrijving op van de officiële
// dagpagina; gefaalde pogingen vallen stil terug op een lege tekst.

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('Gebruik: node csv-to-fitlog.mjs <input.csv> <output.json>');
  process.exit(1);
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ';') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1);
}

function toISODate(s) {
  const m = /^(\d{2})-(\d{2})-(\d{4})/.exec(s.trim());
  if (!m) throw new Error('Ongeldige datum: ' + s);
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function num(s) {
  return Number(String(s).trim().replace(',', '.'));
}

// "4m 11s" / "12m" / "20m" -> {min, sec}
function parseTime(s) {
  const t = s.trim();
  let m = /^(\d+)m(?:\s*(\d+)s?)?$/.exec(t) || /^(\d+):(\d+)$/.exec(t);
  if (m) return { min: Number(m[1]), sec: m[2] ? Number(m[2]) : 0 };
  m = /^(\d+)\s*s$/.exec(t);
  if (m) return { min: 0, sec: Number(m[1]) };
  return { min: 0, sec: 0 };
}

// "3 / 240" of "9 / 13" -> {rounds, reps}
function parseRoundsReps(s) {
  const parts = s.split('/').map(p => num(p));
  return { rounds: parts[0] || 0, reps: parts[1] || 0 };
}

// Score "45 kg" / "40kg" / "150 kg" -> kg
function parseKg(s) {
  return num(s.replace(/kg/i, '').trim());
}

// Repschema "3 x 55 kg" -> [{reps, kg}]
function parseRepSchema(s) {
  return s.split(',').map(part => {
    const m = /(\d+)\s*x\s*([\d.,]+)\s*kg/i.exec(part.trim());
    if (!m) return null;
    return { reps: Number(m[1]), kg: num(m[2]) };
  }).filter(Boolean);
}

const TYPE_MAP = {
  'tijd': 'time',
  'herhalingen': 'reps',
  'gewicht': 'load',
  'gewicht (sets vs reps)': 'lift',
  'rondes + herhalingen': 'amrap',
  'afstand': 'other',
};

let n = 0;
function uid() {
  n += 1;
  return 'imp-' + String(n).padStart(3, '0');
}

const rows = parseCsv(readFileSync(input, 'utf8'));
const header = rows.shift().map(h => h.trim().toLowerCase());
const idx = {};
for (const [i, h] of header.entries()) idx[h] = i;

// Omschrijvingen van bekende WOD's (benchmarks + Open); gebruikt om geïmporteerde
// resultaten zonder omschrijving alsnog van tekst te voorzien.
const WOD_TEXTS = {
  fran: '21-15-9 thrusters (\u2642 42,5 kg / \u2640 30 kg) & pull-ups',
  diane: '21-15-9 deadlifts (\u2642 100 kg / \u2640 70 kg) & handstand push-ups',
  grace: '30 clean & jerks (\u2642 60 kg / \u2640 43 kg)',
  andi: 'For time: 100 hang power snatches, 100 push presses, 100 sumo deadlift high pulls, 100 front squats (\u2640 20 kg / \u2642 30 kg)',
  topsy: 'AMRAP 25 min: 3 ring muscle-ups, 8 thrusters (\u2642 42,5 kg / \u2640 30 kg), 17-calorie roeien',
  christine: '3 rondes voor tijd: 500 m roeien, 12 deadlifts (lichaamsgewicht), 21 box jumps (\u2642 60 cm / \u2640 50 cm)',
  'open 20.1': '10 rondes voor tijd: 8 bar-facing burpees, 10 dumbbell snatches (\u2642 22,5 kg / \u2640 15 kg). Time cap: 15 min',
  'half open 20.1': 'Helft van Open 20.1: 5 rondes van 8 bar-facing burpees en 10 dumbbell snatches (\u2642 22,5 kg / \u2640 15 kg)',
  'open 22.3': 'Voor tijd: 21 pull-ups, 42 double-unders, 21 thrusters (\u2642 42,5 kg / \u2640 30 kg) \u00b7 18 chest-to-bar pull-ups, 36 double-unders, 18 thrusters (\u2642 52,5 kg / \u2640 35 kg) \u00b7 15 bar muscle-ups, 30 double-unders, 15 thrusters (\u2642 60 kg / \u2640 40 kg). Time cap: 12 min',
  'open 25.2': 'Herhaling van Open 22.3: 21 pull-ups, 42 double-unders, 21 thrusters (\u2642 42,5 kg / \u2640 30 kg) \u00b7 18 chest-to-bar pull-ups, 36 double-unders, 18 thrusters (\u2642 52,5 kg / \u2640 35 kg) \u00b7 15 bar muscle-ups, 30 double-unders, 15 thrusters (\u2642 60 kg / \u2640 40 kg). Time cap: 12 min',
  'open 22.3 / 25.2': 'Voor tijd: 21 pull-ups, 42 double-unders, 21 thrusters (\u2642 42,5 kg / \u2640 30 kg) \u00b7 18 chest-to-bar pull-ups, 36 double-unders, 18 thrusters (\u2642 52,5 kg / \u2640 35 kg) \u00b7 15 bar muscle-ups, 30 double-unders, 15 thrusters (\u2642 60 kg / \u2640 40 kg). Time cap: 12 min (22.3, in 2025 herhaald als 25.2)',
  'open 24.1': 'Voor tijd: 21-15-9 per arm \u2014 21 dumbbell snatches (arm 1), 21 lateral burpees over de dumbbell, 21 dumbbell snatches (arm 2), 21 lateral burpees; daarna 15\u2019s en 9\u2019s (\u2642 22,5 kg / \u2640 15 kg). Time cap: 15 min',
  'open workout 26.1': 'Voor tijd (piramide): 20 wall-ball shots, 18 box jump-overs, 30 wall-ball shots, 18 box jump-overs, 40 wall-ball shots, 18 medicine-ball box step-overs, 66 wall-ball shots, 18 medicine-ball box step-overs, 40 wall-ball shots, 18 box jump-overs, 30 wall-ball shots, 18 box jump-overs, 20 wall-ball shots (\u2642 9 kg / \u2640 6 kg, box \u2642 60 cm / \u2640 50 cm). Time cap: 12 min',
  'open workout 26.2': '3 rondes voor tijd, per ronde zwaardere gymnastiek: 80 ft dumbbell overhead walking lunges, 20 alternating dumbbell snatches (\u2642 22,5 kg / \u2640 15 kg), 20 pull-ups \u2192 ronde 2: 20 chest-to-bar pull-ups \u2192 ronde 3: 20 ring muscle-ups. Time cap: 15 min',
};
const knownWodText = name => WOD_TEXTS[String(name || '').trim().toLowerCase()] || '';

const dateCodeRE = /^(\d{6})(?:\s*\/\s*(\d{6}))?$/;

async function fetchHqWodText(code) {
  const yy = code.slice(0, 2), mm = code.slice(2, 4), dd = code.slice(4, 6);
  const url = `${URL_CF_DAY}20${yy}/${mm}/${dd}`;
  try {
    // JSON-endpoint van crossfit.com (zelfde als de site zelf gebruikt):
    // geeft { wods: { wodRaw, title } } voor elke historische datum.
    const res = await fetch(url, { headers: { 'user-agent': 'FitLog-WOD-updater/1.0', accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const raw = String((j.wods && j.wods.wodRaw) || '').replace(/\r\n/g, '\n').trim();
    if (!raw) return '';
    if (/rest day/i.test(raw.slice(0, 20))) return 'Rest day';
    // Markdown-links ([Box jumps](https://...)) strippen naar platte tekst;
    // **Naam**-markeringen naar de naam zelf.
    const plain = raw
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\s*\\?\n\s*\\?\n/g, '\n');
    return cleanBody(plain);
  } catch (e) {
    warnings.push(`Kon HQ-WOD ${code} niet ophalen: ${e.message}`);
    return '';
  }
}

const results = [];
const lifts = [];
const warnings = [];

const hqTextCache = new Map();
async function hqText(name){
  const m = dateCodeRE.exec(name);
  if (!m) return '';
  if (!hqTextCache.has(m[1])) hqTextCache.set(m[1], await fetchHqWodText(m[1]));
  return hqTextCache.get(m[1]);
}

for (const r of rows) {
  const date = toISODate(r[idx['datum']]);
  const name = (r[idx['workout']] || '').trim();
  if (!name) continue;
  const rawType = (r[idx['type']] || '').trim().toLowerCase();
  const scaled = (r[idx['rx/scaled']] || '').trim().toLowerCase() === 'scaled';
  const score = (r[idx['score']] || '').trim();
  const schema = (r[idx['repschema']] || '').trim();
  const notes = (r[idx['opmerkingen']] || '').trim();
  const type = TYPE_MAP[rawType];
  if (!type) { warnings.push(`Onbekend type "${rawType}" voor ${name} (${date})`); continue; }

  if (type === 'lift') {
    // Lifting-tab: kg x reps per oefening
    for (const set of parseRepSchema(schema)) {
      lifts.push({ id: uid(), date, lift: name.toLowerCase(), kg: set.kg, reps: set.reps, ...(notes ? { notes } : {}) });
    }
    if (!schema) warnings.push(`Leeg repschema voor lift ${name} (${date})`);
    continue;
  }

  const wodText = knownWodText(name) || await hqText(name);
  const res = { id: uid(), date, wodName: name, wodText, movements: [], type, timeDomain: '', scaled, notes };
  if (type === 'time') Object.assign(res, parseTime(score));
  else if (type === 'amrap') Object.assign(res, parseRoundsReps(score));
  else if (type === 'load') res.kg = parseKg(score);
  else if (type === 'reps') res.reps = parseKg(score.replace(/reps?/i, '').trim()) || 0;
  else res.txt = score;
  results.push(res);
}

// Herken paren: een datumcode-WOD (bv. '260921') en een benchmark-WOD met
// dezelfde score binnen 1 dag zijn dezelfde workout -> samenvoegen onder de naam.
const BENCHMARKS = new Set(['grace','fran','diane','christine','annie','karen','barbara','chelsea','cindy','elizabeth','linda','mary','nancy','selena','helena','kelly','jackie','isabel','ava','carol','chad','whitten','badger','severin','nate','daniel','josh','dt','randy','murph','eva','topsy','andi']);
const isDateCode = n => /^\d{2}\d{2}\d{2}(\/ ?\d{2}\d{2}\d{2})?$/.test(n);
const scoreKey = r => [r.type, r.min, r.sec, r.rounds, r.reps, r.kg, r.txt].join('|');
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
const merged = [];
const used = new Set();
for (const code of results.filter(r => isDateCode(r.wodName))) {
  const twin = results.find(r => !used.has(r.id) && !isDateCode(r.wodName)
    && BENCHMARKS.has(r.wodName.toLowerCase())
    && scoreKey(r) === scoreKey(code) && Math.abs(dayDiff(r.date, code.date)) <= 1);
  if (twin) {
    used.add(twin.id); used.add(code.id);
    merged.push({ ...code, wodName: twin.wodName, notes: [code.notes, twin.notes].filter(Boolean).join(' | ') });
    console.log('Samengevoegd: ' + code.wodName + ' + ' + twin.wodName + ' (' + code.date + ') -> ' + twin.wodName);
  }
}
const finalResults = results.filter(r => !used.has(r.id)).concat(merged)
  .sort((a, b) => (a.date < b.date ? 1 : -1));

const out = {
  app: 'fitlog',
  version: 1,
  exported: new Date().toISOString(),
  results: finalResults,
  lifts,
};
writeFileSync(output, JSON.stringify(out, null, 2) + '\n');
console.log(`results: ${finalResults.length}, lifts: ${lifts.length}`);
for (const w of warnings) console.log('WAARSCHUWING: ' + w);

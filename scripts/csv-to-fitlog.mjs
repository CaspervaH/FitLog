#!/usr/bin/env node
// Zet een SugarWOD-achtige CSV-export om naar het fitlog-backupformaat.
// Gebruik: node csv-to-fitlog.mjs <input.csv> <output.json>
import { readFileSync, writeFileSync } from 'node:fs';

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

const results = [];
const lifts = [];
const warnings = [];

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

  const res = { id: uid(), date, wodName: name, wodText: '', movements: [], type, timeDomain: '', scaled, notes };
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

# 🏋️ FitLog

CrossFit-logapp in één statisch HTML-bestand: bekijk de HQ-WOD van de dag, log je resultaat direct, en zie je PR's — geen account, geen backend, alles blijft in je browser (localStorage).

## Functies

- **📅 WOD (startpagina)** — weekdag + datum bovenin, ‹ › knoppen om dagen door te bladeren. De officiële WOD van crossfit.com wordt automatisch geladen (rustdagen meegerekend). Onderaan log je direct je resultaat: Rx'd/Scaled, minuten/reps/kg afhankelijk van het score-type, plus scaling-notities.
- **📊 Vergelijkbare WOD's** — WOD's zijn gestructureerd opgeslagen (bewegingen, type, tijdsdomein). Bij het openen van een WOD zie je welke vergelijkbare WOD's je eerder deed en wat je toen scoorde (% bewegingsoverlap).
- **🏆 PR-detectie** — automatisch beste score per WOD (snelste tijd, meeste rondes/reps of kilo's) met PR-melding bij opslaan.
- **Benchmark** — 30 klassieke benchmark-WOD's (The Girls & Heroes) met omschrijving en PR-overzicht.
- **Lifting** — log kg × reps per oefening; PR-tabel met zwaarste set, geschatte 1RM (Epley) en echte 1RM.
- **Automatische lift-herkenning** — bevat een WOD een lift-oefening (bv. "Push press 5-5-5-5-5", "Build to a 1-rep-max clean and jerk" of een "N sets for load"-blok), dan verschijnt die automatisch in het logformulier. Bij Rx'd worden het Rx-gewicht (uit de ♀/♂-regels, lb→kg omgerekend) plus de voorgeschreven reps en sets voorgevuld; bij Scaled vul je zelf gewicht, reps en sets in. Bij opslaan wordt de lift meegenomen in je lifting-log en PR-overzicht. Metcon-reps (bv. 30 clean and jerks in Grace) worden niet als lift-set gelogd.
- **WOD-log** — volledige historie met zoeken en export/import als JSON-backup.

## Gebruiken

Open `index.html` direct in je browser, of zet de repo aan op GitHub Pages:

1. Repo → **Settings → Pages**
2. Source: *Deploy from a branch* → `main` → `/ (root)`
3. De app is daarna bereikbaar op `https://caspervah.github.io/FitLog/`

## Automatische WOD-update

Een GitHub Action ([update-wods.yml](.github/workflows/update-wods.yml)) draait dagelijks om ~06:30 Nederlandse tijd, scraped crossfit.com/workout en commit de actuele WOD's naar `hq-wods.json`. De app laadt dat bestand bij het opstarten; er zit ook een ingebakken backlog in `index.html` zodat de app zonder het bestand toch werkbaar is.

Lokaal kan de scraper met `node scripts/scrape-wods.mjs` gedraaid worden (Node 18+ met `fetch`).

## Techniek

- Pure HTML/CSS/vanilla JS, één bestand, geen dependencies
- localStorage voor resultaten en lifts
- Scraper: Node.js-script, getest tegen de echte pagina-structuur van crossfit.com

## Back-compatibiliteit

De import in de WOD-log accepteert zowel het huidige fitlog-backupformaat als oudere platte exports (lijst van resultaten).

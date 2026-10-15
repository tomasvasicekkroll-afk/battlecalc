# Battlecalc

Warhammer 40k damage kalkulátor. Migrováno z Claude.ai artifactu na samostatný
Vite + React projekt.

## Stav migrace

- [x] Cíl 1: appka běží jako samostatný Vite projekt, mimo Claude.ai sandbox
- [x] Cíl 2: uživatelské účty + Supabase — přihlášení (magic link i email/heslo),
      data uložená per-uživatel v Supabase Postgres
- [ ] Cíl 3: komunitní knihovna jednotek

`window.storage` bylo nahrazeno vrstvou v [`src/lib/storage.js`](src/lib/storage.js)
se stejným API (`get`/`set`/`delete`/`list`), napojenou na Supabase (tabulka
`user_data`, viz [`supabase/schema.sql`](supabase/schema.sql)) — data jsou vázaná
na přihlášeného uživatele a chráněná row-level security politikami.

Appka je za přihlašovací branou ([`src/AuthGate.jsx`](src/AuthGate.jsx)) — bez
přihlášení se nezobrazí. Vyžaduje `.env.local` s `VITE_SUPABASE_URL` a
`VITE_SUPABASE_ANON_KEY` (viz `.env.example`); na Vercelu jsou nastavené jako
Environment Variables projektu.

## Funkce

- Přesný výpočet očekávaného poškození + **Monte Carlo simulace** (`src/lib/montecarlo.js`):
  hází každou kostkou zvlášť a přiděluje zranění po modelech.
- **Edice pravidel 10./11.** (Nastavení; `src/lib/rules.js`). Pravidla 11. edice jsou ze sekundárních
  shrnutí — ověř je v oficiální příručce, položky označené `verify` jsou nejméně jisté.
- Import z New Recruit / BattleScribe: `.rosz`, `.ros`, JSON (`src/lib/roster.js`), ukázková armáda pro první start.
- Deska s terénem, tokeny a **line of sight** (`src/lib/los.js`).
- **Sdílení mezi lidmi** (`supabase/shares.sql`): soukromý odkaz na vybrané armády nebo celou knihovnu (platí 30 dní, jde zrušit,
  nikdo nemůže procházet cizí sdílení), nebo soubor. Žádná veřejná knihovna.
- **PWA**: instalovatelná, funguje offline (`public/sw.js`, data se cachují a zápisy se odešlou po připojení).

## Nastavení Supabase

V SQL editoru spusť postupně `supabase/schema.sql` a `supabase/shares.sql` (sdílení odkazem).

## Testy

```bash
npm test
```

## Lokální vývoj

Vyžaduje Node.js (LTS, 18+). Pak:

```bash
npm install
npm run dev
```

Otevře se na `http://localhost:5173`.

## Build pro nasazení

```bash
npm run build
```

Vygeneruje statické soubory do `dist/`.

## Nasazení na Vercel/Netlify bez lokálního Node

Není potřeba mít Node nainstalovaný lokálně — build proběhne na jejich serverech:

1. Nahraj tenhle repozitář na GitHub (nebo GitLab).
2. Na [vercel.com](https://vercel.com) nebo [netlify.com](https://netlify.com) zvol
   "Import Project" / "Add new site from Git" a vyber repo.
3. Framework preset: **Vite** (obvykle se detekuje automaticky).
   - Build command: `npm run build`
   - Output directory: `dist`
4. Deploy.

## Struktura

- `src/App.jsx` — celá appka (zatím jeden velký soubor)
- `src/lib/storage.js` — úložná vrstva nad Supabase (chyby se vyhazují; klíč, který se nepodařilo načíst, se nepřepisuje)
- `src/AuthGate.jsx`, `src/lib/auth.js` — přihlášení
- `src/ErrorBoundary.jsx` — záchytná síť proti bílé obrazovce při chybě vykreslení
- `vercel.json` — bezpečnostní hlavičky (CSP, HSTS, …); při přidání externí domény je potřeba upravit CSP
- `src/main.jsx` — vstupní bod

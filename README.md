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

- `src/App.jsx` — celá appka (zatím jeden soubor, jako v původním artifactu)
- `src/lib/storage.js` — abstraktní úložná vrstva (dnes localStorage, zítra Supabase)
- `src/main.jsx` — vstupní bod

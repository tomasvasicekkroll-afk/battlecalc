# Battlecalc

Warhammer 40k damage kalkulátor. Migrováno z Claude.ai artifactu na samostatný
Vite + React projekt.

## Stav migrace

- [x] Cíl 1: appka běží jako samostatný Vite projekt, mimo Claude.ai sandbox
- [ ] Cíl 2: uživatelské účty + Supabase (zatím data v `localStorage` prohlížeče)
- [ ] Cíl 3: komunitní knihovna jednotek

`window.storage` bylo nahrazeno vrstvou v [`src/lib/storage.js`](src/lib/storage.js)
se stejným API (`get`/`set`/`delete`/`list`), zatím napojenou na `localStorage`.
Až budou hotové Supabase účty, mění se jen tenhle jeden soubor.

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

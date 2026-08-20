# BATTLECALC — brief pro Claude Code

## Co appka je
Warhammer 40k damage kalkulátor (React, jeden soubor `wh40k-kalkulacka.jsx`,
~4000 řádků). Zatím žije jako Claude.ai artifact — ukládá data přes
`window.storage` (funguje jen uvnitř Claude.ai).

## Co appka umí (hotovo)
- Import armád z New Recruit / BattleScribe JSON exportu (i prostý textový export)
- Knihovna jednotek s ruční editací, oblíbenými, exportem/importem mezi uživateli
- Kalkulačka: výběr útočníka (podle frakce/armády) → úprava (bonusy na dálku/blízko
  zvlášť, volba profilu zbraně typu Sweep/Strike, Melta toggle) → výběr obránce →
  výsledek
- Detekce z importu: Lethal Hits, Sustained Hits, Twin-linked, Melta X,
  Feel No Pain (i jako samostatné "rules", ne jen "profiles"), redukce damage
  (např. C'tan)
- Šance počítané binomickým rozdělením (ne jen průměr), rozdělení na dálku/blízko
- Historie výpočtů (rozklikovatelná, kopírovatelná, editovatelná — dá se znovu
  otevřít a upravit)
- Cheat sheet pro tisk: matice útočník × cíl s malými SVG koláčovými grafy
  (Základ vs. S bonusy), tiskově spolehlivé (ne CSS gradient)
- Vlastní confirm/alert dialogy (native `window.confirm/alert` je v sandboxu
  Claude.ai nespolehlivé — nahrazeno vlastním overlay komponentem)

## Tři cíle dalšího vývoje (v tomhle pořadí)
1. **Nasadit appku na vlastní web** (Vercel/Netlify, Vite build)
2. **Uživatelské účty + databáze** (doporučeno: Supabase — Auth + Postgres,
   zdarma tarif stačí) — nahradit `window.storage` voláními do Supabase,
   svázat knihovnu/armády/historii s uživatelem
3. **Komunitní knihovna jednotek** — uživatelé mohou sdílet SVOJE naimportované
   jednotky s ostatními (ne kompletní oficiální GW databáze — to je copyright
   problém, nedělat)

## Důležitá omezení / co NEdělat
- NEnahrávat/nedistribuovat kompletní oficiální GW datasheety jako "master"
  databázi — jen to, co si každý uživatel sám naimportuje/sdílí ze svého
  New Recruit exportu.
- Zachovat vlastní confirm/alert dialogy (ne native browser dialogy) — uvnitř
  webové appky už `window.confirm`/`alert` fungovat budou, ale je to zbytečné
  měnit zpět, současné řešení je hezčí a konzistentní se stylem appky.

## Technické detaily k migraci ze `window.storage`
V souboru je `window.storage.get/set/delete/list(key, shared)` používané na
těchto místech (najdi `window.storage` v souboru): knihovna jednotek
(`library_v2`), armády (`armies_v1`), historie výpočtů (`history_v1`).
Nejčistší cesta: vytvořit malou abstraktní vrstvu (`storage.ts`) se stejným
API, uvnitř použít Supabase klienta místo `window.storage`, a v komponentě
jen přepsat import.

## Soubor
Přiložený `wh40k-kalkulacka.jsx` — nahraď v novém projektu, případně rozděl
na menší komponenty/soubory podle potřeby.

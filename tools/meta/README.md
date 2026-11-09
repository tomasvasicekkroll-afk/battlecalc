# Refreshing the tournament-meta data ("Stavba armády" and "Ideální list")

`src/data/metaRaw.js` holds the raw 4-1-or-better lists of 16+ player events from
https://listhammer.info (11th edition) for the last ~62 days, one compact row per list. The app
(`src/data/metaLogic.js`) derives everything from it at runtime:
- the 30-day detachment groups of the "Stavba armády" view (lists newer than capturedAt - 30 days),
- the "Ideální list" builder (faction + disposition + detachment, whole 62 days).

It does not update itself; redo it when it gets old (the view shows the period it covers).

How it is made (done in the Claude Code browser pane, the site has no export):

1. Open a faction page on listhammer.info in the built-in browser (`preview_start` with `url`).
2. Paste `listhammer-scrape.js` into one `javascript_tool` call after `window.__DAYS = 62;`
   (the file reads `window.__DAYS`, default 30). It installs `window.__LH` and `window.__OUT`.
3. For each 40k faction link (the first 28 of `__LH.factions()`, up to World Eaters) run
   `r = await __LH.runFaction(href); r.name = name; __OUT[href] = r;` in a background loop and poll
   (tool calls time out after 45 s; ~1 minute per faction, 30-40 minutes in all). `runFaction`
   switches the page to "Last 4 Weeks", opens the first list modal, walks it with Next (newest
   first) and stops after 6 lists older than the window. Lists not in English or without a
   readable datasheet text are skipped.
4. Return `"JSONSTART" + JSON.stringify(__LH.exportRaw(Object.keys(__OUT))) + "JSONEND"`; the tool
   saves the long result to a file and prints its path.
5. In `tools/meta`: `python export_raw_to_json.py <that file>` then
   `python build_raw.py raw_export.json 62` (rewrites `src/data/metaRaw.js`). Do not commit
   `raw_export.json`. Run `npm run build`, commit `src/data/metaRaw.js`, push.

## Matchup data ("Týmovka: kdo proti komu")

`src/data/matchData.js` holds (1) the site's own "Matchups" table of every faction for "Last 4 Weeks"
(all players; the faction page cannot select "Since Dataslate", it ignores that option) and
(2) round-by-round results (opponent faction, win/loss) of the 4-1-or-better lists of the last
~92 days, with the player's disposition. `src/data/matchLogic.js` turns it into pair statistics;
`src/TeamPlanner.jsx` is the UI.

Refresh: paste `listhammer-matchups.js` into one `javascript_tool` call on a listhammer.info page,
run `__MU.runFaction(href)` for the first 28 faction links in a background loop (name it into
`__MU_OUT[href]`, ~1.5 hours), return `"JSONSTART" + JSON.stringify(__MU.exportAll()) + "JSONEND"`
and run `python build_matchups.py <saved tool output file>` in `tools/meta`.

# Refreshing the tournament-meta data ("Stavba armády")

`src/data/metaListsAuto.js` is a snapshot of the last 30 days of 4-1-or-better lists from
https://listhammer.info (11th edition). It does not update itself; redo it when it gets old
(Stavba shows the period it covers).

How it was made (done in the Claude Code browser pane, the site has no export):

1. Open a faction page on listhammer.info, e.g. `/factions/grey-knights`.
2. Click "Switch to Last 4 Weeks" (win rates then cover the same period).
3. For each 40k faction: click the first "View … army list" button; the modal has Previous / Next.
   Walk through it with Next, keep the modal text of each list, stop after ~6 lists older than
   30 days (the list is newest first). The list text has the sections ATTACHED UNITS, CHARACTERS,
   BATTLELINE, DEDICATED TRANSPORTS, OTHER DATASHEETS, ALLIED UNITS and lines like
   `Purifier Squad204 points` (note: "points" can be capital P in some lists) and
   `Enhancement(s): X`. Lists not in English or without that text are skipped.
4. Group the lists by their detachment combination (header lines between the faction name and
   "View"), per group compute: n, dispositions, average units, average result, average points per
   section, per datasheet (% of lists, median copies, max copies, average points, most common
   section) and enhancement counts. Exact groups need n >= 3, `any:<detachment>` groups n >= 2.
5. Export the result as one JSON `{ "/factions/<slug>": { source, capturedAt, period, siteStats,
   listsSeen, listsUsed, groups } }`, run `export_to_json.py <saved tool output>` and then
   `build_meta.py <json>` (run it from `tools/meta`) to rewrite `src/data/metaListsAuto.js`.

// Disposition vs disposition win rates (all players), from the "Disposition Win Rates" table of
// listhammer.info/stats (click a disposition to see its rate against each other one; mirrors left out).
// Captured 2026-11-09. vs[A][B] = [A's win rate % against B, games]; overall[A] = [win rate %, games].
// "ds" = since the Dataslate (30 Sep 2026), "4w" = last 4 weeks.
export const DISP_DATA = {
  capturedAt: "2026-11-09",
  windows: {
    ds: {
      label: "od Dataslate (30. 9.)",
      overall: { "Purge the Foe": [51, 4581], "Take and Hold": [50.2, 5781], "Priority Assets": [49.7, 4834], Reconnaissance: [49.9, 2752], Disruption: [46.3, 1102] },
      vs: {
        Disruption: { "Priority Assets": [41.4, 302], "Purge the Foe": [50.9, 285], Reconnaissance: [47.4, 133], "Take and Hold": [46.3, 382] },
        "Priority Assets": { Disruption: [58.6, 302], "Purge the Foe": [49, 1458], Reconnaissance: [46.2, 812], "Take and Hold": [50.2, 2262] },
        "Purge the Foe": { Disruption: [49.1, 285], "Priority Assets": [51, 1458], Reconnaissance: [52.7, 754], "Take and Hold": [50.7, 2084] },
        Reconnaissance: { Disruption: [52.6, 133], "Priority Assets": [53.8, 812], "Purge the Foe": [47.4, 754], "Take and Hold": [48.3, 1053] },
        "Take and Hold": { Disruption: [53.7, 382], "Priority Assets": [49.8, 2262], "Purge the Foe": [49.3, 2084], Reconnaissance: [51.7, 1053] },
      },
    },
    "4w": {
      label: "poslední 4 týdny",
      overall: { "Purge the Foe": [50.8, 3572], "Take and Hold": [50.1, 4505], "Priority Assets": [50.2, 3802], Reconnaissance: [49.5, 2185], Disruption: [46.2, 796] },
      vs: {
        Disruption: { "Priority Assets": [40.3, 226], "Purge the Foe": [48.5, 204], Reconnaissance: [48.5, 99], "Take and Hold": [48.7, 267] },
        "Priority Assets": { Disruption: [59.7, 226], "Purge the Foe": [48.5, 1136], Reconnaissance: [47.5, 653], "Take and Hold": [51, 1787] },
        "Purge the Foe": { Disruption: [51.5, 204], "Priority Assets": [51.5, 1136], Reconnaissance: [53.5, 607], "Take and Hold": [49.3, 1625] },
        Reconnaissance: { Disruption: [51.5, 99], "Priority Assets": [52.5, 653], "Purge the Foe": [46.5, 607], "Take and Hold": [49, 826] },
        "Take and Hold": { Disruption: [51.3, 267], "Priority Assets": [49, 1787], "Purge the Foe": [50.7, 1625], Reconnaissance: [51, 826] },
      },
    },
  },
};

import React, { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef, useId } from "react";
import {
  Lock,
  Unlock,
  RotateCw,
  ZoomIn,
  ZoomOut,
  Swords,
  Shield,
  Plus,
  Trash2,
  Pencil,
  ChevronDown,
  ChevronRight,
  Save,
  Percent,
  Upload,
  AlertTriangle,
  Crosshair,
  Sword,
  Star,
  FolderPlus,
  Menu,
  Settings,
  Home,
  Search,
  Folder,
  Clock,
  List,
  ArrowLeft,
  Swords as SwordsAlt,
  Maximize2,
  Minimize2,
  HelpCircle,
  LayoutGrid,
  ArrowLeftRight,
  Map as MapIcon,
  Copy,
} from "lucide-react";
import { storage } from "./lib/storage";
import { supabase } from "./lib/supabaseClient";

const REROLL_OPTIONS = [
  { value: "none", label: "Žádný" },
  { value: "ones", label: "Jedničky" },
  { value: "all", label: "Vše (neúspěšné)" },
];

const WEAPON_TYPE_OPTIONS = [
  { value: "ranged", label: "Na dálku" },
  { value: "melee", label: "Na blízko" },
];

// Shared -3..+3 modifier dropdown options. Positive = better for the
// attacker (lower target number to hit/wound), negative = worse — matches
// how hitMod/woundMod are subtracted from the target number in computeWeapon.
const MOD_OPTIONS_3 = [-3, -2, -1, 0, 1, 2, 3].map((n) => ({ value: String(n), label: n > 0 ? `+${n}` : String(n) }));


// Deployment-zone shapes for the battlefield board — generic geometric
// patterns (opposite edges, opposite corners, offset diagonal bands, one big
// zone + one small pocket, two whole-board triangles, opposite wedges around
// a center no-man's-land circle), not a redraw of any official GW mission map
// and not tied to any named mission/disposition. Picked purely by its little
// two-tone color preview, not by a label. Each entry only defines `mineClip`
// — `theirsClip` is always derived from it by mirrorClipPathDiagonally (a
// 180° rotation through the board's center), the exact same rule the custom
// "Moje zóna" tools (drawing, numeric rectangles, saved slots) use for their
// own "Zóna protihráče" — so a preset layout is just a built-in starting
// point for the same one-sided-zone system, not a separate mechanism.

// Builds a clip-path polygon approximating a circular sector (a "pie slice",
// optionally with a smaller inner radius cut out for the "center-wedge"
// layout below) as a fan of straight-line points. Computed in real inches
// against a reference board size and converted to percent, same convention
// as the rest of the board's coordinate math, so the arc reads as a true
// circle on the default board size rather than whatever ellipse the raw
// percentages would stretch into.
function sectorPolygon(cxIn, cyIn, rInnerIn, rOuterIn, angleStartDeg, angleEndDeg, boardWIn, boardHIn, steps = 16) {
  const toPct = (xIn, yIn) => `${((xIn / boardWIn) * 100).toFixed(2)}% ${((yIn / boardHIn) * 100).toFixed(2)}%`;
  const arcPoint = (r, deg) => {
    const rad = (deg * Math.PI) / 180;
    return toPct(cxIn + r * Math.cos(rad), cyIn + r * Math.sin(rad));
  };
  const pts = [];
  for (let i = 0; i <= steps; i++) pts.push(arcPoint(rOuterIn, angleStartDeg + ((angleEndDeg - angleStartDeg) * i) / steps));
  for (let i = steps; i >= 0; i--) pts.push(arcPoint(rInnerIn, angleStartDeg + ((angleEndDeg - angleStartDeg) * i) / steps));
  return `polygon(${pts.join(", ")})`;
}

// 180°-rotates any "polygon(x% y%, ...)" clip-path string through the
// board's center (each point (x,y) -> (100-x, 100-y)) — the generic version
// of mirrorRectDiagonally/mirrorPointsDiagonally below, usable on a plain
// string instead of a rect or a points array. Used both to derive every
// DEPLOYMENT_LAYOUTS' theirsClip from its mineClip, and (inside the
// component) to derive a user-saved layout's theirsClip the same way.
function mirrorClipPathDiagonally(clip) {
  const inner = clip.slice(clip.indexOf("(") + 1, clip.lastIndexOf(")"));
  const mirrored = inner
    .split(",")
    .map((pair) => {
      const [xStr, yStr] = pair.trim().split(/\s+/);
      return `${100 - parseFloat(xStr)}% ${100 - parseFloat(yStr)}%`;
    })
    .join(", ");
  return `polygon(${mirrored})`;
}
// Same 180° mirror, but for a layout's mineClip field, which (per
// asClipArray above) can be either a single clip-path string or an array of
// them — mirrors each one and preserves whichever shape it was given.
const mirrorLayoutClip = (value) => (Array.isArray(value) ? value.map(mirrorClipPathDiagonally) : mirrorClipPathDiagonally(value));

// Converts a flat array of {x,y} percent points (as produced by a freehand
// zone draw) into a single clip-path polygon string.
const pointsToClipPath = (points) => `polygon(${points.map((p) => `${p.x}% ${p.y}%`).join(", ")})`;

// Resolves what a side's deployment zone should actually render as: a
// board.customZones[side] override — either a flat {x,y} points array (a
// freehand draw) or an array of clip-path strings (the numeric-rectangle
// tool, or a loaded layout) — normalized to always an array of clip-path
// strings; or, when there's no override, the currently selected layout's own
// mineClip/theirsClip (itself a string or an array, see asClipArray). One
// shared function so the board's render and "save the current zone as a
// layout" always agree on what "the current zone" is.
function resolveZoneClips(value, fallback) {
  if (Array.isArray(value) && value.length > 0) return typeof value[0] === "string" ? value : [pointsToClipPath(value)];
  return asClipArray(fallback);
}

// No built-in preset shapes any more — "Rozložení výsadku" is now purely
// user-defined (see customLayouts in the component). DEPLOYMENT_LAYOUTS
// stays as an (empty) array rather than being removed outright, since a
// couple of spots use its .length/.map as "how many of allLayouts are
// built-in" — keeping it means those don't need special-casing for zero.
const DEPLOYMENT_LAYOUTS = [];

// A plain placeholder shape (a shallow band along one edge) used only to
// seed the 5 base layout slots below and as a last-resort fallback if
// someone deletes every saved layout — meant to be immediately overwritten
// via "Uložit změny", not a real deployment shape of its own.
const DEFAULT_LAYOUT_CLIP = "polygon(0% 80%, 100% 80%, 100% 100%, 0% 100%)";
// The 5 numbered "base" layouts a fresh board starts with — plain
// placeholders (see DEFAULT_LAYOUT_CLIP) that the person fills in themselves
// with the drawing/numeric/triangle/sector tools, then builds further named
// variants off of via "Uložit jako rozložení". Used as customLayouts' own
// initial state, so it only ever applies before anything's been saved for
// this account — once real data loads from storage it fully replaces this.
const DEFAULT_LAYOUT_SLOTS = ["1", "2", "3", "4", "5"].map((n) => ({ id: n, name: n, mineClip: [DEFAULT_LAYOUT_CLIP] }));

// "Medium rectangle full 2".."11": one 6 x 4" landscape podložka carrying a
// hollow green T-shaped wall outline (a long hollow bar along the top with a
// shorter hollow block hanging from its middle, one open T-shaped hollow
// inside), placed at different default tilts. Proportions measured off the
// "full 2" reference; the tilts of the others are read off small thumbnails.
const MEDIUM_FULL_PARTS = [
  { leftPct: 17.2, topPct: 20.6, widthPct: 70.3, heightPct: 8.8, bg: "#3f7a3f" },
  { leftPct: 17.2, topPct: 29.4, widthPct: 6.2, heightPct: 22.1, bg: "#3f7a3f" },
  { leftPct: 81.2, topPct: 29.4, widthPct: 6.3, heightPct: 22.1, bg: "#3f7a3f" },
  { leftPct: 17.2, topPct: 44.1, widthPct: 18.8, heightPct: 7.4, bg: "#3f7a3f" },
  { leftPct: 67, topPct: 44.1, widthPct: 20.5, heightPct: 7.4, bg: "#3f7a3f" },
  { leftPct: 31, topPct: 51.5, widthPct: 5, heightPct: 22, bg: "#3f7a3f" },
  { leftPct: 67, topPct: 51.5, widthPct: 5, heightPct: 22, bg: "#3f7a3f" },
  { leftPct: 31, topPct: 64.7, widthPct: 41, heightPct: 8.8, bg: "#3f7a3f" },
];
const mediumFullShape = (n, deg) => ({
  id: `h-blok-${n}`,
  label: `Medium rectangle full ${n}`,
  layer: "terrain",
  multiCombo: true,
  widthIn: 6,
  heightIn: 4,
  defaultRotationDeg: deg,
  bg: "rgba(160,150,120,0.5)",
  border: "1px solid rgba(210,200,170,0.7)",
  radius: 3,
  parts: MEDIUM_FULL_PARTS,
});
// "Medium rectangle open 2".."12": same 6 x 4" podložka and two orange
// L-brackets in opposite corners as "open 1" (arms ~29% x 70% top-left,
// ~28% x 68% bottom-right), at different default tilts.
const mediumOpenShape = (n, deg) => ({
  id: `h-blok-open-${n}`,
  label: `Medium rectangle open ${n}`,
  layer: "terrain",
  multiCombo: true,
  widthIn: 6,
  heightIn: 4,
  defaultRotationDeg: deg,
  bg: "rgba(160,150,120,0.5)",
  border: "1px solid rgba(210,200,170,0.7)",
  radius: 3,
  parts: [
    { leftPct: 0, topPct: 0, widthPct: 29, heightPct: 12.5, bg: "#d98b3a" },
    { leftPct: 0, topPct: 0, widthPct: 8.3, heightPct: 70, bg: "#d98b3a" },
    { leftPct: 72, topPct: 87.5, widthPct: 28, heightPct: 12.5, bg: "#d98b3a" },
    { leftPct: 91.7, topPct: 32, widthPct: 8.3, heightPct: 68, bg: "#d98b3a" },
  ],
});
// "Long line 1".."6": a 10 x 2" podložka (Long line size) carrying a hollow
// green rectangular frame that nearly fills it (thick long bars, thin end
// caps, one long slot inside), at different default tilts. Frame
// proportions measured off the "Long line 1" reference; tilts of 2-6 read
// off small thumbnails.
const longLineFrameShape = (n, deg) => ({
  id: `long-line-${n}`,
  label: `Short line full ${n}`,
  layer: "terrain",
  multiCombo: true,
  widthIn: 6,
  heightIn: 2,
  defaultRotationDeg: deg,
  bg: "rgba(160,150,120,0.5)",
  border: "1px solid rgba(210,200,170,0.7)",
  radius: 3,
  parts: [
    { leftPct: 2, topPct: 4, widthPct: 96, heightPct: 30, bg: "#3f7a3f" },
    { leftPct: 2, topPct: 66, widthPct: 96, heightPct: 30, bg: "#3f7a3f" },
    { leftPct: 2, topPct: 4, widthPct: 5, heightPct: 92, bg: "#3f7a3f" },
    { leftPct: 93, topPct: 4, widthPct: 5, heightPct: 92, bg: "#3f7a3f" },
  ],
});

// Terrain "stavebnice" (building blocks) for the board — generic, original
// shapes (not traced from any terrain kit or official layout) the person
// drags onto their own board to sketch their actual table. Default sizes
// are just reasonable starting points; width/height are freely editable
// per piece once placed.
// `layer` decides stacking order on the board: "base" pieces (a plinth/mat a
// terrain piece stands on) always render underneath "terrain" pieces,
// regardless of the order either were placed in — see the board.terrain
// render, which sorts base-layer pieces first.
const TERRAIN_SHAPES = [
  { id: "ruin", label: "Ruina", layer: "terrain", widthIn: 8, heightIn: 5, bg: "#5c5c52", border: "2px dashed #8f8f7e", radius: 4 },
  // "T obrys" = the hollow green T-shaped wall outline of the "Medium
  // rectangle full" modules WITHOUT a podložka (transparent, no border), for
  // layouts where the ruin overlaps the edge of other plates.
  {
    id: "t-bare",
    label: "T obrys (bez podložky)",
    layer: "terrain",
    multiCombo: true,
    bare: true,
    widthIn: 6,
    heightIn: 4,
    bg: "transparent",
    border: "none",
    radius: 0,
    parts: [
      { leftPct: 17.2, topPct: 20.6, widthPct: 70.3, heightPct: 8.8, bg: "#3f7a3f" },
      { leftPct: 17.2, topPct: 29.4, widthPct: 6.2, heightPct: 22.1, bg: "#3f7a3f" },
      { leftPct: 81.2, topPct: 29.4, widthPct: 6.3, heightPct: 22.1, bg: "#3f7a3f" },
      { leftPct: 17.2, topPct: 44.1, widthPct: 18.8, heightPct: 7.4, bg: "#3f7a3f" },
      { leftPct: 67, topPct: 44.1, widthPct: 20.5, heightPct: 7.4, bg: "#3f7a3f" },
      { leftPct: 31, topPct: 51.5, widthPct: 5, heightPct: 22, bg: "#3f7a3f" },
      { leftPct: 67, topPct: 51.5, widthPct: 5, heightPct: 22, bg: "#3f7a3f" },
      { leftPct: 31, topPct: 64.7, widthPct: 41, heightPct: 8.8, bg: "#3f7a3f" },
    ],
  },
  // Objective markers: ~40mm (1.6") round tokens with our own plain geometric
  // glyphs — a coloured square (home objective, red/blue side), a gold ring
  // (centre) and a teal diamond (expansion) — to mark objectives on a map.
  {
    id: "obj-home-red",
    label: "Objektiv domácí červený",
    layer: "terrain",
    multiCombo: true,
    widthIn: 1.6,
    heightIn: 1.6,
    bg: "rgba(16,20,28,0.92)",
    border: "2px solid #c0392b",
    radius: "50%",
    parts: [{ leftPct: 30, topPct: 30, widthPct: 40, heightPct: 40, bg: "#c0392b" }],
  },
  {
    id: "obj-home-blue",
    label: "Objektiv domácí modrý",
    layer: "terrain",
    multiCombo: true,
    widthIn: 1.6,
    heightIn: 1.6,
    bg: "rgba(16,20,28,0.92)",
    border: "2px solid #3b82c4",
    radius: "50%",
    parts: [{ leftPct: 30, topPct: 30, widthPct: 40, heightPct: 40, bg: "#3b82c4" }],
  },
  {
    id: "obj-center",
    label: "Objektiv střed",
    layer: "terrain",
    multiCombo: true,
    widthIn: 1.6,
    heightIn: 1.6,
    bg: "rgba(16,20,28,0.92)",
    border: "2px solid #e0c34a",
    radius: "50%",
    parts: [
      { leftPct: 24, topPct: 24, widthPct: 52, heightPct: 52, bg: "#e0c34a", radius: "50%" },
      { leftPct: 38, topPct: 38, widthPct: 24, heightPct: 24, bg: "rgb(16,20,28)", radius: "50%" },
    ],
  },
  {
    id: "obj-expansion",
    label: "Objektiv expanze",
    layer: "terrain",
    multiCombo: true,
    widthIn: 1.6,
    heightIn: 1.6,
    bg: "rgba(16,20,28,0.92)",
    border: "2px solid #3fa7a0",
    radius: "50%",
    parts: [{ leftPct: 28, topPct: 28, widthPct: 44, heightPct: 44, bg: "#3fa7a0", rotationDeg: 45 }],
  },
  // "Long line" = a terrain feature on a 10 x 2" podložka: a long barricade
  // — a horizontal bar with three crossbars poking out top and bottom, drawn
  // as one clip-path polygon. Combo, so the podložka and the barricade scale
  // together in proportion when the piece is resized.
  {
    id: "long-line",
    label: "Short line full",
    layer: "terrain",
    combo: true,
    widthIn: 6,
    heightIn: 2,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    terrainWidthIn: 5.04,
    terrainHeightIn: 1.3,
    terrainBg: "#3f7a3f",
    terrainBorder: "none",
    terrainRadius: 0,
    terrainClipPath:
      "polygon(0% 30%, 18.5% 30%, 18.5% 0%, 25.5% 0%, 25.5% 30%, 46.5% 30%, 46.5% 0%, 53.5% 0%, 53.5% 30%, 74.5% 30%, 74.5% 0%, 81.5% 0%, 81.5% 30%, 100% 30%, 100% 70%, 81.5% 70%, 81.5% 100%, 74.5% 100%, 74.5% 70%, 53.5% 70%, 53.5% 100%, 46.5% 100%, 46.5% 70%, 25.5% 70%, 25.5% 100%, 18.5% 100%, 18.5% 70%, 0% 70%)",
  },
  // "Long line 1".."6" — see longLineFrameShape above.
  ...[[1, 58], [2, 0], [3, 90], [4, -40], [5, -25], [6, -32]].map(([n, deg]) => longLineFrameShape(n, deg)),
  // "Short line" = a 6 x 2" podložka with a plain yellow rectangle on it (no
  // crossbars). Combo, scales together.
  {
    id: "short-line",
    label: "Short line",
    layer: "terrain",
    combo: true,
    widthIn: 6,
    heightIn: 2,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    terrainWidthIn: 5,
    terrainHeightIn: 1,
    terrainBg: "#d4bf3a",
    terrainBorder: "none",
    terrainRadius: 0,
  },
  // "Short line 1" = a 6 x 2" podložka with a single golden bar down the
  // middle (~60% of the length), tilted -22° by default. Estimated.
  {
    id: "short-line-1",
    label: "Short line 1",
    layer: "terrain",
    multiCombo: true,
    widthIn: 6,
    heightIn: 2,
    defaultRotationDeg: -22,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 20, topPct: 40, widthPct: 60, heightPct: 20, bg: "#d9a32a" },
    ],
  },
  // "Short line 2" = like "Short line 1": a 6 x 2" podložka with a single
  // golden bar (~76% of the length, a bit thicker), tilted +28° by default
  // (descending to the right).
  // Estimated.
  {
    id: "short-line-2",
    label: "Short line 2",
    layer: "terrain",
    multiCombo: true,
    widthIn: 6,
    heightIn: 2,
    defaultRotationDeg: 28,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 12, topPct: 36, widthPct: 76, heightPct: 28, bg: "#d9a32a" },
    ],
  },
  // "Short line 3".."6" = like "Short line 1/2": a 6 x 2" podložka with a
  // single golden bar, differing only in default tilt (3: 0°, 4: +50°,
  // 5: 90°, 6: +15°) and small bar offsets. Estimated.
  {
    id: "short-line-3",
    label: "Short line 3",
    layer: "terrain",
    multiCombo: true,
    widthIn: 6,
    heightIn: 2,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 10, topPct: 34, widthPct: 78, heightPct: 30, bg: "#d9a32a" },
    ],
  },
  {
    id: "short-line-4",
    label: "Short line 4",
    layer: "terrain",
    multiCombo: true,
    widthIn: 6,
    heightIn: 2,
    defaultRotationDeg: 50,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 12, topPct: 34, widthPct: 76, heightPct: 30, bg: "#d9a32a" },
    ],
  },
  {
    id: "short-line-5",
    label: "Short line 5",
    layer: "terrain",
    multiCombo: true,
    widthIn: 6,
    heightIn: 2,
    defaultRotationDeg: 90,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 9, topPct: 40, widthPct: 75, heightPct: 28, bg: "#d9a32a" },
    ],
  },
  {
    id: "short-line-6",
    label: "Short line 6",
    layer: "terrain",
    multiCombo: true,
    widthIn: 6,
    heightIn: 2,
    defaultRotationDeg: 15,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 10, topPct: 34, widthPct: 80, heightPct: 30, bg: "#d9a32a" },
    ],
  },
  // "Short line 7" / "Short line 8" = same 6 x 2" podložka with a single
  // golden bar, default tilt -64° / -4°. Estimated.
  {
    id: "short-line-7",
    label: "Short line 7",
    layer: "terrain",
    multiCombo: true,
    widthIn: 6,
    heightIn: 2,
    defaultRotationDeg: -64,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 10, topPct: 34, widthPct: 78, heightPct: 30, bg: "#d9a32a" },
    ],
  },
  {
    id: "short-line-8",
    label: "Short line 8",
    layer: "terrain",
    multiCombo: true,
    widthIn: 6,
    heightIn: 2,
    defaultRotationDeg: -4,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 10, topPct: 34, widthPct: 78, heightPct: 30, bg: "#d9a32a" },
    ],
  },
  // "Medium rectangle full" = a terrain feature on a 6 x 4" podložka: a left
  // post, a short connector, and a right upright with a round blob at each
  // end (the circles approximated as ~6-point arcs in one clip-path polygon;
  // same shape as before, now squeezed into 6 x 4"). Combo, so podložka +
  // terrain scale together. (Kept id "h-blok" so saved boards still resolve.)
  {
    id: "h-blok",
    label: "Medium rectangle full",
    layer: "terrain",
    combo: true,
    widthIn: 6,
    heightIn: 4,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    terrainWidthIn: 6,
    terrainHeightIn: 4,
    terrainBg: "#3f7a3f",
    terrainBorder: "none",
    terrainRadius: 0,
    terrainClipPath:
      "polygon(72.5% 0%, 85% 2.7%, 94.1% 10%, 97.4% 17.9%, 95.1% 28.5%, 88.6% 35.3%, 77.5% 39.6%, 77.5% 60.4%, 88.6% 64.7%, 96% 73.2%, 97.1% 83.5%, 91.6% 92.9%, 81% 98.8%, 72.5% 100%, 64% 98.8%, 53.4% 92.9%, 48.4% 85.2%, 47.5% 76.5%, 55% 65.7%, 55% 56%, 32.5% 56%, 32.5% 64%, 7.5% 64%, 7.5% 36%, 32.5% 36%, 32.5% 44%, 55% 44%, 55% 34.3%, 47.5% 20%, 50.9% 10%, 60% 2.7%)",
  },
  // "Medium rectangle full 1" = a portrait 4 x 6" podložka carrying one
  // green wall outline: a tall hollow upright (right) and a shorter hollow
  // block stepping out to its left, sharing one open T-shaped hollow inside.
  // multiCombo = every wall segment is a % rectangle of the podložka, so it
  // drags/resizes/rotates as one piece. Proportions read off the reference.
  {
    id: "h-blok-1",
    label: "Medium rectangle full 1",
    layer: "terrain",
    multiCombo: true,
    widthIn: 4,
    heightIn: 6,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      // upright: top cap, right wall, bottom cap, left wall (upper + lower)
      { leftPct: 44.4, topPct: 8.2, widthPct: 37.6, heightPct: 8.2, bg: "#3f7a3f" },
      { leftPct: 69.1, topPct: 16.4, widthPct: 12.9, heightPct: 64.7, bg: "#3f7a3f" },
      { leftPct: 44.4, topPct: 81.1, widthPct: 37.6, heightPct: 9.1, bg: "#3f7a3f" },
      { leftPct: 44.4, topPct: 16.4, widthPct: 13.6, heightPct: 16.4, bg: "#3f7a3f" },
      { leftPct: 44.4, topPct: 65.6, widthPct: 13.6, heightPct: 15.5, bg: "#3f7a3f" },
      // left block: top bar, left wall, bottom bar
      { leftPct: 20.25, topPct: 24.3, widthPct: 24.15, heightPct: 8.5, bg: "#3f7a3f" },
      { leftPct: 20.25, topPct: 32.8, widthPct: 13.05, heightPct: 32.8, bg: "#3f7a3f" },
      { leftPct: 20.25, topPct: 65.6, widthPct: 24.15, heightPct: 8.2, bg: "#3f7a3f" },
    ],
  },
  // "Medium rectangle full 2".."11" — see MEDIUM_FULL_PARTS above.
  ...[[2, -42], [3, 0], [4, 58], [5, 30], [6, 40], [7, -80], [8, -5], [9, 35], [10, -35], [11, -85]].map(([n, deg]) => mediumFullShape(n, deg)),
  // "Medium rectangle open 1" = a 6 x 4" podložka with two open orange
  // L-brackets in opposite corners (top-left: 29% x 69% arms, bottom-right:
  // 29% x 65% arms, ~0.5" thick), placed tilted +48° by default. Arm
  // lengths measured off the enlarged reference.
  {
    id: "h-blok-open-1",
    label: "Medium rectangle open 1",
    layer: "terrain",
    multiCombo: true,
    widthIn: 6,
    heightIn: 4,
    defaultRotationDeg: 48,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 0, topPct: 0, widthPct: 29, heightPct: 12.5, bg: "#d98b3a" },
      { leftPct: 0, topPct: 0, widthPct: 8.3, heightPct: 69, bg: "#d98b3a" },
      { leftPct: 71, topPct: 87.5, widthPct: 29, heightPct: 12.5, bg: "#d98b3a" },
      { leftPct: 91.7, topPct: 35, widthPct: 8.3, heightPct: 65, bg: "#d98b3a" },
    ],
  },
  // "Medium rectangle open 2".."12" — see mediumOpenShape above (2: -37° measured
  // off the enlarged reference; 3-12 read off small thumbnails, tilts approximate).
  ...[[2, -37], [3, -20], [4, 62], [5, -15], [6, -30], [7, 0], [8, 70], [9, -15], [10, -28], [11, 80], [12, 55]].map(([n, deg]) => mediumOpenShape(n, deg)),
  // "Large rectangle" = an 11.5 x 7" podložka carrying wall segments: green
  // L-walls in the top-left and bottom-right corners, a green upright on the
  // lower-left edge, and a straight orange wall along the top-right edge.
  // multiCombo = one rigid piece — every wall is a % rectangle of the
  // podložka, so dragging / resizing / rotating moves them all together.
  {
    id: "large-rectangle",
    label: "Large rectangle",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 7,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      // top-left L (green)
      { leftPct: 0, topPct: 0, widthPct: 42, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 0, widthPct: 4.3, heightPct: 44, bg: "#3f7a3f" },
      // lower-left upright (green)
      { leftPct: 0, topPct: 52, widthPct: 4.3, heightPct: 48, bg: "#3f7a3f" },
      // bottom-right L (green)
      { leftPct: 95.7, topPct: 40, widthPct: 4.3, heightPct: 60, bg: "#3f7a3f" },
      { leftPct: 56, topPct: 92.9, widthPct: 44, heightPct: 7.1, bg: "#3f7a3f" },
      // top-right straight (orange)
      { leftPct: 56, topPct: 0, widthPct: 44, heightPct: 7.1, bg: "#d98b3a" },
    ],
  },
  // "Long line kombi" = a 10 x 2" podložka (Long line size) as one rigid
  // module: a green ruin block in the middle that stands proud top and
  // bottom, with a yellow barricade running out to each side.
  {
    id: "long-line-kombi",
    label: "Short line full kombi",
    layer: "terrain",
    multiCombo: true,
    widthIn: 6,
    heightIn: 2,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      // yellow barricade left
      {
        leftPct: 1, topPct: 38, widthPct: 34, heightPct: 30, bg: "#c9a227",
        clipPath: "polygon(0% 33%, 14% 33%, 14% 0%, 22% 0%, 22% 33%, 60% 33%, 60% 0%, 68% 0%, 68% 33%, 100% 33%, 100% 67%, 68% 67%, 68% 100%, 60% 100%, 60% 67%, 22% 67%, 22% 100%, 14% 100%, 14% 67%, 0% 67%)",
      },
      // yellow barricade right
      {
        leftPct: 65, topPct: 38, widthPct: 34, heightPct: 30, bg: "#c9a227",
        clipPath: "polygon(0% 33%, 32% 33%, 32% 0%, 40% 0%, 40% 33%, 78% 33%, 78% 0%, 86% 0%, 86% 33%, 100% 33%, 100% 67%, 86% 67%, 86% 100%, 78% 100%, 78% 67%, 40% 67%, 40% 100%, 32% 100%, 32% 67%, 0% 67%)",
      },
      // green ruin block in the middle
      { leftPct: 34, topPct: -30, widthPct: 32, heightPct: 160, bg: "#2e7d5b", radius: 2 },
    ],
  },
  // "Long line combi 2" = a 10 x 2" podložka (Long line size) as one rigid
  // module: a thin golden line down the whole length and a green rectangular
  // frame around the middle that stands proud top and bottom; tilted -25° by
  // default. Line/frame proportions and tilt estimated.
  {
    id: "long-line-combi-2",
    label: "Short line full combi 2",
    layer: "terrain",
    multiCombo: true,
    widthIn: 6,
    heightIn: 2,
    defaultRotationDeg: -25,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      // golden line along the whole length
      { leftPct: 2, topPct: 44, widthPct: 96, heightPct: 12, bg: "#d9a32a" },
      // green frame in the middle (4 bars)
      { leftPct: 39, topPct: -12, widthPct: 22, heightPct: 15, bg: "#2e7d5b" },
      { leftPct: 39, topPct: 97, widthPct: 22, heightPct: 15, bg: "#2e7d5b" },
      { leftPct: 39, topPct: -12, widthPct: 3.8, heightPct: 124, bg: "#2e7d5b" },
      { leftPct: 57.2, topPct: -12, widthPct: 3.8, heightPct: 124, bg: "#2e7d5b" },
    ],
  },
  // "Long line combi 3" = near-twin of "Long line combi 2": same golden line
  // and green frame, frame nudged a bit left of centre, tilted -20° by
  // default. Estimated.
  {
    id: "long-line-combi-3",
    label: "Short line full combi 3",
    layer: "terrain",
    multiCombo: true,
    widthIn: 6,
    heightIn: 2,
    defaultRotationDeg: -20,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 2, topPct: 44, widthPct: 96, heightPct: 12, bg: "#d9a32a" },
      { leftPct: 34, topPct: -12, widthPct: 22, heightPct: 15, bg: "#2e7d5b" },
      { leftPct: 34, topPct: 97, widthPct: 22, heightPct: 15, bg: "#2e7d5b" },
      { leftPct: 34, topPct: -12, widthPct: 3.8, heightPct: 124, bg: "#2e7d5b" },
      { leftPct: 52.2, topPct: -12, widthPct: 3.8, heightPct: 124, bg: "#2e7d5b" },
    ],
  },
  // "Long line combi 4" / "Long line combi 5" = same golden line and green
  // frame as "Long line combi 2", steeply tilted by default (-63° / -56°),
  // frame centred / nudged toward the lower-left end. Estimated.
  {
    id: "long-line-combi-4",
    label: "Short line full combi 4",
    layer: "terrain",
    multiCombo: true,
    widthIn: 6,
    heightIn: 2,
    defaultRotationDeg: -63,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 2, topPct: 44, widthPct: 96, heightPct: 12, bg: "#d9a32a" },
      { leftPct: 39, topPct: -12, widthPct: 22, heightPct: 15, bg: "#2e7d5b" },
      { leftPct: 39, topPct: 97, widthPct: 22, heightPct: 15, bg: "#2e7d5b" },
      { leftPct: 39, topPct: -12, widthPct: 3.8, heightPct: 124, bg: "#2e7d5b" },
      { leftPct: 57.2, topPct: -12, widthPct: 3.8, heightPct: 124, bg: "#2e7d5b" },
    ],
  },
  {
    id: "long-line-combi-5",
    label: "Short line full combi 5",
    layer: "terrain",
    multiCombo: true,
    widthIn: 6,
    heightIn: 2,
    defaultRotationDeg: -56,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 2, topPct: 44, widthPct: 96, heightPct: 12, bg: "#d9a32a" },
      { leftPct: 32, topPct: -12, widthPct: 22, heightPct: 15, bg: "#2e7d5b" },
      { leftPct: 32, topPct: 97, widthPct: 22, heightPct: 15, bg: "#2e7d5b" },
      { leftPct: 32, topPct: -12, widthPct: 3.8, heightPct: 124, bg: "#2e7d5b" },
      { leftPct: 50.2, topPct: -12, widthPct: 3.8, heightPct: 124, bg: "#2e7d5b" },
    ],
  },
  // "Long line combi 6" = same golden line and green frame as "Long line
  // combi 2", frame centred, tilted -42° by default. Estimated.
  {
    id: "long-line-combi-6",
    label: "Short line full combi 6",
    layer: "terrain",
    multiCombo: true,
    widthIn: 6,
    heightIn: 2,
    defaultRotationDeg: -42,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 2, topPct: 44, widthPct: 96, heightPct: 12, bg: "#d9a32a" },
      { leftPct: 39, topPct: -12, widthPct: 22, heightPct: 15, bg: "#2e7d5b" },
      { leftPct: 39, topPct: 97, widthPct: 22, heightPct: 15, bg: "#2e7d5b" },
      { leftPct: 39, topPct: -12, widthPct: 3.8, heightPct: 124, bg: "#2e7d5b" },
      { leftPct: 57.2, topPct: -12, widthPct: 3.8, heightPct: 124, bg: "#2e7d5b" },
    ],
  },
  // "Long line combi 7".."10" = same golden line and green frame as "Long
  // line combi 2", with different default tilts / frame positions (7: 0°,
  // frame right of centre; 8: -81°; 9: -68°; 10: 0°). Estimated.
  {
    id: "long-line-combi-7",
    label: "Short line full combi 7",
    layer: "terrain",
    multiCombo: true,
    widthIn: 6,
    heightIn: 2,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 2, topPct: 44, widthPct: 96, heightPct: 12, bg: "#d9a32a" },
      { leftPct: 43, topPct: -12, widthPct: 22, heightPct: 15, bg: "#2e7d5b" },
      { leftPct: 43, topPct: 97, widthPct: 22, heightPct: 15, bg: "#2e7d5b" },
      { leftPct: 43, topPct: -12, widthPct: 3.8, heightPct: 124, bg: "#2e7d5b" },
      { leftPct: 61.2, topPct: -12, widthPct: 3.8, heightPct: 124, bg: "#2e7d5b" },
    ],
  },
  {
    id: "long-line-combi-8",
    label: "Short line full combi 8",
    layer: "terrain",
    multiCombo: true,
    widthIn: 6,
    heightIn: 2,
    defaultRotationDeg: -81,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 2, topPct: 44, widthPct: 96, heightPct: 12, bg: "#d9a32a" },
      { leftPct: 44, topPct: -12, widthPct: 22, heightPct: 15, bg: "#2e7d5b" },
      { leftPct: 44, topPct: 97, widthPct: 22, heightPct: 15, bg: "#2e7d5b" },
      { leftPct: 44, topPct: -12, widthPct: 3.8, heightPct: 124, bg: "#2e7d5b" },
      { leftPct: 62.2, topPct: -12, widthPct: 3.8, heightPct: 124, bg: "#2e7d5b" },
    ],
  },
  {
    id: "long-line-combi-9",
    label: "Short line full combi 9",
    layer: "terrain",
    multiCombo: true,
    widthIn: 6,
    heightIn: 2,
    defaultRotationDeg: -68,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 2, topPct: 44, widthPct: 96, heightPct: 12, bg: "#d9a32a" },
      { leftPct: 40, topPct: -12, widthPct: 22, heightPct: 15, bg: "#2e7d5b" },
      { leftPct: 40, topPct: 97, widthPct: 22, heightPct: 15, bg: "#2e7d5b" },
      { leftPct: 40, topPct: -12, widthPct: 3.8, heightPct: 124, bg: "#2e7d5b" },
      { leftPct: 58.2, topPct: -12, widthPct: 3.8, heightPct: 124, bg: "#2e7d5b" },
    ],
  },
  {
    id: "long-line-combi-10",
    label: "Short line full combi 10",
    layer: "terrain",
    multiCombo: true,
    widthIn: 6,
    heightIn: 2,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 2, topPct: 44, widthPct: 96, heightPct: 12, bg: "#d9a32a" },
      { leftPct: 39, topPct: -12, widthPct: 22, heightPct: 15, bg: "#2e7d5b" },
      { leftPct: 39, topPct: 97, widthPct: 22, heightPct: 15, bg: "#2e7d5b" },
      { leftPct: 39, topPct: -12, widthPct: 3.8, heightPct: 124, bg: "#2e7d5b" },
      { leftPct: 57.2, topPct: -12, widthPct: 3.8, heightPct: 124, bg: "#2e7d5b" },
    ],
  },
  // "Long line combi 11" = same golden line and green frame as "Long line
  // combi 2", frame centred, tilted -38° by default. Estimated.
  {
    id: "long-line-combi-11",
    label: "Short line full combi 11",
    layer: "terrain",
    multiCombo: true,
    widthIn: 6,
    heightIn: 2,
    defaultRotationDeg: -38,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 2, topPct: 44, widthPct: 96, heightPct: 12, bg: "#d9a32a" },
      { leftPct: 39, topPct: -12, widthPct: 22, heightPct: 15, bg: "#2e7d5b" },
      { leftPct: 39, topPct: 97, widthPct: 22, heightPct: 15, bg: "#2e7d5b" },
      { leftPct: 39, topPct: -12, widthPct: 3.8, heightPct: 124, bg: "#2e7d5b" },
      { leftPct: 57.2, topPct: -12, widthPct: 3.8, heightPct: 124, bg: "#2e7d5b" },
    ],
  },
  // "Ruin diag A" / "Ruin diag B" — two standalone 6 x 7" ruin modules (each
  // its own podložka + two L-corner accents).
  {
    id: "ruin-diag-a",
    label: "Ruin diag A",
    layer: "terrain",
    multiCombo: true,
    widthIn: 6,
    heightIn: 7,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      // green L, top-right
      { leftPct: 60, topPct: 0, widthPct: 40, heightPct: 6, bg: "#3f7a3f" },
      { leftPct: 92, topPct: 0, widthPct: 8, heightPct: 40, bg: "#3f7a3f" },
      // orange L, bottom-right
      { leftPct: 60, topPct: 94, widthPct: 40, heightPct: 6, bg: "#d98b3a" },
      { leftPct: 92, topPct: 60, widthPct: 8, heightPct: 40, bg: "#d98b3a" },
    ],
  },
  {
    id: "ruin-diag-b",
    label: "Ruin diag B",
    layer: "terrain",
    multiCombo: true,
    widthIn: 6,
    heightIn: 7,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      // orange L, top-left
      { leftPct: 0, topPct: 0, widthPct: 40, heightPct: 6, bg: "#d98b3a" },
      { leftPct: 0, topPct: 0, widthPct: 8, heightPct: 40, bg: "#d98b3a" },
      // green L, bottom-left
      { leftPct: 0, topPct: 94, widthPct: 40, heightPct: 6, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 60, widthPct: 8, heightPct: 40, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 1" = a 7 x 11.5" portrait podložka module: an orange
  // L-wall in the top-left corner and a green L-wall in the bottom-left
  // corner (arms ~a third of the edge, ~0.5" thick — estimated).
  {
    id: "large-rectangle-1",
    label: "Large rectangle 1",
    layer: "terrain",
    multiCombo: true,
    widthIn: 7,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      // orange L, top-left
      { leftPct: 0, topPct: 0, widthPct: 33, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 0, topPct: 0, widthPct: 7.1, heightPct: 33, bg: "#d98b3a" },
      // green L, bottom-left
      { leftPct: 0, topPct: 95.7, widthPct: 33, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 67, widthPct: 7.1, heightPct: 33, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 2" = a 7 x 11.5" portrait podložka module: green L-walls
  // in the top-right and bottom-left corners plus a green upright lower down
  // the right edge (arms ~a third of the edge, ~0.5" thick — estimated).
  {
    id: "large-rectangle-2",
    label: "Large rectangle 2",
    layer: "terrain",
    multiCombo: true,
    widthIn: 7,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      // green L, top-right
      { leftPct: 62, topPct: 0, widthPct: 38, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 92.9, topPct: 0, widthPct: 7.1, heightPct: 38, bg: "#3f7a3f" },
      // green upright, lower right
      { leftPct: 92.9, topPct: 55, widthPct: 7.1, heightPct: 30, bg: "#3f7a3f" },
      // green L, bottom-left
      { leftPct: 0, topPct: 95.7, widthPct: 38, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 62, widthPct: 7.1, heightPct: 38, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 3" = a plain 7 x 11.5" portrait podložka, green L-walls
  // in the top-right and bottom-right corners (arms ~a third of the edge,
  // ~0.5" thick — estimated).
  {
    id: "large-rectangle-3",
    label: "Large rectangle 3",
    layer: "terrain",
    multiCombo: true,
    widthIn: 7,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      // green L, top-right
      { leftPct: 55, topPct: 0, widthPct: 37, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 87, topPct: 0, widthPct: 6, heightPct: 35, bg: "#3f7a3f" },
      // green L, bottom-right
      { leftPct: 55, topPct: 95.7, widthPct: 37, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 87, topPct: 65, widthPct: 6, heightPct: 35, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 4" = a plain 7 x 11.5" portrait podložka: orange L-wall
  // top-left, green L-wall bottom-left (arms ~a third of the edge, ~0.5"
  // thick — estimated).
  {
    id: "large-rectangle-4",
    label: "Large rectangle 4",
    layer: "terrain",
    multiCombo: true,
    widthIn: 7,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      // orange L, top-left
      { leftPct: 0, topPct: 0, widthPct: 33, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 0, topPct: 0, widthPct: 7.1, heightPct: 33, bg: "#d98b3a" },
      // green L, bottom-left
      { leftPct: 0, topPct: 95.7, widthPct: 33, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 67, widthPct: 7.1, heightPct: 33, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 5" = a plain 7 x 11.5" portrait podložka: green L-wall
  // top-left, orange L-wall bottom-left (Large rectangle 4 with the two
  // colours swapped).
  {
    id: "large-rectangle-5",
    label: "Large rectangle 5",
    layer: "terrain",
    multiCombo: true,
    widthIn: 7,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      // green L, top-left
      { leftPct: 0, topPct: 0, widthPct: 33, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 0, widthPct: 7.1, heightPct: 33, bg: "#3f7a3f" },
      // orange L, bottom-left
      { leftPct: 0, topPct: 95.7, widthPct: 33, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 0, topPct: 67, widthPct: 7.1, heightPct: 33, bg: "#d98b3a" },
    ],
  },
  // "Large rectangle 6" = a plain 7 x 11.5" portrait podložka: orange L-wall
  // top-right, green L-wall bottom-right.
  {
    id: "large-rectangle-6",
    label: "Large rectangle 6",
    layer: "terrain",
    multiCombo: true,
    widthIn: 7,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      // orange L, top-right
      { leftPct: 67, topPct: 0, widthPct: 33, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 92.9, topPct: 0, widthPct: 7.1, heightPct: 33, bg: "#d98b3a" },
      // green L, bottom-right
      { leftPct: 67, topPct: 95.7, widthPct: 33, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 92.9, topPct: 67, widthPct: 7.1, heightPct: 33, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 7" = a plain 11.5 x 7" landscape podložka: a green bar
  // along the top-left edge and a green L-wall in the bottom-right corner.
  {
    id: "large-rectangle-7",
    label: "Large rectangle 7",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 7,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      // green bar, top-left edge
      { leftPct: 4, topPct: 0, widthPct: 30, heightPct: 7, bg: "#3f7a3f" },
      // green L, bottom-right
      { leftPct: 55, topPct: 92.9, widthPct: 40, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 91, topPct: 60, widthPct: 5, heightPct: 40, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 8" = a plain 7 x 11.5" portrait podložka: green L-walls
  // in diagonally opposite corners (top-right, bottom-left). Placed at a 45°
  // tilt by default (defaultRotationDeg) to match its diagonal reference —
  // still freely re-rotatable afterward from the selected-piece panel.
  {
    id: "large-rectangle-8",
    label: "Large rectangle 8",
    layer: "terrain",
    multiCombo: true,
    widthIn: 7,
    heightIn: 11.5,
    defaultRotationDeg: 45,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      // green L, top-right
      { leftPct: 67, topPct: 0, widthPct: 33, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 92.9, topPct: 0, widthPct: 7.1, heightPct: 33, bg: "#3f7a3f" },
      // green L, bottom-left
      { leftPct: 0, topPct: 95.7, widthPct: 33, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 67, widthPct: 7.1, heightPct: 33, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 9" = a plain 11.5 x 7" landscape podložka: a green bar
  // along the top-left edge and a green L-wall in the bottom-right corner.
  {
    id: "large-rectangle-9",
    label: "Large rectangle 9",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 7,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      // green bar, top-left edge
      { leftPct: 4, topPct: 0, widthPct: 30, heightPct: 7, bg: "#3f7a3f" },
      // green L, bottom-right
      { leftPct: 55, topPct: 92.9, widthPct: 40, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 91, topPct: 60, widthPct: 5, heightPct: 40, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 10" = a plain 11.5 x 7" landscape podložka: green
  // L-walls in the top-left and bottom-right corners.
  {
    id: "large-rectangle-10",
    label: "Large rectangle 10",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 7,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      // green L, top-left
      { leftPct: 0, topPct: 0, widthPct: 40, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 0, widthPct: 5, heightPct: 40, bg: "#3f7a3f" },
      // green L, bottom-right
      { leftPct: 60, topPct: 92.9, widthPct: 40, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 95, topPct: 60, widthPct: 5, heightPct: 40, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 15" = a plain 11.5 x 7" landscape podložka: green
  // L-walls in diagonally opposite corners (top-right, bottom-left), tilted
  // 25° by default to match its diagonal reference.
  {
    id: "large-rectangle-15",
    label: "Large rectangle 15",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 7,
    defaultRotationDeg: 25,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      // green L, top-right
      { leftPct: 60, topPct: 0, widthPct: 40, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 95, topPct: 0, widthPct: 5, heightPct: 40, bg: "#3f7a3f" },
      // green L, bottom-left
      { leftPct: 0, topPct: 92.9, widthPct: 40, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 60, widthPct: 5, heightPct: 40, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 16" = a plain 7 x 11.5" portrait podložka: green L-wall
  // top-right (a bar plus a short upright) and green L-wall bottom-left.
  {
    id: "large-rectangle-16",
    label: "Large rectangle 16",
    layer: "terrain",
    multiCombo: true,
    widthIn: 7,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      // green L, top-right
      { leftPct: 55, topPct: 0, widthPct: 45, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 92.9, topPct: 0, widthPct: 7.1, heightPct: 30, bg: "#3f7a3f" },
      // green L, bottom-left
      { leftPct: 0, topPct: 95.7, widthPct: 33, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 67, widthPct: 7.1, heightPct: 33, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 17" = a plain 7 x 11.5" portrait podložka: orange
  // L-wall top-left, green L-wall bottom-right.
  {
    id: "large-rectangle-17",
    label: "Large rectangle 17",
    layer: "terrain",
    multiCombo: true,
    widthIn: 7,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      // orange L, top-left
      { leftPct: 0, topPct: 0, widthPct: 33, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 0, topPct: 0, widthPct: 7.1, heightPct: 33, bg: "#d98b3a" },
      // green L, bottom-right
      { leftPct: 67, topPct: 95.7, widthPct: 33, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 92.9, topPct: 67, widthPct: 7.1, heightPct: 33, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 20" = a plain 11.5 x 7" landscape podložka: tall green
  // uprights along the left and right edges, each with a foot at the
  // bottom corner.
  {
    id: "large-rectangle-20",
    label: "Large rectangle 20",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 7,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      // left upright + foot
      { leftPct: 0, topPct: 8, widthPct: 5, heightPct: 84, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 92.9, widthPct: 25, heightPct: 7.1, bg: "#3f7a3f" },
      // right upright + foot
      { leftPct: 95, topPct: 8, widthPct: 5, heightPct: 84, bg: "#3f7a3f" },
      { leftPct: 75, topPct: 92.9, widthPct: 25, heightPct: 7.1, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 21" = a plain 7 x 11.5" portrait podložka: green L-wall
  // top-left, green L-wall bottom-right.
  {
    id: "large-rectangle-21",
    label: "Large rectangle 21",
    layer: "terrain",
    multiCombo: true,
    widthIn: 7,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      // green L, top-left
      { leftPct: 0, topPct: 0, widthPct: 33, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 0, widthPct: 7.1, heightPct: 33, bg: "#3f7a3f" },
      // green L, bottom-right
      { leftPct: 67, topPct: 95.7, widthPct: 33, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 92.9, topPct: 67, widthPct: 7.1, heightPct: 33, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 22" = a plain 11.5 x 7" landscape podložka: green
  // L-walls top-left and bottom-right (same layout as Large rectangle 10).
  {
    id: "large-rectangle-22",
    label: "Large rectangle 22",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 7,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 0, topPct: 0, widthPct: 40, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 0, widthPct: 5, heightPct: 40, bg: "#3f7a3f" },
      { leftPct: 60, topPct: 92.9, widthPct: 40, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 95, topPct: 60, widthPct: 5, heightPct: 40, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 23" = a plain 7 x 11.5" portrait podložka: orange
  // L-wall top-left, green L-wall bottom-right (same layout as Large
  // rectangle 17).
  {
    id: "large-rectangle-23",
    label: "Large rectangle 23",
    layer: "terrain",
    multiCombo: true,
    widthIn: 7,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 0, topPct: 0, widthPct: 33, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 0, topPct: 0, widthPct: 7.1, heightPct: 33, bg: "#d98b3a" },
      { leftPct: 67, topPct: 95.7, widthPct: 33, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 92.9, topPct: 67, widthPct: 7.1, heightPct: 33, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 24" = a plain 11.5 x 7" landscape podložka: green
  // L-walls top-left and bottom-right, tilted -20° by default.
  {
    id: "large-rectangle-24",
    label: "Large rectangle 24",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 7,
    defaultRotationDeg: -20,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 0, topPct: 0, widthPct: 40, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 0, widthPct: 5, heightPct: 40, bg: "#3f7a3f" },
      { leftPct: 60, topPct: 92.9, widthPct: 40, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 95, topPct: 60, widthPct: 5, heightPct: 40, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 25" = a plain 7 x 11.5" portrait podložka: green L-wall
  // bottom-left (large), orange L-wall accent lower-right, tilted 15° by
  // default.
  {
    id: "large-rectangle-25",
    label: "Large rectangle 25",
    layer: "terrain",
    multiCombo: true,
    widthIn: 7,
    heightIn: 11.5,
    defaultRotationDeg: 15,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      // green L, bottom-left
      { leftPct: 0, topPct: 95.7, widthPct: 40, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 60, widthPct: 7.1, heightPct: 40, bg: "#3f7a3f" },
      // orange L accent, lower-right
      { leftPct: 80, topPct: 55, widthPct: 20, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 92.9, topPct: 55, widthPct: 7.1, heightPct: 16, bg: "#d98b3a" },
    ],
  },
  // "Large rectangle 26" = a plain 11.5 x 7" landscape podložka: green
  // L-walls in diagonally opposite corners (top-right, bottom-left).
  {
    id: "large-rectangle-26",
    label: "Large rectangle 26",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 7,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 60, topPct: 0, widthPct: 40, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 95, topPct: 0, widthPct: 5, heightPct: 40, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 92.9, widthPct: 40, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 60, widthPct: 5, heightPct: 40, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 27" = a plain 7 x 11.5" portrait podložka: green L-walls
  // in the top-left (long top arm) and bottom-right corners, tilted -37° by
  // default (arm lengths estimated).
  {
    id: "large-rectangle-27",
    label: "Large rectangle 27",
    layer: "terrain",
    multiCombo: true,
    widthIn: 7,
    heightIn: 11.5,
    defaultRotationDeg: -37,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 0, topPct: 0, widthPct: 88, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 0, widthPct: 7.1, heightPct: 32, bg: "#3f7a3f" },
      { leftPct: 55, topPct: 95.7, widthPct: 45, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 92.9, topPct: 55, widthPct: 7.1, heightPct: 45, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 28" = a plain 11.5 x 7" landscape podložka: green
  // L-walls top-right (short top arm, long right arm) and bottom-left (long
  // left arm, half-length bottom arm), tilted -31° by default (arms estimated).
  {
    id: "large-rectangle-28",
    label: "Large rectangle 28",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 7,
    defaultRotationDeg: -31,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 72, topPct: 0, widthPct: 28, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 95.7, topPct: 0, widthPct: 4.3, heightPct: 90, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 92.9, widthPct: 50, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 25, widthPct: 4.3, heightPct: 75, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 29" = a plain 7 x 11.5" portrait podložka: green L-walls
  // top-right (half-width top arm, half-height right arm) and bottom-left
  // (45%-width bottom arm, 45%-height left arm). Arms estimated.
  {
    id: "large-rectangle-29",
    label: "Large rectangle 29",
    layer: "terrain",
    multiCombo: true,
    widthIn: 7,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 50, topPct: 0, widthPct: 50, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 92.9, topPct: 0, widthPct: 7.1, heightPct: 50, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 95.7, widthPct: 45, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 55, widthPct: 7.1, heightPct: 45, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 30" = a plain 7 x 11.5" portrait podložka: small orange
  // L-wall top-right + larger green L-wall bottom-right. Arms estimated.
  {
    id: "large-rectangle-30",
    label: "Large rectangle 30",
    layer: "terrain",
    multiCombo: true,
    widthIn: 7,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 70, topPct: 0, widthPct: 30, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 92.9, topPct: 0, widthPct: 7.1, heightPct: 28, bg: "#d98b3a" },
      { leftPct: 66, topPct: 95.7, widthPct: 34, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 92.9, topPct: 45, widthPct: 7.1, heightPct: 55, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 31" = a plain 11.5 x 7" landscape podložka: green
  // L-walls top-right (short top arm, long right arm) and bottom-left (long
  // bottom arm, ~70% left arm). Arms estimated.
  {
    id: "large-rectangle-31",
    label: "Large rectangle 31",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 7,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 71, topPct: 0, widthPct: 29, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 95.7, topPct: 0, widthPct: 4.3, heightPct: 80, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 92.9, widthPct: 55, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 29, widthPct: 4.3, heightPct: 71, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 32" = a plain 11.5 x 7" landscape podložka: green L-wall
  // bottom-left (long bottom arm) + small orange L-wall bottom-right, tilted
  // -36° by default. Low-confidence estimate of arms/tilt/corner.
  {
    id: "large-rectangle-32",
    label: "Large rectangle 32",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 7,
    defaultRotationDeg: -36,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 0, topPct: 92.9, widthPct: 60, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 75, widthPct: 4.3, heightPct: 25, bg: "#3f7a3f" },
      { leftPct: 88, topPct: 92.9, widthPct: 12, heightPct: 7.1, bg: "#d98b3a" },
      { leftPct: 95.7, topPct: 65, widthPct: 4.3, heightPct: 35, bg: "#d98b3a" },
    ],
  },
  // "Large rectangle 33" = a plain 7 x 11.5" portrait podložka: green L-walls
  // top-right (~40% top arm, ~55% right arm) and bottom-left (~50% bottom
  // arm, ~32% left arm), tilted 10° by default. Arms estimated.
  {
    id: "large-rectangle-33",
    label: "Large rectangle 33",
    layer: "terrain",
    multiCombo: true,
    widthIn: 7,
    heightIn: 11.5,
    defaultRotationDeg: 10,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 58, topPct: 0, widthPct: 42, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 92.9, topPct: 0, widthPct: 7.1, heightPct: 55, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 95.7, widthPct: 50, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 68, widthPct: 7.1, heightPct: 32, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 34" = plain 11.5 x 7" landscape podložka: green L-walls
  // top-right (long right arm) and bottom-left. Arms estimated.
  {
    id: "large-rectangle-34",
    label: "Large rectangle 34",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 7,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 68, topPct: 0, widthPct: 32, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 95.7, topPct: 0, widthPct: 4.3, heightPct: 85, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 92.9, widthPct: 45, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 45, widthPct: 4.3, heightPct: 55, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 35" = plain 11.5 x 7" landscape podložka: orange L-wall
  // bottom-left (short bottom arm) + green L-wall bottom-right (full-height
  // right arm). Arms estimated.
  {
    id: "large-rectangle-35",
    label: "Large rectangle 35",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 7,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 0, topPct: 92.9, widthPct: 16, heightPct: 7.1, bg: "#d98b3a" },
      { leftPct: 0, topPct: 55, widthPct: 4.3, heightPct: 45, bg: "#d98b3a" },
      { leftPct: 76, topPct: 92.9, widthPct: 24, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 95.7, topPct: 0, widthPct: 4.3, heightPct: 100, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 36" = plain 11.5 x 7" landscape podložka: green L-wall
  // bottom-left (long bottom arm) + small orange L-wall bottom-right. Arms
  // estimated.
  {
    id: "large-rectangle-36",
    label: "Large rectangle 36",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 7,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 0, topPct: 92.9, widthPct: 57, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 53, widthPct: 4.3, heightPct: 47, bg: "#3f7a3f" },
      { leftPct: 78, topPct: 92.9, widthPct: 22, heightPct: 7.1, bg: "#d98b3a" },
      { leftPct: 78, topPct: 80, widthPct: 4.3, heightPct: 20, bg: "#d98b3a" },
    ],
  },
  // "Triangle" = an 8 x 11.5" portrait podložka with one green right-triangle
  // (right angle bottom-left, legs along the left and bottom edges). The
  // triangle orientation/colour is a generic default — not specified.
  {
    id: "triangle",
    label: "Triangle",
    layer: "terrain",
    multiCombo: true,
    widthIn: 8,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 0, topPct: 0, widthPct: 100, heightPct: 100, bg: "#3f7a3f", clipPath: "polygon(0% 0%, 0% 100%, 100% 100%)" },
    ],
  },
  // "Triangle 1" = an 8 x 11.5" triangular podložka (right angle bottom-right,
  // hypotenuse cut off flat at the top so the top corner can carry a bar),
  // with plain rectangular L-wall bars like the Large rectangles: green
  // bottom-right, small orange top-right, tilted 53° by default. Arm lengths
  // and the cut-off tip width are estimated.
  {
    id: "triangle-1",
    label: "Triangle 1",
    layer: "terrain",
    multiCombo: true,
    widthIn: 8,
    heightIn: 11.5,
    defaultRotationDeg: 53,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 0,
    clipPath: "polygon(72% 0%, 100% 0%, 100% 100%, 0% 100%)",
    parts: [
      // green L, bottom-right
      { leftPct: 35, topPct: 95.7, widthPct: 65, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 93.75, topPct: 45, widthPct: 6.25, heightPct: 55, bg: "#3f7a3f" },
      // orange L, top-right
      { leftPct: 72, topPct: 0, widthPct: 28, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 93.75, topPct: 0, widthPct: 6.25, heightPct: 25, bg: "#d98b3a" },
    ],
  },
  // "Triangle 2" = an 8 x 11.5" triangular podložka (right angle top-right,
  // hypotenuse cut off flat at the bottom tip so it can carry a bar), plain
  // rectangular L-wall bars: green at the right angle, small orange at the
  // bottom tip; tilted -31° by default. Arm lengths and tip width estimated.
  {
    id: "triangle-2",
    label: "Triangle 2",
    layer: "terrain",
    multiCombo: true,
    widthIn: 8,
    heightIn: 11.5,
    defaultRotationDeg: -31,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 0,
    clipPath: "polygon(0% 0%, 100% 0%, 100% 100%, 72% 100%)",
    parts: [
      // green L at the right angle (top-right)
      { leftPct: 46, topPct: 0, widthPct: 54, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 93.75, topPct: 0, widthPct: 6.25, heightPct: 41, bg: "#3f7a3f" },
      // orange L at the bottom tip
      { leftPct: 72, topPct: 95.7, widthPct: 28, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 93.75, topPct: 75, widthPct: 6.25, heightPct: 25, bg: "#d98b3a" },
    ],
  },
  // "Triangle 3" = near-twin of "Triangle 2" (same podložka/right-angle-top-
  // right layout), slightly shorter green arms and -33° default tilt.
  {
    id: "triangle-3",
    label: "Triangle 3",
    layer: "terrain",
    multiCombo: true,
    widthIn: 8,
    heightIn: 11.5,
    defaultRotationDeg: -33,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 0,
    clipPath: "polygon(0% 0%, 100% 0%, 100% 100%, 72% 100%)",
    parts: [
      { leftPct: 48, topPct: 0, widthPct: 52, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 93.75, topPct: 0, widthPct: 6.25, heightPct: 36, bg: "#3f7a3f" },
      { leftPct: 72, topPct: 95.7, widthPct: 28, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 93.75, topPct: 75, widthPct: 6.25, heightPct: 25, bg: "#d98b3a" },
    ],
  },
  // "Triangle 4" = 8 x 11.5" triangular podložka (right angle top-left,
  // hypotenuse cut off flat at the bottom-left tip), plain rectangular L-wall
  // bars: green at the right angle (long left arm, short top arm), small
  // orange at the tip; tilted 123° by default. Arms/tip width estimated.
  {
    id: "triangle-4",
    label: "Triangle 4",
    layer: "terrain",
    multiCombo: true,
    widthIn: 8,
    heightIn: 11.5,
    defaultRotationDeg: 123,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 0,
    clipPath: "polygon(0% 0%, 100% 0%, 28% 100%, 0% 100%)",
    parts: [
      { leftPct: 0, topPct: 0, widthPct: 75, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 0, widthPct: 6.25, heightPct: 34, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 95.7, widthPct: 28, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 0, topPct: 75, widthPct: 6.25, heightPct: 25, bg: "#d98b3a" },
    ],
  },
  // "Triangle 5" = same podložka/bars as "Triangle 4" (right angle top-left,
  // tip bottom-left) but tilted -33° by default with a longer top green arm.
  {
    id: "triangle-5",
    label: "Triangle 5",
    layer: "terrain",
    multiCombo: true,
    widthIn: 8,
    heightIn: 11.5,
    defaultRotationDeg: -33,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 0,
    clipPath: "polygon(0% 0%, 100% 0%, 28% 100%, 0% 100%)",
    parts: [
      { leftPct: 0, topPct: 0, widthPct: 56, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 0, widthPct: 6.25, heightPct: 36, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 95.7, widthPct: 28, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 0, topPct: 75, widthPct: 6.25, heightPct: 25, bg: "#d98b3a" },
    ],
  },
  // "Triangle 6" = same podložka/bars layout as "Triangle 1" (right angle
  // bottom-right, tip top-right) tilted 33° by default; green arms 60% (bottom)
  // and 37% (right), orange L at the top tip. Arms estimated.
  {
    id: "triangle-6",
    label: "Triangle 6",
    layer: "terrain",
    multiCombo: true,
    widthIn: 8,
    heightIn: 11.5,
    defaultRotationDeg: 33,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 0,
    clipPath: "polygon(72% 0%, 100% 0%, 100% 100%, 0% 100%)",
    parts: [
      { leftPct: 40, topPct: 95.7, widthPct: 60, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 93.75, topPct: 63, widthPct: 6.25, heightPct: 37, bg: "#3f7a3f" },
      { leftPct: 72, topPct: 0, widthPct: 28, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 93.75, topPct: 0, widthPct: 6.25, heightPct: 25, bg: "#d98b3a" },
    ],
  },
  // "Triangle 7" = "Triangle 4" layout (right angle top-left, tip
  // bottom-left) tilted 53°; green arms 59% (top) / 36% (left). Estimated.
  {
    id: "triangle-7",
    label: "Triangle 7",
    layer: "terrain",
    multiCombo: true,
    widthIn: 8,
    heightIn: 11.5,
    defaultRotationDeg: 53,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 0,
    clipPath: "polygon(0% 0%, 100% 0%, 28% 100%, 0% 100%)",
    parts: [
      { leftPct: 0, topPct: 0, widthPct: 59, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 0, widthPct: 6.25, heightPct: 36, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 95.7, widthPct: 28, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 0, topPct: 75, widthPct: 6.25, heightPct: 25, bg: "#d98b3a" },
    ],
  },
  // "Triangle 8" = 8 x 11.5" triangular podložka, upright (no tilt), right
  // angle bottom-left, tip cut flat at the top-left: green L at the right
  // angle (half-height left arm, long bottom arm), small orange L at the tip.
  {
    id: "triangle-8",
    label: "Triangle 8",
    layer: "terrain",
    multiCombo: true,
    widthIn: 8,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 0,
    clipPath: "polygon(0% 0%, 28% 0%, 100% 100%, 0% 100%)",
    parts: [
      { leftPct: 0, topPct: 95.7, widthPct: 75, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 50, widthPct: 6.25, heightPct: 50, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 0, widthPct: 28, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 0, topPct: 0, widthPct: 6.25, heightPct: 25, bg: "#d98b3a" },
    ],
  },
  // "Triangle 9" = "Triangle 2" layout (right angle top-right, tip
  // bottom-right) tilted -27°; green arms 54% (top) / 42% (right). Estimated.
  {
    id: "triangle-9",
    label: "Triangle 9",
    layer: "terrain",
    multiCombo: true,
    widthIn: 8,
    heightIn: 11.5,
    defaultRotationDeg: -27,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 0,
    clipPath: "polygon(0% 0%, 100% 0%, 100% 100%, 72% 100%)",
    parts: [
      { leftPct: 46, topPct: 0, widthPct: 54, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 93.75, topPct: 0, widthPct: 6.25, heightPct: 42, bg: "#3f7a3f" },
      { leftPct: 72, topPct: 95.7, widthPct: 28, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 93.75, topPct: 75, widthPct: 6.25, heightPct: 25, bg: "#d98b3a" },
    ],
  },
  // "Triangle 10" = "Triangle 2" layout tilted -77° (long leg pointing
  // right); green arms 49% (top) / 38% (right). Estimated.
  {
    id: "triangle-10",
    label: "Triangle 10",
    layer: "terrain",
    multiCombo: true,
    widthIn: 8,
    heightIn: 11.5,
    defaultRotationDeg: -77,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 0,
    clipPath: "polygon(0% 0%, 100% 0%, 100% 100%, 72% 100%)",
    parts: [
      { leftPct: 51, topPct: 0, widthPct: 49, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 93.75, topPct: 0, widthPct: 6.25, heightPct: 38, bg: "#3f7a3f" },
      { leftPct: 72, topPct: 95.7, widthPct: 28, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 93.75, topPct: 75, widthPct: 6.25, heightPct: 25, bg: "#d98b3a" },
    ],
  },
  // "Triangle 11" = "Triangle 1" layout (right angle bottom-right, tip
  // top-right) tilted 35°; green arms 62% (bottom) / 31% (right). Estimated.
  {
    id: "triangle-11",
    label: "Triangle 11",
    layer: "terrain",
    multiCombo: true,
    widthIn: 8,
    heightIn: 11.5,
    defaultRotationDeg: 35,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 0,
    clipPath: "polygon(72% 0%, 100% 0%, 100% 100%, 0% 100%)",
    parts: [
      { leftPct: 38, topPct: 95.7, widthPct: 62, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 93.75, topPct: 69, widthPct: 6.25, heightPct: 31, bg: "#3f7a3f" },
      { leftPct: 72, topPct: 0, widthPct: 28, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 93.75, topPct: 0, widthPct: 6.25, heightPct: 25, bg: "#d98b3a" },
    ],
  },
  // "Triangle 12" = upright (no tilt) "Triangle 2" layout: right angle
  // top-right, tip at bottom-right cut ~20% wide; green arms 51% (top) / 42%
  // (right), small orange L at the tip. Estimated.
  {
    id: "triangle-12",
    label: "Triangle 12",
    layer: "terrain",
    multiCombo: true,
    widthIn: 8,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 0,
    clipPath: "polygon(0% 0%, 100% 0%, 100% 100%, 80% 100%)",
    parts: [
      { leftPct: 49, topPct: 0, widthPct: 51, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 93.75, topPct: 0, widthPct: 6.25, heightPct: 42, bg: "#3f7a3f" },
      { leftPct: 80, topPct: 95.7, widthPct: 20, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 93.75, topPct: 75, widthPct: 6.25, heightPct: 25, bg: "#d98b3a" },
    ],
  },
  // "Triangle 13" = an 11.5 x 8" landscape triangular podložka (right angle
  // bottom-right, hypotenuse rising to the top-right, tip cut flat at the
  // left), upright: green L at the right angle (bottom arm 45%, right arm
  // 52%), small orange L at the bottom-left tip. Estimated.
  {
    id: "triangle-13",
    label: "Triangle 13",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 8,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 0,
    clipPath: "polygon(100% 0%, 100% 100%, 0% 100%, 0% 78%)",
    parts: [
      { leftPct: 55, topPct: 93.75, widthPct: 45, heightPct: 6.25, bg: "#3f7a3f" },
      { leftPct: 95.7, topPct: 48, widthPct: 4.3, heightPct: 52, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 93.75, widthPct: 14, heightPct: 6.25, bg: "#d98b3a" },
      { leftPct: 0, topPct: 78, widthPct: 4.3, heightPct: 22, bg: "#d98b3a" },
    ],
  },
  // "Triangle 14" = "Triangle 2" layout (right angle top-right, tip
  // bottom-right) tilted -14°; green arms 56% (top) / 40% (right). Estimated.
  {
    id: "triangle-14",
    label: "Triangle 14",
    layer: "terrain",
    multiCombo: true,
    widthIn: 8,
    heightIn: 11.5,
    defaultRotationDeg: -14,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 0,
    clipPath: "polygon(0% 0%, 100% 0%, 100% 100%, 72% 100%)",
    parts: [
      { leftPct: 44, topPct: 0, widthPct: 56, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 93.75, topPct: 0, widthPct: 6.25, heightPct: 40, bg: "#3f7a3f" },
      { leftPct: 72, topPct: 95.7, widthPct: 28, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 93.75, topPct: 75, widthPct: 6.25, heightPct: 25, bg: "#d98b3a" },
    ],
  },
  // "Triangle 15" = "Triangle 2" layout tilted -97° (long leg pointing
  // right); green arms 57% (top) / 43% (right). Estimated.
  {
    id: "triangle-15",
    label: "Triangle 15",
    layer: "terrain",
    multiCombo: true,
    widthIn: 8,
    heightIn: 11.5,
    defaultRotationDeg: -97,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 0,
    clipPath: "polygon(0% 0%, 100% 0%, 100% 100%, 72% 100%)",
    parts: [
      { leftPct: 43, topPct: 0, widthPct: 57, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 93.75, topPct: 0, widthPct: 6.25, heightPct: 43, bg: "#3f7a3f" },
      { leftPct: 72, topPct: 95.7, widthPct: 28, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 93.75, topPct: 75, widthPct: 6.25, heightPct: 25, bg: "#d98b3a" },
    ],
  },
  // "Triangle 16" = "Triangle 2" layout tilted 7°; green arms 45% (top) /
  // 41% (right). Estimated.
  {
    id: "triangle-16",
    label: "Triangle 16",
    layer: "terrain",
    multiCombo: true,
    widthIn: 8,
    heightIn: 11.5,
    defaultRotationDeg: 7,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 0,
    clipPath: "polygon(0% 0%, 100% 0%, 100% 100%, 72% 100%)",
    parts: [
      { leftPct: 55, topPct: 0, widthPct: 45, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 93.75, topPct: 0, widthPct: 6.25, heightPct: 41, bg: "#3f7a3f" },
      { leftPct: 72, topPct: 95.7, widthPct: 28, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 93.75, topPct: 75, widthPct: 6.25, heightPct: 25, bg: "#d98b3a" },
    ],
  },
  // "Triangle 17" = 11.5 x 8" landscape triangular podložka, upright: right
  // angle top-left, tip at top-right cut flat; green L at the right angle
  // (top arm 38%, left arm 67%), small orange L at the tip. Estimated.
  {
    id: "triangle-17",
    label: "Triangle 17",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 8,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 0,
    clipPath: "polygon(0% 0%, 100% 0%, 100% 28%, 0% 100%)",
    parts: [
      { leftPct: 0, topPct: 0, widthPct: 38, heightPct: 6.25, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 0, widthPct: 4.3, heightPct: 67, bg: "#3f7a3f" },
      { leftPct: 86, topPct: 0, widthPct: 14, heightPct: 6.25, bg: "#d98b3a" },
      { leftPct: 95.7, topPct: 0, widthPct: 4.3, heightPct: 22, bg: "#d98b3a" },
    ],
  },
  // "Large rectangle 37" = a plain 11.5 x 10" landscape podložka: green
  // L-walls top-left and bottom-right (~40% x ~38% arms) and small orange
  // L-walls top-right and bottom-left (~14% x ~16% arms), thin (~0.35") bars.
  // Arms measured off the layout schematic it was made for.
  {
    id: "large-rectangle-37",
    label: "Large rectangle 37",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 10,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 0, topPct: 0, widthPct: 39.5, heightPct: 3.5, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 0, widthPct: 3, heightPct: 37.5, bg: "#3f7a3f" },
      { leftPct: 60.5, topPct: 96.5, widthPct: 39.5, heightPct: 3.5, bg: "#3f7a3f" },
      { leftPct: 97, topPct: 61.5, widthPct: 3, heightPct: 38.5, bg: "#3f7a3f" },
      { leftPct: 86.1, topPct: 0, widthPct: 13.9, heightPct: 3.5, bg: "#d98b3a" },
      { leftPct: 97, topPct: 0, widthPct: 3, heightPct: 15.8, bg: "#d98b3a" },
      { leftPct: 0, topPct: 96.5, widthPct: 13.9, heightPct: 3.5, bg: "#d98b3a" },
      { leftPct: 0, topPct: 84.1, widthPct: 3, heightPct: 15.9, bg: "#d98b3a" },
    ],
  },
  // "Large rectangle 38" = a plain 11.5 x 7" landscape podložka: green L in
  // the top-left (40% top arm, long ~86% left arm) and green L in the
  // bottom-right (53% bottom arm, ~44% right arm). Measured off the layout
  // schematic it was made for.
  {
    id: "large-rectangle-38",
    label: "Large rectangle 38",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 7,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 0, topPct: 0, widthPct: 40, heightPct: 6.5, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 0, widthPct: 3.8, heightPct: 85.6, bg: "#3f7a3f" },
      { leftPct: 47, topPct: 93.5, widthPct: 53, heightPct: 6.5, bg: "#3f7a3f" },
      { leftPct: 96.2, topPct: 56.5, widthPct: 3.8, heightPct: 43.5, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 39" = a plain 7 x 11.5" portrait podložka: green L in
  // the top-left (66% top arm, ~53% left arm) and green L in the
  // bottom-right (87% bottom arm, ~27% right arm). Measured off the layout
  // schematic it was made for.
  {
    id: "large-rectangle-39",
    label: "Large rectangle 39",
    layer: "terrain",
    multiCombo: true,
    widthIn: 7,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 0, topPct: 0, widthPct: 66, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 0, widthPct: 7.1, heightPct: 53, bg: "#3f7a3f" },
      { leftPct: 13, topPct: 95.7, widthPct: 87, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 92.9, topPct: 73, widthPct: 7.1, heightPct: 27, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 40" = a plain 11.5 x 7" landscape podložka: green L in
  // the top-right (27% top arm, ~86% right arm) and green L in the
  // bottom-left (53% bottom arm, ~65% left arm). Measured off the layout
  // schematic it was made for.
  {
    id: "large-rectangle-40",
    label: "Large rectangle 40",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 7,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 73, topPct: 0, widthPct: 27, heightPct: 6.5, bg: "#3f7a3f" },
      { leftPct: 96.2, topPct: 0, widthPct: 3.8, heightPct: 86, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 93.5, widthPct: 53, heightPct: 6.5, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 35, widthPct: 3.8, heightPct: 65, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 41" = a plain 10 x 11.5" portrait podložka: green
  // L-walls top-left and bottom-right (45% x 31% arms) and small orange
  // L-walls top-right and bottom-left (15% x 13.5% arms), thin (~0.35")
  // bars — the same four-corner pattern as "Large rectangle 37", on a
  // portrait plate. Measured off the layout schematic it was made for.
  {
    id: "large-rectangle-41",
    label: "Large rectangle 41",
    layer: "terrain",
    multiCombo: true,
    widthIn: 10,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 0, topPct: 0, widthPct: 45, heightPct: 3.2, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 0, widthPct: 3.6, heightPct: 31, bg: "#3f7a3f" },
      { leftPct: 55, topPct: 96.8, widthPct: 45, heightPct: 3.2, bg: "#3f7a3f" },
      { leftPct: 96.4, topPct: 69, widthPct: 3.6, heightPct: 31, bg: "#3f7a3f" },
      { leftPct: 85, topPct: 0, widthPct: 15, heightPct: 3.2, bg: "#d98b3a" },
      { leftPct: 96.4, topPct: 0, widthPct: 3.6, heightPct: 13.5, bg: "#d98b3a" },
      { leftPct: 0, topPct: 96.8, widthPct: 15, heightPct: 3.2, bg: "#d98b3a" },
      { leftPct: 0, topPct: 86.5, widthPct: 3.6, heightPct: 13.5, bg: "#d98b3a" },
    ],
  },
  // "Large rectangle 42" = a plain 10 x 11.5" portrait podložka: green
  // L-walls top-right (38% x 40% arms) and bottom-left (39% x 39% arms) and
  // small orange L-walls top-left and bottom-right (15.5% x 14% arms) — the
  // left-right mirror of "Large rectangle 41". Measured off the layout
  // schematic it was made for.
  {
    id: "large-rectangle-42",
    label: "Large rectangle 42",
    layer: "terrain",
    multiCombo: true,
    widthIn: 10,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 62, topPct: 0, widthPct: 38, heightPct: 3.2, bg: "#3f7a3f" },
      { leftPct: 96.4, topPct: 0, widthPct: 3.6, heightPct: 40, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 96.8, widthPct: 39, heightPct: 3.2, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 61, widthPct: 3.6, heightPct: 39, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 0, widthPct: 15.5, heightPct: 3.2, bg: "#d98b3a" },
      { leftPct: 0, topPct: 0, widthPct: 3.6, heightPct: 14, bg: "#d98b3a" },
      { leftPct: 84.5, topPct: 96.8, widthPct: 15.5, heightPct: 3.2, bg: "#d98b3a" },
      { leftPct: 96.4, topPct: 86.5, widthPct: 3.6, heightPct: 13.5, bg: "#d98b3a" },
    ],
  },
  // "Large rectangle 43" = a plain 7 x 11.5" portrait podložka: green L in
  // the top-right (44% top arm, ~52% right arm) and green L in the
  // bottom-left (86% bottom arm, ~23% left arm). Measured off the layout
  // schematic it was made for.
  {
    id: "large-rectangle-43",
    label: "Large rectangle 43",
    layer: "terrain",
    multiCombo: true,
    widthIn: 7,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 56, topPct: 0, widthPct: 44, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 92.9, topPct: 0, widthPct: 7.1, heightPct: 52, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 95.7, widthPct: 86, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 77, widthPct: 7.1, heightPct: 23, bg: "#3f7a3f" },
    ],
  },
  // "Medium rectangle open 13" = a 4 x 6" portrait podložka with two orange
  // L-brackets in opposite corners (top-left 47% x 45% arms, bottom-right
  // 43% x 43% arms, ~0.5" thick) — the portrait counterpart of the "open"
  // modules, placed tilted -23° by default. Measured off the layout schematic
  // it was made for.
  {
    id: "h-blok-open-13",
    label: "Medium rectangle open 13",
    layer: "terrain",
    multiCombo: true,
    widthIn: 4,
    heightIn: 6,
    defaultRotationDeg: 337,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 0, topPct: 0, widthPct: 47, heightPct: 8.3, bg: "#d98b3a" },
      { leftPct: 0, topPct: 0, widthPct: 12.5, heightPct: 45, bg: "#d98b3a" },
      { leftPct: 57, topPct: 91.7, widthPct: 43, heightPct: 8.3, bg: "#d98b3a" },
      { leftPct: 87.5, topPct: 57, widthPct: 12.5, heightPct: 43, bg: "#d98b3a" },
    ],
  },
  // "Large rectangle 44" = a plain 7 x 11.5" portrait podložka: orange L in
  // the top-left (37% top arm, short ~15% left arm) and green L in the
  // bottom-right (37% bottom arm, ~53% right arm). Measured off the layout
  // schematic it was made for.
  {
    id: "large-rectangle-44",
    label: "Large rectangle 44",
    layer: "terrain",
    multiCombo: true,
    widthIn: 7,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 0, topPct: 0, widthPct: 37, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 0, topPct: 0, widthPct: 7.1, heightPct: 15, bg: "#d98b3a" },
      { leftPct: 63, topPct: 95.7, widthPct: 37, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 92.9, topPct: 47, widthPct: 7.1, heightPct: 53, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 45" = a plain 7 x 11.5" portrait podložka: green L in
  // the top-left (87% top arm, ~27% left arm) and green L in the
  // bottom-right (38% bottom arm, ~52% right arm). Measured off the layout
  // schematic it was made for.
  {
    id: "large-rectangle-45",
    label: "Large rectangle 45",
    layer: "terrain",
    multiCombo: true,
    widthIn: 7,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 0, topPct: 0, widthPct: 87, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 0, widthPct: 7.1, heightPct: 27, bg: "#3f7a3f" },
      { leftPct: 62, topPct: 95.7, widthPct: 38, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 92.9, topPct: 48, widthPct: 7.1, heightPct: 52, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 46" = a plain 11.5 x 7" landscape podložka: green L in
  // the bottom-left (53% bottom arm, 65% left arm) and a small orange L in
  // the top-right (14% top arm, ~37% right arm). Measured off the layout
  // schematic it was made for.
  {
    id: "large-rectangle-46",
    label: "Large rectangle 46",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 7,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 0, topPct: 93.5, widthPct: 53, heightPct: 6.5, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 35, widthPct: 3.8, heightPct: 65, bg: "#3f7a3f" },
      { leftPct: 86, topPct: 0, widthPct: 14, heightPct: 6.5, bg: "#d98b3a" },
      { leftPct: 96.2, topPct: 0, widthPct: 3.8, heightPct: 37, bg: "#d98b3a" },
    ],
  },
  // "Large rectangle 47" = a plain 11.5 x 7" landscape podložka: green L in
  // the top-right (27% top arm, ~86% right arm) and green L in the
  // bottom-left (53% bottom arm, ~38% left arm). Measured off the layout
  // schematic it was made for.
  {
    id: "large-rectangle-47",
    label: "Large rectangle 47",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 7,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 73, topPct: 0, widthPct: 27, heightPct: 6.5, bg: "#3f7a3f" },
      { leftPct: 96.2, topPct: 0, widthPct: 3.8, heightPct: 86, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 93.5, widthPct: 53, heightPct: 6.5, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 62, widthPct: 3.8, heightPct: 38, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 48" = a plain 7 x 11.5" portrait podložka: green L in
  // the top-right (44% top arm, ~52% right arm) and a small orange L in the
  // bottom-right (37% bottom arm, ~15% right arm). Measured off the layout
  // schematic it was made for.
  {
    id: "large-rectangle-48",
    label: "Large rectangle 48",
    layer: "terrain",
    multiCombo: true,
    widthIn: 7,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 56, topPct: 0, widthPct: 44, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 92.9, topPct: 0, widthPct: 7.1, heightPct: 52, bg: "#3f7a3f" },
      { leftPct: 63, topPct: 95.7, widthPct: 37, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 92.9, topPct: 85, widthPct: 7.1, heightPct: 15, bg: "#d98b3a" },
    ],
  },
  // "Large rectangle 49" = a plain 11.5 x 7" landscape podložka: green L in
  // the top-right (29% top arm, ~96% right arm) and a green L in the
  // bottom-left (57% bottom arm, ~73% left arm). Measured off the layout
  // schematic it was made for.
  {
    id: "large-rectangle-49",
    label: "Large rectangle 49",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 7,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 71, topPct: 0, widthPct: 29, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 95.7, topPct: 0, widthPct: 4.3, heightPct: 96, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 92.9, widthPct: 57, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 27, widthPct: 4.3, heightPct: 73, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 50" = a plain 11.5 x 7" landscape podložka: green L in
  // the bottom-left (57% bottom arm, 37% left arm) and a small orange L in
  // the bottom-right (24% bottom arm, 22% right arm). Measured off the
  // layout schematic it was made for.
  {
    id: "large-rectangle-50",
    label: "Large rectangle 50",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 7,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 0, topPct: 92.9, widthPct: 57, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 63, widthPct: 4.3, heightPct: 37, bg: "#3f7a3f" },
      { leftPct: 76, topPct: 92.9, widthPct: 24, heightPct: 7.1, bg: "#d98b3a" },
      { leftPct: 95.7, topPct: 78, widthPct: 4.3, heightPct: 22, bg: "#d98b3a" },
    ],
  },
  // "Large rectangle 51" = a plain 7 x 11.5" portrait podložka: green L in
  // the bottom-left (91% bottom arm, 25% left arm) and a small orange L in
  // the top-right (26% top arm, 25% right arm). Measured off the layout
  // schematic it was made for.
  {
    id: "large-rectangle-51",
    label: "Large rectangle 51",
    layer: "terrain",
    multiCombo: true,
    widthIn: 7,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 0, topPct: 95.7, widthPct: 91, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 75, widthPct: 7.1, heightPct: 25, bg: "#3f7a3f" },
      { leftPct: 74, topPct: 0, widthPct: 26, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 92.9, topPct: 0, widthPct: 7.1, heightPct: 25, bg: "#d98b3a" },
    ],
  },
  // "Large rectangle 52" = a plain 7 x 11.5" portrait podložka: green L in
  // the top-right (44% top arm, 53% right arm) and a green L in the
  // bottom-left (86% bottom arm, 37% left arm). Measured off the layout
  // schematic it was made for.
  {
    id: "large-rectangle-52",
    label: "Large rectangle 52",
    layer: "terrain",
    multiCombo: true,
    widthIn: 7,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 56, topPct: 0, widthPct: 44, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 92.9, topPct: 0, widthPct: 7.1, heightPct: 53, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 95.7, widthPct: 86, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 63, widthPct: 7.1, heightPct: 37, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 53" = a plain 7 x 11.5" portrait podložka: orange L in
  // the top-left (37% top arm, 14% left arm) and a green L in the
  // bottom-right (71% bottom arm, 53% right arm). Measured off the layout
  // schematic it was made for.
  {
    id: "large-rectangle-53",
    label: "Large rectangle 53",
    layer: "terrain",
    multiCombo: true,
    widthIn: 7,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 0, topPct: 0, widthPct: 37, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 0, topPct: 0, widthPct: 7.1, heightPct: 14, bg: "#d98b3a" },
      { leftPct: 29, topPct: 95.7, widthPct: 71, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 92.9, topPct: 47, widthPct: 7.1, heightPct: 53, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 54" = a plain 11.5 x 7" landscape podložka: small orange
  // L in the bottom-left (17% bottom arm, 37% left arm) and a green L in the
  // bottom-right (55% bottom arm, 46% right arm). Measured off the layout
  // schematic it was made for.
  {
    id: "large-rectangle-54",
    label: "Large rectangle 54",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 7,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 0, topPct: 92.9, widthPct: 17, heightPct: 7.1, bg: "#d98b3a" },
      { leftPct: 0, topPct: 63, widthPct: 3.8, heightPct: 37, bg: "#d98b3a" },
      { leftPct: 45, topPct: 92.9, widthPct: 55, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 96.2, topPct: 54, widthPct: 3.8, heightPct: 46, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 55" = a plain 11.5 x 7" landscape podložka: green L in
  // the top-right (29% top arm, ~96% right arm) and a green L in the
  // bottom-left (57% bottom arm, 41% left arm). Measured off the layout
  // schematic it was made for.
  {
    id: "large-rectangle-55",
    label: "Large rectangle 55",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 7,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 71, topPct: 0, widthPct: 29, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 95.7, topPct: 0, widthPct: 4.3, heightPct: 96, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 92.9, widthPct: 57, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 59, widthPct: 4.3, heightPct: 41, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 56" = a plain 7 x 11.5" portrait podložka: small orange
  // L in the top-left (40% top arm, 15% left arm) and a green L in the
  // bottom-right (42% bottom arm, 57% right arm). Measured off the layout
  // schematic it was made for.
  {
    id: "large-rectangle-56",
    label: "Large rectangle 56",
    layer: "terrain",
    multiCombo: true,
    widthIn: 7,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 0, topPct: 0, widthPct: 40, heightPct: 4.3, bg: "#d98b3a" },
      { leftPct: 0, topPct: 0, widthPct: 7.1, heightPct: 15, bg: "#d98b3a" },
      { leftPct: 58, topPct: 95.7, widthPct: 42, heightPct: 4.3, bg: "#3f7a3f" },
      { leftPct: 92.9, topPct: 43, widthPct: 7.1, heightPct: 57, bg: "#3f7a3f" },
    ],
  },
  // "Large rectangle 57" = a 10 x 11.5" portrait four-corner centre plate:
  // green L in the top-left (49% top arm, 36% left arm) and bottom-right,
  // small orange L (17% / 14.5%) in the top-right and bottom-left. Measured
  // off the layout schematic it was made for.
  {
    id: "large-rectangle-57",
    label: "Large rectangle 57",
    layer: "terrain",
    multiCombo: true,
    widthIn: 10,
    heightIn: 11.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 0, topPct: 0, widthPct: 49, heightPct: 3.2, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 0, widthPct: 3.6, heightPct: 36, bg: "#3f7a3f" },
      { leftPct: 51, topPct: 96.8, widthPct: 49, heightPct: 3.2, bg: "#3f7a3f" },
      { leftPct: 96.4, topPct: 64, widthPct: 3.6, heightPct: 36, bg: "#3f7a3f" },
      { leftPct: 83, topPct: 0, widthPct: 17, heightPct: 3.2, bg: "#d98b3a" },
      { leftPct: 96.4, topPct: 0, widthPct: 3.6, heightPct: 14.5, bg: "#d98b3a" },
      { leftPct: 0, topPct: 96.8, widthPct: 17, heightPct: 3.2, bg: "#d98b3a" },
      { leftPct: 0, topPct: 85.5, widthPct: 3.6, heightPct: 14.5, bg: "#d98b3a" },
    ],
  },
  // "Large rectangle 58" = a plain 11.5 x 7" landscape podložka: green L in
  // the top-left (42% top arm, ~95% left arm) and a green L in the
  // bottom-right (56% bottom arm, 47% right arm). Measured off the layout
  // schematic it was made for.
  {
    id: "large-rectangle-58",
    label: "Large rectangle 58",
    layer: "terrain",
    multiCombo: true,
    widthIn: 11.5,
    heightIn: 7,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      { leftPct: 0, topPct: 0, widthPct: 42, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 0, topPct: 0, widthPct: 4.3, heightPct: 95, bg: "#3f7a3f" },
      { leftPct: 44, topPct: 92.9, widthPct: 56, heightPct: 7.1, bg: "#3f7a3f" },
      { leftPct: 95.7, topPct: 53, widthPct: 4.3, heightPct: 47, bg: "#3f7a3f" },
    ],
  },
  // "Medium rectangle 1" = an 8 x 5.5" landscape podložka module: orange
  // L-walls in the top-left and bottom-right corners (arms ~a third of the
  // edge, ~0.5" thick — estimated).
  {
    id: "medium-rectangle-1",
    label: "Medium rectangle 1",
    layer: "terrain",
    multiCombo: true,
    widthIn: 8,
    heightIn: 5.5,
    bg: "rgba(160,150,120,0.5)",
    border: "1px solid rgba(210,200,170,0.7)",
    radius: 3,
    parts: [
      // orange L, top-left
      { leftPct: 0, topPct: 0, widthPct: 38, heightPct: 8, bg: "#d98b3a" },
      { leftPct: 0, topPct: 0, widthPct: 6, heightPct: 46, bg: "#d98b3a" },
      // orange L, bottom-right
      { leftPct: 62, topPct: 92, widthPct: 38, heightPct: 8, bg: "#d98b3a" },
      { leftPct: 94, topPct: 54, widthPct: 6, heightPct: 46, bg: "#d98b3a" },
    ],
  },
  { id: "wall", label: "Zeď", layer: "terrain", widthIn: 6, heightIn: 1, bg: "#6b6b61", border: "1px solid #8f8f7e", radius: 2 },
  { id: "crater", label: "Kráter", layer: "terrain", widthIn: 5, heightIn: 5, bg: "#4a4436", border: "2px dashed #8a7a4f", radius: "50%" },
  { id: "forest", label: "Les", layer: "terrain", widthIn: 6, heightIn: 6, bg: "rgba(58,92,58,0.6)", border: "2px dashed #5e9a5e", radius: "50%" },
  { id: "container", label: "Kontejner", layer: "terrain", widthIn: 3, heightIn: 2, bg: "#5a6b7d", border: "1px solid #82a0b8", radius: 3 },
  { id: "base-plinth", label: "Podložka", layer: "base", widthIn: 6, heightIn: 4, bg: "rgba(160,150,120,0.5)", border: "1px solid rgba(210,200,170,0.7)", radius: 3 },
];

// Ready-made board layouts the person drew themselves out of the modules in
// TERRAIN_SHAPES: a deployment zone as rectangles (inches, "mine" side only —
// the opponent's side is its diagonal mirror) plus pieces given as center
// position in inches, size and rotation. A layout can list just one half and
// set mirror: true to add the 180°-rotated copy of every non-center piece.
// Loaded with the "Hotová rozložení" button on the Deska tab, which replaces
// the board's zone and terrain.
const MIRROR_1_LAYOUT = {
    widthIn: 44,
    heightIn: 60,
    zoneMine: [
      { x1: 0, y1: 0, x2: 22, y2: 20 },
      { x1: 22, y1: 0, x2: 44, y2: 12 },
    ],
    mirror: true,
    pieces: [
      { shapeId: "long-line-combi-10", cx: 7, cy: 15.5, widthIn: 10, heightIn: 2, rot: 0 },
      { shapeId: "large-rectangle-1", cx: 17.5, cy: 11.75, widthIn: 7, heightIn: 11.5, rot: 0 },
      { shapeId: "h-blok-open-7", cx: 31, cy: 11, widthIn: 6, heightIn: 4, rot: 180 },
      { shapeId: "large-rectangle-29", cx: 37.5, cy: 18.75, widthIn: 7, heightIn: 11.5, rot: 0 },
      { shapeId: "long-line-2", cx: 24, cy: 18.5, widthIn: 6, heightIn: 2, rot: 0 },
      { shapeId: "h-blok-1", cx: 10, cy: 25, widthIn: 4, heightIn: 6, rot: 180 },
      { shapeId: "short-line-5", cx: 7, cy: 29, widthIn: 6, heightIn: 2, rot: 180 },
      { shapeId: "large-rectangle-37", cx: 22, cy: 30, widthIn: 11.5, heightIn: 10, rot: 0, center: true },
    ],
};
const OBJ_MARKER = { widthIn: 1.6, heightIn: 1.6, rot: 0, marker: true };
// Map C: the zone is the top-left quarter of the board minus a 9" circle
// around its centre (angles 180-270° from the centre; 0° = right, 90° =
// down); the opponent's zone is its diagonal mirror (bottom-right).
const MIRROR_C_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMineSector: { cx: 22, cy: 30, r: 9, angleStart: 180, angleEnd: 270 },
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-36", cx: 10.4, cy: 9.5, widthIn: 11.5, heightIn: 7, rot: 314 },
    { shapeId: "long-line-combi-10", cx: 22.5, cy: 14, widthIn: 10, heightIn: 2, rot: 325 },
    { shapeId: "large-rectangle-33", cx: 33.4, cy: 12.3, widthIn: 7, heightIn: 11.5, rot: 8 },
    { shapeId: "h-blok-open-7", cx: 13, cy: 20, widthIn: 6, heightIn: 4, rot: 90 },
    { shapeId: "long-line-2", cx: 8, cy: 24, widthIn: 6, heightIn: 2, rot: 0 },
    { shapeId: "h-blok-1", cx: 11, cy: 33, widthIn: 4, heightIn: 6, rot: 180 },
    { shapeId: "short-line-5", cx: 8, cy: 37, widthIn: 6, heightIn: 2, rot: 180 },
    { shapeId: "large-rectangle-37", cx: 22, cy: 30, widthIn: 11.5, heightIn: 10, rot: 0, center: true },
  ],
};
// Map B: two vertical deployment strips (12" wide, full height; the left
// one is "mine", the opponent's is its diagonal mirror on the right) and
// pieces tilted at various angles. The centre is two "Medium rectangle full"
// plates (6 x 4" each) stacked, one turned 180°.
const MIRROR_B_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [{ x1: 0, y1: 0, x2: 12, y2: 60 }],
  mirror: true,
  pieces: [
    { shapeId: "short-line-5", cx: 8.4, cy: 7.95, widthIn: 6, heightIn: 2, rot: 34 },
    { shapeId: "long-line-combi-10", cx: 9.7, cy: 15.35, widthIn: 10, heightIn: 2, rot: 113 },
    { shapeId: "large-rectangle-30", cx: 7.5, cy: 30.1, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "h-blok-open-7", cx: 37.6, cy: 10.6, widthIn: 6, heightIn: 4, rot: 317 },
    { shapeId: "long-line-2", cx: 37.05, cy: 17.4, widthIn: 6, heightIn: 2, rot: 65 },
    { shapeId: "triangle-9", cx: 16.4, cy: 19.95, widthIn: 8, heightIn: 11.5, rot: 42 },
    { shapeId: "large-rectangle-38", cx: 25.3, cy: 9.55, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "h-blok-3", cx: 22, cy: 28, widthIn: 6, heightIn: 4, rot: 180, center: true },
    { shapeId: "h-blok-3", cx: 22, cy: 32, widthIn: 6, heightIn: 4, rot: 0, center: true },
  ],
};
// Take and Hold vs Purge the Foe A: deployment zone = two stacked rectangles
// on the left (14" x 30" on top, 8" x 30" below; the opponent's is the
// diagonal mirror), ruins tilted at various angles, two triangles in the
// middle carrying the centre objectives.
const MIRROR_PTF_A_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [
    { x1: 0, y1: 0, x2: 14, y2: 30 },
    { x1: 0, y1: 30, x2: 8, y2: 60 },
  ],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-30", cx: 8.4, cy: 11.8, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "large-rectangle-39", cx: 30.5, cy: 10.8, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "short-line-5", cx: 20.5, cy: 11.8, widthIn: 6, heightIn: 2, rot: 228 },
    { shapeId: "h-blok-2", cx: 19.7, cy: 16.8, widthIn: 6, heightIn: 4, rot: 316 },
    { shapeId: "h-blok-open-7", cx: 9.65, cy: 24.45, widthIn: 6, heightIn: 4, rot: 43 },
    { shapeId: "long-line-combi-10", cx: 7.5, cy: 32.25, widthIn: 10, heightIn: 2, rot: 313 },
    { shapeId: "long-line-2", cx: 37.05, cy: 17.55, widthIn: 6, heightIn: 2, rot: 0 },
    { shapeId: "triangle-9", cx: 24.2, cy: 27.4, widthIn: 8, heightIn: 11.5, rot: 7 },
  ],
};
// Take and Hold vs Purge the Foe B: same zone as Map C (top-left quarter
// minus a 9" circle around the centre, opponent's the diagonal mirror),
// mostly upright ruins, two tilted combos and two tilted triangles in the
// middle carrying the centre objectives.
const MIRROR_PTF_B_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMineSector: { cx: 22, cy: 30, r: 9, angleStart: 180, angleEnd: 270 },
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-30", cx: 8.4, cy: 10.9, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "large-rectangle-40", cx: 34.2, cy: 10.7, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "h-blok-2", cx: 19.1, cy: 17.2, widthIn: 6, heightIn: 4, rot: 0 },
    { shapeId: "short-line-5", cx: 22.8, cy: 11.9, widthIn: 6, heightIn: 2, rot: 270 },
    { shapeId: "long-line-combi-10", cx: 35.75, cy: 22, widthIn: 10, heightIn: 2, rot: 140 },
    { shapeId: "long-line-2", cx: 11.2, cy: 23.1, widthIn: 6, heightIn: 2, rot: 90 },
    { shapeId: "h-blok-open-7", cx: 7.15, cy: 28, widthIn: 6, heightIn: 4, rot: 0 },
    { shapeId: "triangle-9", cx: 23.4, cy: 27.8, widthIn: 8, heightIn: 11.5, rot: 345 },
  ],
};
// Take and Hold vs Purge the Foe C: deployment zone = a full-width strip
// along the top (44" x 18"), the opponent's the mirror along the bottom;
// ruins mostly upright, a tilted open piece + frame in the top-right corner
// (mirrored bottom-left) and two tilted triangles in the middle carrying the
// centre objectives.
const MIRROR_PTF_C_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [{ x1: 0, y1: 0, x2: 44, y2: 18 }],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-35", cx: 10.9, cy: 10.7, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "h-blok-open-7", cx: 29.9, cy: 11.6, widthIn: 6, heightIn: 4, rot: 218 },
    { shapeId: "long-line-2", cx: 36.2, cy: 10.7, widthIn: 6, heightIn: 2, rot: 313 },
    { shapeId: "long-line-combi-10", cx: 22, cy: 17.7, widthIn: 10, heightIn: 2, rot: 0 },
    { shapeId: "h-blok-1", cx: 10.2, cy: 22, widthIn: 4, heightIn: 6, rot: 180 },
    { shapeId: "short-line-5", cx: 7.4, cy: 25.7, widthIn: 6, heightIn: 2, rot: 0 },
    { shapeId: "large-rectangle-40", cx: 35.9, cy: 22.3, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "triangle-2", cx: 21.8, cy: 27.2, widthIn: 8, heightIn: 11.5, rot: 258 },
  ],
};
// Order of the buttons in the "Mapa" box.
const LAYOUT_TEMPLATE_ORDER = ["mirror-1", "mirror-1b", "mirror-c", "ptf-a", "ptf-b", "ptf-c", "rec-a", "rec-b", "rec-c", "pri-a", "pri-b", "pri-c", "dis-a", "dis-b", "dis-c", "ptfptf-a", "ptfptf-b", "ptfptf-c", "ptfrec-a", "ptfrec-b", "ptfrec-c", "ptfpri-a", "ptfpri-b", "ptfpri-c", "ptfdis-a", "ptfdis-b", "ptfdis-c", "recrec-a", "recrec-b", "recrec-c", "recpri-a", "recpri-b", "recpri-c", "recdis-a", "recdis-b", "recdis-c", "pripri-a", "pripri-b", "pripri-c", "pridis-a", "pridis-b", "pridis-c", "disdis-a", "disdis-b", "disdis-c"];
// Mission pickers above the map buttons: "Take and Hold vs Purge the Foe A"
// -> missions {Take and Hold, Purge the Foe} + variant "A". The pair is
// unordered, so it doesn't matter which side the player picks first.
const MAP_MISSIONS = ["Take and Hold", "Purge the Foe", "Reconnaissance", "Priority Assets", "Disruption"];
const MAP_VARIANTS = ["A", "B", "C"];
const parseMapMission = (m) => {
  const mt = /^(.*) vs (.*) ([A-C])$/.exec(m || "");
  return mt ? { a: mt[1], b: mt[2], v: mt[3] } : null;
};
const mapPairKey = (a, b) => [a, b].sort().join("|");
// Take and Hold vs Reconnaissance A: same two-rectangle zone as Map A
// (22" x 20" + 22" x 12", the opponent's the diagonal mirror), all ruins
// upright, a 10 x 11.5" four-corner plate in the middle carrying the centre
// objective.
const MIRROR_REC_A_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [
    { x1: 0, y1: 0, x2: 22, y2: 20 },
    { x1: 22, y1: 0, x2: 44, y2: 12 },
  ],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-35", cx: 12.8, cy: 8.4, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "h-blok-open-7", cx: 25.5, cy: 11.05, widthIn: 6, heightIn: 4, rot: 0 },
    { shapeId: "large-rectangle-40", cx: 34.3, cy: 16.5, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "h-blok-2", cx: 17.1, cy: 17.3, widthIn: 6, heightIn: 4, rot: 0 },
    { shapeId: "long-line-combi-10", cx: 9.15, cy: 20.6, widthIn: 10, heightIn: 2, rot: 0 },
    { shapeId: "long-line-2", cx: 11.1, cy: 28.9, widthIn: 6, heightIn: 2, rot: 90 },
    { shapeId: "short-line-5", cx: 7.8, cy: 32.8, widthIn: 6, heightIn: 2, rot: 180 },
    { shapeId: "large-rectangle-41", cx: 22, cy: 30, widthIn: 10, heightIn: 11.5, rot: 0, center: true },
  ],
};
// Take and Hold vs Reconnaissance B: two vertical deployment strips (12"
// wide, the left one "mine", the opponent's its diagonal mirror on the
// right), ruins tilted at various angles around a 10 x 11.5" four-corner plate
// in the middle.
const MIRROR_REC_B_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [{ x1: 0, y1: 0, x2: 12, y2: 60 }],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-30", cx: 7.7, cy: 13.8, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "large-rectangle-39", cx: 27.4, cy: 10.9, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "long-line-combi-10", cx: 17.15, cy: 13.05, widthIn: 10, heightIn: 2, rot: 116 },
    { shapeId: "h-blok-2", cx: 10.7, cy: 26.8, widthIn: 6, heightIn: 4, rot: 225 },
    { shapeId: "short-line-5", cx: 9.6, cy: 32.8, widthIn: 6, heightIn: 2, rot: 320 },
    { shapeId: "h-blok-open-7", cx: 36.4, cy: 15.55, widthIn: 6, heightIn: 4, rot: 224 },
    { shapeId: "long-line-2", cx: 37.3, cy: 9.2, widthIn: 6, heightIn: 2, rot: 131 },
    { shapeId: "large-rectangle-42", cx: 22, cy: 30, widthIn: 10, heightIn: 11.5, rot: 0, center: true },
  ],
};
// Take and Hold vs Reconnaissance C: same zone as Map C (top-left quarter
// minus a 9" circle around the centre, the opponent's the diagonal mirror),
// a tilted flag plate and a tilted combo, around a 10 x 11.5" four-corner
// plate in the middle.
const MIRROR_REC_C_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMineSector: { cx: 22, cy: 30, r: 9, angleStart: 180, angleEnd: 270 },
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-30", cx: 8.7, cy: 11.95, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "long-line-2", cx: 19.2, cy: 16.1, widthIn: 6, heightIn: 2, rot: 0 },
    { shapeId: "h-blok-open-7", cx: 24.2, cy: 12.05, widthIn: 6, heightIn: 4, rot: 90 },
    { shapeId: "large-rectangle-38", cx: 34.2, cy: 13.3, widthIn: 11.5, heightIn: 7, rot: 230 },
    { shapeId: "long-line-combi-10", cx: 10.25, cy: 23.2, widthIn: 10, heightIn: 2, rot: 143 },
    { shapeId: "h-blok-1", cx: 11.2, cy: 32.9, widthIn: 4, heightIn: 6, rot: 180 },
    { shapeId: "short-line-5", cx: 8, cy: 36.8, widthIn: 6, heightIn: 2, rot: 180 },
    { shapeId: "large-rectangle-41", cx: 22, cy: 30, widthIn: 10, heightIn: 11.5, rot: 0, center: true },
  ],
};
// Take and Hold vs Priority Assets A: the deployment zone is a right
// triangle in the top-left (corners (0,0), (44,0), (0,30); the opponent's is
// its diagonal mirror), ruins tilted at various angles, two triangle plates
// in the middle carrying the centre objectives.
const MIRROR_PRIORITY_A_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMinePoly: [[[0, 0], [44, 0], [0, 30]]],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-35", cx: 10.8, cy: 8.6, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "long-line-combi-10", cx: 23.95, cy: 11.35, widthIn: 10, heightIn: 2, rot: 143 },
    { shapeId: "large-rectangle-40", cx: 34.1, cy: 15.3, widthIn: 11.5, heightIn: 7, rot: 328 },
    { shapeId: "h-blok-open-7", cx: 7.7, cy: 21.85, widthIn: 6, heightIn: 4, rot: 140 },
    { shapeId: "long-line-2", cx: 13.2, cy: 19.1, widthIn: 6, heightIn: 2, rot: 323 },
    { shapeId: "h-blok-1", cx: 33.9, cy: 29, widthIn: 4, heightIn: 6, rot: 0 },
    { shapeId: "short-line-5", cx: 36.9, cy: 25.3, widthIn: 6, heightIn: 2, rot: 180 },
    { shapeId: "triangle-9", cx: 20.25, cy: 22.95, widthIn: 8, heightIn: 11.5, rot: 90 },
  ],
};
// Take and Hold vs Priority Assets B: same strips as Purge the Foe C (a
// 44" x 18" zone along the top, the opponent's along the bottom), ruins
// mostly upright, two tilted triangles in the middle carrying the centre
// objectives.
const MIRROR_PRIORITY_B_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [{ x1: 0, y1: 0, x2: 44, y2: 18 }],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-35", cx: 11.8, cy: 10.7, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "h-blok-2", cx: 34.8, cy: 10.8, widthIn: 6, heightIn: 4, rot: 0 },
    { shapeId: "long-line-combi-10", cx: 27.2, cy: 14.3, widthIn: 10, heightIn: 2, rot: 0 },
    { shapeId: "long-line-2", cx: 9.3, cy: 20.5, widthIn: 6, heightIn: 2, rot: 90 },
    { shapeId: "short-line-5", cx: 7.0, cy: 23.9, widthIn: 6, heightIn: 2, rot: 180 },
    { shapeId: "h-blok-open-7", cx: 29, cy: 22.05, widthIn: 6, heightIn: 4, rot: 180 },
    { shapeId: "large-rectangle-43", cx: 37.3, cy: 24.6, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "triangle-2", cx: 19.3, cy: 27, widthIn: 8, heightIn: 11.5, rot: 300 },
  ],
};
// Take and Hold vs Priority Assets C: two vertical deployment strips (12"
// wide, the left one "mine", the opponent's its diagonal mirror), most ruins
// tilted, two tilted triangles in the middle carrying the centre objectives.
const MIRROR_PRIORITY_C_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [{ x1: 0, y1: 0, x2: 12, y2: 60 }],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-39", cx: 26.7, cy: 9.9, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "large-rectangle-30", cx: 6.5, cy: 21.8, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "long-line-combi-10", cx: 9.6, cy: 32.55, widthIn: 10, heightIn: 2, rot: 287 },
    { shapeId: "h-blok-2", cx: 14.6, cy: 14.7, widthIn: 6, heightIn: 4, rot: 335 },
    { shapeId: "short-line-5", cx: 16.1, cy: 9.4, widthIn: 6, heightIn: 2, rot: 242 },
    { shapeId: "h-blok-open-7", cx: 37.4, cy: 8.6, widthIn: 6, heightIn: 4, rot: 128 },
    { shapeId: "long-line-2", cx: 37.1, cy: 15.4, widthIn: 6, heightIn: 2, rot: 70 },
    { shapeId: "triangle-7", cx: 22.1, cy: 25.8, widthIn: 8, heightIn: 11.5, rot: 60 },
  ],
};
// Take and Hold vs Disruption A: same stepped two-rectangle zone as Purge the
// Foe A (14" x 30" on top, 8" x 30" below on the left; the opponent's the
// diagonal mirror), ruins tilted at various angles around a 10 x 11.5"
// four-corner plate in the middle.
const MIRROR_DISRUPTION_A_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [
    { x1: 0, y1: 0, x2: 14, y2: 30 },
    { x1: 0, y1: 30, x2: 8, y2: 60 },
  ],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-30", cx: 7.7, cy: 10.9, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "large-rectangle-43", cx: 30.3, cy: 10.9, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "h-blok-2", cx: 18.6, cy: 14.4, widthIn: 6, heightIn: 4, rot: 310 },
    { shapeId: "short-line-5", cx: 19.1, cy: 9.3, widthIn: 6, heightIn: 2, rot: 229 },
    { shapeId: "h-blok-open-13", cx: 37.9, cy: 14.85, widthIn: 4, heightIn: 6, rot: 337 },
    { shapeId: "long-line-2", cx: 10, cy: 23.7, widthIn: 6, heightIn: 2, rot: 47 },
    { shapeId: "long-line-combi-10", cx: 9.55, cy: 31.35, widthIn: 10, heightIn: 2, rot: 307 },
    { shapeId: "large-rectangle-42", cx: 22.05, cy: 29.95, widthIn: 10, heightIn: 11.5, rot: 0, center: true },
  ],
};
// Take and Hold vs Disruption C: same strips as Purge the Foe C (a 44" x 18"
// zone along the top, the opponent's along the bottom), all ruins upright, a
// 10 x 11.5" four-corner plate in the middle carrying the centre objective.
const MIRROR_DISRUPTION_C_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [{ x1: 0, y1: 0, x2: 44, y2: 18 }],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-36", cx: 22, cy: 13.5, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "large-rectangle-40", cx: 36.2, cy: 22.7, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "h-blok-open-7", cx: 7.1, cy: 13.1, widthIn: 6, heightIn: 4, rot: 0 },
    { shapeId: "long-line-2", cx: 11.1, cy: 8.3, widthIn: 6, heightIn: 2, rot: 270 },
    { shapeId: "h-blok-2", cx: 8.1, cy: 26.1, widthIn: 6, heightIn: 4, rot: 0 },
    { shapeId: "short-line-5", cx: 11.9, cy: 22.4, widthIn: 6, heightIn: 2, rot: 90 },
    { shapeId: "long-line-combi-10", cx: 34.9, cy: 12.6, widthIn: 10, heightIn: 2, rot: 0 },
    { shapeId: "large-rectangle-41", cx: 22, cy: 30, widthIn: 10, heightIn: 11.5, rot: 0, center: true },
  ],
};
// Take and Hold vs Disruption B: the same triangular zones as Priority
// Assets A (corners (0,0), (44,0), (0,30) top-left; the opponent's the
// diagonal mirror), ruins tilted at various angles around a 10 x 11.5"
// four-corner plate in the middle.
const MIRROR_DISRUPTION_B_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMinePoly: [[[0, 0], [44, 0], [0, 30]]],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-44", cx: 8.7, cy: 9.8, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "h-blok-open-7", cx: 19.65, cy: 14.05, widthIn: 6, heightIn: 4, rot: 144 },
    { shapeId: "long-line-2", cx: 25.1, cy: 11.7, widthIn: 6, heightIn: 2, rot: 325 },
    { shapeId: "large-rectangle-40", cx: 33.3, cy: 13.3, widthIn: 11.5, heightIn: 7, rot: 327 },
    { shapeId: "long-line-combi-10", cx: 9.25, cy: 22.15, widthIn: 10, heightIn: 2, rot: 152 },
    { shapeId: "h-blok-1", cx: 11.1, cy: 31, widthIn: 4, heightIn: 6, rot: 0 },
    { shapeId: "short-line-5", cx: 7.3, cy: 34.7, widthIn: 6, heightIn: 2, rot: 0 },
    { shapeId: "large-rectangle-41", cx: 22, cy: 30, widthIn: 10, heightIn: 11.5, rot: 0, center: true },
  ],
};
// Purge the Foe vs Purge the Foe A: top-left quarter minus a 9" circle around
// the centre (the opponent's the diagonal mirror), a tilted triangle, combo
// and short line, and two upright 7 x 11.5" plates beside the centre carrying
// the centre objectives.
const MIRROR_PTF_PTF_A_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMineSector: { cx: 22, cy: 30, r: 9, angleStart: 180, angleEnd: 270 },
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-30", cx: 8.7, cy: 9.9, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "triangle-2", cx: 20.1, cy: 10.4, widthIn: 8, heightIn: 11.5, rot: 60 },
    { shapeId: "h-blok-2", cx: 33.8, cy: 7, widthIn: 6, heightIn: 4, rot: 0 },
    { shapeId: "h-blok-open-7", cx: 37, cy: 17.05, widthIn: 6, heightIn: 4, rot: 0 },
    { shapeId: "long-line-2", cx: 35, cy: 21.5, widthIn: 6, heightIn: 2, rot: 270 },
    { shapeId: "long-line-combi-10", cx: 13.15, cy: 23.15, widthIn: 10, heightIn: 2, rot: 296 },
    { shapeId: "short-line-5", cx: 6.2, cy: 26.3, widthIn: 6, heightIn: 2, rot: 209 },
    { shapeId: "large-rectangle-45", cx: 26.7, cy: 23.4, widthIn: 7, heightIn: 11.5, rot: 0 },
  ],
};
// Purge the Foe vs Purge the Foe C: the stepped two-rectangle zone of
// Purge the Foe A (14" x 30" on top, 8" x 30" below on the left; the
// opponent's the diagonal mirror), ruins tilted at various angles, two
// horizontal plates beside the centre carrying the centre objectives.
const MIRROR_PTF_PTF_C_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [
    { x1: 0, y1: 0, x2: 14, y2: 30 },
    { x1: 0, y1: 30, x2: 8, y2: 60 },
  ],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-30", cx: 8.8, cy: 9.9, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "h-blok-1", cx: 30.2, cy: 7.5, widthIn: 4, heightIn: 6, rot: 180 },
    { shapeId: "long-line-2", cx: 19.8, cy: 8.9, widthIn: 6, heightIn: 2, rot: 225 },
    { shapeId: "h-blok-open-7", cx: 18.7, cy: 13.55, widthIn: 6, heightIn: 4, rot: 132 },
    { shapeId: "triangle-2", cx: 38.5, cy: 14.15, widthIn: 8, heightIn: 11.5, rot: 210 },
    { shapeId: "long-line-combi-10", cx: 9.55, cy: 29.5, widthIn: 10, heightIn: 2, rot: 307 },
    { shapeId: "short-line-5", cx: 9.7, cy: 22.3, widthIn: 6, heightIn: 2, rot: 27 },
    { shapeId: "large-rectangle-20", cx: 23.9, cy: 23.3, widthIn: 11.5, heightIn: 7, rot: 0 },
  ],
};
// Purge the Foe vs Reconnaissance A: strips along the top and bottom (a 44" x
// 18" zone along the top, the opponent's along the bottom). The castle plate
// has an empty 6 x 4" plate and a bare T-shaped ruin outline overlapping its
// edge, a short line plate beside them, a vertical frame + open plate in the
// corner, and two tilted triangle plates in the middle.
const MIRROR_PTF_REC_A_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [{ x1: 0, y1: 0, x2: 44, y2: 18 }],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-35", cx: 18.8, cy: 11.6, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "base-plinth", cx: 30, cy: 14.1, widthIn: 6, heightIn: 4, rot: 0 },
    { shapeId: "t-bare", cx: 25.6, cy: 13.8, widthIn: 6, heightIn: 4, rot: 0 },
    { shapeId: "short-line-5", cx: 35.7, cy: 10.9, widthIn: 6, heightIn: 2, rot: 180 },
    { shapeId: "long-line-2", cx: 8.2, cy: 10.2, widthIn: 6, heightIn: 2, rot: 270 },
    { shapeId: "h-blok-open-7", cx: 6.2, cy: 15.1, widthIn: 6, heightIn: 4, rot: 180 },
    { shapeId: "long-line-combi-10", cx: 9.5, cy: 23.35, widthIn: 10, heightIn: 2, rot: 346 },
    { shapeId: "large-rectangle-43", cx: 36.3, cy: 24.7, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "triangle-2", cx: 23.9, cy: 25.3, widthIn: 8, heightIn: 11.5, rot: 270 },
  ],
};
// Purge the Foe vs Purge the Foe B: the same two-rectangle zone as Map A
// (22" x 20" + 22" x 12", the opponent's the diagonal mirror), a tilted
// triangle carrying the home objective in each corner, a chain of combo and
// short line along the top, and two plates beside the centre carrying the
// centre objectives.
const MIRROR_PTF_PTF_B_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [
    { x1: 0, y1: 0, x2: 22, y2: 20 },
    { x1: 22, y1: 0, x2: 44, y2: 12 },
  ],
  mirror: true,
  pieces: [
    { shapeId: "triangle-2", cx: 11.4, cy: 10.4, widthIn: 8, heightIn: 11.5, rot: 102 },
    { shapeId: "long-line-combi-10", cx: 26, cy: 9.2, widthIn: 10, heightIn: 2, rot: 0 },
    { shapeId: "short-line-5", cx: 34.2, cy: 8.9, widthIn: 6, heightIn: 2, rot: 0 },
    { shapeId: "large-rectangle-46", cx: 36.3, cy: 17.3, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "h-blok-2", cx: 7, cy: 21.2, widthIn: 6, heightIn: 4, rot: 0 },
    { shapeId: "long-line-2", cx: 18.1, cy: 22.7, widthIn: 6, heightIn: 2, rot: 30 },
    { shapeId: "h-blok-open-13", cx: 24.25, cy: 21.7, widthIn: 4, heightIn: 6, rot: 219 },
    { shapeId: "large-rectangle-47", cx: 32.1, cy: 29.3, widthIn: 11.5, heightIn: 7, rot: 0 },
  ],
};
// Purge the Foe vs Reconnaissance B: two vertical deployment strips (12"
// wide, the left one "mine", the opponent's its diagonal mirror), ruins
// tilted at various angles, two tilted triangles in the middle carrying the
// centre objectives.
const MIRROR_PTF_REC_B_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [{ x1: 0, y1: 0, x2: 12, y2: 60 }],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-39", cx: 26.7, cy: 9.8, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "long-line-2", cx: 12.1, cy: 7.4, widthIn: 6, heightIn: 2, rot: 39 },
    { shapeId: "h-blok-open-7", cx: 14.85, cy: 11.9, widthIn: 6, heightIn: 4, rot: 128 },
    { shapeId: "large-rectangle-48", cx: 6.6, cy: 20.8, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "long-line-combi-10", cx: 10.1, cy: 31.65, widthIn: 10, heightIn: 2, rot: 107 },
    { shapeId: "h-blok-2", cx: 8, cy: 44.4, widthIn: 6, heightIn: 4, rot: 215 },
    { shapeId: "short-line-5", cx: 6.4, cy: 49.6, widthIn: 6, heightIn: 2, rot: 124 },
    { shapeId: "triangle-7", cx: 21, cy: 22.1, widthIn: 8, heightIn: 11.5, rot: 225 },
  ],
};
// Purge the Foe vs Reconnaissance C: the triangular zones of Priority
// Assets A (corners (0,0), (44,0), (0,30) top-left; the opponent's the
// diagonal mirror), ruins tilted at various angles, two tilted triangle
// plates in the middle carrying the centre objectives.
const MIRROR_PTF_REC_C_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMinePoly: [[[0, 0], [44, 0], [0, 30]]],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-35", cx: 12.8, cy: 8.7, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "h-blok-2", cx: 26.1, cy: 10.3, widthIn: 6, heightIn: 4, rot: 0 },
    { shapeId: "large-rectangle-40", cx: 32.9, cy: 15.2, widthIn: 11.5, heightIn: 7, rot: 330 },
    { shapeId: "long-line-combi-10", cx: 12.45, cy: 19.6, widthIn: 10, heightIn: 2, rot: 146 },
    { shapeId: "short-line-5", cx: 6.7, cy: 17.8, widthIn: 6, heightIn: 2, rot: 238 },
    { shapeId: "long-line-2", cx: 11.1, cy: 29, widthIn: 6, heightIn: 2, rot: 270 },
    { shapeId: "h-blok-open-7", cx: 9.1, cy: 34.1, widthIn: 6, heightIn: 4, rot: 0 },
    { shapeId: "triangle-2", cx: 22.4, cy: 27, widthIn: 8, heightIn: 11.5, rot: 330 },
  ],
};
// Purge the Foe vs Priority Assets A: two vertical deployment strips (12"
// wide, the left one "mine", the opponent's its diagonal mirror), ruins
// tilted at various angles, two tilted triangles in the middle carrying the
// centre objectives.
const MIRROR_PTF_PRI_A_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [{ x1: 0, y1: 0, x2: 12, y2: 60 }],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-39", cx: 27.4, cy: 9.9, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "large-rectangle-30", cx: 7.9, cy: 16.8, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "h-blok-2", cx: 16.7, cy: 9.8, widthIn: 6, heightIn: 4, rot: 220 },
    { shapeId: "short-line-5", cx: 17.2, cy: 14.7, widthIn: 6, heightIn: 2, rot: 133 },
    { shapeId: "long-line-combi-10", cx: 36.2, cy: 11.1, widthIn: 10, heightIn: 2, rot: 270 },
    { shapeId: "h-blok-open-7", cx: 35.25, cy: 22.85, widthIn: 6, heightIn: 4, rot: 136 },
    { shapeId: "long-line-2", cx: 35.2, cy: 29.2, widthIn: 6, heightIn: 2, rot: 232 },
    { shapeId: "triangle-2", cx: 24.2, cy: 28.1, widthIn: 8, heightIn: 11.5, rot: 324 },
  ],
};
// Purge the Foe vs Priority Assets B: the zone is the top-left quarter of
// the board minus a 9" circle around its centre (as Map C); the opponent's
// is its diagonal mirror. The centre is two tilted triangle plates carrying
// the centre objectives.
const MIRROR_PTF_PRI_B_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMineSector: { cx: 22, cy: 30, r: 9, angleStart: 180, angleEnd: 270 },
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-30", cx: 8.3, cy: 9.8, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "h-blok-2", cx: 31.1, cy: 8, widthIn: 6, heightIn: 4, rot: 0 },
    { shapeId: "large-rectangle-49", cx: 34.4, cy: 17.5, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "long-line-combi-10", cx: 22.6, cy: 12, widthIn: 10, heightIn: 2, rot: 90 },
    { shapeId: "short-line-2", cx: 18, cy: 17.7, widthIn: 6, heightIn: 2, rot: 0 },
    { shapeId: "long-line-2", cx: 11, cy: 25.1, widthIn: 6, heightIn: 2, rot: 270 },
    { shapeId: "h-blok-open-7", cx: 7.1, cy: 30.2, widthIn: 6, heightIn: 4, rot: 0 },
    { shapeId: "triangle-7", cx: 23.8, cy: 28.6, widthIn: 8, heightIn: 11.5, rot: 130 },
  ],
};
// Purge the Foe vs Priority Assets C: two horizontal deployment strips (18"
// deep, the top one "mine", the opponent's its diagonal mirror at the
// bottom), ruins in the strips and two tilted triangles in the centre
// carrying the centre objectives.
const MIRROR_PTF_PRI_C_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [{ x1: 0, y1: 0, x2: 44, y2: 18 }],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-50", cx: 23.4, cy: 12.25, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "h-blok-open-7", cx: 5.8, cy: 10.85, widthIn: 6, heightIn: 4, rot: 180 },
    { shapeId: "long-line-2", cx: 11.8, cy: 13.9, widthIn: 6, heightIn: 2, rot: 0 },
    { shapeId: "long-line-combi-10", cx: 35, cy: 12.4, widthIn: 10, heightIn: 2, rot: 0 },
    { shapeId: "h-blok-1", cx: 10, cy: 21.8, widthIn: 4, heightIn: 6, rot: 180 },
    { shapeId: "short-line-2", cx: 6.9, cy: 25.6, widthIn: 6, heightIn: 2, rot: 0 },
    { shapeId: "large-rectangle-49", cx: 36.2, cy: 22.4, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "triangle-7", cx: 19.7, cy: 28.8, widthIn: 8, heightIn: 11.5, rot: 329 },
  ],
};
// Purge the Foe vs Disruption A: the zone is the top-left quarter of the
// board minus a 9" circle around its centre (as Map C); the opponent's is
// its diagonal mirror. A tilted flag plate, a tilted triangle and two
// upright plates with a combo and short line, plus a ladder outline and a
// frame bar beside the centre.
const MIRROR_PTF_DIS_A_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMineSector: { cx: 22, cy: 30, r: 9, angleStart: 180, angleEnd: 270 },
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-51", cx: 9.6, cy: 10.7, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "long-line-combi-10", cx: 23.4, cy: 11, widthIn: 10, heightIn: 2, rot: 270 },
    { shapeId: "short-line-2", cx: 19, cy: 16.9, widthIn: 6, heightIn: 2, rot: 0 },
    { shapeId: "large-rectangle-52", cx: 34.3, cy: 13.6, widthIn: 7, heightIn: 11.5, rot: 340 },
    { shapeId: "h-blok-open-7", cx: 5.9, cy: 21.2, widthIn: 6, heightIn: 4, rot: 0 },
    { shapeId: "triangle-6", cx: 23.8, cy: 22, widthIn: 8, heightIn: 11.5, rot: 42 },
    { shapeId: "h-blok-1", cx: 11, cy: 30.1, widthIn: 4, heightIn: 6, rot: 180 },
    { shapeId: "long-line-2", cx: 8.1, cy: 34, widthIn: 6, heightIn: 2, rot: 0 },
  ],
};
// Purge the Foe vs Disruption B: the same two-rectangle zone as Map A
// (22" x 20" + 22" x 12", the opponent's the diagonal mirror), a castle
// plate with a vertical frame bar and an open piece beside it, a combo and a
// flag plate along the top, and two tilted triangles in the middle carrying
// the centre objectives.
const MIRROR_PTF_DIS_B_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [
    { x1: 0, y1: 0, x2: 22, y2: 20 },
    { x1: 22, y1: 0, x2: 44, y2: 12 },
  ],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-53", cx: 17.4, cy: 11.5, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "h-blok-open-7", cx: 5.8, cy: 15.7, widthIn: 6, heightIn: 4, rot: 0 },
    { shapeId: "long-line-2", cx: 9.8, cy: 11.1, widthIn: 6, heightIn: 2, rot: 270 },
    { shapeId: "long-line-combi-10", cx: 30, cy: 9.3, widthIn: 10, heightIn: 2, rot: 0 },
    { shapeId: "large-rectangle-49", cx: 34.3, cy: 17.4, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "h-blok-1", cx: 10.8, cy: 26.9, widthIn: 4, heightIn: 6, rot: 180 },
    { shapeId: "short-line-2", cx: 7.8, cy: 30.7, widthIn: 6, heightIn: 2, rot: 180 },
    { shapeId: "triangle-7", cx: 22, cy: 27.5, widthIn: 8, heightIn: 11.5, rot: 52 },
  ],
};
// Purge the Foe vs Disruption C: the stepped two-rectangle zone of Purge the
// Foe A (14" x 30" on top, 8" x 30" below on the left; the opponent's the
// diagonal mirror), ruins tilted at various angles, a tilted flag plate and
// two near-upright triangles in the middle carrying the centre objectives.
const MIRROR_PTF_DIS_C_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [
    { x1: 0, y1: 0, x2: 14, y2: 30 },
    { x1: 0, y1: 30, x2: 8, y2: 60 },
  ],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-30", cx: 8.3, cy: 10.7, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "large-rectangle-49", cx: 25.3, cy: 10, widthIn: 11.5, heightIn: 7, rot: 213 },
    { shapeId: "long-line-combi-10", cx: 16.3, cy: 18.8, widthIn: 10, heightIn: 2, rot: 308 },
    { shapeId: "long-line-2", cx: 35.5, cy: 11, widthIn: 6, heightIn: 2, rot: 302 },
    { shapeId: "h-blok-open-7", cx: 36.5, cy: 17.4, widthIn: 6, heightIn: 4, rot: 27 },
    { shapeId: "short-line-2", cx: 6.9, cy: 25.6, widthIn: 6, heightIn: 2, rot: 214 },
    { shapeId: "h-blok-1", cx: 9.4, cy: 31.4, widthIn: 4, heightIn: 6, rot: 209 },
    { shapeId: "triangle-9", cx: 24.2, cy: 27.7, widthIn: 8, heightIn: 11.5, rot: 4 },
  ],
};
// Reconnaissance vs Reconnaissance A: the stepped two-rectangle zone of Purge
// the Foe A (14" x 30" on top, 8" x 30" below on the left; the opponent's the
// diagonal mirror), a castle plate and a flag plate along the top, ruins
// tilted at various angles on the sides, two near-upright triangles in the
// middle carrying the centre objectives.
const MIRROR_REC_REC_A_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [
    { x1: 0, y1: 0, x2: 14, y2: 30 },
    { x1: 0, y1: 30, x2: 8, y2: 60 },
  ],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-30", cx: 8.25, cy: 10.7, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "large-rectangle-38", cx: 27.9, cy: 8.5, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "h-blok-1", cx: 20, cy: 15, widthIn: 4, heightIn: 6, rot: 180 },
    { shapeId: "long-line-combi-10", cx: 11.6, cy: 21.7, widthIn: 10, heightIn: 2, rot: 294 },
    { shapeId: "short-line-2", cx: 8.4, cy: 38.7, widthIn: 6, heightIn: 2, rot: 308 },
    { shapeId: "long-line-2", cx: 8, cy: 33.2, widthIn: 6, heightIn: 2, rot: 39 },
    { shapeId: "h-blok-open-7", cx: 38, cy: 11.1, widthIn: 6, heightIn: 4, rot: 270 },
    { shapeId: "triangle-9", cx: 24.85, cy: 28.7, widthIn: 8, heightIn: 11.5, rot: 0 },
  ],
};
// Reconnaissance vs Reconnaissance B: the triangular zones of Priority Assets
// A (corners (0,0), (44,0), (0,30) top-left; the opponent's the diagonal
// mirror), a tilted castle plate and flag plate, a T outline, a combo with a
// short line, and two tilted triangles in the middle carrying the centre
// objectives.
const MIRROR_REC_REC_B_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMinePoly: [[[0, 0], [44, 0], [0, 30]]],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-36", cx: 11.8, cy: 10, widthIn: 11.5, heightIn: 7, rot: 330 },
    { shapeId: "h-blok-2", cx: 23.5, cy: 12, widthIn: 6, heightIn: 4, rot: 355 },
    { shapeId: "large-rectangle-49", cx: 33.3, cy: 13.3, widthIn: 11.5, heightIn: 7, rot: 328 },
    { shapeId: "long-line-combi-10", cx: 9.2, cy: 21.8, widthIn: 10, heightIn: 2, rot: 0 },
    { shapeId: "short-line-5", cx: 15, cy: 19.7, widthIn: 6, heightIn: 2, rot: 90 },
    { shapeId: "h-blok-open-7", cx: 11, cy: 32.2, widthIn: 6, heightIn: 4, rot: 268 },
    { shapeId: "long-line-2", cx: 8, cy: 36.5, widthIn: 6, heightIn: 2, rot: 180 },
    { shapeId: "triangle-9", cx: 21.3, cy: 27.5, widthIn: 8, heightIn: 11.5, rot: 330 },
  ],
};
// Reconnaissance vs Reconnaissance C: the same two-rectangle zone as Map A
// (22" x 20" + 22" x 12", the opponent's the diagonal mirror), a castle plate
// and a T outline along the top, a tilted combo and short line, a flag plate
// on the right, and two slightly tilted triangles in the middle carrying the
// centre objectives.
const MIRROR_REC_REC_C_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [
    { x1: 0, y1: 0, x2: 22, y2: 20 },
    { x1: 22, y1: 0, x2: 44, y2: 12 },
  ],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-54", cx: 11.6, cy: 8.3, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "h-blok-2", cx: 27, cy: 10, widthIn: 6, heightIn: 4, rot: 0 },
    { shapeId: "large-rectangle-55", cx: 34.3, cy: 17.4, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "long-line-combi-10", cx: 11.9, cy: 18.3, widthIn: 10, heightIn: 2, rot: 206 },
    { shapeId: "short-line-5", cx: 19.3, cy: 17.1, widthIn: 6, heightIn: 2, rot: 120 },
    { shapeId: "h-blok-open-7", cx: 10.85, cy: 28.05, widthIn: 6, heightIn: 4, rot: 268 },
    { shapeId: "long-line-2", cx: 7.9, cy: 32.1, widthIn: 6, heightIn: 2, rot: 180 },
    { shapeId: "triangle-9", cx: 22.5, cy: 27.8, widthIn: 8, heightIn: 11.5, rot: 285 },
  ],
};
// Reconnaissance vs Priority Assets A: the triangular zones of Priority
// Assets A (corners (0,0), (44,0), (0,30) top-left; the opponent's the
// diagonal mirror), a castle plate, a tilted T outline and flag plate, a combo
// with a short line, and a 10 x 11.5" four-corner plate in the middle carrying
// the centre objective.
const MIRROR_REC_PRI_A_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMinePoly: [[[0, 0], [44, 0], [0, 30]]],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-56", cx: 10.5, cy: 9.7, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "h-blok-2", cx: 23.2, cy: 13.3, widthIn: 6, heightIn: 4, rot: 320 },
    { shapeId: "large-rectangle-49", cx: 33.3, cy: 12.4, widthIn: 11.5, heightIn: 7, rot: 328 },
    { shapeId: "long-line-combi-10", cx: 7.1, cy: 23.1, widthIn: 10, heightIn: 2, rot: 0 },
    { shapeId: "short-line-2", cx: 12.7, cy: 21.1, widthIn: 6, heightIn: 2, rot: 270 },
    { shapeId: "h-blok-open-7", cx: 11.9, cy: 32.1, widthIn: 6, heightIn: 4, rot: 88 },
    { shapeId: "long-line-2", cx: 8.8, cy: 36.2, widthIn: 6, heightIn: 2, rot: 0 },
    { shapeId: "large-rectangle-57", cx: 22, cy: 30.1, widthIn: 10, heightIn: 11.5, rot: 0, center: true },
  ],
};
// Reconnaissance vs Priority Assets B: the same two-rectangle zone as Map A
// (22" x 20" + 22" x 12", the opponent's the diagonal mirror), a castle plate,
// short line and T outline along the top, a flag plate on the right, a
// slightly tilted combo, and an 11.5 x 10" four-corner plate in the middle
// carrying the centre objective.
const MIRROR_REC_PRI_B_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [
    { x1: 0, y1: 0, x2: 22, y2: 20 },
    { x1: 22, y1: 0, x2: 44, y2: 12 },
  ],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-35", cx: 11.6, cy: 10.5, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "short-line-2", cx: 20.4, cy: 14.8, widthIn: 6, heightIn: 2, rot: 0 },
    { shapeId: "h-blok-2", cx: 27.8, cy: 9.2, widthIn: 6, heightIn: 4, rot: 0 },
    { shapeId: "large-rectangle-49", cx: 33.2, cy: 16.5, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "long-line-combi-10", cx: 9, cy: 19.8, widthIn: 10, heightIn: 2, rot: 344 },
    { shapeId: "h-blok-open-7", cx: 10.8, cy: 28.1, widthIn: 6, heightIn: 4, rot: 268 },
    { shapeId: "long-line-2", cx: 7.7, cy: 32.2, widthIn: 6, heightIn: 2, rot: 0 },
    { shapeId: "large-rectangle-37", cx: 22, cy: 30.1, widthIn: 11.5, heightIn: 10, rot: 0, center: true },
  ],
};
// Reconnaissance vs Priority Assets C: the stepped two-rectangle zone of
// Purge the Foe A (14" x 30" on top, 8" x 30" below on the left; the
// opponent's the diagonal mirror), a castle plate and a flag plate along the
// top, tilted ruins on the sides, and a 10 x 11.5" four-corner plate in the
// middle carrying the centre objective.
const MIRROR_REC_PRI_C_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [
    { x1: 0, y1: 0, x2: 14, y2: 30 },
    { x1: 0, y1: 30, x2: 8, y2: 60 },
  ],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-30", cx: 8.2, cy: 11.7, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "large-rectangle-39", cx: 31.4, cy: 9.65, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "h-blok-open-7", cx: 37.2, cy: 18.5, widthIn: 6, heightIn: 4, rot: 268 },
    { shapeId: "h-blok-2", cx: 20, cy: 15.7, widthIn: 6, heightIn: 4, rot: 320 },
    { shapeId: "long-line-2", cx: 21.2, cy: 10.5, widthIn: 6, heightIn: 2, rot: 47 },
    { shapeId: "short-line-5", cx: 8.1, cy: 24, widthIn: 6, heightIn: 2, rot: 225 },
    { shapeId: "long-line-combi-10", cx: 8.6, cy: 29.9, widthIn: 10, heightIn: 2, rot: 135 },
    { shapeId: "large-rectangle-42", cx: 22, cy: 30, widthIn: 10, heightIn: 11.5, rot: 0, center: true },
  ],
};
// Reconnaissance vs Disruption A: the same two-rectangle zone as Map A
// (22" x 20" + 22" x 12", the opponent's the diagonal mirror), a castle plate
// and a combo along the top, a flag plate on the right, ruins tilted slightly
// on the left, and two tilted triangles in the middle carrying the centre
// objectives.
const MIRROR_REC_DIS_A_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [
    { x1: 0, y1: 0, x2: 22, y2: 20 },
    { x1: 22, y1: 0, x2: 44, y2: 12 },
  ],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-53", cx: 17.2, cy: 11.7, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "long-line-combi-10", cx: 28, cy: 11.5, widthIn: 10, heightIn: 2, rot: 0 },
    { shapeId: "large-rectangle-43", cx: 36.6, cy: 18.7, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "long-line-2", cx: 9.8, cy: 11.4, widthIn: 6, heightIn: 2, rot: 270 },
    { shapeId: "h-blok-open-7", cx: 5.8, cy: 16.1, widthIn: 6, heightIn: 4, rot: 0 },
    { shapeId: "h-blok-1", cx: 11.5, cy: 25.7, widthIn: 4, heightIn: 6, rot: 188 },
    { shapeId: "short-line-2", cx: 7.9, cy: 29.8, widthIn: 6, heightIn: 2, rot: 356 },
    { shapeId: "triangle-7", cx: 24, cy: 22.9, widthIn: 8, heightIn: 11.5, rot: 215 },
  ],
};
// Reconnaissance vs Disruption B: two vertical deployment strips (12" wide,
// the left one "mine", the opponent's its diagonal mirror), a castle plate
// in the strip, a tilted flag plate, combo and short line, ruins tilted on
// the sides, and two near-upright triangles in the middle carrying the
// centre objectives.
const MIRROR_REC_DIS_B_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [{ x1: 0, y1: 0, x2: 12, y2: 60 }],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-30", cx: 7.2, cy: 11.7, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "large-rectangle-49", cx: 24.8, cy: 9.8, widthIn: 11.5, heightIn: 7, rot: 232 },
    { shapeId: "long-line-combi-10", cx: 17.7, cy: 21.4, widthIn: 10, heightIn: 2, rot: 299 },
    { shapeId: "short-line-2", cx: 8.2, cy: 26.1, widthIn: 6, heightIn: 2, rot: 57 },
    { shapeId: "h-blok-1", cx: 8.4, cy: 32.9, widthIn: 4, heightIn: 6, rot: 230 },
    { shapeId: "long-line-2", cx: 7.7, cy: 43.1, widthIn: 6, heightIn: 2, rot: 58 },
    { shapeId: "h-blok-open-7", cx: 7.6, cy: 49.5, widthIn: 6, heightIn: 4, rot: 312 },
    { shapeId: "triangle-9", cx: 17.3, cy: 33.4, widthIn: 8, heightIn: 11.5, rot: 180 },
  ],
};
// Reconnaissance vs Disruption C: the zone is the top-left quarter of the
// board minus a 9" circle around its centre (as Map C); the opponent's is its
// diagonal mirror. A castle plate, a vertical combo and frame bar in the
// zone, a tilted flag plate and open piece, and two triangles beside the
// centre carrying the centre objectives.
const MIRROR_REC_DIS_C_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMineSector: { cx: 22, cy: 30, r: 9, angleStart: 180, angleEnd: 270 },
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-30", cx: 6.4, cy: 15.8, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "long-line-combi-10", cx: 21.4, cy: 10.05, widthIn: 10, heightIn: 2, rot: 90 },
    { shapeId: "long-line-2", cx: 16.8, cy: 16.1, widthIn: 6, heightIn: 2, rot: 0 },
    { shapeId: "large-rectangle-49", cx: 32.4, cy: 9.5, widthIn: 11.5, heightIn: 7, rot: 310 },
    { shapeId: "h-blok-open-7", cx: 32.75, cy: 19.7, widthIn: 6, heightIn: 4, rot: 213 },
    { shapeId: "h-blok-1", cx: 9, cy: 30.2, widthIn: 4, heightIn: 6, rot: 180 },
    { shapeId: "short-line-2", cx: 6, cy: 33.9, widthIn: 6, heightIn: 2, rot: 180 },
    { shapeId: "triangle-9", cx: 19.7, cy: 23.8, widthIn: 8, heightIn: 11.5, rot: 90 },
  ],
};
// Priority Assets vs Priority Assets A: the stepped two-rectangle zone of
// Purge the Foe A (14" x 30" on top, 8" x 30" below on the left; the
// opponent's the diagonal mirror), a castle plate and a flag plate along the
// top, a short line and frame bar tilted into a V, a tilted triangle, and two
// "Medium rectangle full" plates stacked in the middle carrying the centre
// objective.
const MIRROR_PRI_PRI_A_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [
    { x1: 0, y1: 0, x2: 14, y2: 30 },
    { x1: 0, y1: 30, x2: 8, y2: 60 },
  ],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-56", cx: 7.5, cy: 9.7, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "large-rectangle-39", cx: 29.8, cy: 9.7, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "short-line-5", cx: 19.4, cy: 12.2, widthIn: 6, heightIn: 2, rot: 228 },
    { shapeId: "long-line-2", cx: 19, cy: 18, widthIn: 6, heightIn: 2, rot: 318 },
    { shapeId: "triangle-9", cx: 7.4, cy: 26.5, widthIn: 8, heightIn: 11.5, rot: 35 },
    { shapeId: "h-blok-open-7", cx: 12.1, cy: 38.1, widthIn: 6, heightIn: 4, rot: 88 },
    { shapeId: "long-line-combi-10", cx: 6.8, cy: 48, widthIn: 10, heightIn: 2, rot: 88 },
    { shapeId: "h-blok-3", cx: 22, cy: 28, widthIn: 6, heightIn: 4, rot: 180, center: true },
    { shapeId: "h-blok-3", cx: 22, cy: 32, widthIn: 6, heightIn: 4, rot: 0, center: true },
  ],
};
// Priority Assets vs Priority Assets B: the triangular zones of Priority
// Assets A (corners (0,0), (44,0), (0,30) top-left; the opponent's the
// diagonal mirror), a castle plate, a combo, a tilted flag plate and
// triangle, and two "Medium rectangle full" plates side by side in the middle
// carrying the centre objective.
const MIRROR_PRI_PRI_B_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMinePoly: [[[0, 0], [44, 0], [0, 30]]],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-35", cx: 10.7, cy: 9.3, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "long-line-combi-10", cx: 26, cy: 9.2, widthIn: 10, heightIn: 2, rot: 323 },
    { shapeId: "large-rectangle-49", cx: 33.1, cy: 13.8, widthIn: 11.5, heightIn: 7, rot: 332 },
    { shapeId: "triangle-7", cx: 16, cy: 17.7, widthIn: 8, heightIn: 11.5, rot: 230 },
    { shapeId: "short-line-5", cx: 4.9, cy: 22.7, widthIn: 6, heightIn: 2, rot: 326 },
    { shapeId: "h-blok-open-7", cx: 11, cy: 29.8, widthIn: 6, heightIn: 4, rot: 268 },
    { shapeId: "long-line-2", cx: 8.1, cy: 33.8, widthIn: 6, heightIn: 2, rot: 180 },
    { shapeId: "h-blok-3", cx: 20, cy: 29.8, widthIn: 6, heightIn: 4, rot: 90, center: true },
    { shapeId: "h-blok-3", cx: 24, cy: 30.2, widthIn: 6, heightIn: 4, rot: 270, center: true },
  ],
};
// Priority Assets vs Priority Assets C: the same two-rectangle zone as Map A
// (22" x 20" + 22" x 12", the opponent's the diagonal mirror), a castle plate
// and a tilted triangle along the top, a flag plate on the right, a combo
// with a short line tilted in the middle, and two "Medium rectangle full"
// plates side by side carrying the centre objective.
const MIRROR_PRI_PRI_C_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [
    { x1: 0, y1: 0, x2: 22, y2: 20 },
    { x1: 22, y1: 0, x2: 44, y2: 12 },
  ],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-35", cx: 9.5, cy: 10.1, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "triangle-9", cx: 28, cy: 7.8, widthIn: 8, heightIn: 11.5, rot: 90 },
    { shapeId: "large-rectangle-43", cx: 36.5, cy: 19.6, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "h-blok-open-7", cx: 10.8, cy: 24, widthIn: 6, heightIn: 4, rot: 88 },
    { shapeId: "long-line-2", cx: 7.8, cy: 27.9, widthIn: 6, heightIn: 2, rot: 0 },
    { shapeId: "long-line-combi-10", cx: 24, cy: 19.6, widthIn: 10, heightIn: 2, rot: 148 },
    { shapeId: "short-line-2", cx: 18.5, cy: 17.8, widthIn: 6, heightIn: 2, rot: 238 },
    { shapeId: "h-blok-3", cx: 20, cy: 29.8, widthIn: 6, heightIn: 4, rot: 90, center: true },
    { shapeId: "h-blok-3", cx: 24, cy: 30.2, widthIn: 6, heightIn: 4, rot: 270, center: true },
  ],
};
// Priority Assets vs Disruption A: the stepped two-rectangle zone of Purge the
// Foe A (14" x 30" on top, 8" x 30" below on the left; the opponent's the
// diagonal mirror), a castle plate and a flag plate along the top, a tilted
// open piece and frame bar, a tilted triangle, and two "Medium rectangle
// full" plates stacked in the middle carrying the centre objective.
const MIRROR_PRI_DIS_A_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [
    { x1: 0, y1: 0, x2: 14, y2: 30 },
    { x1: 0, y1: 30, x2: 8, y2: 60 },
  ],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-30", cx: 7.4, cy: 9.6, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "large-rectangle-39", cx: 30.5, cy: 10.7, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "h-blok-open-7", cx: 18.6, cy: 16.4, widthIn: 6, heightIn: 4, rot: 324 },
    { shapeId: "long-line-2", cx: 20.5, cy: 12, widthIn: 6, heightIn: 2, rot: 57 },
    { shapeId: "triangle-9", cx: 6.7, cy: 25.6, widthIn: 8, heightIn: 11.5, rot: 50 },
    { shapeId: "short-line-2", cx: 12.7, cy: 34, widthIn: 6, heightIn: 2, rot: 270 },
    { shapeId: "long-line-combi-10", cx: 6.5, cy: 45, widthIn: 10, heightIn: 2, rot: 270 },
    { shapeId: "h-blok-3", cx: 22, cy: 28, widthIn: 6, heightIn: 4, rot: 180, center: true },
    { shapeId: "h-blok-3", cx: 22, cy: 32, widthIn: 6, heightIn: 4, rot: 0, center: true },
  ],
};
// Priority Assets vs Disruption B: the same two-rectangle zone as Map A
// (22" x 20" + 22" x 12", the opponent's the diagonal mirror), a castle plate,
// frame bar and short line in the zone, a combo and a flag plate on the right,
// tilted triangle and open piece, and two "Medium rectangle full" plates side
// by side carrying the centre objective.
const MIRROR_PRI_DIS_B_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [
    { x1: 0, y1: 0, x2: 22, y2: 20 },
    { x1: 22, y1: 0, x2: 44, y2: 12 },
  ],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-30", cx: 17.4, cy: 12.6, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "short-line-2", cx: 5.8, cy: 13.6, widthIn: 6, heightIn: 2, rot: 180 },
    { shapeId: "long-line-2", cx: 9.8, cy: 9.8, widthIn: 6, heightIn: 2, rot: 270 },
    { shapeId: "long-line-combi-10", cx: 30, cy: 10.4, widthIn: 10, heightIn: 2, rot: 180 },
    { shapeId: "large-rectangle-43", cx: 36.6, cy: 19.7, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "h-blok-open-7", cx: 23.5, cy: 22, widthIn: 6, heightIn: 4, rot: 338 },
    { shapeId: "triangle-9", cx: 8.4, cy: 25.6, widthIn: 8, heightIn: 11.5, rot: 75 },
    { shapeId: "h-blok-3", cx: 20, cy: 29.8, widthIn: 6, heightIn: 4, rot: 90, center: true },
    { shapeId: "h-blok-3", cx: 24, cy: 30.2, widthIn: 6, heightIn: 4, rot: 270, center: true },
  ],
};
// Priority Assets vs Disruption C: the zone is the top-left quarter of the
// board minus a 9" circle around its centre (as Map C); the opponent's is its
// diagonal mirror. A castle plate, a vertical combo and short line in the
// zone, a tilted flag plate and triangle, and two "Medium rectangle full"
// plates side by side carrying the centre objective.
const MIRROR_PRI_DIS_C_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMineSector: { cx: 22, cy: 30, r: 9, angleStart: 180, angleEnd: 270 },
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-53", cx: 8.5, cy: 9.6, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "long-line-combi-10", cx: 24.6, cy: 8.8, widthIn: 10, heightIn: 2, rot: 90 },
    { shapeId: "short-line-2", cx: 20.1, cy: 14.6, widthIn: 6, heightIn: 2, rot: 180 },
    { shapeId: "large-rectangle-43", cx: 33.1, cy: 12.3, widthIn: 7, heightIn: 11.5, rot: 14 },
    { shapeId: "triangle-7", cx: 11.5, cy: 21.2, widthIn: 8, heightIn: 11.5, rot: 215 },
    { shapeId: "h-blok-open-7", cx: 11, cy: 33.8, widthIn: 6, heightIn: 4, rot: 88 },
    { shapeId: "long-line-2", cx: 7.9, cy: 38, widthIn: 6, heightIn: 2, rot: 180 },
    { shapeId: "h-blok-3", cx: 20, cy: 29.8, widthIn: 6, heightIn: 4, rot: 90, center: true },
    { shapeId: "h-blok-3", cx: 24, cy: 30.2, widthIn: 6, heightIn: 4, rot: 270, center: true },
  ],
};
// Disruption vs Disruption A: the triangular zones of Priority Assets A
// (corners (0,0), (44,0), (0,30) top-left; the opponent's the diagonal
// mirror), a tilted castle plate, T outline and flag plate, a combo with a
// short line, and a tilted 10 x 11.5" four-corner plate in the middle
// carrying the centre objective.
const MIRROR_DIS_DIS_A_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMinePoly: [[[0, 0], [44, 0], [0, 30]]],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-36", cx: 11.55, cy: 9.65, widthIn: 11.5, heightIn: 7, rot: 328 },
    { shapeId: "h-blok-2", cx: 23.4, cy: 11.4, widthIn: 6, heightIn: 4, rot: 175 },
    { shapeId: "large-rectangle-55", cx: 33.15, cy: 13, widthIn: 11.5, heightIn: 7, rot: 328 },
    { shapeId: "long-line-combi-10", cx: 8.75, cy: 21.4, widthIn: 10, heightIn: 2, rot: 0 },
    { shapeId: "short-line-2", cx: 14.5, cy: 19.4, widthIn: 6, heightIn: 2, rot: 270 },
    { shapeId: "h-blok-open-7", cx: 10.9, cy: 32, widthIn: 6, heightIn: 4, rot: 268 },
    { shapeId: "long-line-2", cx: 7.7, cy: 36.1, widthIn: 6, heightIn: 2, rot: 0 },
    { shapeId: "large-rectangle-57", cx: 22, cy: 30, widthIn: 10, heightIn: 11.5, rot: 329, center: true },
  ],
};
// Disruption vs Disruption B: the same two-rectangle zone as Map A (22" x 20"
// + 22" x 12", the opponent's the diagonal mirror), a castle plate and a T
// outline along the top, a tilted combo and short line, a flag plate on the
// right, and an 11.5 x 10" four-corner plate in the middle carrying the
// centre objective.
const MIRROR_DIS_DIS_B_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [
    { x1: 0, y1: 0, x2: 22, y2: 20 },
    { x1: 22, y1: 0, x2: 44, y2: 12 },
  ],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-35", cx: 11.6, cy: 8.1, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "h-blok-2", cx: 26.8, cy: 10, widthIn: 6, heightIn: 4, rot: 0 },
    { shapeId: "large-rectangle-55", cx: 34.2, cy: 17.4, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "long-line-combi-10", cx: 11.8, cy: 18, widthIn: 10, heightIn: 2, rot: 205 },
    { shapeId: "short-line-2", cx: 19.2, cy: 16.7, widthIn: 6, heightIn: 2, rot: 301 },
    { shapeId: "h-blok-open-7", cx: 10.85, cy: 28, widthIn: 6, heightIn: 4, rot: 268 },
    { shapeId: "long-line-2", cx: 7.9, cy: 32, widthIn: 6, heightIn: 2, rot: 180 },
    { shapeId: "large-rectangle-37", cx: 22, cy: 30, widthIn: 11.5, heightIn: 10, rot: 0, center: true },
  ],
};
// Disruption vs Disruption C: the stepped two-rectangle zone of Purge the Foe
// A (14" x 30" on top, 8" x 30" below on the left; the opponent's the
// diagonal mirror), a castle plate and a flag plate along the top, tilted
// ruins on the sides, and a 10 x 11.5" four-corner plate in the middle
// carrying the centre objective.
const MIRROR_DIS_DIS_C_LAYOUT = {
  widthIn: 44,
  heightIn: 60,
  zoneMine: [
    { x1: 0, y1: 0, x2: 14, y2: 30 },
    { x1: 0, y1: 30, x2: 8, y2: 60 },
  ],
  mirror: true,
  pieces: [
    { shapeId: "large-rectangle-30", cx: 8, cy: 10.4, widthIn: 7, heightIn: 11.5, rot: 0 },
    { shapeId: "large-rectangle-58", cx: 27.9, cy: 8.25, widthIn: 11.5, heightIn: 7, rot: 0 },
    { shapeId: "h-blok-1", cx: 19.9, cy: 15, widthIn: 4, heightIn: 6, rot: 0 },
    { shapeId: "long-line-combi-10", cx: 11.2, cy: 21.4, widthIn: 10, heightIn: 2, rot: 114 },
    { shapeId: "h-blok-open-7", cx: 37.9, cy: 10.9, widthIn: 6, heightIn: 4, rot: 88 },
    { shapeId: "short-line-2", cx: 35.6, cy: 21.3, widthIn: 6, heightIn: 2, rot: 309 },
    { shapeId: "long-line-2", cx: 35.9, cy: 26.7, widthIn: 6, heightIn: 2, rot: 215 },
    { shapeId: "large-rectangle-42", cx: 22, cy: 30, widthIn: 10, heightIn: 11.5, rot: 0, center: true },
  ],
};
const LAYOUT_TEMPLATES = [
  {
    id: "mirror-1",
    name: "Mapa A",
    mission: "Take and Hold vs Take and Hold A",
    ...MIRROR_1_LAYOUT,
    pieces: [
      ...MIRROR_1_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 17.5, cy: 11.75 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 26.5, cy: 48.25 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 37.5, cy: 18.75 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 6.5, cy: 41.25 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22, cy: 30 },
    ],
  },
  {
    id: "mirror-1b",
    name: "Mapa B",
    mission: "Take and Hold vs Take and Hold B",
    ...MIRROR_B_LAYOUT,
    pieces: [
      ...MIRROR_B_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 7.5, cy: 30.1 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 36.5, cy: 29.9 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 25.3, cy: 9.55 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 18.7, cy: 50.45 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22, cy: 30 },
    ],
  },
  {
    id: "ptf-a",
    name: "Mapa PtF A",
    mission: "Take and Hold vs Purge the Foe A",
    ...MIRROR_PTF_A_LAYOUT,
    pieces: [
      ...MIRROR_PTF_A_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 8.5, cy: 11.8 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 35.5, cy: 48.2 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 30.6, cy: 10.9 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 13.7, cy: 49.0 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 24.3, cy: 27.1 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 19.7, cy: 32.7 },
    ],
  },
  {
    id: "ptf-b",
    name: "Mapa PtF B",
    mission: "Take and Hold vs Purge the Foe B",
    ...MIRROR_PTF_B_LAYOUT,
    pieces: [
      ...MIRROR_PTF_B_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 8.5, cy: 10.8 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 35.5, cy: 49.2 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 34.2, cy: 10.7 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 9.8, cy: 49.3 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 23.8, cy: 27.6 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 20.4, cy: 32.3 },
    ],
  },
  {
    id: "ptf-c",
    name: "Mapa PtF C",
    mission: "Take and Hold vs Purge the Foe C",
    ...MIRROR_PTF_C_LAYOUT,
    pieces: [
      ...MIRROR_PTF_C_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 10.9, cy: 10.6 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 33.1, cy: 49.4 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 36, cy: 22.4 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 8, cy: 37.6 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 21.4, cy: 26.8 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22.6, cy: 33.2 },
    ],
  },
  {
    id: "rec-a",
    name: "Mapa Rec A",
    mission: "Take and Hold vs Reconnaissance A",
    ...MIRROR_REC_A_LAYOUT,
    pieces: [
      ...MIRROR_REC_A_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 12.9, cy: 8.3 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 31.1, cy: 51.7 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 34.2, cy: 16.5 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 9.8, cy: 43.5 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22, cy: 29.9 },
    ],
  },
  {
    id: "rec-b",
    name: "Mapa Rec B",
    mission: "Take and Hold vs Reconnaissance B",
    ...MIRROR_REC_B_LAYOUT,
    pieces: [
      ...MIRROR_REC_B_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 8.1, cy: 13.9 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 35.9, cy: 46.1 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 27.5, cy: 10.9 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 16.5, cy: 49.1 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22, cy: 30 },
    ],
  },
  {
    id: "rec-c",
    name: "Mapa Rec C",
    mission: "Take and Hold vs Reconnaissance C",
    ...MIRROR_REC_C_LAYOUT,
    pieces: [
      ...MIRROR_REC_C_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 8.7, cy: 11.9 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 35.3, cy: 48.1 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 34.4, cy: 13.4 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 9.6, cy: 46.6 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22, cy: 29.9 },
    ],
  },
  {
    id: "pri-a",
    name: "Mapa Pri A",
    mission: "Take and Hold vs Priority Assets A",
    ...MIRROR_PRIORITY_A_LAYOUT,
    pieces: [
      ...MIRROR_PRIORITY_A_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 10.7, cy: 8.6 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 33.3, cy: 51.4 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 34.4, cy: 15.3 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 9.8, cy: 44.7 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 20.3, cy: 22.9 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 23.8, cy: 37.1 },
    ],
  },
  {
    id: "pri-b",
    name: "Mapa Pri B",
    mission: "Take and Hold vs Priority Assets B",
    ...MIRROR_PRIORITY_B_LAYOUT,
    pieces: [
      ...MIRROR_PRIORITY_B_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 11.9, cy: 10.6 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 32.1, cy: 49.4 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 37.4, cy: 24.7 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 6.6, cy: 35.3 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 19, cy: 26.5 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 25, cy: 33.5 },
    ],
  },
  {
    id: "pri-c",
    name: "Mapa Pri C",
    mission: "Take and Hold vs Priority Assets C",
    ...MIRROR_PRIORITY_C_LAYOUT,
    pieces: [
      ...MIRROR_PRIORITY_C_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 6.7, cy: 21.8 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 37.4, cy: 38.2 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 26.5, cy: 10 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 17.5, cy: 50 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22, cy: 25.7 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22, cy: 34.3 },
    ],
  },
  {
    id: "dis-a",
    name: "Mapa Dis A",
    mission: "Take and Hold vs Disruption A",
    ...MIRROR_DISRUPTION_A_LAYOUT,
    pieces: [
      ...MIRROR_DISRUPTION_A_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 7.7, cy: 10.7 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 36.3, cy: 49.3 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 30.4, cy: 10.9 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 13.6, cy: 49.1 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22, cy: 29.9 },
    ],
  },
  {
    id: "dis-c",
    name: "Mapa Dis C",
    mission: "Take and Hold vs Disruption C",
    ...MIRROR_DISRUPTION_C_LAYOUT,
    pieces: [
      ...MIRROR_DISRUPTION_C_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 21.9, cy: 13.5 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 22.1, cy: 46.5 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 36.2, cy: 22.5 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 7.8, cy: 37.4 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22.1, cy: 30 },
    ],
  },
  {
    id: "dis-b",
    name: "Mapa Dis B",
    mission: "Take and Hold vs Disruption B",
    ...MIRROR_DISRUPTION_B_LAYOUT,
    pieces: [
      ...MIRROR_DISRUPTION_B_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 8.5, cy: 10 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 35.3, cy: 50.2 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 33.3, cy: 13.2 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 10.8, cy: 46.7 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22.1, cy: 29.9 },
    ],
  },
  {
    id: "ptfptf-a",
    name: "Mapa PtF-PtF A",
    mission: "Purge the Foe vs Purge the Foe A",
    ...MIRROR_PTF_PTF_A_LAYOUT,
    pieces: [
      ...MIRROR_PTF_PTF_A_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 8.7, cy: 9.9 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 35.3, cy: 50.1 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 33.8, cy: 7 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 10.2, cy: 53 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 26.5, cy: 23.2 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 17.5, cy: 36.8 },
    ],
  },
  {
    id: "ptfptf-c",
    name: "Mapa PtF-PtF C",
    mission: "Purge the Foe vs Purge the Foe C",
    ...MIRROR_PTF_PTF_C_LAYOUT,
    pieces: [
      ...MIRROR_PTF_PTF_C_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 8.7, cy: 9.9 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 35.3, cy: 50.1 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 30.1, cy: 7.6 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 13.9, cy: 52.4 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 23.9, cy: 23.3 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 20.1, cy: 36.7 },
    ],
  },
  {
    id: "ptfrec-a",
    name: "Mapa PtF-Rec A",
    mission: "Purge the Foe vs Reconnaissance A",
    ...MIRROR_PTF_REC_A_LAYOUT,
    pieces: [
      ...MIRROR_PTF_REC_A_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 18.8, cy: 11.5 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 25.2, cy: 48.5 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 36.4, cy: 24.6 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 7.6, cy: 35.4 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 23.8, cy: 25.1 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 20.2, cy: 34.9 },
    ],
  },
  {
    id: "ptfptf-b",
    name: "Mapa PtF-PtF B",
    mission: "Purge the Foe vs Purge the Foe B",
    ...MIRROR_PTF_PTF_B_LAYOUT,
    pieces: [
      ...MIRROR_PTF_PTF_B_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 11.5, cy: 10.5 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 32.5, cy: 49.5 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 36.3, cy: 17.4 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 7.7, cy: 42.6 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 32.1, cy: 29.4 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 11.9, cy: 30.6 },
    ],
  },
  {
    id: "ptfrec-b",
    name: "Mapa PtF-Rec B",
    mission: "Purge the Foe vs Reconnaissance B",
    ...MIRROR_PTF_REC_B_LAYOUT,
    pieces: [
      ...MIRROR_PTF_REC_B_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 6.6, cy: 20.7 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 37.4, cy: 39.3 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 26.5, cy: 9.9 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 17.5, cy: 50.1 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 21.1, cy: 22.2 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22.9, cy: 37.8 },
    ],
  },
  {
    id: "ptfrec-c",
    name: "Mapa PtF-Rec C",
    mission: "Purge the Foe vs Reconnaissance C",
    ...MIRROR_PTF_REC_C_LAYOUT,
    pieces: [
      ...MIRROR_PTF_REC_C_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 12.7, cy: 8.6 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 31.3, cy: 51.4 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 32.9, cy: 15.2 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 11.1, cy: 44.8 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22.5, cy: 26.7 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 21.5, cy: 33.3 },
    ],
  },
  {
    id: "ptfpri-a",
    name: "Mapa PtF-Pri A",
    mission: "Purge the Foe vs Priority Assets A",
    ...MIRROR_PTF_PRI_A_LAYOUT,
    pieces: [
      ...MIRROR_PTF_PRI_A_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 8, cy: 16.7 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 36, cy: 43.3 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 27.5, cy: 9.9 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 16.5, cy: 50.1 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 24.3, cy: 28 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 19.7, cy: 32 },
    ],
  },
  {
    id: "ptfpri-b",
    name: "Mapa PtF-Pri B",
    mission: "Purge the Foe vs Priority Assets B",
    ...MIRROR_PTF_PRI_B_LAYOUT,
    pieces: [
      ...MIRROR_PTF_PRI_B_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 8.4, cy: 9.8 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 35.6, cy: 50.2 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 34.3, cy: 17.5 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 9.7, cy: 42.5 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 24, cy: 28.6 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 20, cy: 31.4 },
    ],
  },
  {
    id: "ptfpri-c",
    name: "Mapa PtF-Pri C",
    mission: "Purge the Foe vs Priority Assets C",
    ...MIRROR_PTF_PRI_C_LAYOUT,
    pieces: [
      ...MIRROR_PTF_PRI_C_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 23.2, cy: 12.3 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 20.8, cy: 47.7 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 36.2, cy: 22.4 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 7.8, cy: 37.6 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 19.5, cy: 28.8 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 24.5, cy: 31.2 },
    ],
  },
  {
    id: "ptfdis-a",
    name: "Mapa PtF-Dis A",
    mission: "Purge the Foe vs Disruption A",
    ...MIRROR_PTF_DIS_A_LAYOUT,
    pieces: [
      ...MIRROR_PTF_DIS_A_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 9.5, cy: 10.7 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 34.5, cy: 49.3 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 34.3, cy: 13.5 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 9.7, cy: 46.5 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 23.8, cy: 22.2 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 20.2, cy: 37.8 },
    ],
  },
  {
    id: "ptfdis-b",
    name: "Mapa PtF-Dis B",
    mission: "Purge the Foe vs Disruption B",
    ...MIRROR_PTF_DIS_B_LAYOUT,
    pieces: [
      ...MIRROR_PTF_DIS_B_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 17.4, cy: 11.6 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 26.6, cy: 48.4 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 34.3, cy: 17.3 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 9.7, cy: 42.7 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22, cy: 27.3 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22, cy: 32.7 },
    ],
  },
  {
    id: "ptfdis-c",
    name: "Mapa PtF-Dis C",
    mission: "Purge the Foe vs Disruption C",
    ...MIRROR_PTF_DIS_C_LAYOUT,
    pieces: [
      ...MIRROR_PTF_DIS_C_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 8.4, cy: 10.8 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 35.6, cy: 49.2 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 25.2, cy: 9.9 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 18.8, cy: 50.1 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 24.6, cy: 27.4 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 19.4, cy: 32.6 },
    ],
  },
  {
    id: "recrec-a",
    name: "Mapa Rec-Rec A",
    mission: "Reconnaissance vs Reconnaissance A",
    ...MIRROR_REC_REC_A_LAYOUT,
    pieces: [
      ...MIRROR_REC_REC_A_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 8.6, cy: 10.7 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 35.4, cy: 49.3 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 27.9, cy: 8.5 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 16.1, cy: 51.5 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 25, cy: 28.8 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 19, cy: 31.2 },
    ],
  },
  {
    id: "recrec-b",
    name: "Mapa Rec-Rec B",
    mission: "Reconnaissance vs Reconnaissance B",
    ...MIRROR_REC_REC_B_LAYOUT,
    pieces: [
      ...MIRROR_REC_REC_B_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 11.7, cy: 10.2 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 32.3, cy: 49.8 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 33.3, cy: 13.3 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 10.7, cy: 46.7 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 21.3, cy: 27.1 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22.7, cy: 32.9 },
    ],
  },
  {
    id: "recrec-c",
    name: "Mapa Rec-Rec C",
    mission: "Reconnaissance vs Reconnaissance C",
    ...MIRROR_REC_REC_C_LAYOUT,
    pieces: [
      ...MIRROR_REC_REC_C_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 11.7, cy: 8.4 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 32.3, cy: 51.6 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 34.3, cy: 17.5 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 9.7, cy: 42.5 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22.5, cy: 27.4 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 21.5, cy: 32.6 },
    ],
  },
  {
    id: "recpri-a",
    name: "Mapa Rec-Pri A",
    mission: "Reconnaissance vs Priority Assets A",
    ...MIRROR_REC_PRI_A_LAYOUT,
    pieces: [
      ...MIRROR_REC_PRI_A_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 10.4, cy: 9.6 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 33.6, cy: 50.4 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 33.4, cy: 12.4 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 10.6, cy: 47.6 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22, cy: 30.1 },
    ],
  },
  {
    id: "recpri-b",
    name: "Mapa Rec-Pri B",
    mission: "Reconnaissance vs Priority Assets B",
    ...MIRROR_REC_PRI_B_LAYOUT,
    pieces: [
      ...MIRROR_REC_PRI_B_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 11.5, cy: 10.3 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 32.5, cy: 49.7 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 33.2, cy: 16.5 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 10.8, cy: 43.5 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22, cy: 30.1 },
    ],
  },
  {
    id: "recpri-c",
    name: "Mapa Rec-Pri C",
    mission: "Reconnaissance vs Priority Assets C",
    ...MIRROR_REC_PRI_C_LAYOUT,
    pieces: [
      ...MIRROR_REC_PRI_C_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 8.3, cy: 11.6 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 35.7, cy: 48.4 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 31.4, cy: 9.65 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 12.6, cy: 50.35 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22, cy: 30 },
    ],
  },
  {
    id: "recdis-a",
    name: "Mapa Rec-Dis A",
    mission: "Reconnaissance vs Disruption A",
    ...MIRROR_REC_DIS_A_LAYOUT,
    pieces: [
      ...MIRROR_REC_DIS_A_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 17.4, cy: 11.7 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 26.6, cy: 48.3 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 36.5, cy: 18.7 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 7.5, cy: 41.3 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 24, cy: 22.9 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 20, cy: 37.1 },
    ],
  },
  {
    id: "recdis-b",
    name: "Mapa Rec-Dis B",
    mission: "Reconnaissance vs Disruption B",
    ...MIRROR_REC_DIS_B_LAYOUT,
    pieces: [
      ...MIRROR_REC_DIS_B_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 7.2, cy: 11.7 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 36.8, cy: 48.3 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 24.7, cy: 9.7 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 19.3, cy: 50.3 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 27, cy: 26.7 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 17, cy: 33.3 },
    ],
  },
  {
    id: "recdis-c",
    name: "Mapa Rec-Dis C",
    mission: "Reconnaissance vs Disruption C",
    ...MIRROR_REC_DIS_C_LAYOUT,
    pieces: [
      ...MIRROR_REC_DIS_C_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 6.45, cy: 15.9 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 37.55, cy: 44.1 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 32.4, cy: 9.5 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 11.6, cy: 50.5 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 19.7, cy: 24.1 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 24.3, cy: 35.9 },
    ],
  },
  {
    id: "pripri-a",
    name: "Mapa Pri-Pri A",
    mission: "Priority Assets vs Priority Assets A",
    ...MIRROR_PRI_PRI_A_LAYOUT,
    pieces: [
      ...MIRROR_PRI_PRI_A_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 7.6, cy: 9.8 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 36.4, cy: 50.2 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 29.6, cy: 9.8 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 14.4, cy: 50.2 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22, cy: 30 },
    ],
  },
  {
    id: "pripri-b",
    name: "Mapa Pri-Pri B",
    mission: "Priority Assets vs Priority Assets B",
    ...MIRROR_PRI_PRI_B_LAYOUT,
    pieces: [
      ...MIRROR_PRI_PRI_B_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 10.7, cy: 9.3 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 33.3, cy: 50.7 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 33.1, cy: 13.8 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 10.9, cy: 46.2 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22, cy: 30 },
    ],
  },
  {
    id: "pripri-c",
    name: "Mapa Pri-Pri C",
    mission: "Priority Assets vs Priority Assets C",
    ...MIRROR_PRI_PRI_C_LAYOUT,
    pieces: [
      ...MIRROR_PRI_PRI_C_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 9.5, cy: 10.2 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 34.5, cy: 49.8 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 36.5, cy: 19.5 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 7.5, cy: 40.5 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22, cy: 30 },
    ],
  },
  {
    id: "pridis-a",
    name: "Mapa Pri-Dis A",
    mission: "Priority Assets vs Disruption A",
    ...MIRROR_PRI_DIS_A_LAYOUT,
    pieces: [
      ...MIRROR_PRI_DIS_A_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 7.3, cy: 9.8 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 36.7, cy: 50.2 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 30.4, cy: 10.7 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 13.6, cy: 49.3 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22, cy: 30 },
    ],
  },
  {
    id: "pridis-b",
    name: "Mapa Pri-Dis B",
    mission: "Priority Assets vs Disruption B",
    ...MIRROR_PRI_DIS_B_LAYOUT,
    pieces: [
      ...MIRROR_PRI_DIS_B_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 17.4, cy: 12.5 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 26.6, cy: 47.5 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 36.6, cy: 19.6 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 7.4, cy: 40.4 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22, cy: 30 },
    ],
  },
  {
    id: "pridis-c",
    name: "Mapa Pri-Dis C",
    mission: "Priority Assets vs Disruption C",
    ...MIRROR_PRI_DIS_C_LAYOUT,
    pieces: [
      ...MIRROR_PRI_DIS_C_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 8.5, cy: 9.55 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 35.5, cy: 50.45 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 33.1, cy: 12.3 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 10.9, cy: 47.7 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22, cy: 30 },
    ],
  },
  {
    id: "disdis-a",
    name: "Mapa Dis-Dis A",
    mission: "Disruption vs Disruption A",
    ...MIRROR_DIS_DIS_A_LAYOUT,
    pieces: [
      ...MIRROR_DIS_DIS_A_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 11.55, cy: 9.9 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 32.45, cy: 50.1 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 33.4, cy: 13 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 10.6, cy: 47 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22, cy: 30 },
    ],
  },
  {
    id: "disdis-b",
    name: "Mapa Dis-Dis B",
    mission: "Disruption vs Disruption B",
    ...MIRROR_DIS_DIS_B_LAYOUT,
    pieces: [
      ...MIRROR_DIS_DIS_B_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 11.6, cy: 8.4 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 32.4, cy: 51.6 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 34.2, cy: 17.3 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 9.8, cy: 42.7 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22, cy: 30 },
    ],
  },
  {
    id: "disdis-c",
    name: "Mapa Dis-Dis C",
    mission: "Disruption vs Disruption C",
    ...MIRROR_DIS_DIS_C_LAYOUT,
    pieces: [
      ...MIRROR_DIS_DIS_C_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 8.2, cy: 10.4 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 35.8, cy: 49.6 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 27.7, cy: 8.25 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 16.3, cy: 51.75 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22, cy: 30 },
    ],
  },
  {
    id: "mirror-c",
    name: "Mapa C",
    mission: "Take and Hold vs Take and Hold C",
    ...MIRROR_C_LAYOUT,
    pieces: [
      ...MIRROR_C_LAYOUT.pieces,
      { ...OBJ_MARKER, shapeId: "obj-home-red", cx: 10.4, cy: 9.5 },
      { ...OBJ_MARKER, shapeId: "obj-home-blue", cx: 33.6, cy: 50.5 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 33.4, cy: 12.3 },
      { ...OBJ_MARKER, shapeId: "obj-expansion", cx: 10.6, cy: 47.7 },
      { ...OBJ_MARKER, shapeId: "obj-center", cx: 22, cy: 30 },
    ],
  },
];
const MAP_TEMPLATE_BY_PAIR = (() => {
  const out = {};
  for (const t of LAYOUT_TEMPLATES) {
    const pm = parseMapMission(t.mission);
    if (pm) out[`${mapPairKey(pm.a, pm.b)}|${pm.v}`] = t;
  }
  return out;
})();

// Anti-X Y+: against a unit with keyword X, an unmodified wound roll of Y+
// always counts as a Critical Wound (auto-wounds), regardless of the normal
// S vs T table. Modeled as taking the better (lower) of the two thresholds —
// see computeWeapon.
const ANTI_KEYWORD_OPTIONS = [
  { value: "none", label: "Žádné" },
  { value: "monster", label: "MONSTER" },
  { value: "vehicle", label: "VEHICLE" },
  { value: "character", label: "CHARACTER" },
  { value: "infantry", label: "INFANTRY" },
];

const emptyWeapon = () => ({
  id: crypto.randomUUID(),
  name: "Zbraň",
  type: "ranged",
  attacks: 1,
  hitX: 3,
  strength: 4,
  ap: 0,
  damage: 1,
  lethalHits: false,
  sustained: 0,
  critHitsOn: 6,
  critWoundOn: 6,
  devastatingWounds: false,
  melta: 0,
  rapidFire: 0,
  antiKeyword: "none",
  antiValue: 4,
  isPsychic: false,
  rerollVsKeywords: { monster: false, vehicle: false, character: false },
  rerollHit: "none",
  rerollWound: "none",
  rerollOneHit: false,
  rerollOneWound: false,
  damageDice: "",
  rerollOneDamage: false,
  // +1 to this weapon's Attacks whenever an attached leader (Character) is
  // leading the unit in the calculator — e.g. Castellan Crowe leading
  // Purifiers gives their Purifying Flame +1 Attack.
  plusAttackWithLeader: false,
  copies: 1,
  needsStats: false,
  note: "",
});

const emptyMember = () => ({
  id: crypto.randomUUID(),
  name: "Model",
  count: 1,
  weapons: [emptyWeapon()],
});

// Standard round and oval base sizes (diameter / length×width, in mm) — the
// actual physical sizes GW bases ship in, so picking one is just "which base
// is this unit actually on" rather than typing an arbitrary number. Stored on
// a unit as this same string ("32" or "90x52"); parseBaseSizeMm below reads
// it back (also accepting a bare legacy numeric baseSize from before this
// list existed) into a {w, h} mm pair for the board token's footprint.
const BASE_SIZES = [
  { value: "25", label: "25mm" },
  { value: "28.5", label: "28.5mm" },
  { value: "32", label: "32mm" },
  { value: "40", label: "40mm" },
  { value: "50", label: "50mm" },
  { value: "60", label: "60mm" },
  { value: "80", label: "80mm" },
  { value: "90", label: "90mm" },
  { value: "100", label: "100mm" },
  { value: "130", label: "130mm" },
  { value: "160", label: "160mm" },
  { value: "60x35", label: "60×35mm oválná" },
  { value: "75x46", label: "75×46mm oválná" },
  { value: "90x52", label: "90×52mm oválná" },
  { value: "105x70", label: "105×70mm oválná" },
  { value: "120x92", label: "120×92mm oválná" },
  { value: "170x109", label: "170×109mm oválná" },
  { value: "hull:115x70", label: "Hull 115×70mm (obdélník, menší tank)" },
  { value: "hull:120x75", label: "Hull 120×75mm (obdélník, Rhino/Razorback)" },
  { value: "hull:130x90", label: "Hull 130×90mm (obdélník, Leman Russ)" },
  { value: "hull:140x90", label: "Hull 140×90mm (obdélník, Repulsor)" },
  { value: "hull:165x95", label: "Hull 165×95mm (obdélník, Land Raider)" },
  { value: "hull:220x150", label: "Hull 220×150mm (obdélník, superheavy)" },
];

// New Recruit gives vehicles "Hull" instead of a size - they stand on their
// own hull, which is a rectangle. These are approximate footprints (mm,
// length x width) picked by name; the unit editor's Base size list lets the
// person change one.
const HULL_FOOTPRINTS = [
  [/baneblade|shadowsword|stormsword|stormlord|banehammer|banesword|doomhammer/i, "hull:220x150"],
  [/land raider/i, "hull:165x95"],
  [/repulsor|executioner/i, "hull:140x90"],
  [/leman russ|basilisk|hellhound|manticore|deathstrike|chimera|taurox/i, "hull:130x90"],
  [/predator|whirlwind|vindicator|hunter|stalker/i, "hull:115x70"],
];
function hullBaseFor(name) {
  const n = String(name || "");
  const hit = HULL_FOOTPRINTS.find(([re]) => re.test(n));
  return hit ? hit[1] : "hull:120x75";
}
function parseBaseSizeMm(baseSize) {
  let s = String(baseSize ?? "32").trim();
  if (s.startsWith("hull:")) {
    const [w, h] = s.slice(5).split("x").map((v) => parseFloat(v));
    return { w: w || 120, h: h || w || 75, rect: true };
  }
  if (s.includes("x")) {
    const [w, h] = s.split("x").map((v) => parseFloat(v));
    return { w: w || 32, h: h || w || 32 };
  }
  const n = parseFloat(s) || 32;
  return { w: n, h: n };
}

// Reads New Recruit's "Base" column on a Unit profile ("32mm", "100mm",
// "170mm x 109mm") into the same "32" / "170x109" string BASE_SIZES uses.
// Anything that isn't a plain millimetre size ("Hull", "Unique", "-", "")
// gives null so the caller keeps its default.
function parseBaseText(text) {
  if (/^\s*hull/i.test(String(text ?? ""))) return "hull";
  const m = String(text ?? "").match(/(\d+(?:[.,]\d+)?)\s*(?:mm)?\s*(?:[x×]\s*(\d+(?:[.,]\d+)?))?/i);
  if (!m) return null;
  const num = (v) => parseFloat(String(v).replace(",", "."));
  const a = num(m[1]);
  const b = m[2] ? num(m[2]) : null;
  if (!(a >= 10 && a <= 300) || (b !== null && !(b >= 10 && b <= 300))) return null;
  return b !== null ? `${a}x${b}` : `${a}`;
}
// BASE_SIZES plus the unit's own current value when it isn't one of the
// standard ones (e.g. an imported "180x110"), so the dropdown never shows a
// size other than the real one.
function baseSizeOptions(current) {
  const cur = String(current ?? "32");
  if (BASE_SIZES.some((b) => b.value === cur)) return BASE_SIZES;
  const label = cur.startsWith("hull:") ? `Hull ${cur.slice(5).replace("x", "×")}mm` : cur.includes("x") ? `${cur.replace("x", "×")}mm` : `${cur}mm`;
  return [...BASE_SIZES, { value: cur, label }];
}

const emptyUnit = () => ({
  id: crypto.randomUUID(),
  faction: "",
  name: "",
  points: "",
  toughness: 4,
  save: 3,
  invul: 0,
  wounds: 2,
  fnp: 0,
  psychicFnp: 0,
  woundDebuff: false,
  damageReduction: 0,
  keywords: { monster: false, vehicle: false, character: false, infantry: false },
  // Model base size (mm), for the battlefield board (token size) — one of
  // BASE_SIZES' standard values ("32", "90x52", …), see parseBaseSizeMm.
  baseSize: "32",
  members: [emptyMember()],
  needsStats: false,
  isLeader: false,
  isFavorite: false,
});

// Guards the initial-load calls below against a stuck network/Supabase
// request — without this, a request that never settles would leave the
// "Načítám…" message on screen forever instead of falling back to "not
// loaded" and letting the person retry.
function withTimeout(promise, ms = 10000) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

function clampNum(v, fallback = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function totalModels(unit) {
  return (unit.members || []).reduce((s, m) => s + (clampNum(m.count) || 0), 0);
}

// Produces a stable signature for a unit's actual content, ignoring randomly
// generated ids and fields that can legitimately differ between imports of the
// same unit without it being a different unit (points cost, favorite flag) — so
// re-importing the same unit from a different list doesn't create a duplicate.
const SIGNATURE_IGNORE_KEYS = new Set(["id", "points", "isFavorite", "baseSize", "modelCount"]);
function stripIds(value) {
  if (Array.isArray(value)) return value.map(stripIds);
  if (value && typeof value === "object") {
    const out = {};
    Object.keys(value)
      .filter((k) => !SIGNATURE_IGNORE_KEYS.has(k))
      .sort()
      .forEach((k) => {
        out[k] = stripIds(value[k]);
      });
    return out;
  }
  return value;
}
function unitSignature(unit) {
  return JSON.stringify(stripIds(unit));
}

// Priority order for combining rerolls: "all" > "ones" > "none"
const REROLL_PRIORITY = { none: 0, ones: 1, all: 2 };
function betterReroll(a, b) {
  return (REROLL_PRIORITY[a] || 0) >= (REROLL_PRIORITY[b] || 0) ? a : b;
}

// Looks at what a unit's weapons already have built in, so the quick attack-bonus
// panel starts pre-checked to match reality rather than always defaulting to off.
function emptyBonus() {
  return {
    lethalHits: false,
    sustained: 0,
    rerollHit: "none",
    rerollWound: "none",
    apMod: 0,
    hitMod: 0,
    woundMod: 0,
    mortalWounds: 0,
    // Fire Overwatch stratagem: only ranged attacks, hits only on an
    // unmodified roll of 6 (see computeWeapon's effectiveHitX handling).
    fireOverwatch: false,
  };
}

// Cheat sheet only: a "slot" (Útočníci or Cíle) can hold BOTH offensive and
// defensive modifiers, since after "Prohodit útočníky a cíle" the same army
// may sit in either role — see emptySlotModifiers below.
function emptyFullModifier() {
  return {
    ...emptyBonus(),
    fnp: 0,
    woundDebuff: false,
    damageReduction: 0,
    benefitOfCover: false, // only meaningful for the ranged slice — cover doesn't apply in melee
    saveReroll: "none",
  };
}
function emptySlotModifiers() {
  return { ranged: emptyFullModifier(), melee: emptyFullModifier(), toughnessMod: 0, saveMod: 0 };
}

function autoDetectBonus(unit) {
  const result = { ranged: emptyBonus(), melee: emptyBonus() };
  if (!unit) return result;
  unit.members.forEach((m) => {
    m.weapons.forEach((w) => {
      const key = w.type === "melee" ? "melee" : "ranged";
      if (w.lethalHits) result[key].lethalHits = true;
      if (w.sustained > result[key].sustained) result[key].sustained = w.sustained;
      result[key].rerollHit = betterReroll(result[key].rerollHit, w.rerollHit || "none");
      result[key].rerollWound = betterReroll(result[key].rerollWound, w.rerollWound || "none");
    });
  });
  return result;
}

// ---------------------------------------------------------------------------
// Core probability math for a single weapon profile vs a defender profile
// ---------------------------------------------------------------------------
function computeWeapon(weapon, modelCount, def, bonus) {
  const b = bonus || emptyBonus();
  // Some units (e.g. GMNDK) can re-roll all hit and wound rolls specifically
  // against a keyword like MONSTER/VEHICLE — distinct from Anti-X, which
  // instead lowers the auto-wound threshold.
  const rerollKeywordActive =
    !!weapon.rerollVsKeywords &&
    !!def.keywords &&
    Object.keys(weapon.rerollVsKeywords).some((k) => weapon.rerollVsKeywords[k] && def.keywords[k]);
  // "Re-roll one damage roll" (e.g. a weapon whose ability lets you re-roll a
  // bad damage die): only meaningful when the raw dice notation (e.g. "D6")
  // is known, since it needs the actual spread of outcomes, not just the
  // average. Modeled as a flat bonus added on top of weapon.damage — that
  // average already carries the flat notation's own bonus (e.g. "D3+3") plus
  // any upstream adjustments like a Melta bump, so only the extra value the
  // reroll itself adds needs to be computed and layered on here.
  let rerollDamageBonus = 0;
  if (weapon.rerollOneDamage && weapon.damageDice) {
    const dist = parseDiceDistribution(weapon.damageDice);
    if (dist) {
      const baseMean = Array.from(dist.entries()).reduce((s, [v, p]) => s + v * p, 0);
      rerollDamageBonus = expectedValueWithOneReroll(dist) - baseMean;
    }
  }
  const att = {
    models: modelCount * (weapon.copies || 1),
    attacks: weapon.attacks,
    hitX: weapon.hitX,
    strength: weapon.strength,
    ap: weapon.ap - (b.apMod || 0),
    damage: weapon.damage + rerollDamageBonus,
    lethalHits: weapon.lethalHits || b.lethalHits,
    sustained: Math.max(weapon.sustained, b.sustained),
    // Critical Hit/Wound threshold: normally an unmodified 6, but some
    // abilities lower it (e.g. "Critical Hits on 5+"). A lower number is
    // "better" (easier), so an unset weapon field just falls back to 6.
    critHitsOn: Math.max(2, Math.min(6, weapon.critHitsOn || 6)),
    critWoundOn: Math.max(2, Math.min(6, weapon.critWoundOn || 6)),
    devastatingWounds: !!weapon.devastatingWounds,
    antiKeyword: weapon.antiKeyword || "none",
    antiValue: weapon.antiValue || 0,
    rerollHit: betterReroll(betterReroll(weapon.rerollHit || "none", b.rerollHit), rerollKeywordActive ? "all" : "none"),
    rerollWound: betterReroll(betterReroll(weapon.rerollWound || "none", b.rerollWound), rerollKeywordActive ? "all" : "none"),
  };

  // Hit-roll modifier: weapons that auto-hit (hitX === 1, e.g. Torrent) ignore modifiers.
  // Benefit of Cover (11th ed.): -1 to the attacker's Ballistic Skill against
  // ranged attacks — def.benefitOfCover is only ever set on the ranged
  // defender profile, so this naturally never applies to melee weapons.
  const coverPenalty = def.benefitOfCover ? 1 : 0;
  // Fire Overwatch stratagem: the unit can only score a hit on an unmodified
  // hit roll of 6 — ignores the weapon's normal BS and every hit modifier
  // (including cover above). Reusing effectiveHitX = 6 for this means every
  // downstream formula (reroll-hit, Sustained Hits, Lethal Hits, "reroll one
  // hit") keeps working unchanged, since they only ever look at the
  // resulting probability, not at hitX itself.
  const effectiveHitX = att.hitX <= 1 ? att.hitX : b.fireOverwatch ? 6 : Math.max(2, Math.min(6, att.hitX - (b.hitMod || 0) + coverPenalty));

  const pHitBase = (7 - effectiveHitX) / 6;
  const pHitAdj =
    att.rerollHit === "ones"
      ? pHitBase + (1 / 6) * pHitBase
      : att.rerollHit === "all"
      ? 1 - (1 - pHitBase) ** 2
      : pHitBase;
  // Critical Hit: normally only an unmodified roll of 6, but some weapons
  // score one on a lower unmodified roll (e.g. "Critical Hits on 5+") — the
  // "1/6" chance-of-a-fresh-crit below generalizes to that threshold, while
  // the leading "1/6" (chance the original roll was a natural 1, eligible
  // for a "re-roll ones") stays fixed regardless of the crit threshold.
  const pCritBase = (7 - att.critHitsOn) / 6;
  const pCritAdj =
    att.rerollHit === "ones"
      ? pCritBase + (1 / 6) * pCritBase
      : att.rerollHit === "all"
      ? pCritBase + (1 - pHitBase) * pCritBase
      : pCritBase;

  const attacks = att.models * att.attacks;
  const hitsNormal = attacks * pHitAdj;
  const critHits = attacks * pCritAdj;
  const sustainedExtra = att.sustained > 0 ? critHits * att.sustained : 0;
  // "Re-roll one Hit roll" (e.g. a master-crafted weapon) is a single extra
  // attempt, not a blanket reroll — modeled as: chance there was at least one
  // failure among this attack's hit rolls, times the chance of succeeding on
  // that one reroll.
  const rerollOneHitBonus = weapon.rerollOneHit && attacks > 0 ? (1 - (1 - pHitAdj) ** attacks) * pHitAdj : 0;
  const hitsTotal = hitsNormal + sustainedExtra + rerollOneHitBonus;

  const S = att.strength;
  const T = def.toughness;
  let woundNeed;
  if (S >= 2 * T) woundNeed = 2;
  else if (S > T) woundNeed = 3;
  else if (S === T) woundNeed = 4;
  else if (S * 2 <= T) woundNeed = 6;
  else woundNeed = 5;
  // Defensive ability some units have: worsen the wound roll by 1 whenever the
  // attacking weapon's Strength is greater than this unit's Toughness.
  const woundDebuffApplied = !!(def.woundDebuff && S > T);
  if (woundDebuffApplied) woundNeed += 1;
  woundNeed = Math.max(2, Math.min(6, woundNeed - (b.woundMod || 0)));
  // Anti-X Y+: against a defender with keyword X, a wound roll of Y+ always
  // counts as a Critical Wound — take whichever threshold is easier to hit.
  if (att.antiKeyword !== "none" && att.antiValue > 0 && def.keywords && def.keywords[att.antiKeyword]) {
    woundNeed = Math.min(woundNeed, att.antiValue);
  }

  const pWoundBase = (7 - woundNeed) / 6;
  const pWoundAdj =
    att.rerollWound === "ones"
      ? pWoundBase + (1 / 6) * pWoundBase
      : att.rerollWound === "all"
      ? 1 - (1 - pWoundBase) ** 2
      : pWoundBase;

  const hitsForWound = att.lethalHits ? hitsTotal - critHits : hitsTotal;
  const autoWounds = att.lethalHits ? critHits : 0;
  const woundsFromRoll = hitsForWound * pWoundAdj;
  // Same one-shot logic as the hit re-roll, applied to the wound roll instead.
  const rerollOneWoundBonus = weapon.rerollOneWound && hitsForWound > 0 ? (1 - (1 - pWoundAdj) ** hitsForWound) * pWoundAdj : 0;
  const woundsTotal = woundsFromRoll + autoWounds + rerollOneWoundBonus;

  // Devastating Wounds: a Critical Wound (an unmodified wound roll of 6, or
  // lower via an ability) inflicts its damage directly as mortal wounds —
  // no saving throw of any kind, normal or invulnerable. A critical wound is
  // always also a successful one, so it's a subset of woundsFromRoll here;
  // simplification: only the main wound-roll bucket is eligible (not the
  // Lethal Hits auto-wounds, which never rolled to wound at all, nor the
  // one-shot "re-roll one wound" attempt, kept out to avoid double-counting).
  const pCritWoundBase = (7 - att.critWoundOn) / 6;
  const pCritWoundAdj =
    att.rerollWound === "ones"
      ? pCritWoundBase + (1 / 6) * pCritWoundBase
      : att.rerollWound === "all"
      ? pCritWoundBase + (1 - pWoundBase) * pCritWoundBase
      : pCritWoundBase;
  const devWounds = att.devastatingWounds ? hitsForWound * pCritWoundAdj : 0;
  const normalWoundsPortion = woundsTotal - devWounds;

  const apAbs = Math.abs(att.ap);
  const normalSave = Math.min(def.save + apAbs, 7);
  const effSave = def.invul > 0 && def.invul < normalSave ? def.invul : normalSave;
  const pSaveSuccessBase = Math.min(1, Math.max(0, (7 - effSave) / 6));
  // Re-roll Saving Throws (defender ability) — same "ones" vs "all" reroll
  // convention as the attacker's hit/wound rerolls, just applied to the
  // defender's own save success chance instead.
  const pSaveSuccessAdj =
    def.saveReroll === "ones"
      ? pSaveSuccessBase + (1 / 6) * pSaveSuccessBase
      : def.saveReroll === "all"
      ? 1 - (1 - pSaveSuccessBase) ** 2
      : pSaveSuccessBase;
  const failProb = 1 - pSaveSuccessAdj;
  const through = normalWoundsPortion * failProb + devWounds;

  // Some units have a Feel No Pain that only applies against a specific kind
  // of attack (e.g. a Culexus Assassin: FNP 2+ against Psychic Attacks) —
  // on top of, not instead of, any general FNP the unit might also have.
  // Take whichever applicable threshold is better (lower).
  let effectiveFnp = def.fnp || 0;
  if (weapon.isPsychic && def.psychicFnp > 0) {
    effectiveFnp = effectiveFnp > 0 ? Math.min(effectiveFnp, def.psychicFnp) : def.psychicFnp;
  }
  const fnpProb = effectiveFnp > 0 ? (7 - effectiveFnp) / 6 : 0;
  const afterFnp = through * (1 - fnpProb);
  // Some very tough units (e.g. C'tan Shards) have an ability that subtracts a
  // flat amount from the Damage characteristic of each attack against them,
  // never going below 1 — apply that here before totaling damage.
  const effectiveDamage = def.damageReduction > 0 ? Math.max(1, att.damage - def.damageReduction) : att.damage;
  const totalDamage = afterFnp * effectiveDamage;

  // For transparency in the result screen: how much damage FNP and the flat
  // damage-reduction ability each actually took off, computed additively so
  // grossDamage - reductionSaved - fnpSaved = totalDamage.
  const grossDamage = through * att.damage;
  const afterReductionOnly = through * effectiveDamage;
  const reductionSaved = grossDamage - afterReductionOnly;
  const fnpSaved = afterReductionOnly - totalDamage;

  const dmgPerHit = effectiveDamage > 0 ? effectiveDamage : 1;
  const effWoundsPerKill = Math.ceil(def.wounds / dmgPerHit) * dmgPerHit;
  const killedModels = effWoundsPerKill > 0 ? totalDamage / effWoundsPerKill : 0;

  // For transparency: how many of the hits/wounds above specifically came
  // from "re-roll hit" (both the blanket all/ones reroll and the one-shot
  // reroll) and from Lethal Hits (crits that skipped the wound roll
  // entirely). Computed additively against the no-reroll / no-Lethal-Hits
  // baseline, then converted to a damage-equivalent using the same
  // save/FNP/per-hit-damage rate as the rest of this weapon's damage, so
  // it's directly comparable to the "Poškození" total shown per weapon.
  const hitsFromRerollHit = attacks > 0 ? attacks * (pHitAdj - pHitBase) + rerollOneHitBonus : 0;
  const woundsFromLethalHits = att.lethalHits ? critHits * (1 - pWoundAdj) : 0;
  const damageConvFactor = failProb * (1 - fnpProb) * effectiveDamage;
  const damageFromRerollHit = hitsFromRerollHit * pWoundAdj * damageConvFactor;
  const damageFromLethalHits = woundsFromLethalHits * damageConvFactor;

  return {
    totalDamage,
    killedModels,
    detail: {
      attacks,
      hitX: effectiveHitX,
      pHit: pHitAdj,
      hitsTotal,
      woundNeed,
      woundDebuffApplied,
      pWound: pWoundAdj,
      woundsTotal,
      effSave,
      failProb,
      through,
      fnpProb,
      afterFnp,
      effWoundsPerKill,
      damageReduction: def.damageReduction || 0,
      fnpValue: effectiveFnp,
      reductionSaved,
      fnpSaved,
      hitsFromRerollHit,
      woundsFromLethalHits,
      damageFromRerollHit,
      damageFromLethalHits,
    },
  };
}

// Sums every member/weapon of an attacking unit against a defender profile,
// split into ranged vs melee damage.
// def/bonus can each be either a single object (used for every weapon regardless
// of type) or a { ranged, melee } pair (used only for the matching weapon type).
function pickByType(value, type) {
  if (value && typeof value === "object" && value.ranged && value.melee) {
    return type === "melee" ? value.melee : value.ranged;
  }
  return value;
}

function computeUnitVsUnit(attackerUnit, def, bonus) {
  let rangedDamage = 0;
  let meleeDamage = 0;
  let killedModels = 0;
  const breakdown = [];

  (attackerUnit.members || []).forEach((member) => {
    (member.weapons || []).forEach((weapon) => {
      const d = pickByType(def, weapon.type);
      const b = pickByType(bonus, weapon.type);
      const r = computeWeapon(weapon, clampNum(member.count), d, b);
      if (weapon.type === "melee") meleeDamage += r.totalDamage;
      else rangedDamage += r.totalDamage;
      killedModels += r.killedModels;
      breakdown.push({
        member: member.name,
        weapon: weapon.name,
        type: weapon.type,
        damage: r.totalDamage,
        killedModels: r.killedModels,
        detail: r.detail,
      });
    });
  });

  // Flat mortal-wound bonus (e.g. from a charge ability) — a one-off amount
  // for the whole unit, not scaled by attacks/models. Bypasses save/invuln
  // but is still reduced by Feel No Pain, same as other damage. Folded into
  // the breakdown as its own row so it flows through killedModels/remainingPct
  // and the result screen's totals consistently with everything else.
  ["ranged", "melee"].forEach((type) => {
    const wb = pickByType(bonus, type);
    const raw = (wb && wb.mortalWounds) || 0;
    if (raw <= 0) return;
    const d = pickByType(def, type);
    const fnpProb = d.fnp > 0 ? (7 - d.fnp) / 6 : 0;
    const dmg = raw * (1 - fnpProb);
    const effWoundsPerKill = Math.max(1, d.wounds);
    const killed = dmg / effWoundsPerKill;
    if (type === "melee") meleeDamage += dmg;
    else rangedDamage += dmg;
    killedModels += killed;
    breakdown.push({
      member: "Mortal wounds",
      weapon: "mimo save (např. z charge)",
      type,
      damage: dmg,
      killedModels: killed,
      isMortalWounds: true,
      detail: {
        attacks: 0,
        hitX: 1,
        pHit: 1,
        hitsTotal: 0,
        woundNeed: 1,
        pWound: 1,
        woundsTotal: raw,
        effSave: 7,
        failProb: 1,
        through: raw,
        fnpProb,
        afterFnp: dmg,
        effWoundsPerKill,
        damageReduction: 0,
        fnpValue: d.fnp || 0,
        reductionSaved: 0,
        fnpSaved: raw - dmg,
      },
    });
  });

  const refDef = pickByType(def, "ranged");
  const totalDamage = rangedDamage + meleeDamage;
  const unitPool = refDef.wounds * refDef.models;
  const consumed = killedModels * refDef.wounds;
  const remainingPct = unitPool > 0 ? Math.max(0, (unitPool - consumed) / unitPool) : 0;

  return { rangedDamage, meleeDamage, totalDamage, killedModels, remainingPct, breakdown };
}

function defenderProfile(unit, overrides) {
  const o = overrides || {};
  // Save/invul are always a die-roll target of 2–6 (0 = "none"); clamp defensively
  // so a bad import or stray value can never produce a nonsensical save like "40+".
  const clampSave = (n, fallback) => {
    const v = clampNum(n, fallback);
    if (v <= 0) return 0;
    return Math.max(2, Math.min(6, v));
  };
  // "Nurgle's gifts"-style attacker abilities that worsen the defender's own
  // characteristics for this fight (e.g. -1 Toughness, -1 to Save
  // characteristic) — applied to the base characteristic before AP/invuln.
  // Entered exactly like the ability is worded on a datasheet: typing -1
  // makes the stat worse for the defender in BOTH fields, even though that
  // means "+ the typed value" for Toughness (lower T is worse) but "- the
  // typed value" for Save (a *higher* Sv number is worse).
  const rawToughness = Math.max(1, clampNum(unit.toughness, 4));
  const toughness = Math.max(1, rawToughness + clampNum(o.toughnessMod, 0));
  const rawSave = clampSave(unit.save, 3) || 7;
  const save = rawSave >= 7 ? 7 : Math.max(2, Math.min(7, rawSave - clampNum(o.saveMod, 0)));
  return {
    toughness,
    save,
    // Benefit of Cover (11th ed.): -1 to the attacker's Ballistic Skill
    // against ranged attacks — read by computeWeapon, not applied here,
    // since it worsens the hit roll rather than any defender characteristic.
    benefitOfCover: !!o.benefitOfCover,
    // Re-roll Saving Throws (of 1s, or all failed ones) — a defender-side
    // ability, so it lives here alongside the other defender modifiers
    // rather than in the attacker's bonus object.
    saveReroll: o.saveReroll || "none",
    invul: clampSave(unit.invul, 0),
    wounds: Math.max(1, clampNum(unit.wounds, 1)),
    models: o.models !== undefined && o.models !== null ? Math.max(0, clampNum(o.models, 1)) : totalModels(unit) || 1,
    fnp: clampSave(o.fnp !== undefined && o.fnp !== null ? o.fnp : unit.fnp, 0),
    psychicFnp: clampSave(unit.psychicFnp, 0),
    woundDebuff: o.woundDebuff !== undefined && o.woundDebuff !== null ? !!o.woundDebuff : !!unit.woundDebuff,
    damageReduction: Math.max(0, clampNum(o.damageReduction !== undefined && o.damageReduction !== null ? o.damageReduction : unit.damageReduction, 0)),
    keywords: o.keywords || unit.keywords || {},
  };
}

// ---------------------------------------------------------------------------
// New Recruit plain-text export parser (no combat stats available in this
// format — produces one placeholder weapon per unit, flagged needsStats)
// ---------------------------------------------------------------------------
function parseNewRecruitText(text) {
  const rawLines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  let faction = "";
  const factionLine = rawLines.find((l) => l.toUpperCase().startsWith("+ FACTION KEYWORD"));
  if (factionLine) {
    const value = factionLine.split(":").slice(1).join(":").trim();
    const segs = value.split("-").map((s) => s.trim()).filter(Boolean);
    faction = segs[segs.length - 1] || value;
  }

  const unitRegex = /^(?:[A-Za-z]+\d*:\s*)?(\d+)x\s+(.+?)\s*\((\d+)\s*pts?\)(?::\s*(.*))?$/i;
  const drafts = [];

  for (const line of rawLines) {
    if (line.startsWith("•") || line.startsWith("+") || line.startsWith("&")) continue;
    const m = line.match(unitRegex);
    if (!m) continue;
    const models = parseInt(m[1], 10) || 1;
    const baseName = m[2].trim();
    const points = m[3];
    const wargear = (m[4] || "").trim();
    drafts.push({ baseName, models, points, wargear });
  }

  const counts = {};
  drafts.forEach((d) => {
    counts[d.baseName] = (counts[d.baseName] || 0) + 1;
  });

  const units = drafts.map((d) => {
    const name = counts[d.baseName] > 1 ? `${d.baseName} (${d.points} pts)` : d.baseName;
    return {
      id: crypto.randomUUID(),
      faction: faction || "Neznámá frakce",
      name,
      points: d.points,
      toughness: 4,
      save: 3,
      invul: 0,
      wounds: 1,
      fnp: 0,
      woundDebuff: false,
      damageReduction: 0,
      members: [
        {
          id: crypto.randomUUID(),
          name: d.baseName,
          count: d.models,
          weapons: [
            {
              ...emptyWeapon(),
              name: d.wargear ? "Zbraň (uprav dle loadoutu)" : "Zbraň (uprav)",
              needsStats: true,
              note: d.wargear,
            },
          ],
        },
      ],
      needsStats: true,
      isLeader: false,
      isFavorite: false,
    };
  });

  return { faction, units };
}

// ---------------------------------------------------------------------------
// New Recruit "full text list" export (the newer app-export style: a list
// name/points header, faction/detachment lines, then one heading line per
// unit like "Wolf Guard Terminators (345 points)" followed by indented "•"
// wargear bullets). Unlike parseNewRecruitText above, this doesn't build new
// placeholder units — it only extracts (name, points) pairs so they can be
// matched against units the person already has in their library with real
// stats, to quickly assemble a named army for the cheat sheet without
// re-uploading a full JSON roster every time.
// ---------------------------------------------------------------------------
const ARMY_TEXT_SKIP_PATTERNS = /detachment|strike force|incursion|onslaught|combat patrol|exported with|data version/i;
// Lines that can carry a "(N pts)" but are never a unit — newrecruit.eu puts
// enhancement costs and attachment notes on their own lines.
const ARMY_TEXT_SKIP_LINE = /^(?:enhancement|leading|attached to|supporting|created with|reinforcements|secondary|total army points|number of units|faction keyword|force disposition|show\/hide|\+\s*[a-z])/i;

function parseArmyTextForMatching(text) {
  const rawLines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (rawLines.length === 0) return { listName: "", entries: [] };

  // A unit line: an optional "CharN:" tag, an optional "Nx " count, a name,
  // then "(P pts)" or "(P points)" — which newrecruit.eu puts mid-line with
  // the weapons after it, so this is deliberately not anchored to end-of-line.
  const unitLineRegex = /^(?:char\s*\d+\s*:\s*)?(?:\d+\s*x\s+)?(.+?)\s*\((\d+)\s*(?:points?|pts)\)/i;
  // newrecruit.eu exports open with a "+++ ... +++" header block of
  // "+ KEY: value" / "& ..." lines — none of which are units.
  const isHeaderChrome = (l) => /^\++$/.test(l) || /^[+&]\s/.test(l);

  // The list's own name is normally the first line (minus a trailing points
  // count). If the export has no name line (newrecruit.eu starts straight
  // into the "+++" header), fall back to "+ PLAYER NAME:" from that header.
  let playerName = "";
  for (const l of rawLines) {
    const pm = l.match(/player name\s*:\s*(.+)$/i);
    if (pm) {
      playerName = pm[1].trim();
      break;
    }
  }
  let listName = "";
  if (!isHeaderChrome(rawLines[0]) && !rawLines[0].startsWith("•") && !unitLineRegex.test(rawLines[0])) {
    listName = rawLines[0].replace(/\s*\(\d+\s*(?:points?|pts)\)\s*$/i, "").trim();
  }
  if (!listName) listName = playerName;

  const entries = [];
  // Units listed under the same "Attached Unit N" heading (a leader + the
  // unit it's leading) get merged into a single library entry on JSON import
  // — combined points, combined name. The plain text still lists them as
  // separate lines though, so each entry here also remembers which group
  // (if any) it belongs to, letting the matcher try the group's combined
  // points as a fallback against that merged entry.
  let groupIndex = 0;
  let inGroup = false;
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (i === 0 && (line === listName || isHeaderChrome(line))) continue;
    if (/^attached unit\b/i.test(line)) {
      groupIndex += 1;
      inGroup = true;
      continue;
    }
    if (/^(characters|other datasheets|attached units)$/i.test(line)) {
      inGroup = false;
      continue;
    }
    if (line.startsWith("•")) continue;
    // newrecruit.eu lists an enhancement on its own line, with its cost as
    // "(+N pts)", right after the character that took it — fold that back into
    // that character's points so the total matches the datasheet cost.
    const enh = line.match(/^enhancement\b.*\(\+(\d+)\s*(?:points?|pts)\)/i);
    if (enh && entries.length > 0) {
      entries[entries.length - 1].points = String(parseInt(entries[entries.length - 1].points, 10) + parseInt(enh[1], 10));
      continue;
    }
    if (isHeaderChrome(line)) continue;
    if (ARMY_TEXT_SKIP_LINE.test(line)) continue;
    if (ARMY_TEXT_SKIP_PATTERNS.test(line)) continue;
    const m = line.match(unitLineRegex);
    if (!m) continue;
    entries.push({ name: m[1].trim(), points: m[2], group: inGroup ? groupIndex : null });
  }

  const groupTotals = {};
  entries.forEach((e) => {
    if (e.group === null) return;
    groupTotals[e.group] = (groupTotals[e.group] || 0) + parseInt(e.points, 10);
  });
  entries.forEach((e) => {
    if (e.group !== null && groupTotals[e.group] !== undefined) {
      e.altPoints = String(groupTotals[e.group]);
    }
  });

  return { listName, entries };
}

// Tiered matching against the existing library: prefer an exact name+points
// match (handles multiple same-named units at different loadouts/costs);
// fall back to a unique exact name match; fall back to a unique "library name
// starts with this name" match (catches units renamed by the attached-leader
// merge, e.g. "Wolf Guard Terminators (vede Logan Grimnar)"). Anything still
// unresolved is reported back instead of guessed at.
function matchArmyEntriesToLibrary(entries, library) {
  const matchedIds = new Set();
  const unmatched = [];

  entries.forEach((entry) => {
    const nameLower = entry.name.toLowerCase();
    const pointsToTry = entry.altPoints ? [entry.points, entry.altPoints] : [entry.points];
    for (const pts of pointsToTry) {
      const exact = library.filter((u) => u.name.toLowerCase() === nameLower && String(u.points) === String(pts));
      if (exact.length > 0) {
        matchedIds.add(exact[0].id);
        return;
      }
    }
    // The group's combined points might also show up on a library entry
    // whose name is the *other* member of the pair with a "(vede X)"-style
    // suffix (the leader's own name never survives the merge) — try a
    // prefix match at the combined points before giving up on that tier.
    if (entry.altPoints) {
      const byPrefixAndPoints = library.filter((u) => u.name.toLowerCase().startsWith(nameLower) && String(u.points) === String(entry.altPoints));
      if (byPrefixAndPoints.length === 1) {
        matchedIds.add(byPrefixAndPoints[0].id);
        return;
      }
    }
    const byNameOnly = library.filter((u) => u.name.toLowerCase() === nameLower);
    if (byNameOnly.length === 1) {
      matchedIds.add(byNameOnly[0].id);
      return;
    }
    const byPrefix = library.filter((u) => u.name.toLowerCase().startsWith(nameLower));
    if (byPrefix.length === 1) {
      matchedIds.add(byPrefix[0].id);
      return;
    }
    unmatched.push(entry);
  });

  return { matchedIds: Array.from(matchedIds), unmatched };
}

// ---------------------------------------------------------------------------
// BattleScribe / New Recruit JSON roster parser — pulls real characteristics
// ---------------------------------------------------------------------------
function parseDiceAvg(text) {
  if (text === undefined || text === null) return 0;
  const t = String(text).trim();
  if (!t || t === "N/A" || t === "-") return 0;
  const m = /^(\d*)D(\d+)(?:\+(\d+))?$/i.exec(t);
  if (m) {
    const count = m[1] ? parseInt(m[1], 10) : 1;
    const die = parseInt(m[2], 10);
    const bonus = m[3] ? parseInt(m[3], 10) : 0;
    return count * ((die + 1) / 2) + bonus;
  }
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : 0;
}

// Full probability distribution for a dice-notation string like "D6", "2D6",
// "D3+3" — used to model "re-roll one damage roll" (see below), which needs
// the actual spread of outcomes, not just the average parseDiceAvg gives.
// Returns null for anything that isn't recognized dice notation (flat
// numbers, blank, "N/A", …), so callers can fall back to a no-op.
function parseDiceDistribution(text) {
  if (text === undefined || text === null) return null;
  const t = String(text).trim();
  if (!t) return null;
  const m = /^(\d*)D(\d+)(?:\+(\d+))?$/i.exec(t);
  if (!m) return null;
  const count = m[1] ? parseInt(m[1], 10) : 1;
  const die = parseInt(m[2], 10);
  const flatBonus = m[3] ? parseInt(m[3], 10) : 0;
  if (!count || !die || count > 10 || die > 20) return null;
  // Convolve `count` uniform 1..die dice together.
  let dist = new Map([[0, 1]]);
  for (let i = 0; i < count; i++) {
    const next = new Map();
    dist.forEach((p, sum) => {
      for (let face = 1; face <= die; face++) {
        const key = sum + face;
        next.set(key, (next.get(key) || 0) + p / die);
      }
    });
    dist = next;
  }
  if (flatBonus) {
    const shifted = new Map();
    dist.forEach((p, sum) => shifted.set(sum + flatBonus, p));
    dist = shifted;
  }
  return dist;
}

// "Re-roll one damage roll" (e.g. "you can re-roll the damage roll"): a
// rational player only takes the reroll when the roll came out low, keeping
// it otherwise. Finds the break-even threshold that maximizes the expected
// result — reroll totals at or below it, keep totals above it — and returns
// that expected value. For a plain D6 this lands on "re-roll 3 or less,
// keep 4+", matching how the ability plays out in practice.
function expectedValueWithOneReroll(dist) {
  const entries = Array.from(dist.entries()).sort((a, b) => a[0] - b[0]);
  const baseMean = entries.reduce((s, [v, p]) => s + v * p, 0);
  let best = baseMean;
  let cumP = 0;
  // Threshold t: reroll every value <= t, keep every value > t.
  for (const [t] of entries) {
    cumP += dist.get(t);
    const keptE = entries.filter(([x]) => x > t).reduce((s, [x, p]) => s + x * p, 0);
    const e = cumP * baseMean + keptE;
    if (e > best) best = e;
  }
  return best;
}

function parseHitVal(text) {
  if (!text) return 3;
  const t = String(text).trim();
  if (t.toUpperCase() === "N/A") return 1; // auto-hit (e.g. Torrent weapons)
  const n = parseInt(t.replace("+", ""), 10);
  return Number.isFinite(n) ? n : 3;
}

function parseSaveVal(text) {
  if (!text) return 0;
  const t = String(text).trim();
  if (t === "-" || t.toUpperCase() === "N/A") return 0;
  const n = parseInt(t.replace("+", ""), 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // A save/invulnerable characteristic is always a 2–6 die-roll target; clamp
  // defensively in case the source text is malformed, so it can never come out
  // as something like "40+".
  return Math.max(2, Math.min(6, n));
}

function parseIntSafe(text, fallback = 0) {
  if (text === undefined || text === null) return { value: fallback, ok: false };
  const t = String(text).trim();
  const n = parseInt(t.replace("+", ""), 10);
  return Number.isFinite(n) ? { value: n, ok: true } : { value: fallback, ok: false };
}

function parseWeaponCharacteristics(wc) {
  const keywords = (wc && wc.Keywords) || "";
  const lethalHits = /lethal hits/i.test(keywords);
  let sustained = 0;
  const susMatch = keywords.match(/sustained hits\s*(d?\d*)/i);
  if (susMatch) sustained = susMatch[1] ? parseDiceAvg(susMatch[1]) : 1;

  // Melta X: within half range, add X to the Damage characteristic. We can't
  // know actual table distance, so we store the value and let the person
  // toggle "within half range" per weapon for a given calculation.
  let melta = 0;
  const meltaMatch = keywords.match(/melta\s*(\d+)/i);
  if (meltaMatch) melta = parseInt(meltaMatch[1], 10) || 0;

  // Rapid Fire X: within half range, add X to the Attacks characteristic.
  // Same "can't know actual table distance" caveat as Melta above — stored
  // and toggled per weapon for a given calculation.
  let rapidFire = 0;
  const rapidFireMatch = keywords.match(/rapid fire\s*(\d+)/i);
  if (rapidFireMatch) rapidFire = parseInt(rapidFireMatch[1], 10) || 0;

  // Twin-linked: re-roll the wound roll for this weapon.
  const twinLinked = /twin-linked/i.test(keywords);

  // Anti-X Y+ (e.g. "Anti-Monster 3+") — only the keywords the app has a
  // toggle for on the defender side are recognized; anything else is left
  // as "none" for the person to set up manually if it matters.
  let antiKeyword = "none";
  let antiValue = 0;
  const antiMatch = keywords.match(/anti-(monster|vehicle|character)\s*(\d)\+?/i);
  if (antiMatch) {
    antiKeyword = antiMatch[1].toLowerCase();
    antiValue = parseInt(antiMatch[2], 10) || 0;
  }

  const isMelee = wc && wc.Range && String(wc.Range).trim().toLowerCase() === "melee";
  const hitText = wc ? (isMelee ? wc.WS : wc.BS) : null;
  const strengthParsed = wc ? parseIntSafe(wc.S, 4) : { value: 4, ok: true };

  return {
    type: isMelee ? "melee" : "ranged",
    attacks: wc ? parseDiceAvg(wc.A) || 1 : 1,
    hitX: wc ? parseHitVal(hitText) : 3,
    strength: strengthParsed.value,
    ap: wc ? -Math.abs(parseIntSafe(wc.AP, 0).value) : 0,
    damage: wc ? parseDiceAvg(wc.D) || 1 : 1,
    // Raw dice notation (e.g. "D6", "2D6") kept alongside the averaged
    // `damage` above so a "re-roll one damage roll" ability can be modeled
    // exactly instead of just off the average.
    damageDice: wc && wc.D ? String(wc.D).trim() : "",
    lethalHits,
    sustained,
    melta,
    rapidFire,
    antiKeyword,
    antiValue,
    twinLinked,
    rerollHit: "none",
    rerollWound: twinLinked ? "all" : "none",
    needsStats: !strengthParsed.ok,
    note: wc ? [wc.Range, keywords].filter(Boolean).join(" · ") : "",
  };
}

// New Recruit lists each attack profile of a multi-profile melee weapon (e.g. an
// Axe with separate "Sweep" and "Strike" profiles) as its own entry under the
// same wargear selection. A model can only ever use ONE of them per fight, so we
// group profiles from the same node together and treat them as alternates of a
// single weapon rather than adding both.
function cleanProfileLabel(name, groupName) {
  let n = String(name || "").replace(/^[➤▶►\s]+/, "").trim();
  const prefix = `${groupName} - `;
  if (n.startsWith(prefix)) n = n.slice(prefix.length);
  return n || name || "";
}

// Picks a sensible default profile when a weapon has more than one (e.g. Sweep
// vs Strike) — whichever deals more expected damage against a generic mid-tier
// target (T4, 3+ save), so the default at least reflects a real trade-off rather
// than an arbitrary pick. The user can still switch it in the unit editor.
function pickDefaultProfileIndex(profiles) {
  const genericDef = { toughness: 4, save: 3, invul: 0, wounds: 1, models: 1, fnp: 0, woundDebuff: false, damageReduction: 0 };
  const genericBonus = { lethalHits: false, sustained: 0, rerollHit: "none", rerollWound: "none", apMod: 0, hitMod: 0, woundMod: 0 };
  let bestIdx = 0;
  let bestDmg = -1;
  profiles.forEach((p, i) => {
    const r = computeWeapon(p, 1, genericDef, genericBonus);
    if (r.totalDamage > bestDmg) {
      bestDmg = r.totalDamage;
      bestIdx = i;
    }
  });
  return bestIdx;
}

// Scans a unit's own ability descriptions for two common defensive rules text
// patterns: "Feel No Pain X+" and "subtract/reduce ... Damage characteristic
// ... by N" (e.g. a C'tan Shard's damage-reduction ability) — so both get
// applied automatically instead of needing to be typed in by hand every time.
function detectDefensiveAbilities(topSel) {
  let fnp = 0;
  let damageReduction = 0;
  const checkText = (text) => {
    const fnpMatch = text.match(/feel no pain[^\d]{0,12}(\d)\s*\+/i);
    if (fnpMatch) {
      const v = parseInt(fnpMatch[1], 10);
      if (Number.isFinite(v) && (fnp === 0 || v < fnp)) fnp = v;
    }
    const dmgMatch = text.match(/subtract (\d+) from the damage characteristic|reduce(?:s|d)? the damage characteristic[^.]*by (\d+)|damage characteristic[^.]*(?:reduced|worsened|subtract(?:ed)?)[^.]*by (\d+)/i);
    if (dmgMatch) {
      const v = parseInt(dmgMatch[1] || dmgMatch[2] || dmgMatch[3], 10);
      if (Number.isFinite(v) && v > damageReduction) damageReduction = v;
    } else if (/damage characteristic/i.test(text) && /(reduced|worsened|subtract)/i.test(text) && /\bby 1\b/i.test(text)) {
      damageReduction = Math.max(damageReduction, 1);
    }
  };
  const scan = (node) => {
    // Generic named rules (e.g. "Feel No Pain 5+") live in their own "rules"
    // array — separate from "profiles" — with the actual value usually in the
    // rule's own name rather than its description text.
    (node.rules || []).forEach((r) => {
      checkText(`${r.name || ""} ${r.description || ""}`);
    });
    // Datasheet-specific abilities (e.g. a C'tan's damage-reduction rule) show
    // up as "Abilities"-typeName profiles instead, with the value in either
    // the profile's own name or its characteristic text.
    (node.profiles || []).forEach((p) => {
      const nameText = p.name || "";
      const bodyText = (p.characteristics || []).map((c) => c["$text"] || "").join(" ");
      checkText(`${nameText} ${bodyText}`);
    });
    (node.selections || []).forEach(scan);
  };
  scan(topSel);
  return { fnp, damageReduction };
}

// Scans a unit's own ability text for offensive "re-roll Hit/Wound rolls
// against a keyword" abilities (e.g. a Grand Master in Nemesis Dreadknight:
// "Each time this model makes a melee attack that targets a Monster or
// Vehicle unit, you can re-roll the Hit roll [and] Wound roll") — applied
// automatically to every matching weapon on import instead of needing to be
// ticked by hand. Scoped to melee/ranged/both depending on the ability text;
// the Damage-roll part of such abilities isn't modeled (Damage here is
// already an averaged value, not a live per-attack die roll).
function detectOffensiveRerollAbilities(topSel) {
  const result = { melee: { monster: false, vehicle: false, character: false }, ranged: { monster: false, vehicle: false, character: false } };
  const checkText = (text) => {
    if (!/re-?roll/i.test(text)) return;
    if (!/hit roll/i.test(text) && !/wound roll/i.test(text)) return;
    const scopes = [];
    if (/melee attack/i.test(text)) scopes.push("melee");
    if (/ranged attack/i.test(text)) scopes.push("ranged");
    if (scopes.length === 0) scopes.push("melee", "ranged");
    const kws = [];
    if (/\bmonster\b/i.test(text)) kws.push("monster");
    if (/\bvehicle\b/i.test(text)) kws.push("vehicle");
    if (/\bcharacter\b/i.test(text)) kws.push("character");
    if (kws.length === 0) return;
    scopes.forEach((s) => kws.forEach((k) => (result[s][k] = true)));
  };
  const scan = (node) => {
    (node.rules || []).forEach((r) => checkText(`${r.name || ""} ${r.description || ""}`));
    (node.profiles || []).forEach((p) => {
      const nameText = p.name || "";
      const bodyText = (p.characteristics || []).map((c) => c["$text"] || "").join(" ");
      checkText(`${nameText} ${bodyText}`);
    });
    (node.selections || []).forEach(scan);
  };
  scan(topSel);
  return result;
}

function extractUnitChars(up) {
  const uc = {};
  (up.characteristics || []).forEach((c) => {
    uc[c.name] = c["$text"];
  });
  return {
    toughness: parseIntSafe(uc.T, 4).value,
    save: parseSaveVal(uc.Sv),
    invul: parseSaveVal(uc.InSv),
    wounds: parseIntSafe(uc.W, 1).value,
    // Rare, but some data sources list Feel No Pain as its own characteristic
    // column right alongside T/Sv/W rather than as ability description text.
    fnp: parseSaveVal(uc.FNP || uc["Feel No Pain"] || uc.FNPSave || uc.FnP),
    base: parseBaseText(uc.Base),
  };
}

function parseBattleScribeJSON(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return null;
  }
  const roster = data && data.roster ? data.roster : data;
  if (!roster || !Array.isArray(roster.forces)) return null;

  const armyUnits = [];

  for (const force of roster.forces) {
    const catalogueName = force.catalogueName || "";
    const segs = catalogueName.split("-").map((s) => s.trim()).filter(Boolean);
    const faction = segs[segs.length - 1] || catalogueName || "Neznámá frakce";

    const findUnitProfile = (node) => (node.profiles || []).find((p) => p.typeName === "Unit");

    // "number" on a weapon-selection node is ambiguous in New Recruit's export:
    // for infantry it usually equals the model-line's own model count (one weapon
    // per model), but for a single model carrying multiple copies of the same
    // weapon (e.g. a Land Raider Redeemer's 2x Flamestorm Cannon) it's the copy
    // count instead. Dividing by the model-line's own count disambiguates both.
    // Multiple weapon-typeName profiles found on the SAME node (like Sweep/Strike
    // on one Axe) are grouped together as alternate profiles of one weapon.
    const collectWeaponsLocal = (node, weapons, modelCount) => {
      const profilesHere = (node.profiles || []).filter((p) => p.typeName === "Ranged Weapons" || p.typeName === "Melee Weapons");
      if (profilesHere.length > 0) {
        const rawNumber = node.number || 1;
        const copies = modelCount > 0 ? Math.max(1, Math.round(rawNumber / modelCount)) : 1;
        weapons.push({ profiles: profilesHere, copies, groupName: node.name });
      }
      (node.selections || []).forEach((child) => {
        if (findUnitProfile(child)) return;
        collectWeaponsLocal(child, weapons, modelCount);
      });
    };

    const collectMembers = (node, members) => {
      const up = findUnitProfile(node);
      if (up) {
        const modelCount = node.number || 1;
        const weaponGroups = [];
        collectWeaponsLocal(node, weaponGroups, modelCount);
        const weapons = weaponGroups.map((wg) => {
          const builtProfiles = wg.profiles.map((p) => {
            const wc = {};
            (p.characteristics || []).forEach((c) => {
              wc[c.name] = c["$text"];
            });
            return { name: cleanProfileLabel(p.name, wg.groupName), ...parseWeaponCharacteristics(wc) };
          });
          const displayName = wg.copies > 1 ? `${wg.copies}x ${wg.groupName}` : wg.groupName;
          const base = { id: crypto.randomUUID(), name: displayName, copies: wg.copies };
          if (builtProfiles.length <= 1) {
            return { ...base, ...builtProfiles[0] };
          }
          const activeIdx = pickDefaultProfileIndex(builtProfiles);
          const anyNeedsStats = builtProfiles.some((p) => p.needsStats);
          return { ...base, ...builtProfiles[activeIdx], needsStats: anyNeedsStats, profiles: builtProfiles, activeProfileIndex: activeIdx };
        });
        members.push({
          id: crypto.randomUUID(),
          name: node.name,
          count: modelCount,
          chars: extractUnitChars(up),
          weapons,
        });
      }
      (node.selections || []).forEach((child) => collectMembers(child, members));
    };

    // Real number of models in a unit: the sum of every "model" selection's
    // own number (a Strike Squad = Justicar 1 + Grey Knight 4 = 5). Exports
    // differ - the Unit profile sits on the unit node in some and on each
    // model in others - so the member counts above can't be trusted for this.
    const countModels = (node) => {
      let n = node.type === "model" ? node.number || 1 : 0;
      (node.selections || []).forEach((child) => {
        n += countModels(child);
      });
      return n;
    };

    for (const topSel of force.selections || []) {
      const members = [];
      collectMembers(topSel, members);
      if (members.length === 0) continue;

      const needsStats = members.some((m) => m.weapons.some((w) => w.needsStats));
      const isLeader = (topSel.categories || []).some((c) => (c.name || "").trim().toLowerCase() === "leader");
      const categoryNames = (topSel.categories || []).map((c) => (c.name || "").trim().toLowerCase());
      const keywords = {
        monster: categoryNames.includes("monster"),
        vehicle: categoryNames.includes("vehicle"),
        character: categoryNames.includes("character"),
      };
      const ptsCost = (topSel.costs || []).find((c) => c.name === "pts");
      const points = ptsCost ? String(ptsCost.value) : "";
      const defensiveAbilities = detectDefensiveAbilities(topSel);

      const offensiveRerolls = detectOffensiveRerollAbilities(topSel);
      members.forEach((m) => {
        m.weapons.forEach((w) => {
          const scope = w.type === "melee" ? offensiveRerolls.melee : offensiveRerolls.ranged;
          if (scope.monster || scope.vehicle || scope.character) {
            const existing = w.rerollVsKeywords || {};
            w.rerollVsKeywords = {
              monster: existing.monster || scope.monster,
              vehicle: existing.vehicle || scope.vehicle,
              character: existing.character || scope.character,
            };
          }
        });
      });

      armyUnits.push({
        id: crypto.randomUUID(),
        sourceId: topSel.id,
        associations: topSel.associations || [],
        faction,
        name: topSel.name,
        points,
        members, // still carrying .chars per member at this point — stripped after merge below
        modelCount: countModels(topSel),
        needsStats,
        isLeader,
        keywords,
        fnp: defensiveAbilities.fnp,
        damageReduction: defensiveAbilities.damageReduction,
      });
    }
  }

  // Fold attached leaders (e.g. "Logan Grimnar" Leading "Wolf Guard Terminators") into
  // the unit they lead, so their weapons count as part of that unit's total output —
  // this mirrors how an attached character actually fights as part of the unit.
  const bySource = new Map(armyUnits.map((u) => [u.sourceId, u]));
  const toRemove = new Set();
  armyUnits.forEach((u) => {
    (u.associations || []).forEach((a) => {
      if (a.action === "group" && bySource.has(a.to)) {
        const target = bySource.get(a.to);
        if (target && target !== u) {
          target.members = [...target.members, ...u.members];
          target.name = `${target.name} (vede ${u.name})`;
          target.needsStats = target.needsStats || u.needsStats;
          target.modelCount = (target.modelCount || 0) + (u.modelCount || 0);
          const p1 = parseInt(target.points, 10);
          const p2 = parseInt(u.points, 10);
          if (Number.isFinite(p1) && Number.isFinite(p2)) target.points = String(p1 + p2);
          toRemove.add(u.id);
        }
      }
    });
  });

  const finalUnits = armyUnits
    .filter((u) => !toRemove.has(u.id))
    .map((u) => {
      const weightedPick = (key) => {
        const tally = new Map();
        u.members.forEach((m) => {
          const v = m.chars[key];
          tally.set(v, (tally.get(v) || 0) + m.count);
        });
        let best = null;
        let bestW = -1;
        tally.forEach((w, v) => {
          if (w > bestW) {
            bestW = w;
            best = v;
          }
        });
        return best;
      };
      const total = u.members.reduce((s, m) => s + m.count, 0);
      const weightedWounds = total > 0 ? u.members.reduce((s, m) => s + m.count * m.chars.wounds, 0) / total : 1;
      // FNP can come from either the ability-text scan (u.fnp) or a direct FNP
      // characteristic column on the member's Unit profile (m.chars.fnp) —
      // whichever actually found a value wins (prefer the lower/better one).
      const charsFnp = weightedPick("fnp") || 0;
      const combinedFnp = u.fnp > 0 && charsFnp > 0 ? Math.min(u.fnp, charsFnp) : u.fnp || charsFnp || 0;

      const baseTally = new Map();
      u.members.forEach((m) => {
        if (m.chars.base) baseTally.set(m.chars.base, (baseTally.get(m.chars.base) || 0) + m.count);
      });
      let baseSize = "32";
      let baseBest = -1;
      baseTally.forEach((w, v) => {
        if (w > baseBest) {
          baseBest = w;
          baseSize = v;
        }
      });
      if (baseSize === "hull") baseSize = hullBaseFor(String(u.name || "").replace(/ \(vede.*$/, ""));

      return {
        id: u.id,
        faction: u.faction,
        name: u.name,
        points: u.points,
        baseSize,
        toughness: weightedPick("toughness"),
        save: weightedPick("save"),
        invul: weightedPick("invul"),
        wounds: Math.round(weightedWounds * 100) / 100,
        fnp: combinedFnp,
        woundDebuff: false,
        damageReduction: u.damageReduction || 0,
        keywords: u.keywords || { monster: false, vehicle: false, character: false },
        members: u.members.map((m) => ({ id: m.id, name: m.name, count: m.count, weapons: m.weapons })),
        ...(u.modelCount > 0 ? { modelCount: u.modelCount } : {}),
        needsStats: u.needsStats,
        isLeader: u.isLeader,
        isFavorite: false,
      };
    });

  return finalUnits;
}

// ---------------------------------------------------------------------------
// UI primitives
// ---------------------------------------------------------------------------
function NumberField({ label, value, onChange, step = 1, min, hint, small }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: small ? 11 : 12.5, color: "var(--label)", fontWeight: 600, letterSpacing: 0.2 }}>{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        onChange={(e) => onChange(clampNum(e.target.value))}
        className="wh40k-input"
        style={{
          background: "var(--field-bg)",
          border: "1px solid var(--field-border)",
          borderRadius: 6,
          color: "var(--text)",
          padding: small ? "5px 7px" : "7px 9px",
          fontSize: small ? 12.5 : 14,
          fontFamily: "var(--mono)",
          width: "100%",
          boxSizing: "border-box",
        }}
      />
      {hint && <span style={{ fontSize: 10.5, color: "var(--muted)" }}>{hint}</span>}
    </label>
  );
}

function TextField({ label, value, onChange, placeholder, small }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: small ? 11 : 12.5, color: "var(--label)", fontWeight: 600 }}>{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="wh40k-input"
        style={{
          background: "var(--field-bg)",
          border: "1px solid var(--field-border)",
          borderRadius: 6,
          color: "var(--text)",
          padding: small ? "5px 7px" : "7px 9px",
          fontSize: small ? 12.5 : 14,
          width: "100%",
          boxSizing: "border-box",
        }}
      />
    </label>
  );
}

function SelectField({ label, value, onChange, options, small }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: small ? 11 : 12.5, color: "var(--label)", fontWeight: 600 }}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="wh40k-select"
        style={{
          background: "var(--field-bg)",
          border: "1px solid var(--field-border)",
          borderRadius: 6,
          color: "var(--text)",
          padding: small ? "5px 7px" : "7px 9px",
          fontSize: small ? 12.5 : 14,
          width: "100%",
          boxSizing: "border-box",
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ToggleField({ label, value, onChange, small, hint }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: small ? 11 : 12.5, color: "var(--label)", fontWeight: 600 }}>{label}</span>
      <button
        onClick={() => onChange(!value)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: value ? "var(--accent-dim)" : "var(--field-bg)",
          border: `1px solid ${value ? "var(--accent)" : "var(--field-border)"}`,
          borderRadius: 6,
          color: value ? "var(--accent-text)" : "var(--text)",
          padding: small ? "5px 7px" : "7px 9px",
          fontSize: small ? 12 : 13,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        {value ? "ANO" : "NE"}
      </button>
      {hint && <span style={{ fontSize: 10.5, color: "var(--muted)" }}>{hint}</span>}
    </div>
  );
}

function Row({ children, cols = 3 }) {
  return <div className={`wh40k-row wh40k-row-${cols}`}>{children}</div>;
}

function SectionLabel({ children }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "var(--muted)", margin: "12px 0 6px" }}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Weapon / member editors (used inside the unit form)
// ---------------------------------------------------------------------------
function WeaponEditor({ weapon, onChange, onRemove }) {
  const set = (k) => (v) => onChange({ ...weapon, [k]: v });
  const setRerollKw = (k) => (v) => onChange({ ...weapon, rerollVsKeywords: { ...(weapon.rerollVsKeywords || {}), [k]: v } });
  return (
    <div style={{ background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 8, padding: 10, marginTop: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 6 }}>
        <div style={{ flex: 1 }}>
          <TextField label="Název zbraně" value={weapon.name} onChange={set("name")} small />
        </div>
        <div style={{ width: 130 }}>
          <SelectField label="Typ" value={weapon.type} onChange={set("type")} options={WEAPON_TYPE_OPTIONS} small />
        </div>
        <button
          onClick={onRemove}
          title="Odebrat zbraň"
          style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", padding: 6 }}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <Row cols={3}>
        <NumberField label="Útoků" value={weapon.attacks} onChange={set("attacks")} min={0} small />
        <NumberField label={weapon.type === "melee" ? "Zásah WS (X+)" : "Zásah BS (X+)"} value={weapon.hitX} onChange={set("hitX")} min={1} small />
        <NumberField label="Síla (S)" value={weapon.strength} onChange={set("strength")} min={0} small />
      </Row>
      <Row cols={3}>
        <NumberField label="AP" value={weapon.ap} onChange={set("ap")} small />
        <NumberField label="Damage" value={weapon.damage} onChange={set("damage")} min={0} small />
        <NumberField label="Kopií na model" value={weapon.copies || 1} onChange={set("copies")} min={1} hint="např. 2x Flamestorm Cannon" small />
      </Row>
      <Row cols={4}>
        <ToggleField label="Lethal Hits" value={weapon.lethalHits} onChange={set("lethalHits")} small />
        <NumberField label="Sustained (extra)" value={weapon.sustained} onChange={set("sustained")} min={0} small />
        <SelectField label="Přehoz hit rollu" value={weapon.rerollHit} onChange={set("rerollHit")} options={REROLL_OPTIONS} small />
        <SelectField label="Přehoz wound rollu" value={weapon.rerollWound} onChange={set("rerollWound")} options={REROLL_OPTIONS} small />
      </Row>
      <Row cols={3}>
        <NumberField
          label="Critical Hit na (X+)"
          value={weapon.critHitsOn || 6}
          onChange={set("critHitsOn")}
          min={2}
          hint="normálně 6; např. Critical Hits on 5+"
          small
        />
        <NumberField
          label="Critical Wound na (X+)"
          value={weapon.critWoundOn || 6}
          onChange={set("critWoundOn")}
          min={2}
          hint="normálně 6; např. Critical Wounds on 5+"
          small
        />
        <ToggleField
          label="Devastating Wounds"
          value={weapon.devastatingWounds}
          onChange={set("devastatingWounds")}
          hint="Critical Wound = mortal wounds mimo jakýkoli save"
          small
        />
      </Row>
      <Row cols={2}>
        <ToggleField label="Přehoz 1 hitu (jednorázově)" value={weapon.rerollOneHit} onChange={set("rerollOneHit")} small />
        <ToggleField label="Přehoz 1 woundu (jednorázově)" value={weapon.rerollOneWound} onChange={set("rerollOneWound")} small />
      </Row>
      <Row cols={2}>
        <TextField
          label="Kostky Damage (nepovinné)"
          value={weapon.damageDice || ""}
          onChange={set("damageDice")}
          placeholder="např. D6, 2D6, D3+3"
          small
        />
        <ToggleField
          label="Přehoz 1 damage rollu (jednorázově)"
          value={weapon.rerollOneDamage}
          onChange={set("rerollOneDamage")}
          hint={weapon.damageDice ? undefined : "vyžaduje vyplněné kostky Damage výše"}
          small
        />
      </Row>
      <Row cols={2}>
        <ToggleField
          label="Psychický útok (Psychic)"
          value={weapon.isPsychic}
          onChange={set("isPsychic")}
          hint="pro obránce s FNP jen proti Psychic Attacks (např. Culexus)"
          small
        />
        <ToggleField
          label="+1 útok, když jednotku vede vůdce"
          value={weapon.plusAttackWithLeader}
          onChange={set("plusAttackWithLeader")}
          hint="např. Castellan Crowe u Purifiers → Purifying Flame +1 útok; platí jen když je v kalkulačce připojený vůdce"
          small
        />
      </Row>
      <Row cols={2}>
        <NumberField
          label="Melta (0 = žádná)"
          value={weapon.melta || 0}
          onChange={set("melta")}
          min={0}
          hint="+X k Damage v polovičním dosahu (Twin-linked = přehoz zranění vše)"
          small
        />
        <NumberField
          label="Rapid Fire (0 = žádný)"
          value={weapon.rapidFire || 0}
          onChange={set("rapidFire")}
          min={0}
          hint="+X útoků v polovičním dosahu (Rapid Fire 2 = +2 Attacks)"
          small
        />
      </Row>
      <Row cols={2}>
        <SelectField
          label="Anti- klíčové slovo"
          value={weapon.antiKeyword || "none"}
          onChange={set("antiKeyword")}
          options={ANTI_KEYWORD_OPTIONS}
          small
        />
        <NumberField
          label="Anti- práh (X+)"
          value={weapon.antiValue || 0}
          onChange={set("antiValue")}
          min={2}
          hint="proti tomuto klíč. slovu automaticky zraní na tento hod"
          small
        />
      </Row>
      <div style={{ marginTop: 2 }}>
        <div style={{ fontSize: 11, color: "var(--label)", fontWeight: 600, marginBottom: 4 }}>Přehoz vše (zásah i zranění) proti klíč. slovu</div>
        <Row cols={3}>
          <ToggleField label="vs MONSTER" value={!!(weapon.rerollVsKeywords || {}).monster} onChange={setRerollKw("monster")} small />
          <ToggleField label="vs VEHICLE" value={!!(weapon.rerollVsKeywords || {}).vehicle} onChange={setRerollKw("vehicle")} small />
          <ToggleField label="vs CHARACTER" value={!!(weapon.rerollVsKeywords || {}).character} onChange={setRerollKw("character")} small />
        </Row>
        <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: -2, marginBottom: 6 }}>např. GMNDK proti MONSTER i VEHICLE zároveň</div>
      </div>
      {weapon.note && <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 2 }}>{weapon.note}</div>}
    </div>
  );
}

function MemberEditor({ member, onChange, onRemove }) {
  const setField = (k) => (v) => onChange({ ...member, [k]: v });
  const setWeapon = (idx) => (w) => {
    const weapons = member.weapons.slice();
    weapons[idx] = w;
    onChange({ ...member, weapons });
  };
  const addWeapon = () => onChange({ ...member, weapons: [...member.weapons, emptyWeapon()] });
  const removeWeapon = (idx) => onChange({ ...member, weapons: member.weapons.filter((_, i) => i !== idx) });

  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 8, padding: 10, marginTop: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <div style={{ flex: 1 }}>
          <TextField label="Název modelu / role" value={member.name} onChange={setField("name")} small />
        </div>
        <div style={{ width: 90 }}>
          <NumberField label="Počet" value={member.count} onChange={setField("count")} min={0} small />
        </div>
        <button onClick={onRemove} title="Odebrat model" style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", padding: 6 }}>
          <Trash2 size={14} />
        </button>
      </div>
      {member.weapons.map((w, idx) => (
        <WeaponEditor key={w.id} weapon={w} onChange={setWeapon(idx)} onRemove={() => removeWeapon(idx)} />
      ))}
      <button
        onClick={addWeapon}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          border: "1px dashed var(--field-border)",
          background: "transparent",
          color: "var(--text)",
          borderRadius: 6,
          padding: "5px 10px",
          fontSize: 12,
          cursor: "pointer",
          marginTop: 6,
        }}
      >
        <Plus size={12} /> Přidat zbraň
      </button>
    </div>
  );
}

function UnitForm({ initial, onSave, onCancel }) {
  const [u, setU] = useState(initial);
  const set = (k) => (v) => setU((s) => ({ ...s, [k]: v }));
  const setKeyword = (k) => (v) => setU((s) => ({ ...s, keywords: { ...(s.keywords || {}), [k]: v } }));

  const setMember = (idx) => (m) => {
    const members = u.members.slice();
    members[idx] = m;
    setU((s) => ({ ...s, members }));
  };
  const addMember = () => setU((s) => ({ ...s, members: [...s.members, emptyMember()] }));
  const removeMember = (idx) => setU((s) => ({ ...s, members: s.members.filter((_, i) => i !== idx) }));

  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 10, padding: 16, marginTop: 10 }}>
      {u.needsStats && (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            background: "var(--accent-dim)",
            border: "1px solid var(--accent)",
            borderRadius: 6,
            padding: "8px 10px",
            marginBottom: 12,
            fontSize: 12,
            color: "var(--accent-text)",
          }}
        >
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>Některé hodnoty jsou zástupné nebo nejisté (např. síla zbraně &quot;User&quot;) — zkontroluj je před uložením.</span>
        </div>
      )}

      <Row cols={3}>
        <TextField label="Frakce" value={u.faction} onChange={set("faction")} placeholder="např. Space Wolves" />
        <div style={{ gridColumn: "span 2" }}>
          <TextField label="Název jednotky" value={u.name} onChange={set("name")} placeholder="např. Wolf Guard Terminators" />
        </div>
      </Row>

      <SectionLabel>Obranné staty jednotky (T / Sv / Invul / Wounds na model)</SectionLabel>
      <Row cols={4}>
        <NumberField label="Odolnost (T)" value={u.toughness} onChange={set("toughness")} min={0} />
        <NumberField label="Save (X+)" value={u.save} onChange={set("save")} min={1} />
        <NumberField label="Invul (0 = žádný)" value={u.invul} onChange={set("invul")} min={0} />
        <NumberField label="Wounds na model" value={u.wounds} onChange={set("wounds")} min={0} />
      </Row>
      <Row cols={2}>
        <SelectField label="Base size (pro Desku)" value={String(u.baseSize || 32)} onChange={set("baseSize")} options={baseSizeOptions(u.baseSize)} />
        <div />
      </Row>
      <Row cols={3}>
        <NumberField label="Feel No Pain (0 = žádný)" value={u.fnp} onChange={set("fnp")} min={0} />
        <NumberField
          label="FNP proti Psychic (0 = žádný)"
          value={u.psychicFnp || 0}
          onChange={set("psychicFnp")}
          min={0}
          hint="jen proti zbraním označeným jako Psychic, např. Culexus Assassin"
        />
        <ToggleField label="Může vést jednotku (Leader)" value={u.isLeader} onChange={set("isLeader")} hint="jen jednotky s touto schopností lze připojit jako vůdce" />
      </Row>
      <Row cols={3}>
        <ToggleField
          label="Debuff: -1 WR pokud S > T"
          value={u.woundDebuff}
          onChange={set("woundDebuff")}
          hint="ztíží hod na zranění, když má útočník vyšší sílu než tato jednotka toughness"
        />
      </Row>
      <Row cols={3}>
        <NumberField
          label="Redukce damage (0 = žádná)"
          value={u.damageReduction}
          onChange={set("damageReduction")}
          min={0}
          hint="např. C'tan Shard: -1 k Damage každého útoku, min. 1"
        />
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end", fontSize: 12, color: "var(--muted)" }}>
          Celkem modelů v jednotce: <b style={{ color: "var(--text)" }}>{totalModels(u)}</b>
        </div>
      </Row>
      <Row cols={3}>
        <ToggleField label="Klíčové slovo: MONSTER" value={!!(u.keywords || {}).monster} onChange={setKeyword("monster")} hint="pro Anti-MONSTER X+ u útočníkových zbraní" small />
        <ToggleField label="Klíčové slovo: VEHICLE" value={!!(u.keywords || {}).vehicle} onChange={setKeyword("vehicle")} hint="pro Anti-VEHICLE X+ u útočníkových zbraní" small />
        <ToggleField label="Klíčové slovo: CHARACTER" value={!!(u.keywords || {}).character} onChange={setKeyword("character")} hint="pro Anti-CHARACTER X+ u útočníkových zbraní" small />
        <ToggleField label="Klíčové slovo: INFANTRY" value={!!(u.keywords || {}).infantry} onChange={setKeyword("infantry")} hint="pro Anti-INFANTRY X+ u útočníkových zbraní" small />
      </Row>

      <SectionLabel>Modely a jejich zbraně</SectionLabel>
      {u.members.map((m, idx) => (
        <MemberEditor key={m.id} member={m} onChange={setMember(idx)} onRemove={() => removeMember(idx)} />
      ))}
      <button
        onClick={addMember}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          border: "1px dashed var(--field-border)",
          background: "transparent",
          color: "var(--text)",
          borderRadius: 6,
          padding: "7px 12px",
          fontSize: 12.5,
          cursor: "pointer",
          marginTop: 8,
        }}
      >
        <Plus size={13} /> Přidat skupinu modelů
      </button>

      <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
        <button
          onClick={onCancel}
          style={{ border: "1px solid var(--field-border)", background: "transparent", color: "var(--text)", borderRadius: 6, padding: "7px 14px", fontSize: 13, cursor: "pointer" }}
        >
          Zrušit
        </button>
        <button
          onClick={() => {
            if (!u.name.trim()) return;
            onSave({ ...u, needsStats: false });
          }}
          className="wh40k-btn"
          style={{
            border: "none",
            background: "var(--accent)",
            color: "var(--accent-on)",
            borderRadius: 6,
            padding: "7px 14px",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Save size={14} /> Uložit jednotku
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Import box
// ---------------------------------------------------------------------------
function ImportBox({ onImport }) {
  const [text, setText] = useState("");
  const [summary, setSummary] = useState(null);
  const [fileName, setFileName] = useState("");

  const handleFile = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => setText(String(ev.target.result || ""));
    reader.onerror = () => setSummary({ error: true, message: "Soubor se nepodařilo přečíst." });
    reader.readAsText(file);
  };

  const handleImport = () => {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (trimmed.startsWith("{")) {
      const units = parseBattleScribeJSON(trimmed);
      if (!units || units.length === 0) {
        setSummary({ error: true, message: "Nepodařilo se rozpoznat strukturu JSON rosteru. Zkontroluj, že jde o export z New Recruit / BattleScribe." });
        return;
      }
      let rosterName = "";
      try {
        const parsed = JSON.parse(trimmed);
        rosterName = (parsed && parsed.roster && parsed.roster.name) || "";
      } catch (e) {
        rosterName = "";
      }
      // Roster export often has no name set in New Recruit — fall back to
      // something so this import always ends up selectable as one army in
      // the cheat sheet, instead of silently skipping army creation.
      if (!rosterName.trim()) {
        rosterName = `${units[0]?.faction || "Import"} ${new Date().toLocaleDateString("cs-CZ")}`;
      }
      const flagged = units.filter((u) => u.needsStats).length;
      const { added, skipped } = onImport(units, rosterName);
      setSummary({ error: false, count: added, skipped, faction: units[0]?.faction, flagged, full: true, rosterName });
      setText("");
      setFileName("");
      return;
    }

    const { faction, units } = parseNewRecruitText(trimmed);
    if (units.length === 0) {
      setSummary({ error: true, message: "Ve vloženém textu se nepodařilo najít žádné jednotky." });
      return;
    }
    const { added, skipped } = onImport(units);
    setSummary({ error: false, faction, count: added, skipped, full: false });
    setText("");
    setFileName("");
  };

  return (
    <div style={{ background: "var(--field-bg)", border: "1px dashed var(--field-border)", borderRadius: 8, padding: 12, marginTop: 10 }}>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
        Nahraj JSON export z New Recruit (soubor, nebo vlož obsah níže) — vytáhnou se z něj i skutečné bojové staty
        pro každý model i zbraň v jednotce a velikost podstavce (sloupec „Base“, pokud ho export má — u starších exportů
        chybí, pak zůstane 32 mm). Jde to i s obyčejným textovým exportem, ale ten staty neobsahuje a doplní
        se placeholder, který si pak upravíš ručně.
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            border: "1px solid var(--field-border)",
            borderRadius: 6,
            padding: "6px 12px",
            fontSize: 12.5,
            cursor: "pointer",
            color: "var(--text)",
          }}
        >
          <Upload size={13} /> Nahrát soubor (.json)
          <input type="file" accept=".json,application/json" onChange={handleFile} style={{ display: "none" }} />
        </label>
        {fileName && <span style={{ fontSize: 12, color: "var(--muted)" }}>{fileName}</span>}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="…nebo sem vlož obsah JSON / textového exportu přímo…"
        rows={5}
        style={{
          width: "100%",
          boxSizing: "border-box",
          background: "var(--panel)",
          border: "1px solid var(--field-border)",
          borderRadius: 6,
          color: "var(--text)",
          padding: "8px 9px",
          fontSize: 12,
          fontFamily: "var(--mono)",
          resize: "vertical",
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
        <button
          onClick={handleImport}
          className="wh40k-btn"
          style={{ display: "flex", alignItems: "center", gap: 6, border: "none", background: "var(--accent)", color: "var(--accent-on)", borderRadius: 6, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
        >
          <Upload size={14} /> Naimportovat
        </button>
        {summary && !summary.error && summary.full && (
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            Naimportováno {summary.count} jednotek {summary.faction ? `(${summary.faction})` : ""} se skutečnými staty.
            {summary.skipped > 0 && <> {summary.skipped}× už v knihovně bylo identické, přeskočeno.</>}
            {summary.flagged > 0 && <> {summary.flagged}× nešlo bezpečně rozpoznat sílu zbraně — zkontroluj ručně.</>}
            {summary.rosterName && (
              <>
                {" "}
                Uloženo jako armáda "{summary.rosterName}".
              </>
            )}
          </span>
        )}
        {summary && !summary.error && !summary.full && (
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            Naimportováno {summary.count} jednotek {summary.faction ? `(${summary.faction})` : ""} — doplň jim bojové staty.
            {summary.skipped > 0 && <> {summary.skipped}× už v knihovně bylo identické, přeskočeno.</>}
          </span>
        )}
        {summary && summary.error && <span style={{ fontSize: 12, color: "#e0857c" }}>{summary.message}</span>}
      </div>
    </div>
  );
}

function ArmyTextMatchBox({ onMatch }) {
  const [text, setText] = useState("");
  const [summary, setSummary] = useState(null);

  const handleMatch = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const result = onMatch(trimmed);
    setSummary(result);
    if (!result.error) setText("");
  };

  return (
    <div style={{ background: "var(--field-bg)", border: "1px dashed var(--field-border)", borderRadius: 8, padding: 12, marginTop: 10 }}>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
        Vlož prostý textový export listu z New Recruit / newrecruit.eu (jen jména a body, žádné staty) — včetně formátu
        s hlavičkou „+++ … +++". Appka jednotky spáruje podle jména a bodů s tím, co už máš v knihovně, a
        uloží/aktualizuje z nich armádu pro cheat sheet. Když list nemá vlastní název, pojmenuje se podle „PLAYER NAME".
        Jednotky, které se nenajdou, je potřeba mít nejdřív v knihovně (naimportované z JSON).
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="…sem vlož textový export listu…"
        rows={5}
        style={{
          width: "100%",
          boxSizing: "border-box",
          background: "var(--panel)",
          border: "1px solid var(--field-border)",
          borderRadius: 6,
          color: "var(--text)",
          padding: "8px 9px",
          fontSize: 12,
          fontFamily: "var(--mono)",
          resize: "vertical",
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
        <button
          onClick={handleMatch}
          className="wh40k-btn"
          style={{ display: "flex", alignItems: "center", gap: 6, border: "none", background: "var(--accent)", color: "var(--accent-on)", borderRadius: 6, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
        >
          <FolderPlus size={14} /> Spárovat s knihovnou
        </button>
        {summary && !summary.error && (
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            Armáda "{summary.name}": spárováno {summary.matchedCount} z {summary.totalCount} jednotek.
            {summary.unmatched.length > 0 && (
              <>
                {" "}
                Nenalezeno: {summary.unmatched.map((u) => `${u.name} (${u.points} pts)`).join(", ")}.
              </>
            )}
          </span>
        )}
        {summary && summary.error && <span style={{ fontSize: 12, color: "#e0857c" }}>{summary.message}</span>}
      </div>
    </div>
  );
}

function ExportImportBox({ library, armies, onImport }) {
  const [mode, setMode] = useState("export"); // export | import
  const [importText, setImportText] = useState("");
  const [importSummary, setImportSummary] = useState(null);
  const [importFileName, setImportFileName] = useState("");
  const [copied, setCopied] = useState(false);

  // Pretty-printed so the "paste as text" fallback stays at least readable —
  // the file download below is the main path now.
  const exportPayload = JSON.stringify({ battlecalcExport: true, units: library, armies }, null, 2);
  const exportFileName = `battlecalc-export-${new Date().toISOString().slice(0, 10)}.json`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(exportPayload);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setCopied(false);
    }
  };

  const handleDownload = () => {
    const blob = new Blob([exportPayload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const importFromText = (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    let data;
    try {
      data = JSON.parse(trimmed);
    } catch (e) {
      setImportSummary({ error: true, message: "Tohle nevypadá jako platný export z Battlecalc (neplatný JSON)." });
      return;
    }
    const units = Array.isArray(data.units) ? data.units : Array.isArray(data) ? data : null;
    if (!units) {
      setImportSummary({ error: true, message: "Tohle nevypadá jako platný export z Battlecalc." });
      return;
    }
    const armiesIn = Array.isArray(data.armies) ? data.armies : [];
    const { added, skipped } = onImport(units, armiesIn);
    setImportSummary({ error: false, added, skipped, armiesAdded: armiesIn.length });
    setImportText("");
    setImportFileName("");
  };

  const handleImport = () => importFromText(importText);

  const handleImportFile = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setImportFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => importFromText(String(ev.target.result || ""));
    reader.onerror = () => setImportSummary({ error: true, message: "Soubor se nepodařilo přečíst." });
    reader.readAsText(file);
  };

  return (
    <div style={{ background: "var(--field-bg)", border: "1px dashed var(--field-border)", borderRadius: 8, padding: 12, marginTop: 10 }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        <button
          onClick={() => setMode("export")}
          style={{
            flex: 1,
            border: "1px solid " + (mode === "export" ? "var(--accent)" : "var(--field-border)"),
            background: mode === "export" ? "var(--accent-dim)" : "transparent",
            color: mode === "export" ? "var(--accent-text)" : "var(--text)",
            borderRadius: 6,
            padding: "6px 0",
            fontSize: 12,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Export (pošli kamarádovi)
        </button>
        <button
          onClick={() => setMode("import")}
          style={{
            flex: 1,
            border: "1px solid " + (mode === "import" ? "var(--accent)" : "var(--field-border)"),
            background: mode === "import" ? "var(--accent-dim)" : "transparent",
            color: mode === "import" ? "var(--accent-text)" : "var(--text)",
            borderRadius: 6,
            padding: "6px 0",
            fontSize: 12,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Import (od kamaráda)
        </button>
      </div>

      {mode === "export" ? (
        <>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
            Stáhni soubor a pošli ho kamarádovi (mail, Discord, cokoliv). On si ho pak v téhle appce nahraje přes záložku "Import".
          </div>
          <button
            onClick={handleDownload}
            className="wh40k-btn"
            style={{ display: "flex", alignItems: "center", gap: 6, border: "none", background: "var(--accent)", color: "#fff", borderRadius: 6, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
          >
            <Save size={14} /> Stáhnout jako soubor
          </button>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6, marginBottom: 10 }}>
            Obsahuje {library.length} jednotek a {armies.length} uložených armád z tvé knihovny ({exportFileName}).
          </div>

          <details>
            <summary style={{ fontSize: 11.5, color: "var(--muted)", cursor: "pointer" }}>Nebo zkopírovat jako text</summary>
            <textarea
              readOnly
              value={exportPayload}
              rows={5}
              style={{ width: "100%", boxSizing: "border-box", marginTop: 8, background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 6, color: "var(--text)", padding: "8px 9px", fontSize: 11, fontFamily: "var(--mono)", resize: "vertical" }}
              onFocus={(e) => e.target.select()}
            />
            <button
              onClick={handleCopy}
              className="wh40k-btn"
              style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, border: "1px solid var(--field-border)", background: "transparent", color: "var(--text)", borderRadius: 6, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
            >
              {copied ? "Zkopírováno ✓" : "Kopírovat"}
            </button>
          </details>
        </>
      ) : (
        <>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>Nahraj soubor, který ti poslal kamarád, nebo vlož jeho obsah jako text.</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                border: "1px solid var(--field-border)",
                borderRadius: 6,
                padding: "6px 12px",
                fontSize: 12.5,
                cursor: "pointer",
                color: "var(--text)",
              }}
            >
              <Upload size={13} /> Nahrát soubor (.json)
              <input type="file" accept=".json,application/json" onChange={handleImportFile} style={{ display: "none" }} />
            </label>
            {importFileName && <span style={{ fontSize: 12, color: "var(--muted)" }}>{importFileName}</span>}
          </div>
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={5}
            placeholder="…nebo sem vlož exportovaný text…"
            style={{ width: "100%", boxSizing: "border-box", background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 6, color: "var(--text)", padding: "8px 9px", fontSize: 11, fontFamily: "var(--mono)", resize: "vertical" }}
          />
          <button
            onClick={handleImport}
            className="wh40k-btn"
            style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, border: "none", background: "var(--accent)", color: "#fff", borderRadius: 6, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
          >
            Importovat
          </button>
          {importSummary && !importSummary.error && (
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>
              Přidáno {importSummary.added} jednotek{importSummary.skipped > 0 ? ` (${importSummary.skipped}× už jsi měl, přeskočeno)` : ""}
              {importSummary.armiesAdded > 0 ? `, ${importSummary.armiesAdded} armád` : ""}.
            </div>
          )}
          {importSummary && importSummary.error && <div style={{ fontSize: 12, color: "#e0857c", marginTop: 6 }}>{importSummary.message}</div>}
        </>
      )}
    </div>
  );
}

// Export/import for board presets ("podložky") — same download-a-file /
// paste-as-text pattern as ExportImportBox above, just for boardPresets
// instead of the unit library. Exports every saved preset at once; on
// import, names that collide with an existing preset get " (import)"
// appended rather than silently overwriting anything.
function BoardShareBox({ boardPresets, onImport }) {
  const [mode, setMode] = useState("export");
  const [importText, setImportText] = useState("");
  const [importSummary, setImportSummary] = useState(null);
  const [importFileName, setImportFileName] = useState("");
  const [copied, setCopied] = useState(false);

  const exportPayload = JSON.stringify({ battlecalcBoardPresets: true, presets: boardPresets }, null, 2);
  const exportFileName = `battlecalc-podlozky-${new Date().toISOString().slice(0, 10)}.json`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(exportPayload);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setCopied(false);
    }
  };

  const handleDownload = () => {
    const blob = new Blob([exportPayload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const importFromText = (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    let data;
    try {
      data = JSON.parse(trimmed);
    } catch (e) {
      setImportSummary({ error: true, message: "Tohle nevypadá jako platný export podložek z Battlecalc (neplatný JSON)." });
      return;
    }
    const presets = Array.isArray(data.presets) ? data.presets : Array.isArray(data) ? data : null;
    if (!presets) {
      setImportSummary({ error: true, message: "Tohle nevypadá jako platný export podložek z Battlecalc." });
      return;
    }
    const { added } = onImport(presets);
    setImportSummary({ error: false, added });
    setImportText("");
    setImportFileName("");
  };

  const handleImportFile = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setImportFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => importFromText(String(ev.target.result || ""));
    reader.onerror = () => setImportSummary({ error: true, message: "Soubor se nepodařilo přečíst." });
    reader.readAsText(file);
  };

  return (
    <div style={{ background: "var(--panel)", border: "1px dashed var(--field-border)", borderRadius: 8, padding: 10, marginTop: 8 }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        <button
          onClick={() => setMode("export")}
          style={{
            flex: 1,
            border: "1px solid " + (mode === "export" ? "var(--accent)" : "var(--field-border)"),
            background: mode === "export" ? "var(--accent-dim)" : "transparent",
            color: mode === "export" ? "var(--accent-text)" : "var(--text)",
            borderRadius: 6,
            padding: "6px 0",
            fontSize: 12,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Export (pošli kamarádovi)
        </button>
        <button
          onClick={() => setMode("import")}
          style={{
            flex: 1,
            border: "1px solid " + (mode === "import" ? "var(--accent)" : "var(--field-border)"),
            background: mode === "import" ? "var(--accent-dim)" : "transparent",
            color: mode === "import" ? "var(--accent-text)" : "var(--text)",
            borderRadius: 6,
            padding: "6px 0",
            fontSize: 12,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Import (od kamaráda)
        </button>
      </div>

      {mode === "export" ? (
        <>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
            Stáhni soubor a pošli ho kamarádovi. On si ho pak v téhle appce nahraje přes záložku "Import".
          </div>
          <button
            onClick={handleDownload}
            disabled={boardPresets.length === 0}
            className="wh40k-btn"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              border: "none",
              background: boardPresets.length === 0 ? "var(--field-border)" : "var(--accent)",
              color: boardPresets.length === 0 ? "var(--muted)" : "#fff",
              borderRadius: 6,
              padding: "7px 14px",
              fontSize: 13,
              fontWeight: 600,
              cursor: boardPresets.length === 0 ? "not-allowed" : "pointer",
            }}
          >
            <Save size={14} /> Stáhnout jako soubor
          </button>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6, marginBottom: 10 }}>
            Obsahuje {boardPresets.length} podložek ({exportFileName}).
          </div>
          <details>
            <summary style={{ fontSize: 11.5, color: "var(--muted)", cursor: "pointer" }}>Nebo zkopírovat jako text</summary>
            <textarea
              readOnly
              value={exportPayload}
              rows={5}
              style={{ width: "100%", boxSizing: "border-box", marginTop: 8, background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 6, color: "var(--text)", padding: "8px 9px", fontSize: 11, fontFamily: "var(--mono)", resize: "vertical" }}
              onFocus={(e) => e.target.select()}
            />
            <button
              onClick={handleCopy}
              className="wh40k-btn"
              style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, border: "1px solid var(--field-border)", background: "transparent", color: "var(--text)", borderRadius: 6, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
            >
              {copied ? "Zkopírováno ✓" : "Kopírovat"}
            </button>
          </details>
        </>
      ) : (
        <>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>Nahraj soubor, který ti poslal kamarád, nebo vlož jeho obsah jako text.</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                border: "1px solid var(--field-border)",
                borderRadius: 6,
                padding: "6px 12px",
                fontSize: 12.5,
                cursor: "pointer",
                color: "var(--text)",
              }}
            >
              <Upload size={13} /> Nahrát soubor (.json)
              <input type="file" accept=".json,application/json" onChange={handleImportFile} style={{ display: "none" }} />
            </label>
            {importFileName && <span style={{ fontSize: 12, color: "var(--muted)" }}>{importFileName}</span>}
          </div>
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={5}
            placeholder="…nebo sem vlož exportovaný text…"
            style={{ width: "100%", boxSizing: "border-box", background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 6, color: "var(--text)", padding: "8px 9px", fontSize: 11, fontFamily: "var(--mono)", resize: "vertical" }}
          />
          <button
            onClick={() => importFromText(importText)}
            className="wh40k-btn"
            style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, border: "none", background: "var(--accent)", color: "#fff", borderRadius: 6, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
          >
            Importovat
          </button>
          {importSummary && !importSummary.error && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>Přidáno {importSummary.added} podložek.</div>}
          {importSummary && importSummary.error && <div style={{ fontSize: 12, color: "#e0857c", marginTop: 6 }}>{importSummary.message}</div>}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unit picker (Faction -> Unit dropdowns)
// ---------------------------------------------------------------------------
function ArmyForm({ initial, groupedLibrary, onSave, onCancel }) {
  const [name, setName] = useState(initial.name);
  const [unitIds, setUnitIds] = useState(new Set(initial.unitIds));

  const toggle = (id) =>
    setUnitIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 10, padding: 16, marginTop: 10 }}>
      <TextField label="Název armády" value={name} onChange={setName} placeholder="např. Space Wolves 2000pts turnaj" />
      <SectionLabel>Jednotky v armádě</SectionLabel>
      {Object.entries(groupedLibrary).map(([faction, units]) => (
        <div key={faction} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--amber)", textTransform: "uppercase", marginBottom: 3 }}>{faction}</div>
          {units.map((u) => (
            <label key={u.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, padding: "2px 0", cursor: "pointer" }}>
              <input type="checkbox" checked={unitIds.has(u.id)} onChange={() => toggle(u.id)} />
              {u.name}
            </label>
          ))}
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
        <button
          onClick={onCancel}
          style={{ border: "1px solid var(--field-border)", background: "transparent", color: "var(--text)", borderRadius: 6, padding: "7px 14px", fontSize: 13, cursor: "pointer" }}
        >
          Zrušit
        </button>
        <button
          onClick={() => {
            if (!name.trim() || unitIds.size === 0) return;
            onSave({ id: initial.id, name: name.trim(), unitIds: Array.from(unitIds) });
          }}
          style={{ border: "none", background: "var(--accent)", color: "var(--accent-on)", borderRadius: 6, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}
          className="wh40k-btn"
        >
          <Save size={14} /> Uložit armádu
        </button>
      </div>
    </div>
  );
}

// Distinguishing summary of a unit's weapon loadout, with how many models carry
// each weapon — e.g. "9x Storm Bolter, 9x Power Weapon, 1x Relic Great Axe" — so
// two similarly-named units with different wargear don't look identical in a list.
function weaponSummary(unit) {
  const parts = [];
  (unit.members || []).forEach((m) => {
    (m.weapons || []).forEach((w) => {
      if (!w.name) return;
      parts.push(`${m.count}x ${w.name}`);
    });
  });
  return parts.join(", ");
}

function LibraryRow({ u, onEdit, onDelete, onToggleFavorite, onSetBaseSize }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 8px", borderRadius: 6, fontSize: 13, gap: 6 }}>
      <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {u.name}
          <span style={{ fontSize: 11, color: "var(--muted)" }}>
            ({totalModels(u)}x, {u.members.length} typ{u.members.length === 1 ? "" : "y"})
          </span>
          {u.isLeader && (
            <span style={{ fontSize: 10, fontWeight: 700, color: "#a9c6e5", border: "1px solid #a9c6e5", borderRadius: 4, padding: "1px 5px", textTransform: "uppercase", letterSpacing: 0.3 }}>
              vůdce
            </span>
          )}
          {u.needsStats && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, fontWeight: 700, color: "var(--amber)", border: "1px solid var(--amber)", borderRadius: 4, padding: "1px 5px", textTransform: "uppercase", letterSpacing: 0.3 }}>
              <AlertTriangle size={10} /> chybí staty
            </span>
          )}
        </span>
        {weaponSummary(u) && <span style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 1 }}>{weaponSummary(u)}</span>}
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
        <select
          value={String(u.baseSize || 32)}
          onChange={(e) => onSetBaseSize(e.target.value)}
          title="Base size jednotky (pro Desku)"
          style={{ background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 6, color: "var(--text)", fontSize: 10.5, padding: "3px 4px", cursor: "pointer" }}
        >
          {baseSizeOptions(u.baseSize).map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
        <button onClick={onToggleFavorite} aria-label="Oblíbené" style={{ background: "transparent", border: "none", color: u.isFavorite ? "#e0c34a" : "var(--muted)", cursor: "pointer", padding: 4 }}>
          <Star size={14} fill={u.isFavorite ? "#e0c34a" : "none"} />
        </button>
        <button onClick={onEdit} aria-label="Upravit" style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", padding: 4 }}>
          <Pencil size={14} />
        </button>
        <button onClick={onDelete} aria-label="Smazat" style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", padding: 4 }}>
          <Trash2 size={14} />
        </button>
      </span>
    </div>
  );
}

function UnitPicker({ library, selectedId, onSelect }) {
  const factions = useMemo(() => Array.from(new Set(library.map((u) => u.faction || "Bez frakce"))).sort(), [library]);
  const [faction, setFaction] = useState("");

  useEffect(() => {
    if (selectedId) {
      const u = library.find((x) => x.id === selectedId);
      if (u) setFaction(u.faction || "Bez frakce");
    }
  }, [selectedId, library]);

  const unitsInFaction = library.filter((u) => (u.faction || "Bez frakce") === faction);

  if (library.length === 0) {
    return (
      <div style={{ fontSize: 12.5, color: "var(--muted)", background: "var(--field-bg)", border: "1px dashed var(--field-border)", borderRadius: 6, padding: "10px 12px" }}>
        Knihovna je zatím prázdná. Přidej jednotky níže a pak si je vyber tady.
      </div>
    );
  }

  return (
    <div className="wh40k-row wh40k-row-2" style={{ marginBottom: 0 }}>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 12.5, color: "var(--label)", fontWeight: 600 }}>Frakce</span>
        <select
          value={faction}
          onChange={(e) => {
            setFaction(e.target.value);
            onSelect(null);
          }}
          style={{ background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 6, color: "var(--text)", padding: "7px 9px", fontSize: 13.5 }}
        >
          <option value="">— vyber frakci —</option>
          {factions.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 12.5, color: "var(--label)", fontWeight: 600 }}>Jednotka</span>
        <select
          value={selectedId || ""}
          onChange={(e) => onSelect(e.target.value || null)}
          disabled={!faction}
          style={{ background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 6, color: "var(--text)", padding: "7px 9px", fontSize: 13.5, opacity: faction ? 1 : 0.5 }}
        >
          <option value="">— vyber jednotku —</option>
          {unitsInFaction.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name} ({totalModels(u)}x)
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function StatChip({ label, value }) {
  return (
    <div
      style={{
        background: "var(--field-bg)",
        border: "1px solid var(--field-border)",
        borderRadius: 6,
        padding: "3px 7px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        minWidth: 30,
      }}
    >
      <span style={{ fontSize: 8.5, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.3, lineHeight: 1.3 }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "var(--mono)", color: "var(--text)", lineHeight: 1.3 }}>{value}</span>
    </div>
  );
}

// A draggable token on the battlefield board — sized in both dimensions as a
// % of the board container so it renders as a true circle regardless of the
// container's actual rendered pixel size (see the "Deska" view for the math:
// width-%/height-% both derive from the same base-size-in-inches, just
// divided by the board's width-in-inches vs height-in-inches respectively).
// A layout's mineClip/theirsClip is either a single clip-path string or an
// array of them (a user-saved layout captured while "Moje zóna" was a
// multi-rectangle union) — always normalized to an array so every renderer
// only has to handle one shape.
const asClipArray = (value) => (Array.isArray(value) ? value : [value]);

// Picker for a saved layout — a small two-tone preview of the shape itself
// (same clip-paths the board uses), no text label beyond its own name shown
// elsewhere. Selecting one is purely "pick by how it looks".
function LayoutSwatch({ layout, selected, onClick }) {
  return (
    <button
      onClick={onClick}
      title="Rozložení výsadku"
      style={{
        position: "relative",
        width: 44,
        height: 34,
        borderRadius: 6,
        border: `2px solid ${selected ? "var(--accent)" : "var(--field-border)"}`,
        background: "#2b3a2e",
        overflow: "hidden",
        cursor: "pointer",
        padding: 0,
        flexShrink: 0,
      }}
    >
      {asClipArray(layout.theirsClip).map((clip, i) => (
        <div key={`t${i}`} style={{ position: "absolute", inset: 0, background: "var(--accent)", opacity: 0.55, clipPath: clip }} />
      ))}
      {asClipArray(layout.mineClip).map((clip, i) => (
        <div key={`m${i}`} style={{ position: "absolute", inset: 0, background: "#c0392b", opacity: 0.55, clipPath: clip }} />
      ))}
    </button>
  );
}

// A draggable/rotatable terrain piece from TERRAIN_SHAPES — same click-vs-
// drag distinction as BoardTokenView (see there), sized as width%/height% of
// the board so it keeps true proportions regardless of the board's own
// aspect ratio, same math as token sizing.
// Small palette-button preview of a terrain/base shape — for a "combo"
// piece (podložka s terénem na ni), shows the terrain swatch nested inside
// the base swatch, same relationship as the real piece on the board.
function PieceSwatch({ shape }) {
  if (shape.multiCombo) {
    return (
      <span style={{ position: "relative", display: "inline-block", width: 16, height: 12, background: shape.bare ? "rgba(255,255,255,0.08)" : shape.bg, border: shape.bare ? "1px dashed rgba(210,200,170,0.5)" : shape.border, borderRadius: shape.radius, flexShrink: 0 }}>
        {(shape.parts || []).map((pt, i) => (
          <span
            key={i}
            style={{ position: "absolute", left: `${pt.leftPct}%`, top: `${pt.topPct}%`, width: `${pt.widthPct}%`, height: `${pt.heightPct}%`, background: pt.bg, borderRadius: pt.radius || 0, transform: pt.rotationDeg ? `rotate(${pt.rotationDeg}deg)` : undefined }}
          />
        ))}
      </span>
    );
  }
  if (shape.isGroup) {
    return (
      <span style={{ position: "relative", display: "inline-block", width: 16, height: 12, flexShrink: 0 }}>
        <span style={{ position: "absolute", left: 0, top: 1, width: 9, height: 7, background: "#5c5c52", border: "1px solid #8f8f7e", borderRadius: 2 }} />
        <span style={{ position: "absolute", right: 0, bottom: 0, width: 8, height: 6, background: "rgba(58,92,58,0.75)", border: "1px solid #5e9a5e", borderRadius: "50%" }} />
      </span>
    );
  }
  if (shape.combo) {
    return (
      <span style={{ position: "relative", display: "inline-block", width: 16, height: 12, background: shape.bg, border: shape.border, borderRadius: shape.radius, flexShrink: 0 }}>
        <span
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            width: "60%",
            height: "60%",
            background: shape.terrainBg,
            border: shape.terrainBorder,
            borderRadius: shape.terrainRadius,
            clipPath: shape.terrainClipPath,
          }}
        />
      </span>
    );
  }
  return <span style={{ display: "inline-block", width: 16, height: 12, background: shape.bg, border: shape.border, borderRadius: shape.radius, clipPath: shape.clipPath, flexShrink: 0 }} />;
}

function TerrainPieceView({ piece, shape, containerRef, sizePctW, sizePctH, selected, locked, onMove, onCommit, onRemove, onSelect }) {
  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const startRef = useRef({ x: 0, y: 0 });
  // Where on the piece you actually grabbed it, relative to its own center —
  // without this, the piece's center would snap straight to the cursor on
  // the very first move, which looks like a jump ("it clicks a bit off")
  // whenever you don't grab exactly dead-center — the bigger the piece
  // (a large podložka, say), the more that jump stands out.
  const grabOffsetRef = useRef({ dx: 0, dy: 0 });

  const handlePointerDown = (e) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    movedRef.current = false;
    startRef.current = { x: e.clientX, y: e.clientY };
    if (containerRef.current) {
      const { x: cursorXPct, y: cursorYPct } = boardPctFromPointer(containerRef.current, e);
      grabOffsetRef.current = { dx: piece.xPct - cursorXPct, dy: piece.yPct - cursorYPct };
    }
  };
  const handlePointerMove = (e) => {
    if (!draggingRef.current || !containerRef.current) return;
    if (!movedRef.current && Math.hypot(e.clientX - startRef.current.x, e.clientY - startRef.current.y) > 4) {
      movedRef.current = true;
    }
    if (!movedRef.current) return;
    const { x: cursorXPct, y: cursorYPct } = boardPctFromPointer(containerRef.current, e);
    const { dx, dy } = grabOffsetRef.current;
    const xPct = Math.max(0, Math.min(100, cursorXPct + dx));
    const yPct = Math.max(0, Math.min(100, cursorYPct + dy));
    onMove(piece.id, xPct, yPct);
  };
  const handlePointerUp = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (movedRef.current) onCommit();
    else onSelect(piece.id);
  };

  return (
    <div
      data-board-piece="terrain"
      data-bare={shape.bare ? "1" : undefined}
      data-obj={String(shape.id || "").startsWith("obj-") ? "1" : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onRemove(piece.id);
      }}
      title={locked ? undefined : `${shape.label} — táhni pro přesun, klik pro úpravy, dvojklik pro odebrání`}
      style={{
        position: "absolute",
        left: `${piece.xPct}%`,
        top: `${piece.yPct}%`,
        width: `${sizePctW}%`,
        height: `${sizePctH}%`,
        pointerEvents: locked ? "none" : "auto",
        transform: `translate(-50%, -50%) rotate(${piece.rotationDeg || 0}deg)`,
        minWidth: 10,
        minHeight: 10,
        borderRadius: shape.radius,
        clipPath: shape.clipPath,
        background: shape.bg,
        border: shape.border,
        boxShadow: selected ? "0 0 0 2px #fff, 0 2px 6px rgba(0,0,0,0.4)" : shape.bare ? "none" : "0 2px 6px rgba(0,0,0,0.4)",
        cursor: locked ? "default" : "grab",
        userSelect: "none",
        touchAction: "none",
        zIndex: selected ? 2 : 1,
      }}
    >
      {/* A "combo" piece (podložka + terén na ni) is one rigid unit — the
          outer div above IS the base, and this inner div is the terrain
          shape sized/centered as a % of it, so resizing the outer piece
          (see the selected-piece panel) scales both together automatically. */}
      {shape.combo && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: `${(shape.terrainWidthIn / shape.widthIn) * 100}%`,
            height: `${(shape.terrainHeightIn / shape.heightIn) * 100}%`,
            transform: "translate(-50%, -50%)",
            borderRadius: shape.terrainRadius,
            clipPath: shape.terrainClipPath,
            background: shape.terrainBg,
            border: shape.terrainBorder,
            pointerEvents: "none",
          }}
        />
      )}
      {/* A "multiCombo" piece is one rigid unit like a combo, but the outer
          podložka carries several coloured sub-elements, each placed as a %
          rectangle of the podložka — so resizing/rotating/dragging the piece
          moves them all together, in proportion. */}
      {shape.multiCombo &&
        (shape.parts || []).map((pt, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: `${pt.leftPct}%`,
              top: `${pt.topPct}%`,
              width: `${pt.widthPct}%`,
              height: `${pt.heightPct}%`,
              background: pt.bg,
              borderRadius: pt.radius || 0,
              clipPath: pt.clipPath,
              transform: pt.rotationDeg ? `rotate(${pt.rotationDeg}deg)` : undefined,
              pointerEvents: "none",
            }}
          />
        ))}
    </div>
  );
}

function BoardTokenView({ token, unit, containerRef, sizePctW, sizePctH, rectBase, viewRot, selected, multiSelected, onDragStart, onMove, onCommit, onRemove, onSelect }) {
  const draggingRef = useRef(false);
  // Distinguishes a drag from a plain click/tap: if the pointer never moves
  // more than a few px between down and up, treat it as a click (used to
  // pick attacker/target for a quick matchup) instead of a (no-op) drag.
  const movedRef = useRef(false);
  const startRef = useRef({ x: 0, y: 0 });
  // Where on the token you actually grabbed it, relative to its own center —
  // without this, the token's center would snap straight to the cursor on
  // the very first move, which looks like a jump ("it clicks a bit off")
  // whenever you don't grab exactly dead-center, worse the bigger the token.
  const grabOffsetRef = useRef({ dx: 0, dy: 0 });

  const handlePointerDown = (e) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    movedRef.current = false;
    startRef.current = { x: e.clientX, y: e.clientY };
    // Lets the board decide what moves with this token (the whole unit, the
    // marquee selection, or just this model - Alt flips the unit/model mode).
    if (onDragStart) onDragStart(token, e.altKey, e.shiftKey);
    if (containerRef.current) {
      const { x: cursorXPct, y: cursorYPct } = boardPctFromPointer(containerRef.current, e);
      grabOffsetRef.current = { dx: token.xPct - cursorXPct, dy: token.yPct - cursorYPct };
    }
  };
  const handlePointerMove = (e) => {
    if (!draggingRef.current || !containerRef.current) return;
    if (!movedRef.current && Math.hypot(e.clientX - startRef.current.x, e.clientY - startRef.current.y) > 4) {
      movedRef.current = true;
    }
    if (!movedRef.current) return;
    const { x: cursorXPct, y: cursorYPct } = boardPctFromPointer(containerRef.current, e);
    const { dx, dy } = grabOffsetRef.current;
    const xPct = Math.max(0, Math.min(100, cursorXPct + dx));
    const yPct = Math.max(0, Math.min(100, cursorYPct + dy));
    onMove(token.id, xPct, yPct);
  };
  const handlePointerUp = (e) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (movedRef.current) {
      onCommit();
    } else {
      onSelect(token, e);
    }
  };

  const label = unit ? unit.name.slice(0, 3).toUpperCase() : "?";
  const color = token.side === "mine" ? "var(--accent)" : "#c0392b";

  return (
    <div
      data-board-piece="token"
      data-token-id={token.id}
      data-sel={selected || multiSelected ? "1" : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      title={unit ? `${unit.name} — klik pro výběr do souboje, táhni pro přesun, Shift+klik označí` : "model"}
      style={{
        position: "absolute",
        left: `${token.xPct}%`,
        top: `${token.yPct}%`,
        width: `${sizePctW}%`,
        height: `${sizePctH}%`,
        transform: `translate(-50%, -50%) rotate(${token.rot || 0}deg)`,
        minWidth: 14,
        minHeight: 14,
        borderRadius: rectBase ? 6 : "50%",
        background: color,
        border: multiSelected ? "2px solid #ffd54a" : selected ? "2px solid #fff" : "2px solid rgba(255,255,255,0.85)",
        boxShadow: multiSelected
          ? "0 0 0 3px rgba(255,213,74,0.7), 0 2px 6px rgba(0,0,0,0.4)"
          : selected
            ? "0 0 0 3px rgba(255,255,255,0.55), 0 2px 6px rgba(0,0,0,0.4)"
            : "0 2px 6px rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        fontSize: 8,
        fontWeight: 800,
        color: "#fff",
        cursor: "grab",
        userSelect: "none",
        touchAction: "none",
        zIndex: multiSelected || selected ? 3 : 2,
      }}
    >
      {/* Facing tick (only once a model has been turned) - the label is
          counter-rotated so it always reads upright. */}
      {token.rot ? (
        <span style={{ position: "absolute", top: 1, left: "50%", width: 3, height: 3, marginLeft: -1.5, borderRadius: "50%", background: "#fff" }} />
      ) : null}
      <span style={{ display: "inline-block", transform: `rotate(${-(token.rot || 0) - (viewRot || 0)}deg)` }}>{label}</span>
    </div>
  );
}

function UnitComposition({ unit, profileChoices, onChooseProfile, meltaActive, onToggleMelta, rapidFireActive, onToggleRapidFire }) {
  if (!unit) return null;

  // Flatten to {member, weapon} pairs and put multi-profile weapons (e.g. an axe
  // with separate Sweep/Strike profiles) first, so the choice that actually
  // needs making is immediately visible instead of buried in the list.
  const flat = [];
  unit.members.forEach((m) => {
    m.weapons.forEach((w) => flat.push({ member: m, weapon: w }));
  });
  flat.sort((a, b) => {
    const aMulti = a.weapon.profiles && a.weapon.profiles.length > 1 ? 0 : 1;
    const bMulti = b.weapon.profiles && b.weapon.profiles.length > 1 ? 0 : 1;
    return aMulti - bMulti;
  });

  return (
    <div style={{ marginTop: 10, fontSize: 12 }}>
      {flat.map(({ member: m, weapon: w }) => {
        const hasProfiles = w.profiles && w.profiles.length > 1;
        const meltaOn = !!(meltaActive && meltaActive[w.id]);
        const rapidFireOn = !!(rapidFireActive && rapidFireActive[w.id]);
        // w.damage/w.attacks here already include the melta/rapid-fire bump
        // when active (applied once, upstream in effectiveAttackerUnit) —
        // don't add it again.
        const displayDamage = w.damage;
        return (
          <div
            key={w.id}
            style={{
              background: "var(--field-bg)",
              border: `1px solid ${hasProfiles ? "var(--accent)" : "var(--field-border)"}`,
              borderRadius: 8,
              padding: "6px 8px",
              marginBottom: 6,
            }}
          >
            <div style={{ fontSize: 9.5, color: "var(--muted)", marginBottom: 2 }}>
              {m.count}× {m.name}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--text)", fontSize: 11.5, fontWeight: 600, marginBottom: 5, flexWrap: "wrap" }}>
              {w.type === "melee" ? <Sword size={11} color="var(--accent-text)" /> : <Crosshair size={11} color="#a9c6e5" />}
              {w.name}
              {w.lethalHits && (
                <span style={{ fontSize: 8.5, fontWeight: 700, color: "var(--accent-text)", border: "1px solid var(--accent)", borderRadius: 4, padding: "0 4px", textTransform: "uppercase" }}>
                  Lethal
                </span>
              )}
              {(w.critHitsOn || 6) < 6 && (
                <span style={{ fontSize: 8.5, fontWeight: 700, color: "var(--accent-text)", border: "1px solid var(--accent)", borderRadius: 4, padding: "0 4px", textTransform: "uppercase" }}>
                  Crit Hit {w.critHitsOn}+
                </span>
              )}
              {(w.critWoundOn || 6) < 6 && (
                <span style={{ fontSize: 8.5, fontWeight: 700, color: "var(--accent-text)", border: "1px solid var(--accent)", borderRadius: 4, padding: "0 4px", textTransform: "uppercase" }}>
                  Crit Wound {w.critWoundOn}+
                </span>
              )}
              {w.devastatingWounds && (
                <span style={{ fontSize: 8.5, fontWeight: 700, color: "var(--accent-text)", border: "1px solid var(--accent)", borderRadius: 4, padding: "0 4px", textTransform: "uppercase" }}>
                  Dev. Wounds
                </span>
              )}
              {w.sustained > 0 && (
                <span style={{ fontSize: 8.5, fontWeight: 700, color: "#a9c6e5", border: "1px solid var(--blue)", borderRadius: 4, padding: "0 4px", textTransform: "uppercase" }}>
                  Sust. {fmtNum(w.sustained)}
                </span>
              )}
              {w.twinLinked && (
                <span style={{ fontSize: 8.5, fontWeight: 700, color: "#a9c6e5", border: "1px solid var(--blue)", borderRadius: 4, padding: "0 4px", textTransform: "uppercase" }}>
                  Twin-linked
                </span>
              )}
              {w.melta > 0 && (
                <span style={{ fontSize: 8.5, fontWeight: 700, color: "var(--amber)", border: "1px solid var(--amber)", borderRadius: 4, padding: "0 4px", textTransform: "uppercase" }}>
                  Melta {w.melta}
                </span>
              )}
              {w.rapidFire > 0 && (
                <span style={{ fontSize: 8.5, fontWeight: 700, color: "var(--amber)", border: "1px solid var(--amber)", borderRadius: 4, padding: "0 4px", textTransform: "uppercase" }}>
                  Rapid Fire {w.rapidFire}
                </span>
              )}
            </div>
            {hasProfiles && (
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6, alignItems: "center" }}>
                <span style={{ fontSize: 9.5, color: "var(--muted)" }}>Profil (jen jeden najednou):</span>
                {w.profiles.map((p, i) => {
                  const active = i === (w.activeProfileIndex ?? 0);
                  return (
                    <button
                      key={p.name + i}
                      onClick={() => onChooseProfile && onChooseProfile(w.id, i)}
                      style={{
                        fontSize: 10.5,
                        fontWeight: 700,
                        padding: "2px 8px",
                        borderRadius: 5,
                        border: `1px solid ${active ? "var(--accent)" : "var(--field-border)"}`,
                        background: active ? "var(--accent-dim)" : "transparent",
                        color: active ? "var(--accent-text)" : "var(--muted)",
                        cursor: onChooseProfile ? "pointer" : "default",
                      }}
                    >
                      {p.name}
                    </button>
                  );
                })}
              </div>
            )}
            {w.melta > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                <span style={{ fontSize: 9.5, color: "var(--muted)" }}>V polovičním dosahu (melta):</span>
                <button
                  onClick={() => onToggleMelta && onToggleMelta(w.id)}
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    padding: "2px 8px",
                    borderRadius: 5,
                    border: `1px solid ${meltaOn ? "var(--amber)" : "var(--field-border)"}`,
                    background: meltaOn ? "rgba(232,167,47,0.15)" : "transparent",
                    color: meltaOn ? "var(--amber)" : "var(--muted)",
                    cursor: onToggleMelta ? "pointer" : "default",
                  }}
                >
                  {meltaOn ? `ANO (+${w.melta} Dmg)` : "NE"}
                </button>
              </div>
            )}
            {w.rapidFire > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                <span style={{ fontSize: 9.5, color: "var(--muted)" }}>V polovičním dosahu (rapid fire):</span>
                <button
                  onClick={() => onToggleRapidFire && onToggleRapidFire(w.id)}
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    padding: "2px 8px",
                    borderRadius: 5,
                    border: `1px solid ${rapidFireOn ? "var(--amber)" : "var(--field-border)"}`,
                    background: rapidFireOn ? "rgba(232,167,47,0.15)" : "transparent",
                    color: rapidFireOn ? "var(--amber)" : "var(--muted)",
                    cursor: onToggleRapidFire ? "pointer" : "default",
                  }}
                >
                  {rapidFireOn ? `ANO (+${w.rapidFire} Atk)` : "NE"}
                </button>
              </div>
            )}
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              <StatChip label="Atk" value={fmtNum(w.attacks)} />
              <StatChip label="Hit" value={w.hitX <= 1 ? "auto" : `${w.hitX}+`} />
              <StatChip label="Str" value={w.strength} />
              <StatChip label="AP" value={w.ap} />
              <StatChip label="Dmg" value={fmtNum(displayDamage)} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Shared cranium outline, reused by SkullIcon below and by the cheat sheet's
// skull-shaped pie chart (same silhouette, different fill treatment).
const SKULL_OUTLINE_D =
  "M12 2.5C7.3 2.5 3.5 6.3 3.5 11c0 3.1 1.65 5.8 4.1 7.3.22.13.35.36.35.62V20a1 1 0 0 0 1 1h.55v1.1c0 .5.4.9.9.9h3.2c.5 0 .9-.4.9-.9V21h.55a1 1 0 0 0 1-1v-1.08c0-.26.13-.49.35-.62 2.45-1.5 4.1-4.2 4.1-7.3 0-4.7-3.8-8.5-8.5-8.5z";

// Custom skull icon — lucide's built-in "Skull" reads as an abstract blob at
// small UI sizes, so we draw a proper cranium + eye sockets + nose + teeth.
function SkullIcon({ size = 16, color = "currentColor", filled = false, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} xmlns="http://www.w3.org/2000/svg">
      <path
        d={SKULL_OUTLINE_D}
        fill={filled ? color : "none"}
        stroke={color}
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <ellipse cx="8.7" cy="11.2" rx="1.6" ry="2" fill={filled ? "var(--panel)" : color} />
      <ellipse cx="15.3" cy="11.2" rx="1.6" ry="2" fill={filled ? "var(--panel)" : color} />
      <path d="M12 12.3l-1.1 2.3h2.2L12 12.3z" fill={filled ? "var(--panel)" : color} />
      <path d="M9.3 17.3h5.4M10.3 17.3v1.3M12 17.3v1.6M13.7 17.3v1.3" stroke={filled ? "var(--panel)" : color} strokeWidth="1" strokeLinecap="round" fill="none" />
    </svg>
  );
}

// Pure-SVG pie slice (not a CSS background) so it reliably shows up when
// printed, regardless of the browser's "print background graphics" setting.
function MiniPie({ frac, size = 34, color = "#1b5faa", trackColor = "#ddd" }) {
  const clamped = Math.max(0, Math.min(1, frac));
  const r = size / 2;
  let slice = null;
  if (clamped >= 0.999) {
    slice = <circle cx={r} cy={r} r={r} fill={color} />;
  } else if (clamped > 0) {
    const angle = clamped * 2 * Math.PI;
    const x = r + r * Math.sin(angle);
    const y = r - r * Math.cos(angle);
    const largeArc = clamped > 0.5 ? 1 : 0;
    slice = <path d={`M ${r} ${r} L ${r} 0 A ${r} ${r} 0 ${largeArc} 1 ${x} ${y} Z`} fill={color} />;
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: "block" }}>
      <circle cx={r} cy={r} r={r} fill={trackColor} />
      {slice}
      <circle cx={r} cy={r} r={r} fill="none" stroke="#999" strokeWidth="0.75" />
    </svg>
  );
}

// Row of small skull glyphs (reusing SkullIcon's path) filling in proportionally
// — the cheat sheet's print-friendly stand-in for a pie chart, at a size that
// actually fits a narrow matrix column instead of a full 34px circle.
// Pie chart clipped to the skull silhouette instead of a circle — same "fill
// sweeps clockwise from the top" reading as MiniPie, just skull-shaped.
function MiniSkullPie({ frac, size = 34, color = "#1b5faa", trackColor = "#ddd" }) {
  const clamped = Math.max(0, Math.min(1, frac));
  const clipId = useId();
  const cx = 12;
  const cy = 12;
  const r = 17; // covers the whole 24x24 viewBox from center at any angle
  let slice = null;
  if (clamped >= 0.999) {
    slice = <rect x="0" y="0" width="24" height="24" fill={color} />;
  } else if (clamped > 0) {
    const angle = clamped * 2 * Math.PI;
    const x = cx + r * Math.sin(angle);
    const y = cy - r * Math.cos(angle);
    const largeArc = clamped > 0.5 ? 1 : 0;
    slice = <path d={`M ${cx} ${cy} L ${cx} ${cy - r} A ${r} ${r} 0 ${largeArc} 1 ${x} ${y} Z`} fill={color} />;
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: "block" }}>
      <defs>
        <clipPath id={clipId}>
          <path d={SKULL_OUTLINE_D} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <rect x="0" y="0" width="24" height="24" fill={trackColor} />
        {slice}
      </g>
      <path d={SKULL_OUTLINE_D} fill="none" stroke="#999" strokeWidth="0.6" />
    </svg>
  );
}

function PieChart({ frac, size = 64 }) {
  const clamped = Math.max(0, Math.min(1, frac));
  const angle = clamped * 360;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: `conic-gradient(var(--accent) ${angle}deg, var(--field-border) ${angle}deg)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        marginTop: 10,
        boxShadow: clamped > 0 ? "0 0 14px rgba(47,143,232,0.35)" : "none",
      }}
    >
      <div
        style={{
          width: size * 0.68,
          height: size * 0.68,
          borderRadius: "50%",
          background: "var(--panel)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 13,
          fontWeight: 700,
          color: "var(--accent-text)",
          fontFamily: "var(--mono)",
        }}
      >
        {(clamped * 100).toFixed(0)}%
      </div>
    </div>
  );
}

function SkullRow({ killed, total }) {
  const frac = total > 0 ? Math.max(0, Math.min(1, killed / total)) : 0;
  // A single-model target (a character, vehicle, C'tan…) isn't well described
  // by "X of 10 models destroyed" — show how much of that one model's health
  // pool is spent instead, as a simple pie chart.
  if (total <= 1) {
    return <PieChart frac={frac} />;
  }
  const totalIcons = 10;
  const filled = Math.round(frac * totalIcons);
  return (
    <div style={{ display: "flex", gap: 4, marginTop: 10 }}>
      {Array.from({ length: totalIcons }).map((_, i) => (
        <SkullIcon key={i} size={18} color={i < filled ? "var(--accent-text)" : "var(--field-border)"} filled={i < filled} />
      ))}
    </div>
  );
}

function fmtNum(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// ---------------------------------------------------------------------------
// Real binomial probabilities tied to the actual number of save rolls this
// attack generates (M) and the real chance of failing one of them (q) — e.g.
// "10 attacks, 4+ save → ~5 expected to get through" is exactly this model,
// not an approximation around the average.
// ---------------------------------------------------------------------------
function binomialCDF(k, n, p) {
  if (!Number.isFinite(p) || n <= 0) return k >= 0 ? 1 : 0;
  if (p <= 0) return 1; // failure is impossible → always "at or under k" failures
  if (p >= 1) return k >= n ? 1 : 0;
  if (k < 0) return 0;
  if (k >= n) return 1;
  let pmf = Math.pow(1 - p, n);
  let cdf = pmf;
  for (let i = 1; i <= k; i++) {
    pmf = pmf * ((n - i + 1) / i) * (p / (1 - p));
    cdf += pmf;
  }
  return Math.max(0, Math.min(1, cdf));
}

// Sums the killedModels contributed by just one weapon type (ranged or melee)
// out of a computeUnitVsUnit result's breakdown — used to show Shoot/Melee
// separately in the cheat sheet instead of only the combined figure.
function killedModelsByType(res, type) {
  if (!res || !res.breakdown) return 0;
  return res.breakdown.filter((b) => b.type === type).reduce((s, b) => s + b.killedModels, 0);
}

// Given a computeUnitVsUnit-style result (with .breakdown and .totalDamage) and
// the target unit being attacked, works out: M = how many wound rolls actually
// reach a save this round, q = the real chance a given one of those fails its
// save, then uses the binomial distribution over those M independent rolls to
// get the chance of killing at least one model / wiping the whole unit.
function computeSurvivalStats(res, defenderUnit, defenderModelsCount) {
  const zero = { chanceAtLeast1: 0, chanceDestroyUnit: 0 };
  if (!res || !defenderUnit || !res.breakdown) return zero;
  let wounds = 0;
  let through = 0;
  res.breakdown.forEach((b) => {
    wounds += b.detail.woundsTotal;
    through += b.detail.through;
  });
  const M = Math.round(wounds);
  if (M <= 0 || through <= 0 || res.totalDamage <= 0) return zero;
  const q = Math.max(0, Math.min(1, through / wounds));
  const avgDmgPerFail = res.totalDamage / through;
  if (avgDmgPerFail <= 0) return zero;

  const woundsPerModel = clampNum(defenderUnit.wounds, 1);
  const totalWoundsPool = defenderModelsCount * woundsPerModel;
  const maxTolerable = Math.floor(totalWoundsPool / avgDmgPerFail);
  const failsToKillOne = Math.max(1, Math.ceil(woundsPerModel / avgDmgPerFail));

  const survivalChance = binomialCDF(maxTolerable, M, q);
  const chanceAtLeast1 = 1 - binomialCDF(failsToKillOne - 1, M, q);

  return {
    chanceAtLeast1: Math.max(0, Math.min(1, chanceAtLeast1)),
    chanceDestroyUnit: Math.max(0, Math.min(1, 1 - survivalChance)),
  };
}

// Pointer position as a % of the board in the BOARD's own frame, whatever the
// view rotation is: the board element is CSS-rotated for display, so its
// bounding box is the rotated one and the fractions are turned back here.
// (Not clamped - callers clamp as they need.)
function boardPctFromPointer(el, e) {
  const rect = el.getBoundingClientRect();
  const rot = Number(el.dataset.viewRot || 0);
  const u = (e.clientX - rect.left) / rect.width;
  const v = (e.clientY - rect.top) / rect.height;
  let x = u;
  let y = v;
  if (rot === 90) {
    x = v;
    y = 1 - u;
  } else if (rot === 180) {
    x = 1 - u;
    y = 1 - v;
  } else if (rot === 270) {
    x = 1 - v;
    y = u;
  }
  return { x: x * 100, y: y * 100 };
}

// Second visual set ("Taktický"): same layout, a different skin - saturated
// blue HUD colours, glowing panel edges, textured plates, hex tokens, compass
// and scale on the board. The classic look stays the default.
const TACTICAL_VARS = {
  "--bg": "#040b17",
  "--panel": "#0a1a2f",
  "--field-bg": "#071424",
  "--field-border": "#1d4f8f",
  "--text": "#eef6ff",
  "--muted": "#7fa3c9",
  "--label": "#a8c6e8",
  "--accent": "#2d8cff",
  "--accent-dim": "#0b2f5c",
  "--accent-text": "#8fd0ff",
  "--blue": "#2d8cff",
  "--blue-dim": "#0b2f5c",
  "--amber": "#ffb02e",
};

function SkullLogo({ size = 28 }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: "2px solid var(--accent)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        boxShadow: "0 0 14px rgba(47,143,232,0.55)",
        background: "radial-gradient(circle, rgba(47,143,232,0.18), transparent 70%)",
      }}
    >
      <SkullIcon size={size * 0.58} color="var(--accent-text)" />
    </div>
  );
}

function TileButton({ icon: Icon, label, value, onClick }) {
  return (
    <button onClick={onClick} className="wh40k-card wh40k-btn" style={{ textAlign: "left", background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 12, padding: "13px 14px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6 }}>{label}</span>
        <Icon size={16} color="var(--accent-text)" />
      </div>
      <span style={{ fontSize: 13, color: "var(--text)" }}>{value}</span>
    </button>
  );
}

function SearchBox({ value, onChange, placeholder }) {
  return (
    <div style={{ position: "relative", marginBottom: 10 }}>
      <Search size={14} color="var(--muted)" style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)" }} />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="wh40k-input"
        style={{ width: "100%", boxSizing: "border-box", background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 8, color: "var(--text)", padding: "9px 10px 9px 32px", fontSize: 13.5 }}
      />
    </div>
  );
}

function UnitListRow({ u, selected, onClick, onNext, nextLabel }) {
  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      className="wh40k-btn"
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: selected ? "var(--accent-dim)" : "var(--field-bg)",
        border: `1px solid ${selected ? "var(--accent)" : "var(--field-border)"}`,
        borderRadius: 8,
        padding: "9px 10px",
        cursor: "pointer",
        marginBottom: 6,
        textAlign: "left",
      }}
    >
      <SkullLogo size={26} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{u.name}</div>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>
          {u.faction || "Bez frakce"}
          {u.points ? ` · ${u.points} pts` : ""}
        </div>
        {weaponSummary(u) && (
          <div style={{ fontSize: 10.5, color: "var(--muted)", opacity: 0.85, lineHeight: 1.4, marginTop: 1 }}>{weaponSummary(u)}</div>
        )}
      </div>
      {selected && onNext ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onNext();
          }}
          className="wh40k-btn"
          style={{
            border: "none",
            background: "var(--accent)",
            color: "#fff",
            borderRadius: 6,
            padding: "7px 11px",
            fontSize: 11.5,
            fontWeight: 700,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 4,
            flexShrink: 0,
            whiteSpace: "nowrap",
          }}
        >
          {nextLabel || "Další"} <ChevronRight size={13} />
        </button>
      ) : (
        <ChevronRight size={15} color="var(--muted)" style={{ flexShrink: 0 }} />
      )}
    </div>
  );
}

function PickerRow({ icon: Icon, label, count, onClick }) {
  return (
    <button
      onClick={onClick}
      className="wh40k-btn"
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: "var(--field-bg)",
        border: "1px solid var(--field-border)",
        borderRadius: 8,
        padding: "10px 10px",
        cursor: "pointer",
        marginBottom: 6,
        textAlign: "left",
      }}
    >
      <div style={{ width: 26, height: 26, borderRadius: 7, background: "var(--accent-dim)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Icon size={14} color="var(--accent-text)" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{label}</div>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>
          {count} jednot{count === 1 ? "ka" : count >= 2 && count <= 4 ? "ky" : "ek"}
        </div>
      </div>
      <ChevronRight size={15} color="var(--muted)" />
    </button>
  );
}

function BonusFieldsGroup({ bonus, setBonus, isRanged }) {
  return (
    <>
      <Row cols={2}>
        <ToggleField label="Lethal Hits" value={bonus.lethalHits} onChange={(v) => setBonus((s) => ({ ...s, lethalHits: v }))} small />
        <NumberField label="Sustained (extra)" value={bonus.sustained} onChange={(v) => setBonus((s) => ({ ...s, sustained: v }))} min={0} small />
      </Row>
      {isRanged && (
        <Row cols={2}>
          <ToggleField
            label="Fire Overwatch (stratagem)"
            value={bonus.fireOverwatch}
            onChange={(v) => setBonus((s) => ({ ...s, fireOverwatch: v }))}
            hint="zásah jen na neupravenou 6, ignoruje ostatní hit modifikátory; jen na dálku"
            small
          />
          <div />
        </Row>
      )}
      <Row cols={2}>
        <SelectField label="Přehoz hit rollu" value={bonus.rerollHit} onChange={(v) => setBonus((s) => ({ ...s, rerollHit: v }))} options={REROLL_OPTIONS} small />
        <SelectField label="Přehoz wound rollu" value={bonus.rerollWound} onChange={(v) => setBonus((s) => ({ ...s, rerollWound: v }))} options={REROLL_OPTIONS} small />
      </Row>
      <Row cols={3}>
        <SelectField
          label="Modifikátor hit rollu"
          value={String(bonus.hitMod || 0)}
          onChange={(v) => setBonus((s) => ({ ...s, hitMod: Number(v) }))}
          options={MOD_OPTIONS_3}
          small
        />
        <SelectField
          label="Modifikátor wound rollu"
          value={String(bonus.woundMod || 0)}
          onChange={(v) => setBonus((s) => ({ ...s, woundMod: Number(v) }))}
          options={MOD_OPTIONS_3}
          small
        />
        <SelectField
          label="AP bonus"
          value={String(bonus.apMod || 0)}
          onChange={(v) => setBonus((s) => ({ ...s, apMod: Number(v) }))}
          options={MOD_OPTIONS_3}
          small
        />
      </Row>
      <Row cols={2}>
        <NumberField
          label="Mortal wounds navíc"
          value={bonus.mortalWounds || 0}
          onChange={(v) => setBonus((s) => ({ ...s, mortalWounds: Math.max(0, v) }))}
          min={0}
          hint="jednorázově za celou jednotku, mimo save (např. z charge); FNP se počítá"
          small
        />
        <div />
      </Row>
    </>
  );
}

// Cheat sheet only: the offensive fields above (BonusFieldsGroup) plus the
// defensive ones a "Debuffy obránce" panel used to have on its own — merged
// so either slot panel can hold both, letting values follow an army through
// a "Prohodit útočníky a cíle" swap. `mod` is one type-slice (ranged/melee)
// of a slot's modifiers (see emptyFullModifier).
function FullModifierFields({ mod, setMod, isRanged }) {
  return (
    <>
      <BonusFieldsGroup bonus={mod} setBonus={setMod} isRanged={isRanged} />
      <Row cols={isRanged ? 4 : 3}>
        <NumberField label="FNP (0 = jen vlastní)" value={mod.fnp} onChange={(v) => setMod((s) => ({ ...s, fnp: Math.max(0, v) }))} min={0} small />
        <NumberField
          label="Redukce dmg (0 = jen vlastní)"
          value={mod.damageReduction}
          onChange={(v) => setMod((s) => ({ ...s, damageReduction: Math.max(0, v) }))}
          min={0}
          small
        />
        <ToggleField label="Debuff: -1 WR pokud S > T" value={mod.woundDebuff} onChange={(v) => setMod((s) => ({ ...s, woundDebuff: v }))} small />
        {isRanged && (
          <ToggleField
            label="Benefit of Cover (-1 BS)"
            value={mod.benefitOfCover}
            onChange={(v) => setMod((s) => ({ ...s, benefitOfCover: v }))}
            hint="jen na dálku"
            small
          />
        )}
      </Row>
      <Row cols={2}>
        <SelectField
          label="Přehoz save hodu"
          value={mod.saveReroll || "none"}
          onChange={(v) => setMod((s) => ({ ...s, saveReroll: v }))}
          options={REROLL_OPTIONS}
          small
        />
        <div />
      </Row>
    </>
  );
}

function CheatSlotPanel({ title, hint, accent, slot, setSlot }) {
  const setType = (type) => (updater) => setSlot((s) => ({ ...s, [type]: typeof updater === "function" ? updater(s[type]) : updater }));
  return (
    <div style={{ background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 10, padding: 12, marginBottom: 14 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
        {title} <span style={{ fontWeight: 400, textTransform: "none" }}>({hint})</span>
      </div>
      <Row cols={2}>
        <NumberField
          label="Toughness (Nurglovy dary)"
          value={slot.toughnessMod}
          onChange={(v) => setSlot((s) => ({ ...s, toughnessMod: v }))}
          hint="zadej -1 pro zhoršení; pro obě strany"
          small
        />
        <NumberField
          label="Save (Nurglovy dary)"
          value={slot.saveMod}
          onChange={(v) => setSlot((s) => ({ ...s, saveMod: v }))}
          hint="zadej -1 pro zhoršení; pro obě strany"
          small
        />
      </Row>
      <div style={{ background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 8, padding: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#a9c6e5", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6, display: "flex", alignItems: "center", gap: 4 }}>
          <Crosshair size={11} /> Na dálku
        </div>
        <FullModifierFields mod={slot.ranged} setMod={setType("ranged")} isRanged />
      </div>
      <div style={{ background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 8, padding: 8 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: accent, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6, display: "flex", alignItems: "center", gap: 4 }}>
          <Sword size={11} /> Na blízko
        </div>
        <FullModifierFields mod={slot.melee} setMod={setType("melee")} isRanged={false} />
      </div>
    </div>
  );
}

function StepDots({ steps, current }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4, flexWrap: "wrap" }}>
      {steps.map((label, i) => {
        const n = i + 1;
        const active = n === current;
        const done = n < current;
        return (
          <React.Fragment key={label}>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: "50%",
                  fontSize: 9.5,
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: active || done ? "var(--accent)" : "var(--field-border)",
                  color: active || done ? "#fff" : "var(--muted)",
                  flexShrink: 0,
                }}
              >
                {n}
              </span>
              <span style={{ fontSize: 9.5, fontWeight: 700, color: active ? "var(--accent-text)" : "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</span>
            </div>
            {i < steps.length - 1 && <span style={{ width: 10, height: 1, background: "var(--field-border)" }} />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manual / help view — built into the app itself (not an external link) so
// anyone visiting the site can open it, logged in or not.
// ---------------------------------------------------------------------------
function ManualPath({ children }) {
  return (
    <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 4, padding: "1px 6px", whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

function ManualSection({ num, title, children }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, borderBottom: "1px solid var(--field-border)", paddingBottom: 8, marginBottom: 12 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent-text)", border: "1px solid var(--accent)", borderRadius: 4, padding: "1px 6px", flexShrink: 0 }}>{num}</span>
        <div style={{ fontSize: 15.5, fontWeight: 700 }}>{title}</div>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--text)", lineHeight: 1.65 }}>{children}</div>
    </div>
  );
}

function ManualP({ children, muted }) {
  return <div style={{ marginBottom: 10, color: muted ? "var(--muted)" : "var(--text)" }}>{children}</div>;
}

function ManualH({ children }) {
  return <div style={{ fontSize: 12.5, fontWeight: 700, margin: "16px 0 6px" }}>{children}</div>;
}

function ManualSteps({ items }) {
  return (
    <ol style={{ margin: "0 0 12px", padding: 0, listStyle: "none", counterReset: "ms" }}>
      {items.map((it, i) => (
        <li key={i} style={{ counterIncrement: "ms", position: "relative", padding: "3px 0 3px 30px", marginBottom: 2 }}>
          <span
            style={{
              position: "absolute",
              left: 0,
              top: 2,
              width: 19,
              height: 19,
              borderRadius: 5,
              background: "var(--accent-dim)",
              color: "var(--accent-text)",
              fontFamily: "var(--mono)",
              fontWeight: 700,
              fontSize: 10.5,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {i + 1}
          </span>
          {it}
        </li>
      ))}
    </ol>
  );
}

function ManualUl({ items }) {
  return (
    <ul style={{ margin: "0 0 12px", padding: 0, listStyle: "none" }}>
      {items.map((it, i) => (
        <li key={i} style={{ position: "relative", padding: "0 0 8px 14px" }}>
          <span style={{ position: "absolute", left: 0, top: 7, width: 5, height: 5, background: "var(--muted)", opacity: 0.6, borderRadius: 1 }} />
          {it}
        </li>
      ))}
    </ul>
  );
}

function ManualNote({ tone = "accent", label, children }) {
  const color = tone === "warn" ? "#e0857c" : "var(--accent-text)";
  const bg = tone === "warn" ? "rgba(224,133,124,0.1)" : "var(--accent-dim)";
  const border = tone === "warn" ? "rgba(224,133,124,0.4)" : "var(--accent)";
  return (
    <div style={{ background: bg, border: `1px solid ${border}`, borderRadius: 8, padding: "10px 12px", margin: "10px 0" }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color, marginBottom: 4 }}>{label}</div>
      <div style={{ color: "var(--text)" }}>{children}</div>
    </div>
  );
}

function ManualView({ onBack }) {
  return (
    <div className="no-print" style={{ padding: "4px 14px 16px" }}>
      <button
        onClick={onBack}
        style={{ display: "flex", alignItems: "center", gap: 5, background: "transparent", border: "none", color: "var(--muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, cursor: "pointer", padding: 0, marginBottom: 14 }}
      >
        <ArrowLeft size={13} /> Zpět
      </button>
      <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>Návod k použití</div>
      <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 22 }}>
        Battlecalc počítá očekávané poškození a šance na zabití mezi dvěma jednotkami Warhammeru 40 000 — na základě skutečných statů zbraní, ne jen odhadem.
      </div>

      <ManualSection num="01" title="Přihlášení">
        <ManualP muted>Appka je vázaná na účet — knihovna, armády i historie se ukládají zvlášť pro každého uživatele. Na výběr jsou tři způsoby:</ManualP>
        <ManualH>Odkaz emailem (nejjednodušší)</ManualH>
        <ManualSteps
          items={[
            <>Zadej svůj email a klikni <b>Poslat přihlašovací odkaz</b>.</>,
            <>Otevři si schránku (i spam) a klikni na odkaz v emailu.</>,
            <>Appka tě rovnou přihlásí — heslo nikde nezadáváš.</>,
          ]}
        />
        <ManualH>Email + heslo</ManualH>
        <ManualP>
          Přepni na záložku <ManualPath>Email + heslo</ManualPath>. Poprvé zvol <b>Vytvořit účet</b>, potvrď registraci odkazem v emailu, pak se už přihlašuj heslem.
        </ManualP>
        <ManualH>Google</ManualH>
        <ManualP>
          Tlačítko <b>Pokračovat s Google</b> tě přihlásí přes existující Google účet.
        </ManualP>
        <ManualNote label="Odhlášení">
          Ozubené kolečko vpravo nahoře → dole v menu <b>Odhlásit se</b>.
        </ManualNote>
      </ManualSection>

      <ManualSection num="02" title="Knihovna jednotek">
        <ManualP muted>Knihovna je tvůj sklad jednotek — každou počítanou bitvu appka vybírá útočníka i obránce právě odsud. Naplnit ji jde třemi způsoby.</ManualP>
        <ManualH>Import z New Recruit (JSON export)</ManualH>
        <ManualP>
          <ManualPath>Knihovna → Nahrát novou armádu z New Recruit</ManualPath>
        </ManualP>
        <ManualSteps
          items={[
            <>V New Recruit exportuj svůj list jako <b>JSON</b> (ne obyčejný text).</>,
            <>Nahraj soubor, nebo obsah vlož do textového pole.</>,
            <>Klikni <b>Naimportovat</b>.</>,
          ]}
        />
        <ManualP>
          Tohle je jediný způsob, který appce dá <b>skutečné bojové staty</b> pro každou zbraň — proto se doporučuje jako první krok pro každou novou frakci. Appka sama pozná Lethal Hits, Sustained Hits, Twin-linked, Melta X, Feel No Pain a některé útočné schopnosti (víc v kapitole 05) a rovnou z importu uloží i pojmenovanou armádu.
        </ManualP>
        <ManualNote tone="warn" label="Vůdci jednotek">
          Pokud je v listu postava připojená k jednotce jako vůdce (Leader), appka je při importu spojí do jedné položky knihovny — jejich zbraně se pak počítají dohromady, jméno bude např. „Wolf Guard Terminators (vede Logan Grimnar)“ a body se sečtou.
        </ManualNote>
        <ManualH>Armáda (přehled)</ManualH>
        <ManualP>
          <ManualPath>Domů → Armáda</ManualPath> — vyber uloženou armádu (třeba z New Recruit). Uvidíš její statistiky (body, modely, rány, průměrná odolnost, počet vozidel/monster/postav a očekávaný damage proti pěchotě, elitě a tanku), pod tím vybereš soupeře a jedním klikem otevřeš cheat sheet armáda proti armádě. Tlačítka „Herní deska“ ti armádu rovnou vyberou na desce, případně ji rozmístí (i obě najednou).
        </ManualP>
        <ManualH>Ruční přidání / úprava</ManualH>
        <ManualP>
          <ManualPath>Knihovna → Přidat ručně</ManualPath> — vyplníš obranné staty a přidáš modely se zbraněmi. Stejný formulář se otevře i tužkou u existující jednotky.
        </ManualP>
        <ManualP>Ikonka hvězdy u jednotky ji přidá do Oblíbených.</ManualP>
        <ManualH>Sdílení s kamarádem</ManualH>
        <ManualP>
          <ManualPath>Knihovna → Sdílet s kamarádem → Export</ManualPath> — tlačítko <b>Stáhnout jako soubor</b> uloží celou knihovnu a armády jako <code style={{ fontFamily: "var(--mono)" }}>.json</code> soubor. Kamarád ho na stejném místě přes záložku <b>Import</b> nahraje tlačítkem <b>Nahrát soubor</b>. Duplicity se automaticky přeskočí.
        </ManualP>
        <ManualNote label="Copyright">
          Battlecalc nešíří žádnou oficiální databázi jednotek GW — knihovna obsahuje jen to, co si sám naimportuješ nebo co ti pošle kamarád ze svého vlastního exportu.
        </ManualNote>
      </ManualSection>

      <ManualSection num="03" title="Kalkulačka">
        <ManualP muted>Hlavní obrazovka appky, tři kroky:</ManualP>
        <ManualP>Útočník a obránce jsou naproti sobě ve dvou kartách (na mobilu pod sebou) — vyber jednotku v obou, uprav co potřebuješ, dole klikni Spočítat.</ManualP>
        <ManualH>Karta útočníka</ManualH>
        <ManualUl
          items={[
            <><b>Připojit vůdce</b> — dočasně spojí jednotku s postavou z knihovny (jen pro tenhle výpočet).</>,
            <><b>Bonusy na dálku / na blízko zvlášť</b> — Lethal Hits, Sustained, přehoz zásahu/zranění, modifikátor hit rollu, wound rollu, AP bonus, mortal wounds navíc.</>,
            <><b>Fire Overwatch</b> — jen bonusy na dálku. Zásah jen na neupravenou 6, ignoruje ostatní hit modifikátory (přesně dle strategemu).</>,
            <><b>Profil zbraně</b> — pokud má zbraň víc profilů (např. Sweep/Strike), zvolíš který se použije.</>,
            <><b>Melta</b> — přepínač „v polovičním dosahu“ u zbraní s Meltou X.</>,
            <><b>Rapid Fire</b> — přepínač „v polovičním dosahu“ u zbraní s Rapid Fire X (přidá X útoků).</>,
          ]}
        />
        <ManualH>Karta obránce</ManualH>
        <ManualP>
          Vyber cílovou jednotku. Volitelně rozklikni <b>Modifikátory</b> pro úpravu počtu modelů, FNP, debuffu, Benefit of Cover nebo <b>přehozu save hodu</b> (Jedničky / Vše). Klikni <b>Spočítat</b>.
        </ManualP>
      </ManualSection>

      <ManualSection num="04" title="Čtení výsledku">
        <ManualH>Očekávané zabité modely</ManualH>
        <ManualP>
          Tohle číslo je <b>průměr přes mnoho her</b>, ne jistota — <code style={{ fontFamily: "var(--mono)" }}>1.84</code> znamená „za 100 stejných útoků v průměru zabiješ 184 modelů“. Vedle je proto i <b>„jistě padne N“</b> — spodní odhad zaokrouhlený dolů.
        </ManualP>
        <ManualH>Tři šance dole</ManualH>
        <ManualP muted>Počítané binomickým rozdělením (ne jen průměrem):</ManualP>
        <ManualUl items={["Šance zabít alespoň 1 model", "Šance zničit celou jednotku", "Šance, že jednotka přežije"]} />
        <ManualH>Rozpis podle zbraní</ManualH>
        <ManualP>
          Vedle procent vidíš i skutečné očekávané počty, např. <code style={{ fontFamily: "var(--mono)" }}>3+ → 66.7% (0.67)</code>. Řádek se navíc označí, pokud se u něj uplatnil debuff -1 na wound roll.
        </ManualP>
      </ManualSection>

      <ManualSection num="05" title="Co appka umí rozpoznat">
        <ManualP muted>Z JSON importu appka automaticky vyčte a nastaví: Lethal Hits, Sustained Hits X, Twin-linked, Melta X, Rapid Fire X, Feel No Pain, redukci damage (např. C'tan Shard).</ManualP>
        <ManualP>Tohle je potřeba doplnit/zkontrolovat ručně v editaci jednotky nebo zbraně (tužka v knihovně):</ManualP>
        <ManualUl
          items={[
            <><b>Anti-X Y+</b> — zbraň → „Anti- klíčové slovo“ + práh. Proti MONSTER/VEHICLE/CHARACTER/INFANTRY automaticky zraní na hod Y+.</>,
            <><b>Přehoz vše proti keywordu</b> — zbraň → „vs MONSTER/VEHICLE/CHARACTER“. Přehoz zásahu i zranění jen proti danému keywordu (např. GMNDK).</>,
            <><b>Přehoz 1 hitu / 1 woundu</b> — zbraň → zaškrtávátko. Jednorázový přehoz, jiná matematika než „všechny“/„jedničky“.</>,
            <><b>Přehoz 1 damage rollu</b> — zbraň → vyplň „Kostky Damage“ (např. D6, 2D6, D3+3) a zaškrtni přehoz. Appka spočítá optimální strategii (přehodit jen nízké hody).</>,
            <><b>Critical Hit / Critical Wound na X+</b> — zbraň → obě pole, normálně 6. Snižuje práh, kdy se hit/wound počítá jako kritický (ovlivňuje Lethal Hits, Sustained Hits i Devastating Wounds).</>,
            <><b>Devastating Wounds</b> — zbraň → zaškrtávátko. Critical Wound = mortal wounds rovné Damage, mimo jakýkoli save (ani invulnerable).</>,
            <><b>Přehoz save hodu</b> — obránce → Modifikátory → „Přehoz save hodu“ (Jedničky / Vše), zvlášť na dálku/na blízko.</>,
            <><b>FNP proti Psychic</b> — jednotka → „FNP proti Psychic“. Funguje jen proti zbraním označeným jako „Psychický útok“ (např. Culexus).</>,
            <><b>Klíčová slova jednotky</b> — MONSTER / VEHICLE / CHARACTER / INFANTRY. Nutné pro Anti-X a keyword-rerolly výše.</>,
            <><b>Mortal wounds navíc</b> — karta útočníka, bonusový panel. Jednorázově za celou jednotku, mimo save.</>,
          ]}
        />
      </ManualSection>

      <ManualSection num="06" title="Armády">
        <ManualP>
          <ManualPath>Cheat sheet → Moje armády</ManualPath> — pojmenovaná skupina jednotek z knihovny, hlavně pro cheat sheet (kapitola 07). Dvě cesty, jak ji založit:
        </ManualP>
        <ManualH>Ručně</ManualH>
        <ManualP><b>Uložit novou armádu</b> → pojmenuj a zaškrtni jednotky z knihovny.</ManualP>
        <ManualH>Z textu (New Recruit)</ManualH>
        <ManualP>
          <b>Armáda z textu (New Recruit)</b> — vlož prostý textový export listu (bez statů, jen jména a body). Appka spáruje jednotky podle jména a bodů s knihovnou a armádu uloží nebo aktualizuje.
        </ManualP>
        <ManualNote label="Vůdce v textu zvlášť">
          Pokud text uvádí vůdce a jednotku zvlášť, appka zkusí i jejich <b>součet bodů</b> a najde sloučenou položku v knihovně. Samotný vůdce se pak ukáže jako „nenalezeno“ — to je v pořádku, jeho staty už jsou uvnitř sloučené jednotky.
        </ManualNote>
        <ManualH>Přidání do cheat sheetu</ManualH>
        <ManualP>
          U každé uložené armády jsou dvě tlačítka — <b>Útočník</b> a <b>Obránce</b> — zaškrtnou rovnou všechny její jednotky na příslušné straně.
        </ManualP>
      </ManualSection>

      <ManualSection num="07" title="Cheat sheet k tisku">
        <ManualP>
          <ManualPath>Cheat sheet → Cheat sheet pro tisk</ManualPath> spočítá matici všichni útočníci × všichni cíle najednou.
        </ManualP>
        <ManualSteps
          items={[
            <>Volitelně rozbal <b>Modifikátory</b> a nastav bonusy útočníka / debuffy obránce navíc k vestavěným schopnostem — tabulka ukáže obojí, „Základ“ i „S bonusy“.</>,
            <>Zaškrtni útočníky a cíle — nebo použij <b>Zaškrtnout celou armádu…</b> / tlačítka Útočník/Obránce u uložené armády.</>,
            <>Výsledková matice se počítá průběžně, hned nad zaškrtávacími seznamy. Klikni <b>Vytisknout cheat sheet</b>.</>,
          ]}
        />
        <ManualP>
          Každá buňka má čtyři lebky ve dvou řádcích — <b>S</b> (na dálku) a <b>M</b> (na blízko), v obou řádcích šedou (jen vestavěné schopnosti) a modrou (+ tvoje bonusy) — vyplněné podle procenta zničené jednotky.
        </ManualP>
        <ManualP muted>Tlačítko <b>Prohodit útočníky a cíle</b> prohodí obě zaškrtnutí najednou.</ManualP>
      </ManualSection>

      <ManualSection num="08" title="Herní deska">
        <ManualP>
          <ManualPath>Herní deska</ManualPath> — vizuální bojiště na míru. Zaškrtni jednotky z knihovny do <b>Moje jednotky</b> nebo <b>Jednotky protihráče</b> — objeví se jako tokeny (jeden na každý model), přetáhni je na místo. Nad seznamem vybereš uloženou armádu (třeba z New Recruit) — seznam se zúží na její jednotky a „Dát celou armádu na desku“ je rozmístí najednou; „Nahrát z New Recruit (JSON)“ nahraje nový export rovnou na tuhle stranu i s base sizy ze sloupce Base. Tažením modelu hýbeš celou jednotkou (tlačítko v liště přepne na jeden model, Alt při tažení přepne na opak; Shift při tažení vezme vždy jen jeden model — třeba když ho chceš nacpat za zeď). Víc modelů označíš tažením myší po prázdné desce (Shift přidává, Shift+klik na model ho přidá/odebere) — pak se všechny označené hýbou spolu. Kolečkem myši nad modelem otočíš celou jednotku (nebo označené modely, nebo jeden model — stejná pravidla jako při tažení); kolečko dolů otáčí po směru hodin, Shift = jemné kroky po 5°. Vzhled aplikace přepneš v Nastavení (ozubené kolečko → Vzhled): „Základní“ nebo „Taktický“ (sytě modrý HUD, hexagonové tokeny, texturované podložky, kompas a měřítko na desce). Desku můžeš otočit o 90° tlačítkem „Otočit“ (jen pohled, data zůstávají) a přibližovat tlačítky lupy nebo Ctrl + kolečkem (na touchpadu štípnutím) kolem kurzoru; přiblíženou desku posouváš posuvníky. Podložky jsou standardně zamčené (tlačítko „Terén zamčený“ v liště nad deskou) — táhneš jen modely, terén se nehne; odemknutím ho zase přesouváš a upravuješ. Velikost tokenu vychází z base size jednotky — přímo u jednotky v knihovně je malý rozklikávací seznam se standardními velikostmi (25 až 160mm kulaté, plus běžné oválné jako 90×52mm), není potřeba kvůli tomu otvírat celou editaci.
        </ManualP>
        <ManualUl
          items={[
            <>Model odebereš tak, že ho označíš (Shift+klik nebo tažením myší po desce) a stiskneš Delete, nebo tlačítkem „Odebrat označené“; jednotku celou odškrtnutím v seznamu.</>,
            <>Rozměry desky (šířka/výška v palcích) jdou upravit nahoře — token si přepočítá velikost podle nich.</>,
            <>Jeden token = celá jednotka (počet modelů je v odznáčku v rohu), ne model po modelu.</>,
            <><b>Rozložení výsadku — základní mapy</b> (v Desce sbalené pod „Tvorba mapy“) — nahoře je řada „základních map" (nový účet začíná s pěti, sloty <b>1–5</b>). Každá je jen tvar zóny — nakresli/zadej si do ní svou „Moji zónu" a ulož přes „Uložit změny do…"; druhá strana je vždy její diagonální (o 180° otočený) protějšek. Kliknutí na základní mapu ji rovnou zobrazí na desce (pokud máš rozdělaný neuložený tvar zóny, appka se před zahozením zeptá) — pak už jen přidávej ruiny. „Uložit jako novou základní mapu" přidá šestou, sedmou… „Smazat" pod mapou ji odebere i s jejími mutacemi.</>,
            <><b>Mutace map</b> — pod základními mapami je box „Mutace mapy „N"". Vyber základní mapu, rozestav na desce terén/podložky, případně dolaď zónu, a klikni „Uložit rozestavění jako mutaci" — uloží se jako podřízená kartička té mapy (zóna + celý terén). Kliknutí na mutaci načte její zónu i terén zpět. Takhle si z jedné základní mapy uděláš víc variant. „Uložit změny do…" u vybrané mutace přepíše i její terén.</>,
            <><b>Nakreslit vlastní výsadek</b> — klikni „Nakreslit mou zónu“, pak stiskni na desce a táhni jako štětcem (min. 3 body), a klikni Dokončit. „Zóna protihráče“ se sama dopočítá jako tvar otočený o 180° přes střed desky (diagonálně, ne jen prosté zrcadlo nahoru/dolů). „Zpět na vybrané rozložení“ obě strany zase vrátí na tvar aktuálně vybrané kartičky. Čísla po 5 palcích podél okrajů desky se zapínají/vypínají spolu s mřížkou.</>,
            <><b>Zóna čísly (v palcích)</b> — pod tlačítkem pro kreslení je box Moje zóna se dvěma obdélníky (Obdélník 1 a 2) — zadej jim Od X/Y a Do X/Y podle čísel na okraji desky a klikni na tlačítko Nastavit. Oba obdélníky se spojí do jedné zóny, takže jde postavit i L-tvar nebo schod, ne jen jeden obdélník. „Zóna protihráče“ se vždy dopočítá automaticky jako diagonální (o 180° otočený) protějšek — nezadává se ručně.</>,
            <><b>Trojúhelník a kruhová výseč čísly</b> — pod obdélníky jsou další dva boxy: Trojúhelník (tři rohy, každý svým X/Y) a Kruhová výseč (střed X/Y, poloměr od/do, úhel od/do ve stupních — 0° doprava, 90° dolů; poloměr „od“ 0 = bez otvoru uprostřed; zaškrtnutím „Opačně“ se z výseče stane celý výsek od středu ven s vykrojeným kruhem, tlačítko „Čtvrtina bez kruhu 9″“ to nastaví jedním klikem). Každý má vlastní tlačítko Nastavit a nahradí celou „Moji zónu“ (nekombinuje se s obdélníky). „Zóna protihráče“ se i tady vždy dopočítá jako diagonální protějšek.</>,
            <><b>Rychlý souboj</b> — klikni na svůj token, pak na token protihráče. Appka spočítá zabité modely/damage jen z vestavěných schopností obou jednotek (žádné bonusy). „Otevřít v kalkulačce“ tě přenese do plné kalkulačky s modifikátory.</>,
            <><b>Terén (stavebnice)</b> — klikni na Ruina/T obrys (bez podložky)/Objektiv domácí červený/Objektiv domácí modrý/Objektiv střed/Objektiv expanze/Short line full/Short line full 1/Short line full 2/Short line full 3/Short line full 4/Short line full 5/Short line full 6/Short line full kombi/Short line full combi 2/Short line full combi 3/Short line full combi 4/Short line full combi 5/Short line full combi 6/Short line full combi 7/Short line full combi 8/Short line full combi 9/Short line full combi 10/Short line full combi 11/Short line/Short line 1/Short line 2/Short line 3/Short line 4/Short line 5/Short line 6/Short line 7/Short line 8/Ruin diag A/Ruin diag B/Triangle/Triangle 1/Triangle 2/Triangle 3/Triangle 4/Triangle 5/Triangle 6/Triangle 7/Triangle 8/Triangle 9/Triangle 10/Triangle 11/Triangle 12/Triangle 13/Triangle 14/Triangle 15/Triangle 16/Triangle 17/Medium rectangle full/Medium rectangle full 1/Medium rectangle full 2/Medium rectangle full 3/Medium rectangle full 4/Medium rectangle full 5/Medium rectangle full 6/Medium rectangle full 7/Medium rectangle full 8/Medium rectangle full 9/Medium rectangle full 10/Medium rectangle full 11/Medium rectangle open 1/Medium rectangle open 2/Medium rectangle open 3/Medium rectangle open 4/Medium rectangle open 5/Medium rectangle open 6/Medium rectangle open 7/Medium rectangle open 8/Medium rectangle open 9/Medium rectangle open 10/Medium rectangle open 11/Medium rectangle open 12/Medium rectangle open 13/Medium rectangle 1/Large rectangle/Large rectangle 1/Large rectangle 2/Large rectangle 3/Large rectangle 4/Large rectangle 5/Large rectangle 6/Large rectangle 7/Large rectangle 8/Large rectangle 9/Large rectangle 10/Large rectangle 15–58/Zeď/Kráter/Les/Kontejner pro přidání kusu doprostřed desky, pak ho přetáhni na místo. „Large rectangle", „Large rectangle 1–10, 15–37", „Medium rectangle 1" i „Short line full kombi" jsou jeden pevný modul — podložka se zídkami, táhne/otáčí/škáluje se najednou. Klik na terén otevře dole šířku/výšku/otočení; odebereš ho dvojklikem, tlačítkem Odebrat, nebo klávesou Delete / Backspace, když je vybraný. Kus, který nechceš mít v paletě, smažeš popelnicí vedle něj; „Obnovit smazané“ je vrátí. Úplně nahoře v Desce vybereš, co hraješ („Já hraju“) a proti čemu („Proti“) — Take and Hold, Purge the Foe, Reconnaissance, Priority Assets nebo Disruption (pořadí je jedno) — a pak variantu A, B nebo C: jedním klikem se načte celá mapa (zónu i terén); všechny mají navíc značky objektivů (vlastní: čtverec = domácí, kroužek = střed, kosočtverec = expanze). Všechno ostatní pod tím (tvorba mapy, paleta terénu, Terén čísly, vlastní terén, Moje podložky) je schované pod rozbalovátkem „Úpravy mapy a terénu“. Vybraný kus zkopíruješ tlačítkem „Kopírovat kus“ nebo klávesou Ctrl+D (případně Ctrl+C a Ctrl+V). Pod rozměry je „Umístit bod“: vyber roh (nebo střed) kusu a zadej jeho X/Y v palcích — měří se vždy od odpovídajících okrajů desky (pravý roh od pravého okraje, dolní roh od dolního okraje atd., střed od levého a horního), počítá se i s otočením.</>,
            <><b>Uložit jako skupinu</b> — když máš na desce rozestavěno víc kusů (třeba ruinu se zdí a zelení), objeví se pole „Uložit N kusů jako skupinu". Pojmenuj a ulož → skupina se přidá do palety jako jeden kus. Klik na ni pak vysype celé to rozestavění zpět na desku (kusy zůstávají samostatně přetažitelné). „Smazat" u skupiny funguje jako u ostatních vlastních typů.</>,
            <><b>Mřížka po 1 palci</b> — přepínač u rozměrů desky, čtvercová síť odpovídající skutečným palcům na stole.</>,
            <><b>Terén čísly (obdélník / zeď)</b> — pod paletou je rozklikávací box. Obdélník zadáš dvěma protilehlými rohy (X/Y v palcích podle okraje desky), zeď dvěma konci úsečky + tloušťkou (kus se sám natočí do směru úsečky). „Přidat na desku" vytvoří normální terénní kus, který jde pak přetáhnout, zvětšit, otočit i uložit do skupiny.</>,
            <><b>Vytvořit vlastní terén / podložku</b> — vlastní název, tvar (obdélník/kruh/trojúhelník), rozměry a barva. „Vrstva“ určuje, jestli kus stojí nahoře (terén), dole (podložka, na které terén stojí), nebo <b>obojí najednou</b> (podložka s terénem přilepeným na ní — jeden kus, co se táhne a otáčí spolu).</>,
            <><b>Moje podložky</b> — ulož rozměry + rozložení výsadku + rozestavěný terén (bez jednotek) pod jménem, kdykoli znovu načti. <b>Sdílet podložku</b> stáhne/nahraje soubor stejně jako sdílení knihovny.</>,
          ]}
        />
        <ManualNote>
          Rozložení výsadku jsou obecné geometrické tvary, ne přesná kopie oficiálních GW map — appka schválně nemá žádnou oficiální databázi misí.
        </ManualNote>
      </ManualSection>

      <ManualSection num="09" title="Historie">
        <ManualP>
          Každý spočítaný výsledek se uloží do <ManualPath>Historie</ManualPath>. <b>Kopírovat</b> zkopíruje čitelný textový přehled, <b>Upravit</b> tě vrátí do kalkulačky se stejným nastavením.
        </ManualP>
      </ManualSection>

      <ManualSection num="10" title="Menu a zobrazení">
        <ManualP muted>Ikona ☰ vlevo nahoře otevře rychlé menu:</ManualP>
        <ManualUl
          items={[
            "Nový výpočet, Knihovna jednotek, Moje armády a cheat sheet, Historie výpočtů — přímé skoky do sekcí.",
            <><b>Celá obrazovka</b> — appka zabere celou obrazovku prohlížeče.</>,
            <><b>Automaticky podle displeje / Vždy úzké (mobil)</b> — šířka appky se sama přizpůsobuje displeji; tímhle přepínačem to jde vypnout.</>,
            <><b>Návod k použití</b> — tahle stránka.</>,
          ]}
        />
      </ManualSection>

      <ManualSection num="11" title="Časté dotazy">
        <ManualH>Proč se mi po smazání jednotky nezobrazuje armáda?</ManualH>
        <ManualP muted>Smazání jednotky ji odstraní i ze všech armád, které ji obsahovaly — a armádu, která by zůstala prázdná, appka smaže celou.</ManualP>
        <ManualH>Uvidí moji knihovnu někdo jiný?</ManualH>
        <ManualP muted>Ne. Data jsou vázaná na tvůj přihlášený účet, dokud je sám nepošleš přes „Sdílet s kamarádem“.</ManualP>
        <ManualH>Proč +1 u modifikátoru znamená zlepšení?</ManualH>
        <ManualP muted>+1 u modifikátoru hit/wound rollu vždy znamená zlepšení pro útočníka (např. z 3+ na 2+), -1 zhoršení.</ManualP>
        <ManualH>Proč appka nepočítá přehoz jednoho damage rollu?</ManualH>
        <ManualP muted>Damage appka ukládá jako zprůměrované číslo (D6 → 3.5), takže si nepamatuje, že šlo o kostku.</ManualP>
      </ManualSection>

      <div style={{ marginTop: 20, paddingTop: 14, borderTop: "1px solid var(--field-border)", fontSize: 10.5, color: "var(--muted)" }}>
        Neoficiální fanouškovský nástroj, bez vazby na Games Workshop.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function Wh40kCalculator({ session }) {
  const [library, setLibrary] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [editingUnit, setEditingUnit] = useState(null);

  const [attackerUnitId, setAttackerUnitId] = useState(null);
  const [defenderUnitId, setDefenderUnitId] = useState(null);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [methodologyOpen, setMethodologyOpen] = useState(false);
  const [cheatOpen, setCheatOpen] = useState(false);
  const [cheatAttackerIds, setCheatAttackerIds] = useState(new Set());
  const [cheatTargetIds, setCheatTargetIds] = useState(new Set());

  const toggleCheatAttacker = (id) =>
    setCheatAttackerIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const toggleCheatTarget = (id) =>
    setCheatTargetIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  // Swaps which checked units are attackers vs targets — e.g. after building
  // "my army vs their army", flip to "their army vs my army" without
  // re-ticking every checkbox by hand.
  const swapCheatAttackersAndTargets = () => {
    setCheatAttackerIds(cheatTargetIds);
    setCheatTargetIds(cheatAttackerIds);
    setCheatSlotA(cheatSlotB);
    setCheatSlotB(cheatSlotA);
  };

  // Two symmetric slots ("Bonusy útočníka" / "Debuffy obránce" panels) — each
  // holds a full offense+defense modifier set, since after "Prohodit
  // útočníky a cíle" the same army can sit in either role and its modifiers
  // should follow it, not stay pinned to whichever panel they were typed
  // into. Swapping swaps these two objects wholesale.
  const [cheatSlotA, setCheatSlotA] = useState(emptySlotModifiers());
  const [cheatSlotB, setCheatSlotB] = useState(emptySlotModifiers());
  const ZERO_BONUS = { ranged: emptyBonus(), melee: emptyBonus() };

  const addArmyToAttackers = (armyId) => {
    const army = armies.find((a) => a.id === armyId);
    if (!army) return;
    setCheatAttackerIds((prev) => new Set([...prev, ...army.unitIds]));
  };
  const addArmyToTargets = (armyId) => {
    const army = armies.find((a) => a.id === armyId);
    if (!army) return;
    setCheatTargetIds((prev) => new Set([...prev, ...army.unitIds]));
  };

  const [attackerBonus, setAttackerBonus] = useState(autoDetectBonus(null));
  const [attachedLeaderId, setAttachedLeaderId] = useState(null);
  const [weaponProfileChoice, setWeaponProfileChoice] = useState({}); // weaponId -> chosen profile index
  const [weaponMeltaActive, setWeaponMeltaActive] = useState({}); // weaponId -> is target within half range?
  const [weaponRapidFireActive, setWeaponRapidFireActive] = useState({}); // weaponId -> is target within half range?
  const [defenderModelCount, setDefenderModelCount] = useState(0);
  const [defenderFnp, setDefenderFnp] = useState({ ranged: 0, melee: 0 });
  const [defenderWoundDebuff, setDefenderWoundDebuff] = useState({ ranged: false, melee: false });
  const [defenderDamageReduction, setDefenderDamageReduction] = useState({ ranged: 0, melee: 0 });
  const [defenderToughnessMod, setDefenderToughnessMod] = useState(0);
  const [defenderSaveMod, setDefenderSaveMod] = useState(0);
  const [defenderBenefitOfCover, setDefenderBenefitOfCover] = useState(false);
  const [defenderSaveReroll, setDefenderSaveReroll] = useState({ ranged: "none", melee: "none" });

  const [armies, setArmies] = useState([]);
  const [armiesLoaded, setArmiesLoaded] = useState(false);
  const [board, setBoard] = useState({ widthIn: 44, heightIn: 60, tokens: [], terrain: [], layoutId: DEFAULT_LAYOUT_SLOTS[0].id, customZones: { mine: null, theirs: null } });
  const [boardLoaded, setBoardLoaded] = useState(false);
  // Saved "podložky" — named board presets (size + deployment layout +
  // terrain arrangement, no units) a person can save, reload later, or
  // export/import to share with someone else. Separate from `board` itself,
  // which is the one currently being worked on.
  const [boardPresets, setBoardPresets] = useState([]);
  const [boardPresetsLoaded, setBoardPresetsLoaded] = useState(false);
  // User-created terrain/base shapes (see TERRAIN_SHAPES for the built-in
  // ones) — same shape, just defined by the person instead of shipped with
  // the app. Each has a `layer` ("base" = a plinth terrain stands on, or
  // "terrain") like the built-ins do.
  const [customPieceTypes, setCustomPieceTypes] = useState([]);
  const [customPieceTypesLoaded, setCustomPieceTypesLoaded] = useState(false);
  // Ids of built-in TERRAIN_SHAPES the person has removed from the palette
  // (only hides the palette button — pieces already placed keep rendering).
  const [hiddenShapeIds, setHiddenShapeIds] = useState([]);
  // Mirrors `board` synchronously so drag-end can read the latest tokens
  // without depending on a stale render closure (see commitBoardTokenMove).
  const boardRef = useRef(board);
  useEffect(() => {
    boardRef.current = board;
  }, [board]);
  const [armiesOpen, setArmiesOpen] = useState(false);
  const [editingArmy, setEditingArmy] = useState(null);
  const [textArmyOpen, setTextArmyOpen] = useState(false);

  // Navigation shell state
  const [view, setView] = useState("home"); // home | calculator | library | history | lists
  const [calcStep, setCalcStep] = useState("setup"); // "setup" (attacker + defender side by side), "result"
  const [attackerSearch, setAttackerSearch] = useState("");
  const [defenderSearch, setDefenderSearch] = useState("");
  const [attackerFilter, setAttackerFilter] = useState(null); // { type: 'faction'|'army', key, label } | null
  const [defenderFilter, setDefenderFilter] = useState(null);
  const [librarySearch, setLibrarySearch] = useState("");
  const [libraryTab, setLibraryTab] = useState("units"); // units | weapons
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [defenderModifiersOpen, setDefenderModifiersOpen] = useState(false);
  const [cheatModifiersOpen, setCheatModifiersOpen] = useState(false);
  // Width is responsive by default (see .wh40k-shell media queries below) —
  // forceCompact pins it back to the narrow phone-card width regardless of
  // screen size, for anyone who prefers that even on a big display.
  const [uiTheme, setUiTheme] = useState(() => {
    try {
      return localStorage.getItem("ui_theme_v1") === "tactical" ? "tactical" : "classic";
    } catch (e) {
      return "classic";
    }
  });
  const chooseUiTheme = (t) => {
    setUiTheme(t);
    try {
      localStorage.setItem("ui_theme_v1", t);
    } catch (e) {
      /* storage blocked - the theme still applies for this session */
    }
  };
  const [forceCompact, setForceCompact] = useState(() => {
    try {
      return localStorage.getItem("battlecalc:forceCompact") === "1";
    } catch (e) {
      return false;
    }
  });
  const toggleForceCompact = () => {
    setForceCompact((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("battlecalc:forceCompact", next ? "1" : "0");
      } catch (e) {
        // ignore — purely a per-browser display preference
      }
      return next;
    });
  };
  const [isFullscreen, setIsFullscreen] = useState(!!document.fullscreenElement);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  };

  const [history, setHistory] = useState([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [expandedHistoryId, setExpandedHistoryId] = useState(null);
  const [copiedHistoryId, setCopiedHistoryId] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null); // { message, onConfirm } | null
  const askConfirm = (message, onConfirm) => setConfirmDialog({ message, onConfirm });
  const [alertMessage, setAlertMessage] = useState(null);

  const persistHistory = useCallback(async (next) => {
    setHistory(next);
    try {
      await storage.set("history_v1", JSON.stringify(next), false);
    } catch (e) {
      console.error("Nepodařilo se uložit historii", e);
    }
  }, []);

  const deleteHistoryEntry = (id) => persistHistory(history.filter((h) => h.id !== id));
  const clearHistory = () => persistHistory([]);

  useEffect(() => {
    (async () => {
      try {
        const res = await withTimeout(storage.get("library_v2", false));
        if (res && res.value) setLibrary(JSON.parse(res.value));
      } catch (e) {
        // nothing saved yet, or the request stalled — either way, don't
        // block the UI on it forever
      } finally {
        setLoaded(true);
      }
    })();
    (async () => {
      try {
        const res = await withTimeout(storage.get("armies_v1", false));
        if (res && res.value) setArmies(JSON.parse(res.value));
      } catch (e) {
        // nothing saved yet, or the request stalled
      } finally {
        setArmiesLoaded(true);
      }
    })();
    (async () => {
      try {
        const res = await withTimeout(storage.get("history_v1", false));
        if (res && res.value) setHistory(JSON.parse(res.value));
      } catch (e) {
        // nothing saved yet, or the request stalled
      } finally {
        setHistoryLoaded(true);
      }
    })();
    (async () => {
      try {
        const res = await withTimeout(storage.get("board_v1", false));
        if (res && res.value) setBoard(JSON.parse(res.value));
      } catch (e) {
        // nothing saved yet, or the request stalled
      } finally {
        setBoardLoaded(true);
      }
    })();
    (async () => {
      try {
        const res = await withTimeout(storage.get("board_presets_v1", false));
        if (res && res.value) setBoardPresets(JSON.parse(res.value));
      } catch (e) {
        // nothing saved yet, or the request stalled
      } finally {
        setBoardPresetsLoaded(true);
      }
    })();
    (async () => {
      try {
        const res = await withTimeout(storage.get("custom_pieces_v1", false));
        if (res && res.value) setCustomPieceTypes(JSON.parse(res.value));
      } catch (e) {
        // nothing saved yet, or the request stalled
      } finally {
        setCustomPieceTypesLoaded(true);
      }
    })();
    (async () => {
      try {
        const res = await withTimeout(storage.get("hidden_terrain_shapes_v1", false));
        if (res && res.value) setHiddenShapeIds(JSON.parse(res.value));
      } catch (e) {
        // nothing saved yet, or the request stalled
      }
    })();
    (async () => {
      try {
        const res = await withTimeout(storage.get("custom_layouts_v1", false));
        if (res && res.value) setCustomLayouts(JSON.parse(res.value));
      } catch (e) {
        // nothing saved yet, or the request stalled
      } finally {
        setCustomLayoutsLoaded(true);
      }
    })();
  }, []);

  const persistLibrary = useCallback(async (next) => {
    setLibrary(next);
    try {
      await storage.set("library_v2", JSON.stringify(next), false);
    } catch (e) {
      console.error("Nepodařilo se uložit knihovnu", e);
    }
  }, []);

  const persistArmies = useCallback(async (next) => {
    setArmies(next);
    try {
      await storage.set("armies_v1", JSON.stringify(next), false);
    } catch (e) {
      console.error("Nepodařilo se uložit armády", e);
    }
  }, []);

  // Self-heal armies that reference a unit id no longer in the library —
  // deleteUnit already prunes on the spot when a unit is deleted through this
  // session, but a unit can also disappear from underneath a saved army via a
  // stale write from another device/tab (loads the old armies array, then
  // persists it back after this session already deleted a unit), which
  // otherwise leaves the army looking selectable but silently empty. Runs
  // once, only after both library and armies have actually finished loading
  // (armies loads in parallel with the library, so checking too early would
  // see an empty library and wrongly prune everything).
  const armiesPrunedRef = useRef(false);
  useEffect(() => {
    if (armiesPrunedRef.current || !loaded || !armiesLoaded) return;
    armiesPrunedRef.current = true;
    const libraryIds = new Set(library.map((u) => u.id));
    let danglingFound = false;
    const pruned = [];
    armies.forEach((a) => {
      const keptIds = (a.unitIds || []).filter((id) => libraryIds.has(id));
      if (keptIds.length !== (a.unitIds || []).length) danglingFound = true;
      if (keptIds.length > 0) pruned.push({ ...a, unitIds: keptIds });
      else danglingFound = true;
    });
    if (danglingFound) persistArmies(pruned);
  }, [loaded, armiesLoaded, library, armies, persistArmies]);

  const persistBoard = useCallback(async (next) => {
    setBoard(next);
    try {
      await storage.set("board_v1", JSON.stringify(next), false);
    } catch (e) {
      console.error("Nepodařilo se uložit desku", e);
    }
  }, []);

  const persistBoardPresets = useCallback(async (next) => {
    setBoardPresets(next);
    try {
      await storage.set("board_presets_v1", JSON.stringify(next), false);
    } catch (e) {
      console.error("Nepodařilo se uložit podložky", e);
    }
  }, []);

  // A "podložka" (mat) preset is the board's size, deployment layout and
  // terrain arrangement — deliberately NOT the units on it, since presets
  // are meant to be reusable/shareable tables, not someone's specific army.
  const saveBoardPreset = (name) => {
    const preset = {
      id: crypto.randomUUID(),
      name: name.trim() || "Podložka",
      widthIn: board.widthIn,
      heightIn: board.heightIn,
      layoutId: board.layoutId,
      terrain: board.terrain || [],
    };
    persistBoardPresets([...boardPresets, preset]);
  };
  const loadBoardPreset = (id) => {
    const preset = boardPresets.find((p) => p.id === id);
    if (!preset) return;
    persistBoard({
      ...board,
      widthIn: preset.widthIn,
      heightIn: preset.heightIn,
      layoutId: preset.layoutId,
      terrain: preset.terrain,
    });
    setSelectedTerrainId(null);
  };
  const deleteBoardPreset = (id) => persistBoardPresets(boardPresets.filter((p) => p.id !== id));

  const persistCustomPieceTypes = useCallback(async (next) => {
    setCustomPieceTypes(next);
    try {
      await storage.set("custom_pieces_v1", JSON.stringify(next), false);
    } catch (e) {
      console.error("Nepodařilo se uložit vlastní terén", e);
    }
  }, []);
  const addCustomPieceType = (def) => {
    const piece = { id: crypto.randomUUID(), ...def };
    persistCustomPieceTypes([...customPieceTypes, piece]);
    return piece.id;
  };
  const deleteCustomPieceType = (id) => persistCustomPieceTypes(customPieceTypes.filter((s) => s.id !== id));
  const persistHiddenShapes = async (next) => {
    setHiddenShapeIds(next);
    try {
      await storage.set("hidden_terrain_shapes_v1", JSON.stringify(next), false);
    } catch (e) {
      console.error("Nepodařilo se uložit skryté kusy terénu", e);
    }
  };
  // Looks up a shape definition by id across both the built-in TERRAIN_SHAPES
  // and the user's own saved custom types — so placed pieces, the palette,
  // and the selected-piece panel can all treat them identically.
  const findShapeDef = (shapeId) => TERRAIN_SHAPES.find((s) => s.id === shapeId) || customPieceTypes.find((s) => s.id === shapeId);
  // The shape a placed piece renders as — a freehand-drawn piece carries its
  // own geometry (clipPath) and look, everything else looks its type up.
  const pieceShape = (p) =>
    p.freehand
      ? { label: p.label || "Kreslený terén", layer: "terrain", clipPath: p.clipPath, bg: p.bg, border: p.border, radius: 0, widthIn: p.widthIn, heightIn: p.heightIn }
      : findShapeDef(p.shapeId);

  // How many models a unit has (sum of its member counts), at least 1.
  const unitModelCount = (u) =>
    Math.min(
      100,
      Math.max(1, u.modelCount > 0 ? u.modelCount : (u.members || []).reduce((sum, m) => sum + (Number(m.count) || 0), 0))
    );

  // One token per MODEL: a 10-model unit gets 10 tokens, laid out as a compact
  // block (rows sized by the unit's base, 0.1" apart). Blocks are packed along
  // that side's baseline left to right and wrap inward when the row is full;
  // anything already staged there is skipped over so new blocks don't pile
  // on top of old ones.
  const layoutUnitTokens = (entries, side, existing) => {
    const W = board.widthIn;
    const H = board.heightIn;
    const margin = 1.5;
    const gap = 0.1;
    const bandTokens = existing.filter((t) => t.side === side);
    let startX = margin;
    bandTokens.forEach((t) => {
      const inBand = side === "mine" ? t.yPct > 100 - (14 / H) * 100 : t.yPct < (14 / H) * 100;
      if (inBand) startX = Math.max(startX, (t.xPct / 100) * W + 2);
    });
    let x = startX;
    let rowOffset = 0;
    let rowH = 0;
    const out = [];
    entries.forEach(({ unit: u, inst }) => {
      const n = unitModelCount(u);
      const base = parseBaseSizeMm(u.baseSize);
      const dx = base.w / 25.4 + gap;
      const dy = base.h / 25.4 + gap;
      const cols = n <= 6 ? n : Math.ceil(Math.sqrt(n * 2));
      const rows = Math.ceil(n / cols);
      const blockW = cols * dx;
      const blockH = rows * dy;
      if (x + blockW > W - margin && x > margin) {
        x = margin;
        rowOffset += rowH + 1;
        rowH = 0;
      }
      const y0 = side === "mine" ? H - margin - blockH - rowOffset : margin + rowOffset;
      for (let i = 0; i < n; i++) {
        const cx = x + ((i % cols) + 0.5) * dx;
        const cy = y0 + (Math.floor(i / cols) + 0.5) * dy;
        out.push({
          id: crypto.randomUUID(),
          unitId: u.id,
          inst,
          side,
          xPct: Math.min(98, Math.max(2, (cx / W) * 100)),
          yPct: Math.min(98, Math.max(2, (cy / H) * 100)),
        });
      }
      x += blockW + 1;
      rowH = Math.max(rowH, blockH);
    });
    return out;
  };

  // Toggling a unit on/off the board's roster places every one of its models
  // (one token each) or removes them all; drag them into position afterward.
  const toggleUnitOnBoard = (unitId, side) => {
    const exists = board.tokens.some((t) => t.unitId === unitId && t.side === side);
    if (exists) {
      persistBoard({ ...board, tokens: board.tokens.filter((t) => !(t.unitId === unitId && t.side === side)) });
      return;
    }
    const unit = library.find((u) => u.id === unitId);
    if (!unit) return;
    persistBoard({ ...board, tokens: [...board.tokens, ...layoutUnitTokens([{ unit, inst: 0 }], side, board.tokens)] });
  };

  // Puts every given unit on a side's baseline in one go (units already there
  // are left alone) - used by "celou armadu na desku" and the New Recruit
  // import on the board.
  // One entry per listing of a unit (the same unit listed 3x = 3 instances),
  // skipping instances that are already on that side of the board.
  const boardEntriesFor = (unitIds, side, extraUnits = []) => {
    const wanted = new Map();
    unitIds.forEach((id) => wanted.set(id, (wanted.get(id) || 0) + 1));
    const entries = [];
    wanted.forEach((times, id) => {
      const unit = extraUnits.find((u) => u.id === id) || library.find((u) => u.id === id);
      if (!unit) return;
      const present = new Set(board.tokens.filter((t) => t.side === side && t.unitId === id).map((t) => t.inst || 0)).size;
      for (let k = present; k < times; k++) entries.push({ unit, inst: k });
    });
    return entries;
  };
  const addUnitsToBoardSide = (unitIds, side, extraUnits = []) => {
    const entries = boardEntriesFor(unitIds, side, extraUnits);
    if (entries.length === 0) return;
    persistBoard({ ...board, tokens: [...board.tokens, ...layoutUnitTokens(entries, side, board.tokens)] });
  };
  // Both armies in one save (two separate saves would overwrite each other).
  const addTwoArmiesToBoard = (mineIds, theirIds) => {
    const mine = boardEntriesFor(mineIds, "mine");
    const theirs = boardEntriesFor(theirIds, "theirs");
    if (mine.length + theirs.length === 0) return;
    persistBoard({
      ...board,
      tokens: [
        ...board.tokens,
        ...(mine.length ? layoutUnitTokens(mine, "mine", board.tokens) : []),
        ...(theirs.length ? layoutUnitTokens(theirs, "theirs", board.tokens) : []),
      ],
    });
  };
  const clearSideTokens = (side) => persistBoard({ ...board, tokens: board.tokens.filter((t) => t.side !== side) });

  const removeBoardToken = (tokenId) => persistBoard({ ...board, tokens: board.tokens.filter((t) => t.id !== tokenId) });

  // What moves when a token is grabbed: the marquee selection if the token is
  // part of one, else the whole unit instance (or just the one model - the
  // toolbar mode, flipped while Alt is held).
  const beginTokenDrag = (token, altKey, shiftKey) => {
    if (shiftKey) {
      // Shift-drag always takes just this one model (e.g. to tuck it behind a
      // wall); a Shift-click without moving still toggles the selection.
      dragGroupRef.current = [token.id];
    } else if (selectedTokenIds.length > 1 && selectedTokenIds.includes(token.id)) {
      dragGroupRef.current = selectedTokenIds;
    } else if (moveWholeUnit !== altKey) {
      dragGroupRef.current = board.tokens
        .filter((t) => t.side === token.side && t.unitId === token.unitId && (t.inst || 0) === (token.inst || 0))
        .map((t) => t.id);
    } else {
      dragGroupRef.current = [token.id];
    }
  };
  // The grabbed token follows the cursor; everything else in the group keeps
  // its offset to it (the shift is clamped so nobody leaves the board).
  const moveBoardToken = (tokenId, xPct, yPct) => {
    setBoard((s) => {
      const cur = s.tokens.find((t) => t.id === tokenId);
      if (!cur) return s;
      const group = dragGroupRef.current.includes(tokenId) ? dragGroupRef.current : [tokenId];
      const members = s.tokens.filter((t) => group.includes(t.id));
      let dx = xPct - cur.xPct;
      let dy = yPct - cur.yPct;
      members.forEach((t) => {
        dx = Math.max(-t.xPct, Math.min(100 - t.xPct, dx));
        dy = Math.max(-t.yPct, Math.min(100 - t.yPct, dy));
      });
      if (dx === 0 && dy === 0) return s;
      const ids = new Set(group);
      return { ...s, tokens: s.tokens.map((t) => (ids.has(t.id) ? { ...t, xPct: t.xPct + dx, yPct: t.yPct + dy } : t)) };
    });
  };
  // Mouse wheel over a model turns its unit (or the marquee selection, or one
  // model - same grouping as dragging, Alt flips): the models' positions are
  // rotated around the group's centre, and each model's own facing turns with
  // them (matters for oval bases). Wheel down = clockwise, Shift = fine 5deg
  // steps instead of 15.
  const rotateTokensAt = (tokenId, deltaY, altKey, shiftKey) => {
    const angle = (shiftKey ? 5 : 15) * (deltaY > 0 ? 1 : -1);
    setBoard((s) => {
      const tok = s.tokens.find((t) => t.id === tokenId);
      if (!tok) return s;
      let ids;
      if (selectedTokenIds.length > 1 && selectedTokenIds.includes(tokenId)) {
        ids = selectedTokenIds;
      } else if (moveWholeUnit !== altKey) {
        ids = s.tokens
          .filter((t) => t.side === tok.side && t.unitId === tok.unitId && (t.inst || 0) === (tok.inst || 0))
          .map((t) => t.id);
      } else {
        ids = [tokenId];
      }
      const set = new Set(ids);
      const grp = s.tokens.filter((t) => set.has(t.id));
      const W = s.widthIn;
      const H = s.heightIn;
      const cx = grp.reduce((sum, t) => sum + (t.xPct / 100) * W, 0) / grp.length;
      const cy = grp.reduce((sum, t) => sum + (t.yPct / 100) * H, 0) / grp.length;
      const rad = (angle * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      return {
        ...s,
        tokens: s.tokens.map((t) => {
          if (!set.has(t.id)) return t;
          const dx = (t.xPct / 100) * W - cx;
          const dy = (t.yPct / 100) * H - cy;
          const nx = cx + dx * cos - dy * sin;
          const ny = cy + dx * sin + dy * cos;
          return {
            ...t,
            xPct: Math.min(100, Math.max(0, (nx / W) * 100)),
            yPct: Math.min(100, Math.max(0, (ny / H) * 100)),
            rot: (((t.rot || 0) + angle) % 360 + 360) % 360,
          };
        }),
      };
    });
    // Save once the wheel pauses, not on every notch.
    clearTimeout(wheelSaveTimerRef.current);
    wheelSaveTimerRef.current = setTimeout(() => commitBoardTokenMove(), 400);
  };
  const removeSelectedTokensRef = useRef(null);
  const removeSelectedTokens = () => {
    const ids = new Set(selectedTokenIds);
    persistBoard({ ...board, tokens: board.tokens.filter((t) => !ids.has(t.id)) });
    setSelectedTokenIds([]);
  };
  const boardPctPoint = (e) => {
    const pt = boardPctFromPointer(boardContainerRef.current, e);
    return { x: Math.max(0, Math.min(100, pt.x)), y: Math.max(0, Math.min(100, pt.y)) };
  };
  const finishMarquee = (e) => {
    const st = marqueeStartRef.current;
    if (!st) return;
    marqueeStartRef.current = null;
    setMarquee(null);
    const p = boardPctPoint(e);
    const x0 = Math.min(st.x, p.x);
    const x1 = Math.max(st.x, p.x);
    const y0 = Math.min(st.y, p.y);
    const y1 = Math.max(st.y, p.y);
    if (x1 - x0 < 0.8 && y1 - y0 < 0.8) {
      if (!st.add) setSelectedTokenIds([]);
      return;
    }
    const hit = board.tokens.filter((t) => t.xPct >= x0 && t.xPct <= x1 && t.yPct >= y0 && t.yPct <= y1).map((t) => t.id);
    setSelectedTokenIds(st.add ? Array.from(new Set([...selectedTokenIds, ...hit])) : hit);
  };
  // Only write to storage once the drag actually ends — dragging fires
  // moveBoardToken on every pointer move (fast setState, no network), and
  // persisting every intermediate frame would spam the backend. Reads
  // boardRef instead of the `board` closure variable, since setState from
  // moveBoardToken above won't be reflected in this render's `board` yet.
  const commitBoardTokenMove = () => {
    storage.set("board_v1", JSON.stringify(boardRef.current), false).catch((e) => console.error("Nepodařilo se uložit desku", e));
  };

  const clearBoardTokens = () => persistBoard({ ...board, tokens: [] });
  const setBoardSize = (widthIn, heightIn) => persistBoard({ ...board, widthIn, heightIn });

  // Terrain "stavebnice" — original generic pieces (see TERRAIN_SHAPES), not
  // tied to any unit/army. Dropped in the middle of the board by default;
  // drag into place afterward. Reuses commitBoardTokenMove for drag-end
  // persistence since that just writes whatever boardRef.current holds,
  // regardless of whether a token or a terrain piece moved.
  const addTerrainPiece = (shapeId) => {
    setTerrainLocked(false);
    const shape = findShapeDef(shapeId);
    if (!shape) return;
    // A saved group expands into its member pieces (each a normal, separately
    // draggable piece), dropped around the middle of the board.
    if (shape.isGroup) {
      const newPieces = (shape.pieces || []).map((sp) => {
        const { dxPct, dyPct, ...rest } = sp;
        return {
          ...rest,
          id: crypto.randomUUID(),
          xPct: Math.max(0, Math.min(100, 50 + dxPct)),
          yPct: Math.max(0, Math.min(100, 50 + dyPct)),
          rotationDeg: rest.rotationDeg || 0,
        };
      });
      if (newPieces.length === 0) return;
      persistBoard({ ...board, terrain: [...(board.terrain || []), ...newPieces] });
      setSelectedTerrainId(null);
      return;
    }
    const piece = { id: crypto.randomUUID(), shapeId, xPct: 50, yPct: 50, widthIn: shape.widthIn, heightIn: shape.heightIn, rotationDeg: shape.defaultRotationDeg || 0 };
    persistBoard({ ...board, terrain: [...(board.terrain || []), piece] });
    setSelectedTerrainId(piece.id);
  };
  const removeTerrainPiece = (pieceId) => {
    persistBoard({ ...board, terrain: (board.terrain || []).filter((p) => p.id !== pieceId) });
    setSelectedTerrainId((s) => (s === pieceId ? null : s));
  };
  // Copies a placed piece (same shape/size/rotation) a little down-right of
  // the original and selects the copy, so pressing again keeps cascading.
  const duplicateTerrainPiece = (pieceId) => {
    const src = (board.terrain || []).find((p) => p.id === pieceId);
    if (!src) return;
    const copy = { ...src, id: crypto.randomUUID(), xPct: Math.min(100, src.xPct + 3), yPct: Math.min(100, src.yPct + 3) };
    persistBoard({ ...board, terrain: [...(board.terrain || []), copy] });
    setSelectedTerrainId(copy.id);
  };
  const moveTerrainPiece = (pieceId, xPct, yPct) => {
    setBoard((s) => ({ ...s, terrain: (s.terrain || []).map((p) => (p.id === pieceId ? { ...p, xPct, yPct } : p)) }));
  };
  const updateTerrainPiece = (pieceId, patch) => {
    persistBoard({ ...board, terrain: (board.terrain || []).map((p) => (p.id === pieceId ? { ...p, ...patch } : p)) });
  };
  const clearTerrain = () => {
    persistBoard({ ...board, terrain: [] });
    setSelectedTerrainId(null);
  };
  // Replaces the board's deployment zone and terrain with a ready-made layout
  // from LAYOUT_TEMPLATES (sets the board to the layout's size too) straight
  // away, no confirmation.
  const loadLayoutTemplate = (tpl) => {
    const apply = () => {
      const w = tpl.widthIn;
      const h = tpl.heightIn;
      const n3 = (v) => Math.round(v * 1000) / 1000;
      const toClip = (r) =>
        `polygon(${[[r.x1, r.y1], [r.x2, r.y1], [r.x2, r.y2], [r.x1, r.y2]].map(([x, y]) => `${n3((x / w) * 100)}% ${n3((y / h) * 100)}%`).join(", ")})`;
      const sec = tpl.zoneMineSector;
      const mine = sec
        ? [sectorPolygon(sec.cx, sec.cy, sec.r, 400, sec.angleStart, sec.angleEnd, w, h, 32)]
        : tpl.zoneMinePoly
          ? tpl.zoneMinePoly.map((pts) => `polygon(${pts.map(([x, y]) => `${n3((x / w) * 100)}% ${n3((y / h) * 100)}%`).join(", ")})`)
          : tpl.zoneMine.map(toClip);
      // Objective markers go last so they draw on top of the ruins, and are
      // listed explicitly on both sides, so they're never mirrored.
      const listed = tpl.pieces.map((p) => ({ ...p, rot: p.rot || 0 }));
      const ruins = listed.filter((p) => !p.marker);
      const markers = listed.filter((p) => p.marker);
      const mirrored = tpl.mirror
        ? ruins.filter((p) => !p.center).map((p) => ({ ...p, cx: w - p.cx, cy: h - p.cy, rot: (p.rot + 180) % 360 }))
        : [];
      const terrain = [...ruins, ...mirrored, ...markers].map((p) => ({
        id: crypto.randomUUID(),
        shapeId: p.shapeId,
        xPct: n3((p.cx / w) * 100),
        yPct: n3((p.cy / h) * 100),
        widthIn: p.widthIn,
        heightIn: p.heightIn,
        rotationDeg: p.rot,
      }));
      persistBoard({
        ...board,
        widthIn: w,
        heightIn: h,
        customZones: { mine, theirs: mine.map(mirrorClipPathDiagonally) },
        terrain,
      });
      setSelectedTerrainId(null);
    };
    apply();
  };
  // Save the whole current terrain arrangement (e.g. a ruin with a wall and
  // some vegetation on it) as one named palette entry — a "group". Each
  // piece keeps its own look/size/rotation and its offset from the group's
  // centre; placing the group later drops all of them back in that layout,
  // still individually draggable.
  const saveTerrainGroup = (rawName) => {
    const pieces = board.terrain || [];
    if (pieces.length === 0) return;
    const name = (rawName || "").trim() || `Skupina ${customPieceTypes.filter((s) => s.isGroup).length + 1}`;
    const cx = pieces.reduce((s, p) => s + p.xPct, 0) / pieces.length;
    const cy = pieces.reduce((s, p) => s + p.yPct, 0) / pieces.length;
    const parts = pieces.map((p) => {
      const { id, xPct, yPct, ...rest } = p;
      return { ...rest, dxPct: xPct - cx, dyPct: yPct - cy };
    });
    addCustomPieceType({ label: name, layer: "terrain", isGroup: true, pieces: parts });
  };

  // Freehand deployment-zone drawing (click points on the board to build a
  // polygon), as an alternative to the DEPLOYMENT_LAYOUTS swatches — the
  // shape itself is whatever the person clicks out, so there's nothing here
  // that could ever resemble a copied layout. Only "mine" is ever drawn —
  // "theirs" is always derived as its 180°-rotated (diagonal) opposite, see
  // mirrorPointsDiagonally, since a real deployment is normally the same
  // shape rotated through the board's center, not a plain up/down reflection.
  const startDrawingZone = () => {
    setDrawMode("mine");
    setDrawPoints([]);
  };
  const addDrawPoint = (xPct, yPct) => setDrawPoints((pts) => [...pts, { x: xPct, y: yPct }]);
  const cancelDrawingZone = () => {
    setDrawMode(null);
    setDrawPoints([]);
  };
  const mirrorPointsDiagonally = (points) => points.map((p) => ({ x: 100 - p.x, y: 100 - p.y }));
  const finishDrawingZone = () => {
    if (drawPoints.length < 3) return;
    persistBoard({ ...board, customZones: { ...(board.customZones || {}), mine: drawPoints, theirs: mirrorPointsDiagonally(drawPoints) } });
    setDrawMode(null);
    setDrawPoints([]);
  };
  const clearCustomZones = () => persistBoard({ ...board, customZones: { mine: null, theirs: null } });

  // Parametric terrain: type it in inches off the board ruler instead of
  // dragging. Terrain on the table is, in practice, just rectangles
  // (footprints/ruins) and line segments (walls) — a rectangle by its two
  // opposite corners, a wall by its two endpoints plus a thickness. Both
  // land as normal terrain pieces (reusing the "ruin" / "wall" looks) that
  // can then be dragged/resized/rotated or saved into a group like any other.
  const addParametricRect = () => {
    const { x1, y1, x2, y2, rectLayer } = paramTerrain;
    const xMin = Math.min(x1, x2);
    const xMax = Math.max(x1, x2);
    const yMin = Math.min(y1, y2);
    const yMax = Math.max(y1, y2);
    const piece = {
      id: crypto.randomUUID(),
      shapeId: rectLayer === "base" ? "base-plinth" : "ruin",
      xPct: (((xMin + xMax) / 2) / board.widthIn) * 100,
      yPct: (((yMin + yMax) / 2) / board.heightIn) * 100,
      widthIn: Math.max(0.5, xMax - xMin),
      heightIn: Math.max(0.5, yMax - yMin),
      rotationDeg: 0,
    };
    persistBoard({ ...board, terrain: [...(board.terrain || []), piece] });
    setSelectedTerrainId(piece.id);
  };
  const addParametricWall = () => {
    const { x1, y1, x2, y2, thickness } = paramTerrain;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthIn = Math.max(0.5, Math.hypot(dx, dy));
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    const piece = {
      id: crypto.randomUUID(),
      shapeId: "wall",
      xPct: (((x1 + x2) / 2) / board.widthIn) * 100,
      yPct: (((y1 + y2) / 2) / board.heightIn) * 100,
      widthIn: lengthIn,
      heightIn: Math.max(0.2, thickness || 1),
      rotationDeg: ((angle % 360) + 360) % 360,
    };
    persistBoard({ ...board, terrain: [...(board.terrain || []), piece] });
    setSelectedTerrainId(piece.id);
  };

  // Alternative to click/drag drawing: type "my" zone as two rectangles'
  // corners in inches directly (read straight off the on-board ruler), no
  // mouse precision involved — the two combine (a separate tint per
  // rectangle, same color) into one zone shape, since a real deployment zone
  // is often not a single rectangle. "Zóna protihráče" is never typed in
  // directly — it's always derived as the 180°-rotated (diagonal) opposite of
  // "my" zone, see mirrorRectDiagonally, matching how a real deployment is
  // normally the same shape rotated through the board's center rather than a
  // plain up/down reflection.
  const updateZoneRect = (rectIdx, axis, value) =>
    setZoneRects((s) => ({
      ...s,
      mine: s.mine.map((r, i) => (i === rectIdx ? { ...r, [axis]: value } : r)),
    }));
  // Pure conversions, no state access — safe to call repeatedly building up a
  // combined customZones object in one go (see setZoneRectsFromNumbers below,
  // which needs both sides applied in the SAME persistBoard call: separate
  // calls would each spread the same stale `board.customZones` closure and
  // the later call would silently wipe out the earlier one's update).
  const rectToPoints = (rect) => {
    const { x1, y1, x2, y2 } = rect;
    const xMin = Math.max(0, Math.min(x1, x2));
    const xMax = Math.min(board.widthIn, Math.max(x1, x2));
    const yMin = Math.max(0, Math.min(y1, y2));
    const yMax = Math.min(board.heightIn, Math.max(y1, y2));
    const toPct = (xIn, yIn) => ({ x: (xIn / board.widthIn) * 100, y: (yIn / board.heightIn) * 100 });
    return [toPct(xMin, yMin), toPct(xMax, yMin), toPct(xMax, yMax), toPct(xMin, yMax)];
  };
  const rectToClip = (rect) => pointsToClipPath(rectToPoints(rect));
  // 180°-rotates a rectangle through the board's center (negates both axes),
  // i.e. its diagonally-opposite counterpart — not a plain vertical flip
  // (which would just negate y and keep x, producing a direct up/down mirror
  // instead of a rotated one).
  const mirrorRectDiagonally = (rect) => ({
    x1: board.widthIn - rect.x2,
    x2: board.widthIn - rect.x1,
    y1: board.heightIn - rect.y2,
    y2: board.heightIn - rect.y1,
  });
  // customZones[side] is now an array of clip-path strings — one per
  // rectangle — rendered as that many stacked, same-colored tints (see the
  // board's deployment-zone render), which reads visually as one combined
  // (unioned) zone without needing actual polygon-union math. Both sides are
  // always set together in one persistBoard call — see rectToClip's comment
  // above for why two separate calls here would lose one side.
  const setZoneRectsFromNumbers = () => {
    const mirrored = zoneRects.mine.map(mirrorRectDiagonally);
    persistBoard({
      ...board,
      customZones: { ...(board.customZones || {}), mine: zoneRects.mine.map(rectToClip), theirs: mirrored.map(rectToClip) },
    });
  };

  // Same idea as the rectangle tool above but for a triangle — three corners
  // typed in inches instead of two — replacing (not combining with) whatever
  // "Moje zóna" currently is, same as picking a preset or drawing freehand.
  const triangleToClip = (t) => {
    const toPct = (xIn, yIn) => `${(xIn / board.widthIn) * 100}% ${(yIn / board.heightIn) * 100}%`;
    return `polygon(${toPct(t.x1, t.y1)}, ${toPct(t.x2, t.y2)}, ${toPct(t.x3, t.y3)})`;
  };
  const setTriangleZone = () => {
    const mine = [triangleToClip(triangleShape)];
    persistBoard({ ...board, customZones: { ...(board.customZones || {}), mine, theirs: mine.map(mirrorClipPathDiagonally) } });
  };

  // A circular-sector ("pie slice") zone, typed as a center point, an inner
  // and outer radius (0 inner = a plain wedge with no hole), and a start/end
  // angle in degrees (0°=right, 90°=down) — reuses the exact same
  // sectorPolygon() helper the built-in "center-wedge" layout is built from.
  // "Opačně" (invert) flips it: the zone becomes the whole wedge from the
  // center out past the board edge, with a circle of radius "Poloměr do"
  // cut out around the center (the inner radius is ignored). The 400" outer
  // radius just guarantees the wedge runs off the board on every side.
  const sectorToClip = (s) =>
    s.invert
      ? sectorPolygon(s.cx, s.cy, s.rOuter, 400, s.angleStart, s.angleEnd, board.widthIn, board.heightIn, 32)
      : sectorPolygon(s.cx, s.cy, s.rInner, s.rOuter, s.angleStart, s.angleEnd, board.widthIn, board.heightIn);
  const setSectorZone = (shape = sectorShape) => {
    const mine = [sectorToClip(shape)];
    persistBoard({ ...board, customZones: { ...(board.customZones || {}), mine, theirs: mine.map(mirrorClipPathDiagonally) } });
  };
  // One-click version of the inverted sector: the bottom-left quarter of the
  // board (angles 90-180 from the board's center) minus a 9" circle around
  // the center; the opponent's zone is its diagonal mirror (top-right).
  const setQuarterMinusCircleZone = () => {
    const shape = { cx: board.widthIn / 2, cy: board.heightIn / 2, rInner: 0, rOuter: 9, angleStart: 90, angleEnd: 180, invert: true };
    setSectorShape(shape);
    setSectorZone(shape);
  };

  const persistCustomLayouts = useCallback(async (next) => {
    setCustomLayouts(next);
    try {
      await storage.set("custom_layouts_v1", JSON.stringify(next), false);
    } catch (e) {
      console.error("Nepodařilo se uložit vlastní rozložení", e);
    }
  }, []);
  // What "Moje zóna" currently is, as a plain array of clip-path strings —
  // reads board.customZones.mine when a custom zone is active (drawn or
  // typed), and falls back to the selected layout's own mineClip otherwise —
  // exactly the same source the render itself uses to decide what to draw.
  // This is what actually gets saved when adding/updating a custom layout,
  // so "Uložit jako rozložení" always captures what's really on the board.
  const activeMineZoneClips = () => resolveZoneClips(board.customZones?.mine, (allLayouts.find((l) => l.id === board.layoutId) || allLayouts[0]).mineClip);
  // The base map "in play" — a mutation points back at its parent via
  // parentId; a base map is its own base. (Computed lazily so it doesn't
  // touch `customLayouts` before that state is declared further down.)
  const getActiveBaseLayoutId = () => {
    const sel = customLayouts.find((l) => l.id === board.layoutId);
    return sel ? sel.parentId || sel.id : customLayouts[0]?.id;
  };
  const snapshotTerrain = () => (board.terrain || []).map((t) => ({ ...t }));
  const saveNewLayout = () => {
    const name = newLayoutName.trim() || `Mapa ${customLayouts.filter((l) => !l.parentId).length + 1}`;
    persistCustomLayouts([...customLayouts, { id: crypto.randomUUID(), name, mineClip: activeMineZoneClips() }]);
    setNewLayoutName("");
  };
  // A "mutation" of a base map = that base plus a specific terrain layout,
  // saved as a child entry (parentId points at the base). Captures the zone
  // exactly as it is now (so tweaking it while making the mutation is kept)
  // and the current board terrain, then selects the new mutation.
  const saveMutation = () => {
    const baseId = activeBaseLayoutId;
    const base = customLayouts.find((l) => l.id === baseId);
    if (!base) return;
    const siblings = customLayouts.filter((l) => l.parentId === baseId).length;
    const name = newMutationName.trim() || `${base.name}-${siblings + 1}`;
    const entry = { id: crypto.randomUUID(), name, parentId: baseId, mineClip: activeMineZoneClips(), terrain: snapshotTerrain() };
    persistCustomLayouts([...customLayouts, entry]);
    setNewMutationName("");
    persistBoard({ ...board, layoutId: entry.id });
  };
  // "Uložit změny" — overwrites the selected entry's zone (and, for a
  // mutation, its terrain too) with whatever's on the board right now.
  const updateActiveLayout = () => {
    const active = customLayouts.find((l) => l.id === board.layoutId);
    if (!active) return;
    persistCustomLayouts(
      customLayouts.map((l) =>
        l.id === active.id ? { ...l, mineClip: activeMineZoneClips(), ...(l.parentId ? { terrain: snapshotTerrain() } : {}) } : l
      )
    );
  };
  // Deleting a base map takes its mutations with it.
  const deleteCustomLayout = (id) => persistCustomLayouts(customLayouts.filter((l) => l.id !== id && l.parentId !== id));
  // Selecting a mutation loads its own terrain onto the board and clears any
  // freehand/typed zone override so its saved shape shows; selecting a plain
  // base map likewise clears the override (otherwise a typed/drawn zone would
  // keep covering the map that was just clicked) but leaves terrain alone. If
  // the override is an unsaved zone (differs from the currently selected
  // layout's saved shape), ask before throwing it away.
  const selectLayout = (id) => {
    const layout = customLayouts.find((l) => l.id === id);
    const apply = () => {
      if (layout && layout.parentId && Array.isArray(layout.terrain)) {
        persistBoard({ ...board, layoutId: id, customZones: { mine: null, theirs: null }, terrain: layout.terrain.map((t) => ({ ...t })) });
      } else {
        persistBoard({ ...board, layoutId: id, customZones: { mine: null, theirs: null } });
      }
    };
    const override = board.customZones?.mine;
    if (Array.isArray(override) && override.length > 0) {
      const current = customLayouts.find((l) => l.id === board.layoutId);
      const unsaved = !current || JSON.stringify(resolveZoneClips(override, "")) !== JSON.stringify(asClipArray(current.mineClip));
      if (unsaved) {
        askConfirm("Aktuální tvar zóny není uložený do žádné mapy — načtením mapy zmizí. Pokud ho chceš zachovat, zruš to a nejdřív dej „Uložit změny do…“. Pokračovat?", apply);
        return;
      }
    }
    apply();
  };

  const saveArmy = (army) => {
    const exists = armies.some((a) => a.id === army.id);
    const next = exists ? armies.map((a) => (a.id === army.id ? army : a)) : [...armies, army];
    persistArmies(next);
    setEditingArmy(null);
  };

  const deleteArmy = (id) => persistArmies(armies.filter((a) => a.id !== id));

  // Matches a pasted New Recruit text-list against units already in the
  // library (by name/points) and saves/updates a named army from the
  // matches — no full JSON re-upload needed once the units themselves are
  // already in the library. Re-running with the same list name replaces
  // that army's unit selection rather than piling up duplicates.
  const importArmyFromText = (text) => {
    const { listName, entries } = parseArmyTextForMatching(text);
    if (entries.length === 0) {
      return { error: true, message: "Nepodařilo se v textu najít žádné jednotky (řádky ve tvaru \"Název (N pts)\" nebo \"Název (N points)\")." };
    }
    const { matchedIds, unmatched } = matchArmyEntriesToLibrary(entries, library);
    if (matchedIds.length === 0) {
      return { error: true, message: "Ani jedna jednotka z textu se nenašla v knihovně — nejdřív si armádu naimportuj z JSON, ať máš jednotky se staty." };
    }
    const name = listName || `Import ${new Date().toLocaleDateString("cs-CZ")}`;
    const existing = armies.find((a) => a.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      persistArmies(armies.map((a) => (a.id === existing.id ? { ...a, unitIds: matchedIds } : a)));
    } else {
      persistArmies([...armies, { id: crypto.randomUUID(), name, unitIds: matchedIds }]);
    }
    return { error: false, name, matchedCount: matchedIds.length, totalCount: entries.length, unmatched };
  };

  const saveUnit = (unit) => {
    const exists = library.some((u) => u.id === unit.id);
    const next = exists ? library.map((u) => (u.id === unit.id ? unit : u)) : [...library, unit];
    persistLibrary(next);
    setEditingUnit(null);
  };

  const toggleFavorite = (id) => {
    persistLibrary(library.map((u) => (u.id === id ? { ...u, isFavorite: !u.isFavorite } : u)));
  };

  const setUnitBaseSize = (id, baseSize) => {
    persistLibrary(library.map((u) => (u.id === id ? { ...u, baseSize } : u)));
  };

  const favoriteUnits = useMemo(() => library.filter((u) => u.isFavorite), [library]);

  const deleteUnit = (id) => {
    persistLibrary(library.filter((u) => u.id !== id));
    if (attackerUnitId === id) setAttackerUnitId(null);
    if (defenderUnitId === id) setDefenderUnitId(null);
    // Drop the unit from any saved armies too, and drop armies that end up
    // empty as a result — otherwise a deleted unit leaves a dangling
    // reference and the army looks selectable but produces nothing.
    const nextArmies = armies.map((a) => ({ ...a, unitIds: a.unitIds.filter((uid) => uid !== id) })).filter((a) => a.unitIds.length > 0);
    persistArmies(nextArmies);
  };

  const clearLibrary = () => {
    persistLibrary([]);
    persistArmies([]);
    setAttackerUnitId(null);
    setDefenderUnitId(null);
    setCheatAttackerIds(new Set());
    setCheatTargetIds(new Set());
  };

  const importUnits = (units) => {
    const existingSigs = new Set(library.map(unitSignature));
    const toAdd = [];
    let skipped = 0;
    units.forEach((u) => {
      const sig = unitSignature(u);
      if (existingSigs.has(sig)) {
        skipped += 1;
      } else {
        existingSigs.add(sig);
        toAdd.push(u);
      }
    });
    if (toAdd.length > 0) persistLibrary([...library, ...toAdd]);
    setLibraryOpen(true);
    return { added: toAdd.length, skipped };
  };

  const importUnitsAndArmies = (units, armiesIn) => {
    const result = importUnits(units);
    const existingArmyNames = new Set(armies.map((a) => a.name));
    const newArmies = (armiesIn || []).filter((a) => a && a.name && !existingArmyNames.has(a.name)).map((a) => ({ ...a, id: crypto.randomUUID() }));
    if (newArmies.length > 0) persistArmies([...armies, ...newArmies]);
    return result;
  };

  // New Recruit JSON import: adds the units to the library (deduped as usual),
  // then automatically saves the whole roster as a named army — using every
  // unit's id whether it was newly added or already existed in the library, so
  // the army correctly reflects the whole roster either way.
  const importFromNewRecruit = (units, rosterName) => {
    const existingSigToId = new Map(library.map((u) => [unitSignature(u), u.id]));
    const toAdd = [];
    const allIds = [];
    const baseFromImport = new Map();
    const modelsFromImport = new Map();
    let skipped = 0;
    units.forEach((u) => {
      const sig = unitSignature(u);
      if (existingSigToId.has(sig)) {
        skipped += 1;
        allIds.push(existingSigToId.get(sig));
        if (u.baseSize && String(u.baseSize) !== "32") baseFromImport.set(existingSigToId.get(sig), String(u.baseSize));
        if (u.modelCount > 0) modelsFromImport.set(existingSigToId.get(sig), u.modelCount);
      } else {
        existingSigToId.set(sig, u.id);
        toAdd.push(u);
        allIds.push(u.id);
      }
    });
    // A unit already in the library that still has the default 32mm base picks
    // up the size the import now knows (an older import had no Base column);
    // one the person already set to something else is left alone.
    let baseUpdated = 0;
    const baseUpdatedLibrary = library.map((x) => {
      let next = x;
      const b = baseFromImport.get(x.id);
      if (b && String(x.baseSize || "32") === "32") {
        baseUpdated += 1;
        next = { ...next, baseSize: b };
      }
      const mc = modelsFromImport.get(x.id);
      if (mc && !(x.modelCount > 0)) {
        baseUpdated += 1;
        next = { ...next, modelCount: mc };
      }
      return next;
    });
    if (toAdd.length > 0 || baseUpdated > 0) persistLibrary([...baseUpdatedLibrary, ...toAdd]);
    setLibraryOpen(true);

    let armyId = "";
    if (rosterName && rosterName.trim() && allIds.length > 0) {
      const name = rosterName.trim();
      const existingArmy = armies.find((a) => a.name === name);
      if (existingArmy) {
        armyId = existingArmy.id;
        // Keep duplicates (3x the same unit): per unit, the larger of the
        // old and the new listing count.
        const tally = (arr) => {
          const m = new Map();
          arr.forEach((id) => m.set(id, (m.get(id) || 0) + 1));
          return m;
        };
        const oldCnt = tally(existingArmy.unitIds);
        const newCnt = tally(allIds);
        const mergedIds = [];
        new Set([...oldCnt.keys(), ...newCnt.keys()]).forEach((id) => {
          for (let k = 0; k < Math.max(oldCnt.get(id) || 0, newCnt.get(id) || 0); k++) mergedIds.push(id);
        });
        persistArmies(armies.map((a) => (a.id === existingArmy.id ? { ...a, unitIds: mergedIds } : a)));
      } else {
        armyId = crypto.randomUUID();
        persistArmies([...armies, { id: armyId, name, unitIds: allIds }]);
      }
    }

    // The final unit objects (new ones plus library ones with the freshly
    // read base size), so the board can lay them out before the library state
    // has caught up with this import.
    const units_ = allIds.map((id) => baseUpdatedLibrary.find((x) => x.id === id) || toAdd.find((x) => x.id === id)).filter(Boolean);
    return { added: toAdd.length, skipped, baseUpdated, armyId, unitIds: allIds, units: units_ };
  };

  const attackerUnit = useMemo(() => library.find((u) => u.id === attackerUnitId) || null, [library, attackerUnitId]);
  const defenderUnit = useMemo(() => library.find((u) => u.id === defenderUnitId) || null, [library, defenderUnitId]);
  const attachedLeader = useMemo(() => library.find((u) => u.id === attachedLeaderId) || null, [library, attachedLeaderId]);

  // Combines the picked attacker unit with an optionally attached leader (e.g. a
  // Captain) for this calculation only — the library entries themselves stay
  // untouched, so the same character can be attached to different squads across
  // different calculations. Also applies any manual weapon-profile choice (e.g.
  // Axe Morkai's Sweep vs Strike) and any "within half range" Melta toggle on top.
  const effectiveAttackerUnit = useMemo(() => {
    if (!attackerUnit) return null;
    let merged = attackerUnit;
    if (attachedLeader) {
      merged = {
        ...attackerUnit,
        name: `${attackerUnit.name} + ${attachedLeader.name}`,
        members: [...attackerUnit.members, ...attachedLeader.members],
      };
    }
    if (
      !attachedLeader &&
      Object.keys(weaponProfileChoice).length === 0 &&
      Object.keys(weaponMeltaActive).length === 0 &&
      Object.keys(weaponRapidFireActive).length === 0
    )
      return merged;
    return {
      ...merged,
      members: merged.members.map((m) => ({
        ...m,
        weapons: m.weapons.map((w) => {
          let next = w;
          if (w.profiles && weaponProfileChoice[w.id] !== undefined) {
            const idx = weaponProfileChoice[w.id];
            const p = w.profiles[idx];
            if (p) next = { ...next, ...p, activeProfileIndex: idx };
          }
          if (next.melta > 0 && weaponMeltaActive[w.id]) {
            next = { ...next, damage: next.damage + next.melta };
          }
          if (next.rapidFire > 0 && weaponRapidFireActive[w.id]) {
            next = { ...next, attacks: next.attacks + next.rapidFire };
          }
          // +1 Attack while a leader is attached (e.g. Crowe → Purifying Flame).
          if (attachedLeader && next.plusAttackWithLeader) {
            next = { ...next, attacks: next.attacks + 1 };
          }
          return next;
        }),
      })),
    };
  }, [attackerUnit, attachedLeader, weaponProfileChoice, weaponMeltaActive, weaponRapidFireActive]);

  const chooseWeaponProfile = (weaponId, index) => {
    setWeaponProfileChoice((s) => ({ ...s, [weaponId]: index }));
  };
  const toggleWeaponMelta = (weaponId) => {
    setWeaponMeltaActive((s) => ({ ...s, [weaponId]: !s[weaponId] }));
  };
  const toggleWeaponRapidFire = (weaponId) => {
    setWeaponRapidFireActive((s) => ({ ...s, [weaponId]: !s[weaponId] }));
  };

  // When a new attacker unit (or attached leader) is picked, reset the quick
  // attack-bonus panel to reflect whatever the combined unit already has built
  // in (so it's pre-checked to match reality) — still tweakable manually after.
  // Skipped while restoring a saved history entry, so it doesn't clobber the
  // bonuses/modifiers that entry actually used.
  const restoringFromHistoryRef = useRef(false);
  // The "Deska" board's DOM node, so token drag can turn pointer coordinates
  // into a percentage position via getBoundingClientRect.
  const boardContainerRef = useRef(null);
  // Click-to-calculate on the board: pick a "mine" token (attacker), then a
  // "theirs" token (target), and see a quick matchup result right there.
  const [boardAttackerTokenId, setBoardAttackerTokenId] = useState(null);
  const [boardMatchup, setBoardMatchup] = useState(null); // { attackerUnit, defenderUnit, res } | null
  // Currently selected terrain piece (for the width/height/rotate controls).
  const [selectedTerrainId, setSelectedTerrainId] = useState(null);
  // Last piece copied with Ctrl/Cmd+C (pasted with Ctrl/Cmd+V) and which
  // corner of the selected piece the numeric X/Y fields position.
  const terrainClipboardRef = useRef(null);
  const [terrainAnchor, setTerrainAnchor] = useState("tl");
  // Delete / Backspace removes the currently selected terrain piece (same as
  // double-clicking it or the panel's "Odebrat"), unless a text field has
  // focus. Reads boardRef so it always sees the current terrain list.
  useEffect(() => {
    if (!selectedTerrainId) return;
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const b = boardRef.current;
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        const src = (b.terrain || []).find((p) => p.id === selectedTerrainId);
        if (k === "c" && src) {
          terrainClipboardRef.current = src;
        } else if ((k === "d" && src) || (k === "v" && terrainClipboardRef.current)) {
          e.preventDefault();
          const base = k === "d" ? src : terrainClipboardRef.current;
          const copy = { ...base, id: crypto.randomUUID(), xPct: Math.min(100, base.xPct + 3), yPct: Math.min(100, base.yPct + 3) };
          persistBoard({ ...b, terrain: [...(b.terrain || []), copy] });
          setSelectedTerrainId(copy.id);
          if (k === "v") terrainClipboardRef.current = copy;
        }
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      e.preventDefault();
      persistBoard({ ...b, terrain: (b.terrain || []).filter((p) => p.id !== selectedTerrainId) });
      setSelectedTerrainId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedTerrainId, persistBoard]);
  const [showBoardGrid, setShowBoardGrid] = useState(true);
  // Terrain (podložky) is locked by default so dragging models around never
  // shoves a plate by accident; the toolbar lock unlocks it for editing. The
  // choice is remembered per browser; adding a piece unlocks for this session.
  const [terrainLocked, setTerrainLocked] = useState(() => {
    try {
      return localStorage.getItem("board_terrain_locked_v1") !== "0";
    } catch (e) {
      return true;
    }
  });
  // Moving whole units / marquee selection of several models on the board.
  const [moveWholeUnit, setMoveWholeUnit] = useState(() => {
    try {
      return localStorage.getItem("board_move_unit_v1") !== "0";
    } catch (e) {
      return true;
    }
  });
  const toggleMoveWholeUnit = () => {
    const next = !moveWholeUnit;
    setMoveWholeUnit(next);
    try {
      localStorage.setItem("board_move_unit_v1", next ? "1" : "0");
    } catch (e) {
      /* storage blocked - the mode still works for this session */
    }
  };
  // View-only rotation (0/90/180/270) and zoom of the board; the data itself
  // never changes, so the saved board looks the same when turned back.
  const [viewRot, setViewRot] = useState(() => {
    try {
      const v = Number(localStorage.getItem("board_view_rot_v1"));
      return [0, 90, 180, 270].includes(v) ? v : 0;
    } catch (e) {
      return 0;
    }
  });
  const rotateBoardView = () => {
    const next = (viewRot + 90) % 360;
    setViewRot(next);
    try {
      localStorage.setItem("board_view_rot_v1", String(next));
    } catch (e) {
      /* storage blocked - the rotation still applies for this session */
    }
  };
  const [boardZoom, setBoardZoom] = useState(1);
  const boardScrollRef = useRef(null);
  const boardSizedRef = useRef(null);
  const zoomAnchorRef = useRef(null);
  // Zoom around a point of the visible area (px relative to the scroll box),
  // so that spot stays under the cursor/centre.
  const zoomBoardTo = (nextZoom, px, py) => {
    const sc = boardScrollRef.current;
    const sized = boardSizedRef.current;
    const z = Math.min(4, Math.max(1, Math.round(nextZoom * 100) / 100));
    if (sc && sized) {
      const rectW = sized.offsetWidth || 1;
      const rectH = sized.offsetHeight || 1;
      const cx = px === undefined ? sc.clientWidth / 2 : px;
      const cy = py === undefined ? sc.clientHeight / 2 : py;
      zoomAnchorRef.current = { fx: (sc.scrollLeft + cx) / rectW, fy: (sc.scrollTop + cy) / rectH, px: cx, py: cy };
    }
    setBoardZoom(z);
  };
  const zoomBoardToRef = useRef(null);
  zoomBoardToRef.current = zoomBoardTo;
  const boardZoomRef = useRef(1);
  boardZoomRef.current = boardZoom;
  useLayoutEffect(() => {
    const a = zoomAnchorRef.current;
    const sc = boardScrollRef.current;
    const sized = boardSizedRef.current;
    if (!a || !sc || !sized) return;
    sc.scrollLeft = a.fx * sized.offsetWidth - a.px;
    sc.scrollTop = a.fy * sized.offsetHeight - a.py;
    zoomAnchorRef.current = null;
  }, [boardZoom, viewRot]);
  const [selectedTokenIds, setSelectedTokenIds] = useState([]);
  const [marquee, setMarquee] = useState(null);
  const marqueeStartRef = useRef(null);
  const dragGroupRef = useRef([]);
  const wheelSaveTimerRef = useRef(null);
  const rotateTokensRef = useRef(null);
  const toggleTerrainLocked = () => {
    const next = !terrainLocked;
    setTerrainLocked(next);
    if (next) setSelectedTerrainId(null);
    try {
      localStorage.setItem("board_terrain_locked_v1", next ? "1" : "0");
    } catch (e) {
      /* storage blocked - the lock still works for this session */
    }
  };
  // Freehand deployment-zone drawing: click points on the board to build a
  // polygon for "mine" or "theirs", overriding that side's swatch shape.
  const [drawMode, setDrawMode] = useState(null); // null | "mine" (only "mine" is ever drawn — "theirs" is always derived)
  const [drawPoints, setDrawPoints] = useState([]); // [{x,y}] as % of board
  // Drag state for painting a zone (press, drag, release) rather than
  // click-per-vertex — doesn't need to be React state since it never drives
  // a render on its own, only the drawPoints it produces do.
  const drawStrokeActiveRef = useRef(false);
  const lastDrawPointRef = useRef(null);
  // Alternative to click/drag drawing: type "my" zone as TWO rectangle
  // corners in inches (reading them off the on-board ruler), no mouse
  // precision needed at all — combined (unioned) into one zone shape, since a
  // real deployment zone is often not a single rectangle. "Zóna protihráče"
  // is always derived from this (see mirrorRectDiagonally), never typed in.
  const [zoneRects, setZoneRects] = useState({
    mine: [
      { x1: 0, y1: 0, x2: 10, y2: 10 },
      { x1: 0, y1: 0, x2: 10, y2: 10 },
    ],
  });
  // Same idea, but for a triangle (3 typed corners) and a circular-sector
  // "pie slice" (center + inner/outer radius + start/end angle) — two more
  // precise shapes to type in beyond a plain rectangle.
  const [triangleShape, setTriangleShape] = useState({ x1: 0, y1: 0, x2: 20, y2: 0, x3: 0, y3: 20 });
  const [sectorShape, setSectorShape] = useState({ cx: 22, cy: 30, rInner: 0, rOuter: 20, angleStart: 0, angleEnd: 90, invert: false });
  // User-saved deployment layouts — there are no built-in ones any more (see
  // DEPLOYMENT_LAYOUTS), so this list (rendered as swatches, see allLayouts
  // below) IS "Rozložení výsadku". Starts out as the 5 numbered placeholder
  // slots from DEFAULT_LAYOUT_SLOTS until real saved data loads (or forever,
  // for an account that never saves any). Each is just captured from
  // whatever "Moje zóna" currently is via activeMineZoneClips, so a "layout"
  // is really this system's own name for a saved zone.
  const [customLayouts, setCustomLayouts] = useState(DEFAULT_LAYOUT_SLOTS);
  const [customLayoutsLoaded, setCustomLayoutsLoaded] = useState(false);
  const [newLayoutName, setNewLayoutName] = useState("");
  const [newMutationName, setNewMutationName] = useState("");
  const allLayouts = useMemo(() => {
    const combined = [...DEPLOYMENT_LAYOUTS, ...customLayouts.map((l) => ({ ...l, theirsClip: mirrorLayoutClip(l.mineClip) }))];
    // Safety net only — every render path assumes allLayouts[0] exists;
    // this only ever matters if someone deletes every single saved layout.
    return combined.length > 0 ? combined : [{ id: "1", name: "1", mineClip: DEFAULT_LAYOUT_CLIP, theirsClip: mirrorClipPathDiagonally(DEFAULT_LAYOUT_CLIP) }];
  }, [customLayouts]);
  const activeCustomLayout = customLayouts.find((l) => l.id === board.layoutId);
  const activeBaseLayoutId = getActiveBaseLayoutId();
  const [newPresetName, setNewPresetName] = useState("");
  const [boardShareOpen, setBoardShareOpen] = useState(false);
  const [customFormOpen, setCustomFormOpen] = useState(false);
  const [customForm, setCustomForm] = useState({ name: "", layer: "terrain", shape: "rect", widthIn: 4, heightIn: 4, color: "#5c5c52", baseMarginIn: 1, baseColor: "#8a8a78" });
  const [newGroupName, setNewGroupName] = useState("");
  const [paramTerrain, setParamTerrain] = useState({ mode: "rect", rectLayer: "terrain", x1: 0, y1: 0, x2: 6, y2: 4, thickness: 1 });
  const [paramTerrainOpen, setParamTerrainOpen] = useState(false);
  // Hand-made map tools (base maps, mutations, zone drawing/typing) are
  // collapsed by default now that whole maps load from the "Mapa" box.
  const [mapToolsOpen, setMapToolsOpen] = useState(false);
  const [mapMissionA, setMapMissionA] = useState(MAP_MISSIONS[0]);
  const [mapMissionB, setMapMissionB] = useState(MAP_MISSIONS[0]);
  const [mapVariantLoaded, setMapVariantLoaded] = useState("");
  const [boardArmySel, setBoardArmySel] = useState({ mine: "", theirs: "" });
  const [boardImportSide, setBoardImportSide] = useState("");
  // Army hub ("Armáda" on the home page): which army is open, and the opponent
  // picked for the matchup / board shortcuts ("" none, "__all" every other army).
  const [armyViewId, setArmyViewId] = useState("");
  const [armyOppId, setArmyOppId] = useState("");
  // Everything below the "Mapa" box (map creation, terrain palette, numeric
  // terrain, custom pieces, saved plinths) sits behind one toggle, closed by default.
  const [boardEditOpen, setBoardEditOpen] = useState(false);

  const handleBoardTokenSelect = (token, e) => {
    if (e && (e.shiftKey || e.ctrlKey || e.metaKey)) {
      setSelectedTokenIds((cur) => (cur.includes(token.id) ? cur.filter((id) => id !== token.id) : [...cur, token.id]));
      return;
    }
    if (selectedTokenIds.length > 0) setSelectedTokenIds([]);
    const unit = library.find((u) => u.id === token.unitId);
    if (!unit) return;
    if (token.side === "mine") {
      setBoardAttackerTokenId((prev) => (prev === token.id ? null : token.id));
      setBoardMatchup(null);
      return;
    }
    // Clicked a "theirs" token — need an attacker already picked.
    if (!boardAttackerTokenId) return;
    const attackerToken = board.tokens.find((t) => t.id === boardAttackerTokenId);
    const attackerUnit = attackerToken && library.find((u) => u.id === attackerToken.unitId);
    if (!attackerUnit) return;
    // Baseline matchup — each unit's own built-in stats/abilities, no extra
    // bonuses or debuffs layered on (same "baseline" convention the cheat
    // sheet uses), since there's no per-matchup modifier UI here.
    const res = computeUnitVsUnit(attackerUnit, defenderProfile(unit), emptyBonus());
    setBoardMatchup({ attackerUnit, defenderUnit: unit, res });
  };

  // If the selected attacker's token gets removed from the board (double
  // click, clear, etc.) drop the dangling selection instead of pointing at
  // nothing.
  rotateTokensRef.current = rotateTokensAt;
  removeSelectedTokensRef.current = removeSelectedTokens;
  useEffect(() => {
    if (view !== "board") return undefined;
    const onKey = (e) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const tag = e.target && e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target && e.target.isContentEditable)) return;
      if (selectedTokenIds.length === 0) return;
      e.preventDefault();
      removeSelectedTokensRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, selectedTokenIds]);
  useEffect(() => {
    const el = boardContainerRef.current;
    if (!el) return undefined;
    let acc = 0;
    let accTimer = null;
    let lastId = null;
    let lastAt = 0;
    const onWheel = (e) => {
      // Ctrl/Cmd + wheel (also a trackpad pinch) zooms the board around the cursor.
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const sc = boardScrollRef.current;
        if (sc) {
          const r = sc.getBoundingClientRect();
          zoomBoardToRef.current(boardZoomRef.current * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - r.left, e.clientY - r.top);
        }
        return;
      }
      const tokEl = e.target.closest ? e.target.closest("[data-token-id]") : null;
      const now = Date.now();
      let id = tokEl ? tokEl.getAttribute("data-token-id") : null;
      // Turning a unit moves its models, so the cursor often ends up beside
      // the model it started on - keep turning that unit for a moment instead
      // of letting the page scroll.
      if (!id && lastId && now - lastAt < 800) id = lastId;
      if (!id) return; // empty board / terrain: let the page scroll as usual
      lastId = id;
      lastAt = now;
      e.preventDefault();
      // A trackpad fires many tiny wheel events: collect them so one notch's
      // worth (~50) turns the unit one step instead of every event doing so.
      acc += e.deltaY;
      clearTimeout(accTimer);
      accTimer = setTimeout(() => {
        acc = 0;
      }, 250);
      if (Math.abs(acc) < 50) return;
      const dir = acc;
      acc = 0;
      rotateTokensRef.current(id, dir, e.altKey, e.shiftKey);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [view]);

  useEffect(() => {
    setSelectedTokenIds((cur) => {
      const alive = cur.filter((id) => board.tokens.some((t) => t.id === id));
      return alive.length === cur.length ? cur : alive;
    });
  }, [board.tokens]);

  useEffect(() => {
    if (boardAttackerTokenId && !board.tokens.some((t) => t.id === boardAttackerTokenId)) {
      setBoardAttackerTokenId(null);
      setBoardMatchup(null);
    }
  }, [board.tokens, boardAttackerTokenId]);

  useEffect(() => {
    if (restoringFromHistoryRef.current) return;
    setAttackerBonus(autoDetectBonus(effectiveAttackerUnit));
  }, [attackerUnitId, attachedLeaderId]);

  useEffect(() => {
    if (restoringFromHistoryRef.current) return;
    setAttachedLeaderId(null);
    setWeaponProfileChoice({});
    setWeaponMeltaActive({});
    setWeaponRapidFireActive({});
  }, [attackerUnitId]);

  useEffect(() => {
    if (restoringFromHistoryRef.current) return;
    setDefenderModelCount(defenderUnit ? totalModels(defenderUnit) : 0);
    const fnp = defenderUnit ? clampNum(defenderUnit.fnp, 0) : 0;
    const debuff = defenderUnit ? !!defenderUnit.woundDebuff : false;
    const dmgReduction = defenderUnit ? clampNum(defenderUnit.damageReduction, 0) : 0;
    setDefenderFnp({ ranged: fnp, melee: fnp });
    setDefenderWoundDebuff({ ranged: debuff, melee: debuff });
    setDefenderDamageReduction({ ranged: dmgReduction, melee: dmgReduction });
    setDefenderSaveReroll({ ranged: "none", melee: "none" });
  }, [defenderUnitId]);

  const result = useMemo(() => {
    if (!effectiveAttackerUnit || !defenderUnit) return null;
    const defByType = {
      ranged: defenderProfile(defenderUnit, {
        models: defenderModelCount,
        fnp: defenderFnp.ranged,
        woundDebuff: defenderWoundDebuff.ranged,
        damageReduction: defenderDamageReduction.ranged,
        toughnessMod: defenderToughnessMod,
        saveMod: defenderSaveMod,
        benefitOfCover: defenderBenefitOfCover,
        saveReroll: defenderSaveReroll.ranged,
      }),
      melee: defenderProfile(defenderUnit, {
        models: defenderModelCount,
        fnp: defenderFnp.melee,
        woundDebuff: defenderWoundDebuff.melee,
        damageReduction: defenderDamageReduction.melee,
        toughnessMod: defenderToughnessMod,
        saveMod: defenderSaveMod,
        saveReroll: defenderSaveReroll.melee,
      }),
    };
    return computeUnitVsUnit(effectiveAttackerUnit, defByType, attackerBonus);
  }, [
    effectiveAttackerUnit,
    defenderUnit,
    attackerBonus,
    defenderModelCount,
    defenderFnp,
    defenderWoundDebuff,
    defenderDamageReduction,
    defenderToughnessMod,
    defenderSaveMod,
    defenderBenefitOfCover,
    defenderSaveReroll,
  ]);

  const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "0");
  // Never display a flat "0.0%" — with dice there is always some (tiny) chance,
  // so round-to-zero values are shown as "<0.1%" instead of implying impossibility.
  const pct = (n) => {
    if (!Number.isFinite(n) || n <= 0) return "<0.1%";
    const v = n * 100;
    return v < 0.1 ? "<0.1%" : `${v.toFixed(1)}%`;
  };

  const cheatMatrix = useMemo(() => {
    const attackers = library.filter((u) => cheatAttackerIds.has(u.id));
    const targets = library.filter((u) => cheatTargetIds.has(u.id));
    return attackers.map((att) => ({
      attacker: att,
      cells: targets.map((tgt) => {
        const tgtModels = totalModels(tgt);

        // Baseline: only whatever the units already have built in (weapon abilities,
        // the defender's own stored FNP / debuff) — no cheat-sheet panel involved.
        const baseRes = computeUnitVsUnit(att, defenderProfile(tgt), ZERO_BONUS);

        // Boosted: same units, plus whatever the cheat-sheet panel adds on top
        // (attacker bonuses merge with each weapon's own abilities; defender FNP/
        // debuff are taken as the better/larger of the unit's own value and the panel's).
        const boostedProfile = {
          ranged: defenderProfile(tgt, {
            fnp: Math.max(clampNum(tgt.fnp, 0), cheatSlotB.ranged.fnp),
            woundDebuff: !!tgt.woundDebuff || cheatSlotB.ranged.woundDebuff,
            damageReduction: Math.max(clampNum(tgt.damageReduction, 0), cheatSlotB.ranged.damageReduction),
            toughnessMod: cheatSlotB.toughnessMod,
            saveMod: cheatSlotB.saveMod,
            benefitOfCover: cheatSlotB.ranged.benefitOfCover,
            saveReroll: cheatSlotB.ranged.saveReroll,
          }),
          melee: defenderProfile(tgt, {
            fnp: Math.max(clampNum(tgt.fnp, 0), cheatSlotB.melee.fnp),
            woundDebuff: !!tgt.woundDebuff || cheatSlotB.melee.woundDebuff,
            damageReduction: Math.max(clampNum(tgt.damageReduction, 0), cheatSlotB.melee.damageReduction),
            toughnessMod: cheatSlotB.toughnessMod,
            saveMod: cheatSlotB.saveMod,
            saveReroll: cheatSlotB.melee.saveReroll,
          }),
        };
        const boostedRes = computeUnitVsUnit(att, boostedProfile, { ranged: cheatSlotA.ranged, melee: cheatSlotA.melee });

        const baseStats = computeSurvivalStats(baseRes, tgt, tgtModels);
        const boostedStats = computeSurvivalStats(boostedRes, tgt, tgtModels);

        return {
          target: tgt,
          base: { res: baseRes, ...baseStats },
          boosted: { res: boostedRes, ...boostedStats },
        };
      }),
    }));
  }, [library, cheatAttackerIds, cheatTargetIds, cheatSlotA, cheatSlotB]);

  const groupedLibrary = useMemo(() => {
    const g = {};
    library.forEach((u) => {
      const f = u.faction || "Bez frakce";
      if (!g[f]) g[f] = [];
      g[f].push(u);
    });
    return g;
  }, [library]);

  // Aggregate the per-weapon breakdown into totals for the Result screen.
  const resultAgg = useMemo(() => {
    if (!result) return null;
    const empty = () => ({ attacks: 0, hits: 0, wounds: 0, through: 0, damage: 0, reductionSaved: 0, fnpSaved: 0 });
    const ranged = empty();
    const melee = empty();
    const total = empty();
    result.breakdown.forEach((b) => {
      const t = b.type === "melee" ? melee : ranged;
      t.attacks += b.detail.attacks;
      t.hits += b.detail.hitsTotal;
      t.wounds += b.detail.woundsTotal;
      t.through += b.detail.through;
      t.damage += b.damage;
      t.reductionSaved += b.detail.reductionSaved || 0;
      t.fnpSaved += b.detail.fnpSaved || 0;
      total.attacks += b.detail.attacks;
      total.hits += b.detail.hitsTotal;
      total.wounds += b.detail.woundsTotal;
      total.through += b.detail.through;
      total.damage += b.damage;
      total.reductionSaved += b.detail.reductionSaved || 0;
      total.fnpSaved += b.detail.fnpSaved || 0;
    });
    return { ranged, melee, total };
  }, [result]);

  const survivalStats = useMemo(
    () => computeSurvivalStats(result, defenderUnit, defenderModelCount),
    [result, defenderUnit, defenderModelCount]
  );
  const chanceAtLeast1 = survivalStats.chanceAtLeast1;
  const chanceDestroyUnit = survivalStats.chanceDestroyUnit;

  const logCalculation = () => {
    if (!result || !effectiveAttackerUnit || !defenderUnit) return;
    const entry = {
      id: crypto.randomUUID(),
      date: new Date().toISOString(),
      attackerName: effectiveAttackerUnit.name,
      defenderName: defenderUnit.name,
      killedModels: result.killedModels,
      totalDamage: result.totalDamage,
      rangedDamage: result.rangedDamage,
      meleeDamage: result.meleeDamage,
      remainingPct: result.remainingPct,
      defenderModelCount,
      agg: resultAgg,
      chanceAtLeast1,
      chanceDestroyUnit,
      // Full state snapshot so this calculation can be reopened and edited later.
      attackerUnitId,
      defenderUnitId,
      attachedLeaderId,
      weaponProfileChoice,
      weaponMeltaActive,
      weaponRapidFireActive,
      attackerBonus,
      defenderFnp,
      defenderWoundDebuff,
      defenderDamageReduction,
      defenderSaveReroll,
    };
    persistHistory([entry, ...history].slice(0, 60));
  };

  // Reopens a saved history entry back into the calculator (Result step) so it
  // can be tweaked further — only works if both units are still in the library.
  const reopenHistoryEntry = (h) => {
    const attExists = library.some((u) => u.id === h.attackerUnitId);
    const defExists = library.some((u) => u.id === h.defenderUnitId);
    if (!attExists || !defExists) return false;
    restoringFromHistoryRef.current = true;
    setAttackerUnitId(h.attackerUnitId);
    setDefenderUnitId(h.defenderUnitId);
    setAttachedLeaderId(h.attachedLeaderId || null);
    setWeaponProfileChoice(h.weaponProfileChoice || {});
    setWeaponMeltaActive(h.weaponMeltaActive || {});
    setWeaponRapidFireActive(h.weaponRapidFireActive || {});
    if (h.attackerBonus) setAttackerBonus(h.attackerBonus);
    if (h.defenderModelCount !== undefined) setDefenderModelCount(h.defenderModelCount);
    if (h.defenderFnp) setDefenderFnp(h.defenderFnp);
    if (h.defenderWoundDebuff) setDefenderWoundDebuff(h.defenderWoundDebuff);
    if (h.defenderDamageReduction) setDefenderDamageReduction(h.defenderDamageReduction);
    if (h.defenderSaveReroll) setDefenderSaveReroll(h.defenderSaveReroll);
    setCalcStep("result");
    setView("calculator");
    // Clear the guard on the next tick, once React has finished processing all
    // the effects triggered by the state changes above.
    setTimeout(() => {
      restoringFromHistoryRef.current = false;
    }, 0);
    return true;
  };

  // Full, uncut plain-text summary of a history entry — for the "Kopírovat" button.
  const historyEntryText = (h) => {
    const lines = [
      `${h.attackerName} → ${h.defenderName}`,
      fmtDate(h.date),
      "",
      `Očekávané zabité modely: ${fmt(h.killedModels)} z ${h.defenderModelCount}`,
      `Celkový damage: ${fmt(h.totalDamage)} (na dálku ${fmt(h.rangedDamage)} · na blízko ${fmt(h.meleeDamage)})`,
      `Zbývá z jednotky: ${pct(h.remainingPct)}`,
      `Šance zabít alespoň 1 model (odhad): ${pct(h.chanceAtLeast1)}`,
      `Šance zničit celou jednotku (odhad): ${pct(h.chanceDestroyUnit)}`,
      `Šance, že jednotka přežije (odhad): ${pct(1 - h.chanceDestroyUnit)}`,
    ];
    if (h.agg) {
      lines.push(
        "",
        "Na dálku:",
        `  Útoky: ${fmt(h.agg.ranged.attacks, 1)}`,
        `  Zásahy: ${fmt(h.agg.ranged.hits, 2)}`,
        `  Zranění: ${fmt(h.agg.ranged.wounds, 2)}`,
        `  Neúspěšné save: ${fmt(h.agg.ranged.through, 2)}`,
        `  Damage: ${fmt(h.agg.ranged.damage, 2)}`,
        "",
        "Na blízko:",
        `  Útoky: ${fmt(h.agg.melee.attacks, 1)}`,
        `  Zásahy: ${fmt(h.agg.melee.hits, 2)}`,
        `  Zranění: ${fmt(h.agg.melee.wounds, 2)}`,
        `  Neúspěšné save: ${fmt(h.agg.melee.through, 2)}`,
        `  Damage: ${fmt(h.agg.melee.damage, 2)}`
      );
    }
    return lines.join("\n");
  };

  const startNewCalculation = () => {
    setAttackerUnitId(null);
    setDefenderUnitId(null);
    setAttackerSearch("");
    setDefenderSearch("");
    setAttackerFilter(null);
    setDefenderFilter(null);
    setDefenderModifiersOpen(false);
    setCalcStep("setup");
    setView("calculator");
  };

  const allWeapons = useMemo(() => {
    const map = new Map();
    library.forEach((u) => {
      u.members.forEach((m) => {
        m.weapons.forEach((w) => {
          const key = `${w.name}|${w.type}|${w.attacks}|${w.hitX}|${w.strength}|${w.ap}|${w.damage}`;
          if (!map.has(key)) map.set(key, { ...w, unitName: u.name });
        });
      });
    });
    return Array.from(map.values());
  }, [library]);

  // Factions + saved armies combined into one pick list for the "vyber frakci/armádu"
  // step. Selecting one narrows the unit list shown afterwards.
  const pickerOptions = useMemo(() => {
    const factions = Object.entries(groupedLibrary).map(([faction, units]) => ({ type: "faction", key: faction, label: faction, count: units.length }));
    const armyOpts = armies.map((a) => ({ type: "army", key: a.id, label: a.name, count: a.unitIds.length }));
    return { factions, armyOpts };
  }, [groupedLibrary, armies]);

  const unitMatchesFilter = (u, filter) => {
    if (!filter) return true;
    if (filter.type === "faction") return (u.faction || "Bez frakce") === filter.key;
    const army = armies.find((a) => a.id === filter.key);
    return army ? army.unitIds.includes(u.id) : true;
  };

  const filteredAttackerList = useMemo(
    () => library.filter((u) => u.name.toLowerCase().includes(attackerSearch.toLowerCase()) && unitMatchesFilter(u, attackerFilter)),
    [library, attackerSearch, attackerFilter, armies]
  );
  const filteredDefenderList = useMemo(
    () => library.filter((u) => u.name.toLowerCase().includes(defenderSearch.toLowerCase()) && unitMatchesFilter(u, defenderFilter)),
    [library, defenderSearch, defenderFilter, armies]
  );
  const filteredLibraryUnits = useMemo(
    () => library.filter((u) => u.name.toLowerCase().includes(librarySearch.toLowerCase())),
    [library, librarySearch]
  );
  const filteredWeapons = useMemo(
    () => allWeapons.filter((w) => w.name.toLowerCase().includes(librarySearch.toLowerCase())),
    [allWeapons, librarySearch]
  );

  const fmtDate = (iso) => {
    const d = new Date(iso);
    const today = new Date();
    const isToday = d.toDateString() === today.toDateString();
    const time = d.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" });
    return isToday ? `Dnes, ${time}` : `${d.toLocaleDateString("cs-CZ")}, ${time}`;
  };

  const tabBtnStyle = (active) => ({
    flex: 1,
    border: "1px solid " + (active ? "var(--accent)" : "var(--field-border)"),
    background: active ? "var(--accent-dim)" : "transparent",
    color: active ? "var(--accent-text)" : "var(--text)",
    borderRadius: 8,
    padding: "8px 0",
    fontSize: 12.5,
    fontWeight: 700,
    cursor: "pointer",
  });
  const dashedBtnStyle = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    border: "1px dashed var(--field-border)",
    background: "transparent",
    color: "var(--text)",
    borderRadius: 8,
    padding: "9px 13px",
    fontSize: 12.5,
    cursor: "pointer",
  };

  return (
    <div
      className={`wh40k-shell${forceCompact ? " wh40k-compact" : ""}${uiTheme === "tactical" ? " wh40k-theme-tactical" : ""}`}
      style={{
        "--bg": "#070c14",
        "--panel": "#0f1826",
        "--field-bg": "#0a121e",
        "--field-border": "#1f3149",
        "--text": "#eaf1fb",
        "--muted": "#7e93ad",
        "--label": "#9cb2c9",
        "--accent": "#2f8fe8",
        "--accent-dim": "#0f2842",
        "--accent-text": "#7cc0ff",
        "--accent-on": "#ffffff",
        "--blue": "#2f8fe8",
        "--blue-dim": "#0f2842",
        "--amber": "#e8a72f",
        "--mono": "'JetBrains Mono', 'Courier New', monospace",
        ...(uiTheme === "tactical" ? TACTICAL_VARS : {}),
        fontFamily: "'Inter', -apple-system, sans-serif",
        background:
          uiTheme === "tactical"
            ? "radial-gradient(ellipse 120% 60% at 50% -10%, #0c2c58 0%, #040b17 58%)"
            : "radial-gradient(ellipse 120% 60% at 50% -10%, #102338 0%, #070c14 55%)",
        color: "var(--text)",
        borderRadius: 18,
        width: 460,
        maxWidth: "100%",
        flexShrink: 0,
        margin: "0 auto",
        transition: "width 0.15s ease",
        border: "1px solid #16233a",
        overflow: "hidden",
        paddingBottom: 68,
        position: "relative",
      }}
    >
      <style>{`
        @media print {
          @page { size: landscape; margin: 10mm; }
          .no-print { display: none !important; }
          .print-area { display: block !important; }
          .wh40k-shell {
            max-width: none !important;
            width: 100% !important;
            margin: 0 !important;
            padding: 0 !important;
            border: none !important;
            border-radius: 0 !important;
            background: #fff !important;
            overflow: visible !important;
          }
          .print-area {
            margin: 0 !important;
            padding: 0 !important;
            border-radius: 0 !important;
            overflow: visible !important;
          }
          .print-area table { table-layout: fixed; width: 100%; font-size: 8px; }
          .print-area tr { break-inside: avoid; }
          .print-area th, .print-area td { overflow-wrap: break-word; word-break: normal; padding: 2px 3px !important; }
          .print-area th:first-child, .print-area td:first-child { width: 110px; }
        }
        @keyframes wh40k-pulse {
          0%, 100% { box-shadow: 0 0 14px rgba(47,143,232,0.5), 0 0 0 rgba(47,143,232,0); }
          50% { box-shadow: 0 0 20px rgba(47,143,232,0.8), 0 0 8px rgba(47,143,232,0.3); }
        }
        .wh40k-glow-icon { animation: wh40k-pulse 3s ease-in-out infinite; }
        .wh40k-card { transition: border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease; }
        .wh40k-card:hover { transform: translateY(-1px); }
        .wh40k-hero-card { position: relative; overflow: hidden; }
        .wh40k-hero-card::before {
          content: "";
          position: absolute;
          inset: -40% -10% auto -10%;
          height: 160%;
          background: radial-gradient(closest-side, rgba(47,143,232,0.18), transparent 70%);
          pointer-events: none;
        }
        .wh40k-btn { transition: filter 0.15s ease, transform 0.1s ease; }
        .wh40k-btn:hover { filter: brightness(1.15); }
        .wh40k-btn:active { transform: scale(0.98); }
        .wh40k-select, .wh40k-input { transition: border-color 0.15s ease, box-shadow 0.15s ease; }
        .wh40k-select:focus, .wh40k-input:focus { outline: none; border-color: var(--accent) !important; box-shadow: 0 0 0 3px rgba(47,143,232,0.25); }

        .wh40k-row { display: grid; gap: 8px; margin-bottom: 8px; min-width: 0; }
        .wh40k-row-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .wh40k-row-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .wh40k-row-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
        .wh40k-grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; min-width: 0; }
        .wh40k-grid-2, .wh40k-row, .wh40k-row * { min-width: 0; }
        @media (max-width: 380px) {
          .wh40k-row-2, .wh40k-row-3, .wh40k-row-4 { grid-template-columns: 1fr; }
        }
        /* Responsive by default — wider viewports (tablet/monitor) get a
           wider shell so grids/tables have room to breathe, instead of
           staying pinned at phone-card width. .wh40k-compact opts back out. */
        @media (min-width: 640px) {
          .wh40k-shell:not(.wh40k-compact) { width: 700px !important; }
        }
        @media (min-width: 900px) {
          .wh40k-shell:not(.wh40k-compact) { width: 940px !important; }
        }
        @media (min-width: 1200px) {
          .wh40k-shell:not(.wh40k-compact) { width: 1200px !important; }
        }
        /* Calculator: attacker and defender "naproti sobě" (facing each
           other) — one column on a phone-width shell, two side by side once
           there's room (matches the 900px breakpoint that also widens the
           shell itself, so both cards get real space to breathe). */
        .wh40k-vs-columns { display: grid; grid-template-columns: 1fr; gap: 12px; min-width: 0; margin-bottom: 12px; }
        @media (min-width: 900px) {
          .wh40k-shell:not(.wh40k-compact) .wh40k-vs-columns { grid-template-columns: 1fr 1fr; gap: 16px; }
        }
        /* Deska: setup controls in a sidebar, board itself in a big canvas
           column beside it — one column (sidebar content flows above the
           canvas) on a phone-width shell, side by side once there's room. */
        .wh40k-board-layout { display: block; }
        .wh40k-board-sidebar { min-width: 0; }
        @media (min-width: 900px) {
          .wh40k-shell:not(.wh40k-compact) .wh40k-board-layout { display: grid; grid-template-columns: 300px 1fr; gap: 16px; align-items: start; }
          .wh40k-shell:not(.wh40k-compact) .wh40k-board-sidebar { max-height: 88vh; overflow-y: auto; padding-right: 4px; }
        }
        * { box-sizing: border-box; }

        /* ---- "Taktický" look ------------------------------------------- */
        .wh40k-theme-tactical { font-family: 'Rajdhani', 'Inter', -apple-system, sans-serif !important; letter-spacing: 0.3px; }
        .wh40k-theme-tactical button, .wh40k-theme-tactical select, .wh40k-theme-tactical input, .wh40k-theme-tactical textarea { font-family: inherit; }
        .wh40k-theme-tactical [style*="background: var(--panel)"] {
          background-image: linear-gradient(180deg, rgba(45,140,255,0.10), rgba(45,140,255,0) 42%) !important;
          box-shadow: 0 0 0 1px rgba(45,140,255,0.26), 0 0 18px rgba(30,110,230,0.14), inset 0 0 22px rgba(20,80,170,0.12) !important;
        }
        .wh40k-theme-tactical .wh40k-btn { box-shadow: inset 0 0 0 1px rgba(110,190,255,0.16); text-shadow: 0 0 8px rgba(80,170,255,0.30); font-weight: 700; }
        .wh40k-theme-tactical button[style*="var(--accent)"] { box-shadow: 0 0 12px rgba(45,140,255,0.32), inset 0 0 10px rgba(45,140,255,0.16) !important; }
        .wh40k-theme-tactical .wh40k-board {
          background-color: #08233c !important;
          border: 2px solid #2a7be0 !important;
          box-shadow: 0 0 0 1px #0b3b73, 0 0 36px rgba(30,120,255,0.30), inset 0 0 60px rgba(0,30,70,0.55) !important;
        }
        .wh40k-theme-tactical .wh40k-board[data-grid="1"] {
          background-image:
            repeating-linear-gradient(to right, rgba(110,200,255,0.20) 0, rgba(110,200,255,0.20) 1px, transparent 1px, transparent 100%),
            repeating-linear-gradient(to bottom, rgba(110,200,255,0.20) 0, rgba(110,200,255,0.20) 1px, transparent 1px, transparent 100%) !important;
        }
        /* a stronger line every 5 inches */
        .wh40k-theme-tactical .wh40k-board[data-grid="1"]::after {
          content: "";
          position: absolute;
          inset: 0;
          pointer-events: none;
          background-image:
            linear-gradient(to right, rgba(140,220,255,0.40) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(140,220,255,0.40) 1px, transparent 1px);
          background-size: calc(500% / var(--bw)) calc(500% / var(--bh));
        }
        .wh40k-theme-tactical [data-board-piece="terrain"]:not([data-bare]):not([data-obj]) {
          background-color: #565e66 !important;
          background-image:
            radial-gradient(circle at 20% 30%, rgba(255,255,255,0.08) 0 2px, transparent 3px),
            radial-gradient(circle at 72% 62%, rgba(0,0,0,0.20) 0 3px, transparent 4px),
            linear-gradient(135deg, rgba(255,255,255,0.10), rgba(0,0,0,0.28)) !important;
          background-size: 13px 13px, 19px 19px, 100% 100% !important;
          border: 1px solid #8c959e !important;
          box-shadow: 0 0 0 1px rgba(0,0,0,0.65), 0 4px 10px rgba(0,0,0,0.6) !important;
        }
        .wh40k-theme-tactical [data-board-piece="token"] {
          background-image:
            linear-gradient(160deg, rgba(255,255,255,0.34), rgba(255,255,255,0) 48%),
            radial-gradient(circle at 50% 125%, rgba(0,0,0,0.40), transparent 62%) !important;
          box-shadow: 0 0 10px rgba(45,140,255,0.55), inset 0 0 0 1px rgba(255,255,255,0.35) !important;
          font-weight: 800;
        }
        .wh40k-theme-tactical [data-board-piece="token"][data-sel] { box-shadow: 0 0 12px 3px rgba(255,255,255,0.6) !important; }
      `}</style>

      {/* TOP BAR */}
      <div className="no-print" style={{ padding: "16px 14px 10px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "relative" }}>
        <button onClick={() => setMenuOpen((o) => !o)} aria-label="Menu" style={{ background: "transparent", border: "none", color: "var(--text)", cursor: "pointer", padding: 6, display: "flex" }}>
          <Menu size={20} />
        </button>
        <button
          onClick={() => {
            setView("home");
            setMenuOpen(false);
            setSettingsOpen(false);
          }}
          style={{ display: "flex", alignItems: "center", gap: 8, background: "transparent", border: "none", cursor: "pointer" }}
        >
          <SkullLogo size={30} />
          <div style={{ textAlign: "left" }}>
            <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: 0.5, color: "var(--text)" }}>BATTLECALC</div>
            <div style={{ fontSize: 8, fontWeight: 700, color: "var(--accent-text)", letterSpacing: 1.2 }}>DAMAGE CALCULATOR</div>
          </div>
        </button>
        <button onClick={() => setSettingsOpen((o) => !o)} aria-label="Nastavení" style={{ background: "transparent", border: "none", color: "var(--text)", cursor: "pointer", padding: 6, display: "flex" }}>
          <Settings size={19} />
        </button>

        {(menuOpen || settingsOpen) && (
          <div
            onClick={() => {
              setMenuOpen(false);
              setSettingsOpen(false);
            }}
            style={{ position: "fixed", inset: 0, zIndex: 25 }}
          />
        )}
        {menuOpen && (
          <div style={{ position: "absolute", top: "100%", left: 10, background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 10, padding: 6, zIndex: 30, minWidth: 200, boxShadow: "0 10px 28px rgba(0,0,0,0.5)" }}>
            {[
              ["Nový výpočet", () => startNewCalculation()],
              ["Knihovna jednotek", () => setView("library")],
              ["Armáda", () => setView("army")],
              ["Moje armády a cheat sheet", () => setView("lists")],
              ["Historie výpočtů", () => setView("history")],
              [isFullscreen ? "Ukončit celou obrazovku" : "Celá obrazovka", () => toggleFullscreen()],
              [forceCompact ? "Automaticky podle displeje" : "Vždy úzké (mobil)", () => toggleForceCompact()],
              ["Návod k použití", () => setView("manual")],
            ].map(([label, fn]) => (
              <button
                key={label}
                onClick={() => {
                  fn();
                  setMenuOpen(false);
                }}
                style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", background: "transparent", border: "none", color: "var(--text)", fontSize: 12.5, padding: "8px 10px", borderRadius: 6, cursor: "pointer" }}
              >
                {label === "Celá obrazovka" || label === "Ukončit celou obrazovku" ? (
                  isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />
                ) : null}
                {label === "Automaticky podle displeje" || label === "Vždy úzké (mobil)" ? <LayoutGrid size={13} /> : null}
                {label === "Návod k použití" ? <HelpCircle size={13} /> : null}
                {label}
              </button>
            ))}
          </div>
        )}
        {settingsOpen && (
          <div style={{ position: "absolute", top: "100%", right: 10, background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 10, padding: 6, zIndex: 30, minWidth: 200, boxShadow: "0 10px 28px rgba(0,0,0,0.5)" }}>
            {session?.user?.email && (
              <div style={{ fontSize: 10.5, color: "var(--muted)", padding: "6px 10px 8px", borderBottom: "1px solid var(--field-border)", marginBottom: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {session.user.email}
              </div>
            )}
            <div style={{ padding: "6px 10px 8px", borderBottom: "1px solid var(--field-border)", marginBottom: 4 }}>
              <div style={{ fontSize: 10.5, color: "var(--muted)", marginBottom: 5, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700 }}>Vzhled</div>
              <div style={{ display: "flex", gap: 6 }}>
                {[
                  ["classic", "Základní"],
                  ["tactical", "Taktický"],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => chooseUiTheme(id)}
                    style={{
                      flex: 1,
                      border: `1px solid ${uiTheme === id ? "var(--accent)" : "var(--field-border)"}`,
                      background: uiTheme === id ? "var(--accent)" : "transparent",
                      color: uiTheme === id ? "#fff" : "var(--text)",
                      borderRadius: 6,
                      padding: "5px 8px",
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <button
              onClick={() => {
                setSettingsOpen(false);
                askConfirm("Opravdu smazat celou knihovnu jednotek? Nelze vrátit zpět.", clearLibrary);
              }}
              style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", background: "transparent", border: "none", color: "#e0857c", fontSize: 12.5, padding: "8px 10px", borderRadius: 6, cursor: "pointer" }}
            >
              <Trash2 size={13} /> Vymazat knihovnu
            </button>
            <button
              onClick={() => {
                setSettingsOpen(false);
                askConfirm("Smazat historii výpočtů?", clearHistory);
              }}
              style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", background: "transparent", border: "none", color: "#e0857c", fontSize: 12.5, padding: "8px 10px", borderRadius: 6, cursor: "pointer" }}
            >
              <Trash2 size={13} /> Vymazat historii
            </button>
            <button
              onClick={() => {
                setSettingsOpen(false);
                askConfirm("Odhlásit se?", () => supabase && supabase.auth.signOut());
              }}
              style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", background: "transparent", border: "none", color: "var(--muted)", fontSize: 12.5, padding: "8px 10px", borderRadius: 6, cursor: "pointer" }}
            >
              <ArrowLeft size={13} /> Odhlásit se
            </button>
          </div>
        )}
      </div>

      {/* HOME */}
      {view === "home" && (
        <div className="no-print" style={{ padding: "4px 14px 16px" }}>
          <button onClick={startNewCalculation} className="wh40k-card wh40k-hero-card wh40k-btn" style={{ width: "100%", textAlign: "left", background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 14, padding: 16, cursor: "pointer", marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", position: "relative" }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.7, textTransform: "uppercase", color: "var(--text)" }}>Nový výpočet</div>
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>Vyber útočníka a obránce</div>
              </div>
              <ChevronRight size={18} color="var(--accent-text)" />
            </div>
            <div
              style={{
                marginTop: 14,
                height: 88,
                borderRadius: 10,
                background: "radial-gradient(circle at 50% 50%, rgba(47,143,232,0.3), transparent 70%), linear-gradient(180deg, #0d1c2e, #0a141f)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-around",
                position: "relative",
                overflow: "hidden",
              }}
            >
              <Sword size={32} color="var(--accent-text)" style={{ opacity: 0.5 }} />
              <Crosshair size={38} color="var(--accent-text)" style={{ filter: "drop-shadow(0 0 8px rgba(47,143,232,0.7))" }} />
              <Shield size={32} color="var(--accent-text)" style={{ opacity: 0.5 }} />
            </div>
          </button>

          <button
            onClick={() => setView("army")}
            className="wh40k-card wh40k-btn"
            style={{ width: "100%", textAlign: "left", background: "var(--panel)", border: "1px solid var(--accent)", borderRadius: 14, padding: "13px 16px", cursor: "pointer", marginBottom: 14, display: "flex", alignItems: "center", gap: 12 }}
          >
            <Shield size={26} color="var(--accent-text)" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.7, textTransform: "uppercase", color: "var(--text)" }}>Armáda</div>
              <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2 }}>Statistiky, souboj proti jiným armádám a herní deska</div>
            </div>
            <div style={{ fontSize: 11, color: "var(--accent-text)", fontFamily: "var(--mono)" }}>{armies.length}×</div>
            <ChevronRight size={18} color="var(--accent-text)" />
          </button>

          <div className="wh40k-grid-2" style={{ marginBottom: 16 }}>
            <TileButton icon={Folder} label="Moje výpočty" value={history.length + " uloženo"} onClick={() => setView("history")} />
            <TileButton
              icon={Star}
              label="Oblíbené"
              value={favoriteUnits.length + " položek"}
              onClick={() => {
                setView("library");
                setLibraryTab("units");
              }}
            />
            <TileButton
              icon={SkullIcon}
              label="Knihovna jednotek"
              value="Procházet jednotky"
              onClick={() => {
                setView("library");
                setLibraryTab("units");
              }}
            />
            <TileButton
              icon={Crosshair}
              label="Knihovna zbraní"
              value="Procházet zbraně"
              onClick={() => {
                setView("library");
                setLibraryTab("weapons");
              }}
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6 }}>Poslední výpočty</div>
            {history.length > 0 && (
              <button onClick={() => setView("history")} style={{ background: "transparent", border: "none", color: "var(--accent-text)", fontSize: 11, cursor: "pointer" }}>
                Zobrazit vše
              </button>
            )}
          </div>
          {!historyLoaded && <div style={{ fontSize: 12, color: "var(--muted)" }}>Načítám…</div>}
          {historyLoaded && history.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--muted)", background: "var(--field-bg)", border: "1px dashed var(--field-border)", borderRadius: 8, padding: "10px 12px" }}>
              Zatím žádné výpočty. Klikni na "Nový výpočet" a vyzkoušej to.
            </div>
          )}
          {history.slice(0, 3).map((h) => (
            <div
              key={h.id}
              onClick={() => {
                setExpandedHistoryId(h.id);
                setView("history");
              }}
              role="button"
              tabIndex={0}
              className="wh40k-btn"
              style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 8, padding: "9px 10px", marginBottom: 6, cursor: "pointer" }}
            >
              <Swords size={15} color="var(--accent-text)" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {h.attackerName} vs {h.defenderName}
                </div>
                <div style={{ fontSize: 10.5, color: "var(--muted)" }}>{fmtDate(h.date)}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--accent-text)", fontFamily: "var(--mono)" }}>{fmt(h.killedModels)}</div>
                <div style={{ fontSize: 9, color: "var(--muted)" }}>modelů</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ARMY HUB */}
      {view === "army" && (() => {
        const army = armies.find((a) => a.id === armyViewId) || armies[0] || null;
        const unitsOf = (a) => (a ? a.unitIds.map((id) => library.find((u) => u.id === id)).filter(Boolean) : []);
        const myUnits = unitsOf(army);
        const others = armies.filter((a) => !army || a.id !== army.id);
        const opp = armyOppId === "__all" ? null : others.find((a) => a.id === armyOppId) || null;
        const oppUnitIds =
          armyOppId === "__all" ? others.flatMap((a) => a.unitIds) : opp ? opp.unitIds : [];
        const modelsOf = (u) => (u.modelCount > 0 ? u.modelCount : Math.max(1, totalModels(u)));
        const REF_TARGETS = [
          { label: "Pěchota", sub: "T4 3+ 2W ×10", unit: { toughness: 4, save: 3, invul: 0, wounds: 2, fnp: 0 }, models: 10 },
          { label: "Elita", sub: "T5 2+ 3W 4++ ×5", unit: { toughness: 5, save: 2, invul: 4, wounds: 3, fnp: 0 }, models: 5 },
          { label: "Tank", sub: "T10 3+ 12W ×1", unit: { toughness: 10, save: 3, invul: 0, wounds: 12, fnp: 0 }, models: 1 },
        ];
        // group duplicates (3x the same unit listed -> one row, x3)
        const rows = [];
        const rowById = new Map();
        myUnits.forEach((u) => {
          if (rowById.has(u.id)) {
            rowById.get(u.id).n += 1;
            return;
          }
          const dmg = REF_TARGETS.map((t) => {
            try {
              return computeUnitVsUnit(u, defenderProfile(t.unit, { models: t.models }), emptyBonus()).totalDamage || 0;
            } catch (e) {
              return 0;
            }
          });
          const row = { u, n: 1, models: modelsOf(u), pts: parseInt(u.points, 10) || 0, dmg };
          rowById.set(u.id, row);
          rows.push(row);
        });
        const tot = rows.reduce(
          (acc, r) => {
            acc.units += r.n;
            acc.models += r.n * r.models;
            acc.pts += r.n * r.pts;
            acc.wounds += r.n * r.models * (Number(r.u.wounds) || 1);
            acc.tw += r.n * r.models * (Number(r.u.toughness) || 0);
            r.dmg.forEach((d, i) => {
              acc.dmg[i] += r.n * d;
            });
            if (r.u.keywords?.vehicle) acc.vehicle += r.n;
            if (r.u.keywords?.monster) acc.monster += r.n;
            if (r.u.keywords?.character) acc.character += r.n;
            return acc;
          },
          { units: 0, models: 0, pts: 0, wounds: 0, tw: 0, dmg: REF_TARGETS.map(() => 0), vehicle: 0, monster: 0, character: 0 }
        );
        const factions = Array.from(new Set(myUnits.map((u) => u.faction).filter(Boolean)));
        const cardBtn = { display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", background: "var(--panel)", border: "1px solid var(--accent)", borderRadius: 12, padding: "12px 14px", cursor: "pointer", color: "var(--text)", marginBottom: 8 };
        const th = { textAlign: "right", fontSize: 9.5, color: "var(--muted)", fontWeight: 700, padding: "3px 5px", whiteSpace: "nowrap" };
        const td = { textAlign: "right", fontSize: 11.5, padding: "3px 5px", fontFamily: "var(--mono)", whiteSpace: "nowrap" };
        return (
          <div className="no-print" style={{ padding: "4px 14px 16px" }}>
            <button
              onClick={() => setView("home")}
              style={{ display: "flex", alignItems: "center", gap: 5, background: "transparent", border: "none", color: "var(--muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, cursor: "pointer", padding: 0, marginBottom: 12 }}
            >
              <ArrowLeft size={13} /> Armáda
            </button>

            {armies.length === 0 && (
              <div style={{ fontSize: 12.5, color: "var(--muted)", background: "var(--field-bg)", border: "1px dashed var(--field-border)", borderRadius: 8, padding: "12px 14px" }}>
                Zatím nemáš žádnou uloženou armádu. Nahraj ji v Knihovně (Nahrát novou armádu z New Recruit), nebo ji ulož v „Moje armády“.
                <div style={{ marginTop: 8 }}>
                  <button onClick={() => setView("library")} style={{ border: "1px solid var(--accent)", background: "transparent", color: "var(--accent-text)", borderRadius: 6, padding: "5px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                    Otevřít knihovnu
                  </button>
                </div>
              </div>
            )}

            {army && (
              <>
                <select
                  value={army.id}
                  onChange={(e) => {
                    setArmyViewId(e.target.value);
                    setArmyOppId("");
                  }}
                  className="wh40k-select"
                  style={{ width: "100%", background: "var(--field-bg)", color: "var(--text)", border: "1px solid var(--field-border)", borderRadius: 8, padding: "9px 10px", fontSize: 14, fontWeight: 700, marginBottom: 6 }}
                >
                  {armies.map((a) => (
                    <option key={a.id} value={a.id}>{a.name} ({a.unitIds.length})</option>
                  ))}
                </select>
                <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 12 }}>
                  {factions.join(", ") || "bez frakce"} · {tot.units} jednotek · {tot.models} modelů · {tot.pts} bodů
                </div>

                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>Statistiky</div>
                <div style={{ background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 10, padding: 10, marginBottom: 14 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, marginBottom: 10 }}>
                    {[
                      ["Body", tot.pts],
                      ["Modely", tot.models],
                      ["Celkem ran", fmt(tot.wounds)],
                      ["Prům. T", tot.models ? fmt(tot.tw / tot.models) : "-"],
                      ["Vozidla / monstra", `${tot.vehicle} / ${tot.monster}`],
                      ["Postavy", tot.character],
                    ].map(([k, v]) => (
                      <div key={k} style={{ background: "var(--field-bg)", borderRadius: 8, padding: "6px 8px" }}>
                        <div style={{ fontSize: 9.5, color: "var(--muted)", fontWeight: 700, textTransform: "uppercase" }}>{k}</div>
                        <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "var(--mono)", color: "var(--accent-text)" }}>{v}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 9.5, color: "var(--muted)", fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>
                    Očekávaný damage armády (základ, bez bonusů, vše střelba + souboj dohromady)
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, marginBottom: 10 }}>
                    {REF_TARGETS.map((t, i) => (
                      <div key={t.label} style={{ background: "var(--field-bg)", borderRadius: 8, padding: "6px 8px" }}>
                        <div style={{ fontSize: 9.5, color: "var(--muted)", fontWeight: 700 }}>{t.label} <span style={{ fontWeight: 400 }}>{t.sub}</span></div>
                        <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "var(--mono)", color: "var(--text)" }}>{fmt(tot.dmg[i])}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ borderCollapse: "collapse", width: "100%" }}>
                      <thead>
                        <tr>
                          <th style={{ ...th, textAlign: "left" }}>Jednotka</th>
                          <th style={th}>Mod.</th>
                          <th style={th}>Body</th>
                          <th style={th}>T</th>
                          <th style={th}>Sv</th>
                          <th style={th}>W</th>
                          {REF_TARGETS.map((t) => (
                            <th key={t.label} style={th}>{t.label}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.u.id} style={{ borderTop: "1px solid var(--field-border)" }}>
                            <td style={{ ...td, textAlign: "left", fontFamily: "inherit", whiteSpace: "normal" }}>
                              {r.n > 1 ? `${r.n}× ` : ""}
                              {r.u.name}
                            </td>
                            <td style={td}>{r.models}</td>
                            <td style={td}>{r.pts || "-"}</td>
                            <td style={td}>{r.u.toughness}</td>
                            <td style={td}>{r.u.save}+</td>
                            <td style={td}>{r.u.wounds}</td>
                            {r.dmg.map((d, i) => (
                              <td key={i} style={td}>{fmt(d)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>Proti jiným armádám</div>
                <select
                  value={armyOppId}
                  onChange={(e) => setArmyOppId(e.target.value)}
                  className="wh40k-select"
                  disabled={others.length === 0}
                  style={{ width: "100%", background: "var(--field-bg)", color: "var(--text)", border: "1px solid var(--field-border)", borderRadius: 8, padding: "8px 10px", fontSize: 13, marginBottom: 8 }}
                >
                  <option value="">{others.length === 0 ? "Žádná další armáda zatím není" : "Vyber soupeře…"}</option>
                  {others.length > 1 && <option value="__all">Všechny ostatní armády</option>}
                  {others.map((a) => (
                    <option key={a.id} value={a.id}>{a.name} ({a.unitIds.length})</option>
                  ))}
                </select>
                <button
                  className="wh40k-btn"
                  onClick={() => {
                    setCheatAttackerIds(new Set(army.unitIds));
                    setCheatTargetIds(new Set(oppUnitIds));
                    setView("lists");
                  }}
                  style={cardBtn}
                >
                  <Swords size={20} color="var(--accent-text)" />
                  <span style={{ flex: 1 }}>
                    <span style={{ display: "block", fontWeight: 800, fontSize: 13 }}>{oppUnitIds.length ? "Spočítat souboj (cheat sheet)" : "Otevřít cheat sheet s touto armádou"}</span>
                    <span style={{ display: "block", fontSize: 11, color: "var(--muted)" }}>
                      {oppUnitIds.length ? `${army.name} jako útočník proti ${armyOppId === "__all" ? "všem ostatním" : opp?.name}` : "Vybere ji jako útočníka, soupeře doplníš tam"}
                    </span>
                  </span>
                  <ChevronRight size={16} color="var(--accent-text)" />
                </button>

                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6, margin: "14px 0 8px" }}>Herní deska</div>
                <button
                  className="wh40k-btn"
                  onClick={() => {
                    setBoardArmySel((st) => ({ ...st, mine: army.id, ...(opp ? { theirs: opp.id } : {}) }));
                    setView("board");
                  }}
                  style={cardBtn}
                >
                  <MapIcon size={20} color="var(--accent-text)" />
                  <span style={{ flex: 1 }}>
                    <span style={{ display: "block", fontWeight: 800, fontSize: 13 }}>Otevřít herní desku</span>
                    <span style={{ display: "block", fontSize: 11, color: "var(--muted)" }}>Armáda bude vybraná v „Moje jednotky“{opp ? ", soupeř u protihráče" : ""}</span>
                  </span>
                  <ChevronRight size={16} color="var(--accent-text)" />
                </button>
                <button
                  className="wh40k-btn"
                  onClick={() => {
                    setBoardArmySel((st) => ({ ...st, mine: army.id, ...(opp ? { theirs: opp.id } : {}) }));
                    addTwoArmiesToBoard(army.unitIds, opp ? opp.unitIds : []);
                    setView("board");
                  }}
                  style={cardBtn}
                >
                  <Plus size={20} color="var(--accent-text)" />
                  <span style={{ flex: 1 }}>
                    <span style={{ display: "block", fontWeight: 800, fontSize: 13 }}>Rovnou rozmístit na desku</span>
                    <span style={{ display: "block", fontSize: 11, color: "var(--muted)" }}>
                      {opp ? "Obě armády se dají na své strany desky (po jednom tokenu na model)" : "Tvoje armáda se dá na desku (po jednom tokenu na model)"}
                    </span>
                  </span>
                  <ChevronRight size={16} color="var(--accent-text)" />
                </button>
              </>
            )}
          </div>
        );
      })()}

      {/* CALCULATOR */}
      {view === "calculator" && (
        <div className="no-print" style={{ padding: "4px 14px 16px" }}>
          {calcStep === "setup" && (
            <div style={{ marginTop: 6 }}>
              <button
                onClick={() => setView("home")}
                style={{ display: "flex", alignItems: "center", gap: 5, background: "transparent", border: "none", color: "var(--muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, cursor: "pointer", padding: 0, marginBottom: 12 }}
              >
                <ArrowLeft size={13} /> Kalkulačka
              </button>

              <button
                onClick={() => {
                  logCalculation();
                  setCalcStep("result");
                }}
                disabled={!attackerUnit || !defenderUnit}
                className="wh40k-btn"
                style={{
                  width: "100%",
                  marginBottom: 14,
                  border: "none",
                  background: attackerUnit && defenderUnit ? "var(--accent)" : "var(--field-border)",
                  color: attackerUnit && defenderUnit ? "#fff" : "var(--muted)",
                  borderRadius: 8,
                  padding: 13,
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: attackerUnit && defenderUnit ? "pointer" : "not-allowed",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                }}
              >
                <Crosshair size={16} /> Spočítat
              </button>

              {/* ÚTOČNÍK a OBRÁNCE naproti sobě — jeden sloupec na mobilu, dva na širším displeji. */}
              <div className="wh40k-vs-columns">
                {/* ÚTOČNÍK */}
                <div style={{ background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 12, padding: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                    <Crosshair size={13} color="#a9c6e5" />
                    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6 }}>Útočník</div>
                  </div>

                  {!attackerUnit ? (
                    !attackerFilter ? (
                      <>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>Vyber frakci nebo armádu</div>
                        {library.length === 0 && (
                          <div style={{ fontSize: 12.5, color: "var(--muted)", background: "var(--field-bg)", border: "1px dashed var(--field-border)", borderRadius: 8, padding: 12 }}>
                            Knihovna je prázdná. Přidej jednotky v sekci Knihovna v menu.
                          </div>
                        )}
                        {pickerOptions.armyOpts.length > 0 && (
                          <>
                            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--amber)", textTransform: "uppercase", marginBottom: 4 }}>Moje armády</div>
                            {pickerOptions.armyOpts.map((o) => (
                              <PickerRow key={o.type + o.key} icon={Folder} label={o.label} count={o.count} onClick={() => setAttackerFilter(o)} />
                            ))}
                            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--amber)", textTransform: "uppercase", margin: "10px 0 4px" }}>Frakce</div>
                          </>
                        )}
                        {pickerOptions.factions.map((o) => (
                          <PickerRow key={o.type + o.key} icon={SkullIcon} label={o.label} count={o.count} onClick={() => setAttackerFilter(o)} />
                        ))}
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => {
                            setAttackerFilter(null);
                            setAttackerSearch("");
                          }}
                          style={{ display: "flex", alignItems: "center", gap: 5, background: "transparent", border: "none", color: "var(--accent-text)", fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0, marginBottom: 10 }}
                        >
                          <ArrowLeft size={12} /> {attackerFilter.label}
                        </button>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>Vyber jednotku útočníka</div>
                        <SearchBox value={attackerSearch} onChange={setAttackerSearch} placeholder="Hledat jednotky…" />
                        {filteredAttackerList.length === 0 && (
                          <div style={{ fontSize: 12.5, color: "var(--muted)", background: "var(--field-bg)", border: "1px dashed var(--field-border)", borderRadius: 8, padding: 12 }}>
                            Nic tu neodpovídá hledání.
                          </div>
                        )}
                        <div style={{ maxHeight: 360, overflowY: "auto" }}>
                          {filteredAttackerList.map((u) => (
                            <UnitListRow key={u.id} u={u} selected={u.id === attackerUnitId} onClick={() => setAttackerUnitId(u.id)} />
                          ))}
                        </div>
                      </>
                    )
                  ) : (
                    <>
                      <button
                        onClick={() => setAttackerUnitId(null)}
                        style={{ display: "flex", alignItems: "center", gap: 5, background: "transparent", border: "none", color: "var(--accent-text)", fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0, marginBottom: 10 }}
                      >
                        <ArrowLeft size={12} /> Změnit jednotku
                      </button>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <SkullLogo size={26} />
                        <div style={{ fontWeight: 700, fontSize: 13.5 }}>{attackerUnit.name}</div>
                      </div>
                      <label style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 12 }}>
                        <span style={{ fontSize: 11.5, color: "var(--label)", fontWeight: 600 }}>Připojit vůdce (volitelné)</span>
                        <select
                          value={attachedLeaderId || ""}
                          onChange={(e) => setAttachedLeaderId(e.target.value || null)}
                          className="wh40k-select"
                          style={{ background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 6, color: "var(--text)", padding: "7px 9px", fontSize: 13 }}
                        >
                          <option value="">— žádný —</option>
                          {library
                            .filter((u) => u.id !== attackerUnitId && u.isLeader && (u.faction || "Bez frakce") === (attackerUnit.faction || "Bez frakce"))
                            .filter((u, idx, arr) => arr.findIndex((x) => unitSignature(x) === unitSignature(u)) === idx)
                            .map((u) => (
                              <option key={u.id} value={u.id}>
                                {u.name}
                              </option>
                            ))}
                        </select>
                      </label>
                      <div style={{ marginTop: 8, background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 8, padding: 10 }}>
                        <div style={{ fontSize: 10.5, fontWeight: 700, color: "#a9c6e5", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8, display: "flex", alignItems: "center", gap: 5 }}>
                          <Crosshair size={12} /> Bonusy na dálku
                        </div>
                        <BonusFieldsGroup
                          bonus={attackerBonus.ranged}
                          setBonus={(updater) => setAttackerBonus((s) => ({ ...s, ranged: typeof updater === "function" ? updater(s.ranged) : updater }))}
                          isRanged
                        />
                      </div>
                      <div style={{ marginTop: 8, background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 8, padding: 10 }}>
                        <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--accent-text)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8, display: "flex", alignItems: "center", gap: 5 }}>
                          <Sword size={12} /> Bonusy na blízko
                        </div>
                        <BonusFieldsGroup
                          bonus={attackerBonus.melee}
                          setBonus={(updater) => setAttackerBonus((s) => ({ ...s, melee: typeof updater === "function" ? updater(s.melee) : updater }))}
                        />
                      </div>
                      <UnitComposition
                        unit={effectiveAttackerUnit}
                        profileChoices={weaponProfileChoice}
                        onChooseProfile={chooseWeaponProfile}
                        meltaActive={weaponMeltaActive}
                        onToggleMelta={toggleWeaponMelta}
                        rapidFireActive={weaponRapidFireActive}
                        onToggleRapidFire={toggleWeaponRapidFire}
                      />
                    </>
                  )}
                </div>

                {/* OBRÁNCE */}
                <div style={{ background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 12, padding: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                    <SkullIcon size={13} color="var(--amber)" />
                    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6 }}>Obránce</div>
                  </div>

                  {!defenderUnit ? (
                    !defenderFilter ? (
                      <>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>Vyber frakci nebo armádu</div>
                        {pickerOptions.armyOpts.length > 0 && (
                          <>
                            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--amber)", textTransform: "uppercase", marginBottom: 4 }}>Moje armády</div>
                            {pickerOptions.armyOpts.map((o) => (
                              <PickerRow key={o.type + o.key} icon={Folder} label={o.label} count={o.count} onClick={() => setDefenderFilter(o)} />
                            ))}
                            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--amber)", textTransform: "uppercase", margin: "10px 0 4px" }}>Frakce</div>
                          </>
                        )}
                        {pickerOptions.factions.map((o) => (
                          <PickerRow key={o.type + o.key} icon={SkullIcon} label={o.label} count={o.count} onClick={() => setDefenderFilter(o)} />
                        ))}
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => {
                            setDefenderFilter(null);
                            setDefenderSearch("");
                          }}
                          style={{ display: "flex", alignItems: "center", gap: 5, background: "transparent", border: "none", color: "var(--accent-text)", fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0, marginBottom: 10 }}
                        >
                          <ArrowLeft size={12} /> {defenderFilter.label}
                        </button>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>Vyber jednotku obránce</div>
                        <SearchBox value={defenderSearch} onChange={setDefenderSearch} placeholder="Hledat jednotky…" />
                        {filteredDefenderList.length === 0 && (
                          <div style={{ fontSize: 12.5, color: "var(--muted)", background: "var(--field-bg)", border: "1px dashed var(--field-border)", borderRadius: 8, padding: 12 }}>
                            Nic tu neodpovídá hledání.
                          </div>
                        )}
                        <div style={{ maxHeight: 360, overflowY: "auto" }}>
                          {filteredDefenderList.map((u) => (
                            <UnitListRow key={u.id} u={u} selected={u.id === defenderUnitId} onClick={() => setDefenderUnitId(u.id)} />
                          ))}
                        </div>
                      </>
                    )
                  ) : (
                    <>
                      <button
                        onClick={() => setDefenderUnitId(null)}
                        style={{ display: "flex", alignItems: "center", gap: 5, background: "transparent", border: "none", color: "var(--accent-text)", fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0, marginBottom: 10 }}
                      >
                        <ArrowLeft size={12} /> Změnit jednotku
                      </button>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                        <SkullLogo size={26} />
                        <div style={{ fontWeight: 700, fontSize: 13.5 }}>{defenderUnit.name}</div>
                      </div>
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
                        <StatChip label="Toughness" value={defenderUnit.toughness} />
                        <StatChip label="Save" value={defenderUnit.save + "+"} />
                        <StatChip label="Invuln." value={defenderUnit.invul > 0 ? defenderUnit.invul + "+" : "—"} />
                        <StatChip label="Wounds" value={defenderUnit.wounds} />
                      </div>
                      <button
                        onClick={() => setDefenderModifiersOpen((o) => !o)}
                        style={{ display: "flex", alignItems: "center", gap: 4, background: "transparent", border: "none", color: "var(--accent-text)", fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0, textTransform: "uppercase", letterSpacing: 0.4 }}
                      >
                        <Plus size={12} /> Modifikátory (volitelné)
                        <ChevronDown size={12} style={{ transform: defenderModifiersOpen ? "rotate(180deg)" : "none" }} />
                      </button>
                      {defenderModifiersOpen && (
                        <div style={{ marginTop: 10 }}>
                          <NumberField label="Počet modelů v jednotce" value={defenderModelCount} onChange={(v) => setDefenderModelCount(Math.max(0, v))} min={0} small />
                          <Row cols={2}>
                            <NumberField
                              label="Toughness (Nurglovy dary)"
                              value={defenderToughnessMod}
                              onChange={(v) => setDefenderToughnessMod(v)}
                              hint="zadej -1 pro zhoršení; pro obě strany"
                              small
                            />
                            <NumberField
                              label="Save (Nurglovy dary)"
                              value={defenderSaveMod}
                              onChange={(v) => setDefenderSaveMod(v)}
                              hint="zadej -1 pro zhoršení; pro obě strany"
                              small
                            />
                          </Row>
                          <div style={{ marginTop: 8, background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 8, padding: 8 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: "#a9c6e5", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6, display: "flex", alignItems: "center", gap: 4 }}>
                              <Crosshair size={11} /> Proti útokům na dálku
                            </div>
                            <Row cols={4}>
                              <NumberField
                                label="FNP (0 = žádný)"
                                value={defenderFnp.ranged}
                                onChange={(v) => setDefenderFnp((s) => ({ ...s, ranged: Math.max(0, v) }))}
                                min={0}
                                small
                              />
                              <NumberField
                                label="Redukce dmg (0 = žádná)"
                                value={defenderDamageReduction.ranged}
                                onChange={(v) => setDefenderDamageReduction((s) => ({ ...s, ranged: Math.max(0, v) }))}
                                min={0}
                                small
                              />
                              <ToggleField
                                label="Debuff: -1 WR pokud S > T"
                                value={defenderWoundDebuff.ranged}
                                onChange={(v) => setDefenderWoundDebuff((s) => ({ ...s, ranged: v }))}
                                small
                              />
                              <ToggleField
                                label="Benefit of Cover (-1 BS)"
                                value={defenderBenefitOfCover}
                                onChange={setDefenderBenefitOfCover}
                                hint="jen proti útokům na dálku"
                                small
                              />
                              <SelectField
                                label="Přehoz save hodu"
                                value={defenderSaveReroll.ranged}
                                onChange={(v) => setDefenderSaveReroll((s) => ({ ...s, ranged: v }))}
                                options={REROLL_OPTIONS}
                                small
                              />
                            </Row>
                          </div>
                          <div style={{ marginTop: 8, background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 8, padding: 8 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--accent-text)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6, display: "flex", alignItems: "center", gap: 4 }}>
                              <Sword size={11} /> Proti útokům na blízko
                            </div>
                            <Row cols={4}>
                              <NumberField
                                label="FNP (0 = žádný)"
                                value={defenderFnp.melee}
                                onChange={(v) => setDefenderFnp((s) => ({ ...s, melee: Math.max(0, v) }))}
                                min={0}
                                small
                              />
                              <NumberField
                                label="Redukce dmg (0 = žádná)"
                                value={defenderDamageReduction.melee}
                                onChange={(v) => setDefenderDamageReduction((s) => ({ ...s, melee: Math.max(0, v) }))}
                                min={0}
                                small
                              />
                              <ToggleField
                                label="Debuff: -1 WR pokud S > T"
                                value={defenderWoundDebuff.melee}
                                onChange={(v) => setDefenderWoundDebuff((s) => ({ ...s, melee: v }))}
                                small
                              />
                              <SelectField
                                label="Přehoz save hodu"
                                value={defenderSaveReroll.melee}
                                onChange={(v) => setDefenderSaveReroll((s) => ({ ...s, melee: v }))}
                                options={REROLL_OPTIONS}
                                small
                              />
                            </Row>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {calcStep === "result" && result && (
            <div style={{ marginTop: 2 }}>
              <button
                onClick={() => setCalcStep("setup")}
                style={{ display: "flex", alignItems: "center", gap: 5, background: "transparent", border: "none", color: "var(--muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, cursor: "pointer", padding: 0, marginBottom: 12 }}
              >
                <ArrowLeft size={13} /> Kalkulačka
              </button>

              <div
                className="wh40k-hero-card"
                style={{ background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 14, padding: "18px 18px", boxShadow: "0 0 0 1px rgba(47,143,232,0.12), 0 8px 24px rgba(0,0,0,0.25)" }}
              >
                <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--accent-text)", textTransform: "uppercase", letterSpacing: 0.9, marginBottom: 4, position: "relative" }}>Výsledek</div>
                <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12, position: "relative" }}>
                  {effectiveAttackerUnit.name} → {defenderUnit.name}
                </div>

                <div style={{ fontSize: 11, color: "var(--muted)", position: "relative" }}>Očekávané zabité modely</div>
                <div
                  style={{
                    fontSize: 40,
                    fontWeight: 800,
                    fontFamily: "var(--mono)",
                    lineHeight: 1.15,
                    position: "relative",
                    backgroundImage: "linear-gradient(135deg, #bfe3ff, #2f8fe8 60%, #1b5faa)",
                    WebkitBackgroundClip: "text",
                    backgroundClip: "text",
                    color: "transparent",
                    filter: "drop-shadow(0 0 16px rgba(47,143,232,0.4))",
                  }}
                >
                  {fmt(result.killedModels)}
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: -2, position: "relative" }}>
                  z {defenderModelCount} modelů{" "}
                  <span style={{ opacity: 0.75 }}>
                    (průměr přes více her; jistě padne {Math.floor(result.killedModels)})
                  </span>
                </div>
                <SkullRow killed={result.killedModels} total={defenderModelCount} />
                {defenderModelCount <= 1 && (
                  <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 4 }}>podíl zdraví tohoto modelu spotřebovaný útokem</div>
                )}

                <div className="wh40k-row wh40k-row-2" style={{ marginTop: 16, marginBottom: 0 }}>
                  <div style={{ background: "var(--field-bg)", borderRadius: 10, padding: "10px 12px" }}>
                    <div style={{ fontSize: 9.5, color: "var(--muted)", marginBottom: 3, textTransform: "uppercase" }}>Průměrné poškození</div>
                    <div style={{ fontSize: 17, fontWeight: 700, fontFamily: "var(--mono)" }}>{fmt(result.totalDamage)}</div>
                  </div>
                  <div style={{ background: "var(--field-bg)", borderRadius: 10, padding: "10px 12px" }}>
                    <div style={{ fontSize: 9.5, color: "var(--muted)", marginBottom: 3, textTransform: "uppercase" }}>Zbývá z jednotky</div>
                    <div style={{ fontSize: 17, fontWeight: 700, fontFamily: "var(--mono)" }}>{pct(result.remainingPct)}</div>
                  </div>
                </div>

                <div style={{ marginTop: 12, fontSize: 11.5, position: "relative" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderTop: "1px solid var(--field-border)" }}>
                    <span style={{ color: "var(--muted)" }}>
                      Šance zabít alespoň 1 model <i style={{ opacity: 0.65 }}>(odhad)</i>
                    </span>
                    <b>{pct(chanceAtLeast1)}</b>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderTop: "1px solid var(--field-border)" }}>
                    <span style={{ color: "var(--muted)" }}>
                      Šance zničit celou jednotku <i style={{ opacity: 0.65 }}>(odhad)</i>
                    </span>
                    <b>{pct(chanceDestroyUnit)}</b>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderTop: "1px solid var(--field-border)" }}>
                    <span style={{ color: "var(--muted)" }}>
                      Šance, že jednotka přežije (aspoň 1 model) <i style={{ opacity: 0.65 }}>(odhad)</i>
                    </span>
                    <b style={{ color: "var(--accent-text)" }}>{pct(1 - chanceDestroyUnit)}</b>
                  </div>
                </div>
              </div>

              {resultAgg &&
                (defenderFnp.ranged > 0 ||
                  defenderFnp.melee > 0 ||
                  defenderDamageReduction.ranged > 0 ||
                  defenderDamageReduction.melee > 0 ||
                  resultAgg.ranged.fnpSaved > 0 ||
                  resultAgg.melee.fnpSaved > 0) && (
                <div style={{ background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 12, padding: 14, marginTop: 12 }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>
                    Odečteno obranou obránce
                  </div>
                  {(defenderFnp.ranged > 0 || defenderDamageReduction.ranged > 0 || resultAgg.ranged.fnpSaved > 0) && (
                    <div style={{ marginBottom: 6 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#a9c6e5", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2, display: "flex", alignItems: "center", gap: 4 }}>
                        <Crosshair size={11} /> Na dálku
                      </div>
                      {resultAgg.ranged.fnpSaved > 0 && (
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "2px 0" }}>
                          <span style={{ color: "var(--muted)" }}>
                            FNP zachránilo{defenderUnit.psychicFnp > 0 ? " (vč. FNP proti Psychic)" : ""}
                          </span>
                          <span style={{ fontFamily: "var(--mono)", fontWeight: 700 }}>{fmt(resultAgg.ranged.fnpSaved, 2)} dmg</span>
                        </div>
                      )}
                      {defenderDamageReduction.ranged > 0 && (
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "2px 0" }}>
                          <span style={{ color: "var(--muted)" }}>Redukce -{defenderDamageReduction.ranged} Dmg ubrala</span>
                          <span style={{ fontFamily: "var(--mono)", fontWeight: 700 }}>{fmt(resultAgg.ranged.reductionSaved, 2)} dmg</span>
                        </div>
                      )}
                    </div>
                  )}
                  {(defenderFnp.melee > 0 || defenderDamageReduction.melee > 0 || resultAgg.melee.fnpSaved > 0) && (
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--accent-text)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2, display: "flex", alignItems: "center", gap: 4 }}>
                        <Sword size={11} /> Na blízko
                      </div>
                      {resultAgg.melee.fnpSaved > 0 && (
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "2px 0" }}>
                          <span style={{ color: "var(--muted)" }}>
                            FNP zachránilo{defenderUnit.psychicFnp > 0 ? " (vč. FNP proti Psychic)" : ""}
                          </span>
                          <span style={{ fontFamily: "var(--mono)", fontWeight: 700 }}>{fmt(resultAgg.melee.fnpSaved, 2)} dmg</span>
                        </div>
                      )}
                      {defenderDamageReduction.melee > 0 && (
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "2px 0" }}>
                          <span style={{ color: "var(--muted)" }}>Redukce -{defenderDamageReduction.melee} Dmg ubrala</span>
                          <span style={{ fontFamily: "var(--mono)", fontWeight: 700 }}>{fmt(resultAgg.melee.reductionSaved, 2)} dmg</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div style={{ background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 12, padding: 14, marginTop: 12 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 }}>Rozpis poškození</div>
                {resultAgg && (
                  <>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#a9c6e5", textTransform: "uppercase", letterSpacing: 0.5, margin: "8px 0 2px", display: "flex", alignItems: "center", gap: 4 }}>
                      <Crosshair size={11} /> Na dálku
                    </div>
                    {[
                      ["Útoky", fmt(resultAgg.ranged.attacks, 1)],
                      ["Zásahy", fmt(resultAgg.ranged.hits, 2)],
                      ["Zranění", fmt(resultAgg.ranged.wounds, 2)],
                      ["Neúspěšné save", fmt(resultAgg.ranged.through, 2)],
                      ["Damage", fmt(resultAgg.ranged.damage, 2)],
                    ].map(([label, val]) => (
                      <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderTop: "1px solid var(--field-border)", fontSize: 12.5 }}>
                        <span style={{ color: "var(--muted)" }}>{label}</span>
                        <span style={{ fontFamily: "var(--mono)", fontWeight: 700 }}>{val}</span>
                      </div>
                    ))}

                    <div style={{ fontSize: 10, fontWeight: 700, color: "var(--accent-text)", textTransform: "uppercase", letterSpacing: 0.5, margin: "12px 0 2px", display: "flex", alignItems: "center", gap: 4 }}>
                      <Sword size={11} /> Na blízko
                    </div>
                    {[
                      ["Útoky", fmt(resultAgg.melee.attacks, 1)],
                      ["Zásahy", fmt(resultAgg.melee.hits, 2)],
                      ["Zranění", fmt(resultAgg.melee.wounds, 2)],
                      ["Neúspěšné save", fmt(resultAgg.melee.through, 2)],
                      ["Damage", fmt(resultAgg.melee.damage, 2)],
                    ].map(([label, val]) => (
                      <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderTop: "1px solid var(--field-border)", fontSize: 12.5 }}>
                        <span style={{ color: "var(--muted)" }}>{label}</span>
                        <span style={{ fontFamily: "var(--mono)", fontWeight: 700 }}>{val}</span>
                      </div>
                    ))}
                  </>
                )}
              </div>

              <div style={{ display: "flex", gap: 16, marginTop: 12, flexWrap: "wrap" }}>
                <button onClick={() => setBreakdownOpen((o) => !o)} style={{ background: "transparent", border: "none", color: "var(--muted)", fontSize: 11.5, cursor: "pointer", padding: 0 }}>
                  {breakdownOpen ? "Skrýt" : "Zobrazit"} rozpis podle zbraní
                </button>
                <button onClick={() => setMethodologyOpen((o) => !o)} style={{ background: "transparent", border: "none", color: "var(--muted)", fontSize: 11.5, cursor: "pointer", padding: 0 }}>
                  {methodologyOpen ? "Skrýt" : "Jak se to počítá"}
                </button>
              </div>

              {breakdownOpen && (
                <div style={{ marginTop: 10, overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--mono)", fontSize: 10.5 }}>
                    <thead>
                      <tr style={{ color: "var(--muted)", textAlign: "left" }}>
                        <th style={{ padding: "4px 6px 4px 0", fontWeight: 600 }}>Model — zbraň</th>
                        <th style={{ padding: "4px 6px", fontWeight: 600 }}>Útoky</th>
                        <th style={{ padding: "4px 6px", fontWeight: 600 }}>Zásah</th>
                        <th style={{ padding: "4px 6px", fontWeight: 600 }}>Zranění</th>
                        <th style={{ padding: "4px 6px", fontWeight: 600 }}>Save</th>
                        <th style={{ padding: "4px 6px", fontWeight: 600 }}>Dmg</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.breakdown.map((b, i) =>
                        b.isMortalWounds ? (
                          <tr key={i} style={{ borderTop: "1px solid var(--field-border)", color: "var(--text)" }}>
                            <td style={{ padding: "4px 6px 4px 0" }}>
                              {b.type === "melee" ? "⚔" : "🎯"} {b.member} — {b.weapon}
                            </td>
                            <td style={{ padding: "4px 6px" }}>—</td>
                            <td style={{ padding: "4px 6px" }}>—</td>
                            <td style={{ padding: "4px 6px" }}>—</td>
                            <td style={{ padding: "4px 6px" }}>ignoruje save</td>
                            <td style={{ padding: "4px 6px", fontWeight: 700 }}>{fmt(b.damage)}</td>
                          </tr>
                        ) : (
                          <tr key={i} style={{ borderTop: "1px solid var(--field-border)", color: "var(--text)" }}>
                            <td style={{ padding: "4px 6px 4px 0" }}>
                              {b.type === "melee" ? "⚔" : "🎯"} {b.member} — {b.weapon}
                            </td>
                            <td style={{ padding: "4px 6px" }}>{fmt(b.detail.attacks, 1)}</td>
                            <td style={{ padding: "4px 6px" }}>
                              {b.detail.hitX <= 1 ? "auto" : b.detail.hitX + "+"} → {pct(b.detail.pHit)} ({fmt(b.detail.hitsTotal, 2)})
                              {b.detail.hitsFromRerollHit > 0.005 && (
                                <div style={{ fontSize: 9, color: "var(--accent-text)" }}>z toho přehoz: +{fmt(b.detail.hitsFromRerollHit, 2)}</div>
                              )}
                            </td>
                            <td style={{ padding: "4px 6px" }}>
                              {b.detail.woundNeed}+ → {pct(b.detail.pWound)} ({fmt(b.detail.woundsTotal, 2)})
                              {b.detail.woundDebuffApplied && <div style={{ fontSize: 9, color: "var(--amber)" }}>debuff -1 WR (S&gt;T)</div>}
                              {b.detail.woundsFromLethalHits > 0.005 && (
                                <div style={{ fontSize: 9, color: "var(--accent-text)" }}>z toho Lethal Hits: +{fmt(b.detail.woundsFromLethalHits, 2)}</div>
                              )}
                            </td>
                            <td style={{ padding: "4px 6px" }}>{b.detail.effSave >= 7 ? "neprojde" : b.detail.effSave + "+"}</td>
                            <td style={{ padding: "4px 6px", fontWeight: 700 }}>
                              {fmt(b.damage)}
                              {(b.detail.damageFromRerollHit > 0.005 || b.detail.damageFromLethalHits > 0.005) && (
                                <div style={{ fontSize: 9, fontWeight: 400, color: "var(--accent-text)" }}>
                                  {b.detail.damageFromRerollHit > 0.005 && <>přehoz: +{fmt(b.detail.damageFromRerollHit, 2)} </>}
                                  {b.detail.damageFromLethalHits > 0.005 && <>Lethal: +{fmt(b.detail.damageFromLethalHits, 2)}</>}
                                </div>
                              )}
                            </td>
                          </tr>
                        )
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {methodologyOpen && (
                <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--muted)", lineHeight: 1.75 }}>
                  <div>
                    <b style={{ color: "var(--text)" }}>1. Zásahy:</b> Útoky × pravděpodobnost zásahu, upravená přehozem. Kritický zásah = nehozená 6 (Sustained Hits přidá extra zásahy, Lethal Hits obchází hod na zranění).
                  </div>
                  <div>
                    <b style={{ color: "var(--text)" }}>2. Zranění:</b> Cíl na zranění dle S vs T tabulky, případný debuff -1 WR a modifikátory/přehoz.
                  </div>
                  <div>
                    <b style={{ color: "var(--text)" }}>3. Save:</b> Efektivní save = Save + |AP|, nebo lepší invulnerable.
                  </div>
                  <div>
                    <b style={{ color: "var(--text)" }}>4. FNP:</b> Hází se za každý bod damage po save.
                  </div>
                  <div>
                    <b style={{ color: "var(--text)" }}>5. Kills:</b> Damage / efektivní wounds na zabití (overkill se nepřelévá).
                  </div>
                  <div>
                    <b style={{ color: "var(--text)" }}>6. Šance (odhad):</b> Spočítá se, kolik hodů na zranění se celkem dostane až k save (M) a jaká je reálná šance neúspěchu jednoho z nich (q). Z toho se binomickým rozdělením spočítá šance, že padne dost neúspěšných save na zabití aspoň 1 modelu / celé jednotky.
                  </div>
                  <div style={{ fontStyle: "italic", marginTop: 4 }}>
                    Damage a kills jsou očekávaná (průměrná) hodnota. Šance "odhad" už počítají s rozptylem hodů kostkou (binomické rozdělení), ne jen s průměrem.
                  </div>
                </div>
              )}

              <button
                onClick={startNewCalculation}
                className="wh40k-btn"
                style={{ width: "100%", marginTop: 16, border: "none", background: "var(--accent)", color: "#fff", borderRadius: 8, padding: 12, fontSize: 13.5, fontWeight: 700, cursor: "pointer" }}
              >
                Nový výpočet
              </button>
            </div>
          )}
        </div>
      )}

      {/* LIBRARY */}
      {view === "library" && (
        <div className="no-print" style={{ padding: "4px 14px 16px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 10 }}>Knihovna</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <button onClick={() => setLibraryTab("units")} style={tabBtnStyle(libraryTab === "units")}>
              Jednotky
            </button>
            <button onClick={() => setLibraryTab("weapons")} style={tabBtnStyle(libraryTab === "weapons")}>
              Zbraně
            </button>
          </div>

          {libraryTab === "units" && (
            <>
              <button
                onClick={() => setImportOpen((o) => !o)}
                className="wh40k-btn"
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  border: "1px solid var(--accent)",
                  background: "var(--accent-dim)",
                  color: "var(--accent-text)",
                  borderRadius: 8,
                  padding: "10px 12px",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                  marginBottom: 10,
                }}
              >
                <Upload size={15} /> Nahrát novou armádu z New Recruit
              </button>
              {importOpen && <ImportBox onImport={importFromNewRecruit} />}

              <button onClick={() => setShareOpen((o) => !o)} style={{ ...dashedBtnStyle, width: "100%", justifyContent: "center", marginBottom: 10 }}>
                <Save size={14} /> Sdílet s kamarádem
              </button>
              {shareOpen && <ExportImportBox library={library} armies={armies} onImport={importUnitsAndArmies} />}

              <SearchBox value={librarySearch} onChange={setLibrarySearch} placeholder="Hledat jednotky…" />
              {library.length > 0 && (
                <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
                  <button
                    onClick={() => askConfirm("Opravdu smazat celou knihovnu jednotek? Nelze vrátit zpět.", clearLibrary)}
                    style={{ display: "flex", alignItems: "center", gap: 5, border: "1px solid var(--field-border)", background: "transparent", color: "var(--muted)", borderRadius: 6, padding: "4px 10px", fontSize: 11, cursor: "pointer" }}
                  >
                    <Trash2 size={11} /> Vymazat vše
                  </button>
                </div>
              )}
              {!loaded && <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Načítám knihovnu…</div>}
              {loaded && library.length > 0 && filteredLibraryUnits.length === 0 && <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Nic nenalezeno.</div>}
              {loaded &&
                filteredLibraryUnits.map((u) => (
                  <LibraryRow
                    key={u.id}
                    u={u}
                    onEdit={() => setEditingUnit(u)}
                    onDelete={() => deleteUnit(u.id)}
                    onToggleFavorite={() => toggleFavorite(u.id)}
                    onSetBaseSize={(v) => setUnitBaseSize(u.id, v)}
                  />
                ))}

              {editingUnit ? (
                <UnitForm initial={editingUnit} onSave={saveUnit} onCancel={() => setEditingUnit(null)} />
              ) : (
                <button onClick={() => setEditingUnit(emptyUnit())} style={{ ...dashedBtnStyle, marginTop: 10 }}>
                  <Plus size={14} /> Přidat ručně
                </button>
              )}
            </>
          )}

          {libraryTab === "weapons" && (
            <>
              <SearchBox value={librarySearch} onChange={setLibrarySearch} placeholder="Hledat zbraně…" />
              {filteredWeapons.length === 0 && <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Žádné zbraně v knihovně.</div>}
              {filteredWeapons.map((w, i) => (
                <div key={i} style={{ background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 8, padding: "8px 10px", marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, marginBottom: 5 }}>
                    {w.type === "melee" ? <Sword size={12} color="var(--accent-text)" /> : <Crosshair size={12} color="#a9c6e5" />} {w.name}
                    <span style={{ fontSize: 10, color: "var(--muted)", fontWeight: 400 }}>· {w.unitName}</span>
                  </div>
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                    <StatChip label="Atk" value={fmtNum(w.attacks)} />
                    <StatChip label="Hit" value={w.hitX <= 1 ? "auto" : w.hitX + "+"} />
                    <StatChip label="Str" value={w.strength} />
                    <StatChip label="AP" value={w.ap} />
                    <StatChip label="Dmg" value={fmtNum(w.damage)} />
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* HISTORY */}
      {view === "history" && (
        <div className="no-print" style={{ padding: "4px 14px 16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6 }}>Historie výpočtů</div>
            {history.length > 0 && (
              <button
                onClick={() => askConfirm("Smazat celou historii výpočtů?", clearHistory)}
                style={{ background: "transparent", border: "none", color: "var(--muted)", fontSize: 11, cursor: "pointer" }}
              >
                Vymazat vše
              </button>
            )}
          </div>
          {!historyLoaded && <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Načítám…</div>}
          {historyLoaded && history.length === 0 && (
            <div style={{ fontSize: 12.5, color: "var(--muted)", background: "var(--field-bg)", border: "1px dashed var(--field-border)", borderRadius: 8, padding: 14 }}>
              Zatím žádné uložené výpočty.
            </div>
          )}
          {history.map((h) => {
            const isOpen = expandedHistoryId === h.id;
            return (
              <div key={h.id} style={{ background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 10, padding: "10px 12px", marginBottom: 8 }}>
                <div
                  onClick={() => setExpandedHistoryId(isOpen ? null : h.id)}
                  role="button"
                  tabIndex={0}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, cursor: "pointer" }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {h.attackerName} → {h.defenderName}
                    </div>
                    <div style={{ fontSize: 10.5, color: "var(--muted)" }}>{fmtDate(h.date)}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 15, fontWeight: 700, color: "var(--accent-text)", fontFamily: "var(--mono)" }}>{fmt(h.killedModels)}</div>
                      <div style={{ fontSize: 9, color: "var(--muted)" }}>modelů</div>
                    </div>
                    <ChevronDown size={14} color="var(--muted)" style={{ transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteHistoryEntry(h.id);
                      }}
                      style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", padding: 4 }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                {isOpen && (
                  <div style={{ marginTop: 10, borderTop: "1px solid var(--field-border)", paddingTop: 10 }}>
                    <pre
                      style={{
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        fontFamily: "var(--mono)",
                        fontSize: 11.5,
                        color: "var(--text)",
                        background: "var(--field-bg)",
                        border: "1px solid var(--field-border)",
                        borderRadius: 8,
                        padding: 10,
                        margin: 0,
                      }}
                    >
                      {historyEntryText(h)}
                    </pre>
                    <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                      <button
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(historyEntryText(h));
                            setCopiedHistoryId(h.id);
                            setTimeout(() => setCopiedHistoryId((id) => (id === h.id ? null : id)), 2000);
                          } catch (e) {
                            // clipboard unavailable — text is still visible above to select manually
                          }
                        }}
                        className="wh40k-btn"
                        style={{ border: "1px solid var(--field-border)", background: "transparent", color: "var(--text)", borderRadius: 6, padding: "6px 12px", fontSize: 12, cursor: "pointer" }}
                      >
                        {copiedHistoryId === h.id ? "Zkopírováno ✓" : "Kopírovat"}
                      </button>
                      <button
                        onClick={() => {
                          if (!reopenHistoryEntry(h)) {
                            setAlertMessage("Jedna z jednotek už není v knihovně, takže tenhle výpočet nejde znovu otevřít k úpravě.");
                          }
                        }}
                        className="wh40k-btn"
                        style={{ border: "none", background: "var(--accent)", color: "#fff", borderRadius: 6, padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
                      >
                        Upravit
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* MANUAL */}
      {view === "manual" && <ManualView onBack={() => setView("home")} />}

      {/* LISTS (armies + cheat sheet) */}
      {view === "lists" && (
        <div className="no-print" style={{ padding: "4px 14px 16px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 10 }}>Moje armády</div>
          {!armiesLoaded && <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Načítám armády…</div>}
          {armiesLoaded && armies.length === 0 && <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 10 }}>Zatím žádné uložené armády.</div>}
          {armiesLoaded &&
            armies.map((a) => (
              <div key={a.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 8px", borderRadius: 6, fontSize: 13 }}>
                <span>
                  {a.name} <span style={{ fontSize: 11, color: "var(--muted)" }}>({a.unitIds.length} jednotek)</span>
                </span>
                <span style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                  <button
                    onClick={() => setCheatAttackerIds(new Set(a.unitIds))}
                    title="Do cheat sheetu jako útočník"
                    style={{ display: "flex", alignItems: "center", gap: 4, border: "1px solid var(--accent)", background: "transparent", color: "var(--accent-text)", borderRadius: 6, padding: "3px 8px", fontSize: 11, cursor: "pointer" }}
                  >
                    <Sword size={11} /> Útočník
                  </button>
                  <button
                    onClick={() => setCheatTargetIds(new Set(a.unitIds))}
                    title="Do cheat sheetu jako obránce"
                    style={{ display: "flex", alignItems: "center", gap: 4, border: "1px solid var(--blue)", background: "transparent", color: "#a9c6e5", borderRadius: 6, padding: "3px 8px", fontSize: 11, cursor: "pointer" }}
                  >
                    <Shield size={11} /> Obránce
                  </button>
                  <button onClick={() => setEditingArmy(a)} aria-label="Upravit" style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", padding: 4 }}>
                    <Pencil size={14} />
                  </button>
                  <button onClick={() => deleteArmy(a.id)} aria-label="Smazat" style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", padding: 4 }}>
                    <Trash2 size={14} />
                  </button>
                </span>
              </div>
            ))}

          {editingArmy ? (
            <ArmyForm initial={editingArmy} groupedLibrary={groupedLibrary} onSave={saveArmy} onCancel={() => setEditingArmy(null)} />
          ) : (
            <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
              <button onClick={() => setEditingArmy({ id: crypto.randomUUID(), name: "", unitIds: [] })} style={dashedBtnStyle} disabled={library.length === 0}>
                <FolderPlus size={14} /> Uložit novou armádu
              </button>
              <button onClick={() => setTextArmyOpen((o) => !o)} style={dashedBtnStyle} disabled={library.length === 0}>
                <Upload size={14} /> Armáda z textu (New Recruit)
              </button>
            </div>
          )}
          {library.length === 0 && <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 6 }}>Nejdřív přidej jednotky do knihovny.</div>}
          {!editingArmy && textArmyOpen && <ArmyTextMatchBox onMatch={importArmyFromText} />}

          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6, margin: "22px 0 10px" }}>Cheat sheet pro tisk</div>
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 10 }}>
            Zaškrtni útočníky a očekávané protivníky. Damage se počítá s plným počtem modelů a vestavěnými schopnostmi zbraní.
          </div>

          <button
            onClick={() => setCheatModifiersOpen((o) => !o)}
            style={{ display: "flex", alignItems: "center", gap: 4, background: "transparent", border: "none", color: "var(--accent-text)", fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0, marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.4 }}
          >
            <Plus size={12} /> Modifikátory (volitelné)
            <ChevronDown size={12} style={{ transform: cheatModifiersOpen ? "rotate(180deg)" : "none" }} />
          </button>
          {cheatModifiersOpen && (
          <>
            <CheatSlotPanel title="Bonusy útočníka" hint="navíc k vlastním schopnostem, drží se armády i po prohození" accent="var(--accent-text)" slot={cheatSlotA} setSlot={setCheatSlotA} />
            <CheatSlotPanel title="Debuffy obránce" hint="navíc k vlastním hodnotám, drží se armády i po prohození" accent="var(--accent-text)" slot={cheatSlotB} setSlot={setCheatSlotB} />
            <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: -6, marginBottom: 14 }}>
              Tabulka níže vždy ukáže obojí: "Základ" (jen vestavěné schopnosti) a "S bonusy" (základ + tohle nastavení), ať je vidět rozdíl.
            </div>
          </>
          )}
          {(cheatAttackerIds.size === 0 || cheatTargetIds.size === 0) && (
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14 }}>Zaškrtni aspoň jednu jednotku na obou stranách, ať se má co vygenerovat.</div>
          )}
        </div>
      )}

      {/* Printable result matrix sits right after the modifiers panel (not
          after the unit checklists below) so it's reachable without much
          scrolling — kept as its own top-level block (not nested inside the
          .no-print wrapper above/below) since a display:none ancestor would
          hide it from printing even with its own display override. */}
      {view === "lists" && cheatMatrix.length > 0 && cheatMatrix[0].cells.length > 0 && (
        <div className="print-area" style={{ margin: "0 14px 16px", overflowX: "auto", background: "#fff", borderRadius: 8, padding: 12 }}>
          <button
            onClick={() => window.print()}
            className="wh40k-btn no-print"
            style={{ display: "flex", alignItems: "center", gap: 6, border: "none", background: "var(--accent)", color: "#fff", borderRadius: 6, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer", marginBottom: 10 }}
          >
            Vytisknout cheat sheet
          </button>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#111", marginBottom: 2 }}>BATTLECALC — Cheat Sheet: damage na jedno kolo útoku</div>
          <div style={{ fontSize: 9.5, color: "#777", marginBottom: 8 }}>
            Každá buňka: 4 lebky = % zničené jednotky. Horní řádek <b>S</b> = na dálku (Shoot), dolní řádek <b>M</b> = na blízko (Melee). V obou řádcích: <span style={{ color: "#999" }}>šedá</span> = Základ (jen vestavěné schopnosti), <span style={{ color: "#1b5faa" }}>modrá</span> = S bonusy (základ + nastavené bonusy/debuffy).
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, color: "#111" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "4px 6px", border: "1px solid #ccc", background: "#f0f0f0" }}>Útočník \ Cíl</th>
                {cheatMatrix[0].cells.map((c) => (
                  <th key={c.target.id} style={{ textAlign: "center", padding: "4px 6px", border: "1px solid #ccc", background: "#f0f0f0" }}>
                    {c.target.name}
                    <div style={{ fontWeight: 400, fontSize: 8.5, color: "#555" }}>
                      T{c.target.toughness} Sv{c.target.save}+{c.target.invul > 0 ? " Inv" + c.target.invul + "+" : ""} W{c.target.wounds} ({totalModels(c.target)}x)
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cheatMatrix.map((row) => (
                <tr key={row.attacker.id}>
                  <td style={{ padding: "4px 6px", border: "1px solid #ccc", fontWeight: 700 }}>{row.attacker.name}</td>
                  {row.cells.map((c) => {
                    const targetModels = totalModels(c.target) || 1;
                    const rangedBaseFrac = killedModelsByType(c.base.res, "ranged") / targetModels;
                    const rangedBoostedFrac = killedModelsByType(c.boosted.res, "ranged") / targetModels;
                    const meleeBaseFrac = killedModelsByType(c.base.res, "melee") / targetModels;
                    const meleeBoostedFrac = killedModelsByType(c.boosted.res, "melee") / targetModels;
                    const cell = (frac, color, trackColor) => (
                      <div style={{ textAlign: "center" }}>
                        <MiniSkullPie frac={frac} size={16} color={color} trackColor={trackColor} />
                        <div style={{ fontSize: 6.5, color, fontWeight: 600 }}>{(frac * 100).toFixed(0)}%</div>
                      </div>
                    );
                    return (
                      <td key={c.target.id} style={{ padding: "3px 4px", border: "1px solid #ccc", textAlign: "center" }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "center" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                            <span style={{ fontSize: 6.5, color: "#999", width: 8 }}>S</span>
                            {cell(rangedBaseFrac, "#666", "#e6e6e6")}
                            {cell(rangedBoostedFrac, "#1b5faa", "#dbe8f5")}
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                            <span style={{ fontSize: 6.5, color: "#999", width: 8 }}>M</span>
                            {cell(meleeBaseFrac, "#666", "#e6e6e6")}
                            {cell(meleeBoostedFrac, "#1b5faa", "#dbe8f5")}
                          </div>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view === "lists" && (
        <div className="no-print" style={{ padding: "4px 14px 16px" }}>
          {(cheatAttackerIds.size > 0 || cheatTargetIds.size > 0) && (
            <button
              onClick={swapCheatAttackersAndTargets}
              className="wh40k-btn"
              style={{ display: "flex", alignItems: "center", gap: 6, border: "1px solid var(--field-border)", background: "var(--field-bg)", color: "var(--text)", borderRadius: 6, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", marginBottom: 10 }}
            >
              <ArrowLeftRight size={13} /> Prohodit útočníky a cíle
            </button>
          )}

          <div className="wh40k-grid-2" style={{ marginBottom: 14 }}>
            <div style={{ background: "var(--panel)", border: "1px solid var(--accent)", borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent-text)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Útočníci</div>
              {armies.length > 0 && (
                <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                  <select
                    id="army-select-att"
                    className="wh40k-select"
                    style={{ flex: 1, background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 6, color: "var(--text)", padding: "5px 6px", fontSize: 11 }}
                    defaultValue=""
                  >
                    <option value="" disabled>
                      Zaškrtnout celou armádu…
                    </option>
                    {armies.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.unitIds.length}x)
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => {
                      const el = document.getElementById("army-select-att");
                      if (el && el.value) addArmyToAttackers(el.value);
                    }}
                    title="Zaškrtnout celou vybranou armádu"
                    style={{ display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "1px solid var(--accent)", background: "transparent", color: "var(--accent-text)", borderRadius: 6, width: 26, height: 26, cursor: "pointer" }}
                  >
                    <Plus size={13} />
                  </button>
                </div>
              )}
              {cheatAttackerIds.size > 0 && (
                <button onClick={() => setCheatAttackerIds(new Set())} style={{ background: "transparent", border: "none", color: "var(--muted)", fontSize: 10.5, cursor: "pointer", padding: 0, marginBottom: 6 }}>
                  Vyčistit výběr ({cheatAttackerIds.size})
                </button>
              )}
              {Object.entries(groupedLibrary).map(([faction, units]) => (
                <div key={faction} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "var(--amber)", textTransform: "uppercase", marginBottom: 3 }}>{faction}</div>
                  {units.map((u) => (
                    <label key={u.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: "2px 0", cursor: "pointer" }}>
                      <input type="checkbox" checked={cheatAttackerIds.has(u.id)} onChange={() => toggleCheatAttacker(u.id)} />
                      {u.name}
                    </label>
                  ))}
                </div>
              ))}
              {library.length === 0 && <div style={{ fontSize: 12, color: "var(--muted)" }}>Knihovna je prázdná.</div>}
            </div>

            <div style={{ background: "var(--panel)", border: "1px solid var(--blue)", borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#a9c6e5", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Cíle</div>
              {armies.length > 0 && (
                <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                  <select
                    id="army-select-tgt"
                    className="wh40k-select"
                    style={{ flex: 1, background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 6, color: "var(--text)", padding: "5px 6px", fontSize: 11 }}
                    defaultValue=""
                  >
                    <option value="" disabled>
                      Zaškrtnout celou armádu…
                    </option>
                    {armies.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.unitIds.length}x)
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => {
                      const el = document.getElementById("army-select-tgt");
                      if (el && el.value) addArmyToTargets(el.value);
                    }}
                    title="Zaškrtnout celou vybranou armádu"
                    style={{ display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "1px solid var(--blue)", background: "transparent", color: "#a9c6e5", borderRadius: 6, width: 26, height: 26, cursor: "pointer" }}
                  >
                    <Plus size={13} />
                  </button>
                </div>
              )}
              {cheatTargetIds.size > 0 && (
                <button onClick={() => setCheatTargetIds(new Set())} style={{ background: "transparent", border: "none", color: "var(--muted)", fontSize: 10.5, cursor: "pointer", padding: 0, marginBottom: 6 }}>
                  Vyčistit výběr ({cheatTargetIds.size})
                </button>
              )}
              {Object.entries(groupedLibrary).map(([faction, units]) => (
                <div key={faction} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "var(--amber)", textTransform: "uppercase", marginBottom: 3 }}>{faction}</div>
                  {units.map((u) => (
                    <label key={u.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: "2px 0", cursor: "pointer" }}>
                      <input type="checkbox" checked={cheatTargetIds.has(u.id)} onChange={() => toggleCheatTarget(u.id)} />
                      {u.name}
                    </label>
                  ))}
                </div>
              ))}
              {library.length === 0 && <div style={{ fontSize: 12, color: "var(--muted)" }}>Knihovna je prázdná.</div>}
            </div>
          </div>
        </div>
      )}

      {view === "board" && (
        <div className="no-print" style={{ padding: "4px 14px 16px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 10 }}>Herní deska</div>
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 10, lineHeight: 1.5 }}>
            Zaškrtni jednotky z knihovny do své strany nebo strany protihráče — objeví se jako tokeny na desce (jeden na každý model), které přetáhneš na místo. Model odebereš označením (Shift+klik) a klávesou Delete.
          </div>

          <div className="wh40k-board-layout">
            <div className="wh40k-board-sidebar">
          {uiTheme === "tactical" && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <SkullLogo size={34} />
              <div>
                <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: 1.5, color: "var(--text)", lineHeight: 1 }}>MAPA</div>
                <div style={{ fontSize: 11.5, color: "var(--accent-text)" }}>Vytvoř si vlastní herní pole</div>
              </div>
            </div>
          )}
          <div style={{ marginBottom: 10, background: "var(--field-bg)", border: "1px solid var(--accent)", borderRadius: 8, padding: 8 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Mapa</div>
            <div style={{ fontSize: 10.5, color: "var(--muted)", marginBottom: 6 }}>
              Jedním klikem načte na desku zónu i rozestavěný terén (nahradí současný). Pak ho můžeš upravit a uložit jako základní mapu nebo mutaci.
            </div>
            {(() => {
              const chip = (active) => ({
                border: "1px solid var(--accent)",
                background: active ? "var(--accent)" : "transparent",
                color: active ? "#fff" : "var(--accent-text)",
                borderRadius: 6,
                padding: "5px 10px",
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
              });
              const pairKey = mapPairKey(mapMissionA, mapMissionB);
              const label = { fontSize: 10, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.4, margin: "6px 0 3px" };
              return (
                <>
                  <div style={label}>Já hraju</div>
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                    {MAP_MISSIONS.map((m) => (
                      <button key={m} className="wh40k-btn" onClick={() => setMapMissionA(m)} style={chip(mapMissionA === m)}>{m}</button>
                    ))}
                  </div>
                  <div style={label}>Proti</div>
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                    {MAP_MISSIONS.map((m) => (
                      <button key={m} className="wh40k-btn" onClick={() => setMapMissionB(m)} style={chip(mapMissionB === m)}>{m}</button>
                    ))}
                  </div>
                  <div style={label}>Varianta mapy</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {MAP_VARIANTS.map((v) => {
                      const t = MAP_TEMPLATE_BY_PAIR[`${pairKey}|${v}`];
                      const active = mapVariantLoaded === `${pairKey}|${v}`;
                      return (
                        <button
                          key={v}
                          className="wh40k-btn"
                          disabled={!t}
                          onClick={() => { setMapVariantLoaded(`${pairKey}|${v}`); loadLayoutTemplate(t); }}
                          title={t ? `Načíst „${t.name}“ (${t.mission})` : "Pro tuhle kombinaci tahle varianta není"}
                          style={{ ...chip(active), minWidth: 44, padding: "7px 14px", fontSize: 14, opacity: t ? 1 : 0.35, cursor: t ? "pointer" : "not-allowed" }}
                        >
                          {v}
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 5 }}>
                    {mapMissionA} vs {mapMissionB}
                  </div>
                </>
              );
            })()}
          </div>
          <Row cols={2}>
            <NumberField label="Šířka desky (in)" value={board.widthIn} onChange={(v) => setBoardSize(Math.max(1, v), board.heightIn)} min={1} small />
            <NumberField label="Výška desky (in)" value={board.heightIn} onChange={(v) => setBoardSize(board.widthIn, Math.max(1, v))} min={1} small />
          </Row>

          <button
            onClick={() => setBoardEditOpen((o) => !o)}
            style={{ display: "flex", alignItems: "center", gap: 4, background: "transparent", border: "none", color: "var(--accent-text)", fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0, marginTop: 10, textTransform: "uppercase", letterSpacing: 0.4 }}
          >
            <Plus size={12} /> Úpravy mapy a terénu (stavebnice, tvorba mapy, podložky)
            <ChevronDown size={12} style={{ transform: boardEditOpen ? "rotate(180deg)" : "none" }} />
          </button>
          {boardEditOpen && (
          <>
          <button
            onClick={() => setMapToolsOpen((o) => !o)}
            style={{ display: "flex", alignItems: "center", gap: 4, background: "transparent", border: "none", color: "var(--accent-text)", fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0, marginTop: 10, textTransform: "uppercase", letterSpacing: 0.4 }}
          >
            <Plus size={12} /> Tvorba mapy (základní mapy, mutace, zóna)
            <ChevronDown size={12} style={{ transform: mapToolsOpen ? "rotate(180deg)" : "none" }} />
          </button>
          {mapToolsOpen && (
          <div style={{ marginTop: 10, marginBottom: 4 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Rozložení výsadku — základní mapy</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {allLayouts.filter((l) => !l.parentId).map((l) => (
                <div key={l.id} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                  <LayoutSwatch layout={l} selected={activeBaseLayoutId === l.id} onClick={() => selectLayout(l.id)} />
                  <div style={{ fontSize: 9, color: activeBaseLayoutId === l.id ? "var(--accent-text)" : "var(--muted)", fontWeight: 700 }}>{l.name}</div>
                  <button
                    onClick={() => askConfirm(`Smazat základní mapu „${l.name}“ i s jejími mutacemi?`, () => deleteCustomLayout(l.id))}
                    title="Smazat základní mapu"
                    style={{ background: "transparent", border: "none", color: "var(--muted)", fontSize: 9, cursor: "pointer", padding: 0 }}
                  >
                    smazat
                  </button>
                </div>
              ))}
            </div>

            {/* Mutations of whichever base map is in play — the base's zone
                plus a saved terrain layout, as child entries. */}
            {activeBaseLayoutId && (() => {
              const base = customLayouts.find((l) => l.id === activeBaseLayoutId);
              const mutations = allLayouts.filter((l) => l.parentId === activeBaseLayoutId);
              return (
                <div style={{ marginTop: 10, background: "var(--field-bg)", border: "1px dashed var(--field-border)", borderRadius: 8, padding: 8 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>
                    Mutace mapy „{base?.name}“ {mutations.length > 0 ? `(${mutations.length})` : ""}
                  </div>
                  {mutations.length > 0 && (
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
                      {mutations.map((l) => (
                        <div key={l.id} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                          <LayoutSwatch layout={l} selected={board.layoutId === l.id} onClick={() => selectLayout(l.id)} />
                          <div style={{ fontSize: 9, color: board.layoutId === l.id ? "var(--accent-text)" : "var(--muted)", fontWeight: 700 }}>
                            {l.name} · {(l.terrain || []).length}×
                          </div>
                          <button
                            onClick={() => askConfirm(`Smazat mutaci „${l.name}“?`, () => deleteCustomLayout(l.id))}
                            title="Smazat mutaci"
                            style={{ background: "transparent", border: "none", color: "var(--muted)", fontSize: 9, cursor: "pointer", padding: 0 }}
                          >
                            smazat
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 6, alignItems: "flex-end", flexWrap: "wrap" }}>
                    <TextField label="Název mutace" value={newMutationName} onChange={setNewMutationName} placeholder={`např. ${base?.name}-ruiny`} small />
                    <button
                      onClick={saveMutation}
                      className="wh40k-btn"
                      title="Uloží aktuální zónu + rozestavěný terén jako mutaci této základní mapy"
                      style={{ border: "none", background: "var(--accent)", color: "#fff", borderRadius: 6, padding: "7px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}
                    >
                      Uložit rozestavění jako mutaci
                    </button>
                  </div>
                </div>
              );
            })()}

            <div style={{ display: "flex", gap: 6, alignItems: "flex-end", flexWrap: "wrap", marginTop: 10 }}>
              <TextField label="Název nové základní mapy" value={newLayoutName} onChange={setNewLayoutName} placeholder="např. Rohy s klínem" small />
              <button
                onClick={saveNewLayout}
                className="wh40k-btn"
                style={{ border: "none", background: "var(--accent)", color: "#fff", borderRadius: 6, padding: "7px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}
              >
                Uložit jako novou základní mapu
              </button>
              {activeCustomLayout && (
                <button
                  onClick={updateActiveLayout}
                  className="wh40k-btn"
                  title={`Přepíše „${activeCustomLayout.name}“ aktuální zónou${activeCustomLayout.parentId ? " + terénem" : ""}`}
                  style={{ border: "1px solid var(--accent)", background: "transparent", color: "var(--accent-text)", borderRadius: 6, padding: "7px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}
                >
                  Uložit změny do „{activeCustomLayout.name}“
                </button>
              )}
            </div>
            <div style={{ fontSize: 10.5, color: "var(--muted)", margin: "8px 0 4px" }}>
              Nebo si vlastní výsadek nakresli přímo na desku — nakreslíš jen svou zónu, „Zóna protihráče“ se dopočítá automaticky jako její protějšek otočený o 180° přes střed desky (diagonálně), ne jako prosté zrcadlo:
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button
                onClick={startDrawingZone}
                disabled={!!drawMode}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  border: "1px solid var(--accent)",
                  background: drawMode === "mine" ? "var(--accent-dim)" : "transparent",
                  color: "var(--accent-text)",
                  borderRadius: 6,
                  padding: "5px 9px",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: drawMode ? "not-allowed" : "pointer",
                }}
              >
                <Pencil size={12} /> Nakreslit mou zónu
              </button>
            </div>
            {(board.customZones?.mine || board.customZones?.theirs) && !drawMode && (
              <button
                onClick={clearCustomZones}
                style={{ background: "transparent", border: "none", color: "var(--muted)", fontSize: 10.5, cursor: "pointer", padding: 0, marginTop: 6 }}
              >
                Zpět na vybrané rozložení
              </button>
            )}

            {!drawMode && (
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 10.5, color: "var(--muted)" }}>
                  Nebo zadej svou zónu jako dva obdélníky čísly v palcích (podle čísel na okraji desky) — spojí se do jedné zóny. „Zóna protihráče“ se vždy dopočítá jako diagonální (o 180° otočený) protějšek, nikdy se nezadává ručně:
                </div>
                <div
                  style={{
                    background: "var(--field-bg)",
                    border: "1px solid var(--accent)",
                    borderRadius: 8,
                    padding: 8,
                  }}
                >
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--accent-text)", marginBottom: 6 }}>Moje zóna</div>
                  {[0, 1].map((rectIdx) => (
                    <div key={rectIdx} style={{ marginBottom: 6 }}>
                      <div style={{ fontSize: 9.5, color: "var(--muted)", marginBottom: 3 }}>Obdélník {rectIdx + 1}</div>
                      <Row cols={4}>
                        <NumberField label="Od X" value={zoneRects.mine[rectIdx].x1} onChange={(v) => updateZoneRect(rectIdx, "x1", v)} small />
                        <NumberField label="Od Y" value={zoneRects.mine[rectIdx].y1} onChange={(v) => updateZoneRect(rectIdx, "y1", v)} small />
                        <NumberField label="Do X" value={zoneRects.mine[rectIdx].x2} onChange={(v) => updateZoneRect(rectIdx, "x2", v)} small />
                        <NumberField label="Do Y" value={zoneRects.mine[rectIdx].y2} onChange={(v) => updateZoneRect(rectIdx, "y2", v)} small />
                      </Row>
                    </div>
                  ))}
                  <button
                    onClick={setZoneRectsFromNumbers}
                    className="wh40k-btn"
                    style={{
                      marginTop: 4,
                      border: "none",
                      background: "var(--accent)",
                      color: "#fff",
                      borderRadius: 6,
                      padding: "6px 12px",
                      fontSize: 11.5,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    Nastavit mou zónu
                  </button>
                </div>

                <div style={{ fontSize: 10.5, color: "var(--muted)" }}>
                  Nebo jako trojúhelník (tři rohy v palcích) — nahradí celou „Moji zónu“, nekombinuje se s obdélníky výše:
                </div>
                <div style={{ background: "var(--field-bg)", border: "1px solid var(--accent)", borderRadius: 8, padding: 8 }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--accent-text)", marginBottom: 6 }}>Trojúhelník</div>
                  {[1, 2, 3].map((n) => (
                    <div key={n} style={{ marginBottom: 6 }}>
                      <div style={{ fontSize: 9.5, color: "var(--muted)", marginBottom: 3 }}>Roh {n}</div>
                      <Row cols={2}>
                        <NumberField label="X" value={triangleShape[`x${n}`]} onChange={(v) => setTriangleShape((s) => ({ ...s, [`x${n}`]: v }))} small />
                        <NumberField label="Y" value={triangleShape[`y${n}`]} onChange={(v) => setTriangleShape((s) => ({ ...s, [`y${n}`]: v }))} small />
                      </Row>
                    </div>
                  ))}
                  <button
                    onClick={setTriangleZone}
                    className="wh40k-btn"
                    style={{ marginTop: 4, border: "none", background: "var(--accent)", color: "#fff", borderRadius: 6, padding: "6px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}
                  >
                    Nastavit jako trojúhelník
                  </button>
                </div>

                <div style={{ fontSize: 10.5, color: "var(--muted)" }}>
                  Nebo jako kruhová výseč (střed, poloměr, úhel ve stupních — 0° = doprava, 90° = dolů) — taky nahradí celou „Moji zónu“:
                </div>
                <div style={{ background: "var(--field-bg)", border: "1px solid var(--accent)", borderRadius: 8, padding: 8 }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--accent-text)", marginBottom: 6 }}>Kruhová výseč</div>
                  <Row cols={2}>
                    <NumberField label="Střed X" value={sectorShape.cx} onChange={(v) => setSectorShape((s) => ({ ...s, cx: v }))} small />
                    <NumberField label="Střed Y" value={sectorShape.cy} onChange={(v) => setSectorShape((s) => ({ ...s, cy: v }))} small />
                  </Row>
                  <div style={{ marginTop: 6 }}>
                    <Row cols={2}>
                      <NumberField label="Poloměr od" value={sectorShape.rInner} onChange={(v) => setSectorShape((s) => ({ ...s, rInner: v }))} small hint="0 = bez otvoru uprostřed" />
                      <NumberField label="Poloměr do" value={sectorShape.rOuter} onChange={(v) => setSectorShape((s) => ({ ...s, rOuter: v }))} small />
                    </Row>
                  </div>
                  <div style={{ marginTop: 6 }}>
                    <Row cols={2}>
                      <NumberField label="Úhel od (°)" value={sectorShape.angleStart} onChange={(v) => setSectorShape((s) => ({ ...s, angleStart: v }))} small />
                      <NumberField label="Úhel do (°)" value={sectorShape.angleEnd} onChange={(v) => setSectorShape((s) => ({ ...s, angleEnd: v }))} small />
                    </Row>
                  </div>
                  <label style={{ display: "flex", alignItems: "flex-start", gap: 6, marginTop: 8, fontSize: 10.5, color: "var(--muted)", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={!!sectorShape.invert}
                      onChange={(e) => setSectorShape((s) => ({ ...s, invert: e.target.checked }))}
                      style={{ marginTop: 1 }}
                    />
                    <span>
                      <b>Opačně</b> — zóna je celý výsek od středu až do okraje desky a kruh o poloměru „Poloměr do“ je z ní vykrojený (poloměr „od“ se ignoruje).
                    </span>
                  </label>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                    <button
                      onClick={() => setSectorZone()}
                      className="wh40k-btn"
                      style={{ border: "none", background: "var(--accent)", color: "#fff", borderRadius: 6, padding: "6px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}
                    >
                      Nastavit jako výseč
                    </button>
                    <button
                      onClick={setQuarterMinusCircleZone}
                      className="wh40k-btn"
                      title="Levá dolní čtvrtina desky bez kruhu o poloměru 9″ kolem středu; protihráč diagonálně naproti"
                      style={{ border: "1px solid var(--accent)", background: "transparent", color: "var(--accent-text)", borderRadius: 6, padding: "6px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}
                    >
                      Čtvrtina bez kruhu 9″
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
          )}

          <div style={{ marginTop: 10, marginBottom: 4 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.5 }}>Terén (stavebnice)</div>
              <div style={{ display: "flex", gap: 10 }}>
                {hiddenShapeIds.length > 0 && (
                  <button
                    onClick={() => persistHiddenShapes([])}
                    title="Vrátí do palety všechny smazané kusy"
                    style={{ background: "transparent", border: "none", color: "var(--accent-text)", fontSize: 10.5, cursor: "pointer", padding: 0 }}
                  >
                    Obnovit smazané ({hiddenShapeIds.length})
                  </button>
                )}
                {board.terrain && board.terrain.length > 0 && (
                  <button onClick={clearTerrain} style={{ background: "transparent", border: "none", color: "var(--muted)", fontSize: 10.5, cursor: "pointer", padding: 0 }}>
                    Vyčistit terén
                  </button>
                )}
              </div>
            </div>
            <div style={{ fontSize: 10.5, color: "var(--muted)", marginBottom: 6 }}>Klikni pro přidání kus terénu doprostřed desky, pak ho přetáhni a uprav dole.</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {TERRAIN_SHAPES.filter((s) => !hiddenShapeIds.includes(s.id)).map((s) => (
                <div
                  key={s.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    border: "1px solid var(--field-border)",
                    background: "var(--field-bg)",
                    color: "var(--text)",
                    borderRadius: 6,
                    padding: "5px 6px 5px 6px",
                    fontSize: 11,
                  }}
                >
                  <button
                    onClick={() => addTerrainPiece(s.id)}
                    title={`Přidat: ${s.label}`}
                    style={{ display: "flex", alignItems: "center", gap: 6, background: "transparent", border: "none", color: "var(--text)", padding: 0, cursor: "pointer", fontSize: 11 }}
                  >
                    <PieceSwatch shape={s} />
                    {s.label}
                  </button>
                  <button
                    onClick={() =>
                      askConfirm(
                        `Smazat „${s.label}“ z palety? (Kusy už položené na desce zůstanou. Smazané jde vrátit tlačítkem „Obnovit smazané“.)`,
                        () => persistHiddenShapes([...hiddenShapeIds, s.id])
                      )
                    }
                    title={`Smazat z palety: ${s.label}`}
                    style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", padding: "0 0 0 2px", display: "flex" }}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
              {customPieceTypes.map((s) => (
                <div
                  key={s.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    border: "1px solid var(--accent)",
                    background: "var(--field-bg)",
                    color: "var(--text)",
                    borderRadius: 6,
                    padding: "5px 6px 5px 6px",
                    fontSize: 11,
                  }}
                >
                  <button
                    onClick={() => addTerrainPiece(s.id)}
                    title={`Přidat: ${s.label}`}
                    style={{ display: "flex", alignItems: "center", gap: 6, background: "transparent", border: "none", color: "var(--text)", padding: 0, cursor: "pointer", fontSize: 11 }}
                  >
                    <PieceSwatch shape={s} />
                    {s.label}
                  </button>
                  <button
                    onClick={() => askConfirm(`Smazat vlastní typ „${s.label}“? (Kusy už umístěné na desce zůstanou.)`, () => deleteCustomPieceType(s.id))}
                    title="Smazat vlastní typ"
                    style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", padding: "0 0 0 2px", display: "flex" }}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>

            {board.terrain && board.terrain.length > 1 && (
              <div style={{ display: "flex", gap: 6, alignItems: "flex-end", flexWrap: "wrap", marginTop: 8, background: "var(--field-bg)", border: "1px dashed var(--field-border)", borderRadius: 8, padding: 8 }}>
                <TextField label={`Uložit ${board.terrain.length} kusů jako skupinu`} value={newGroupName} onChange={setNewGroupName} placeholder="např. Ruina se zelení" small />
                <button
                  onClick={() => {
                    saveTerrainGroup(newGroupName);
                    setNewGroupName("");
                  }}
                  className="wh40k-btn"
                  title="Uloží celé aktuální rozestavění terénu jako jeden kus do palety"
                  style={{ border: "none", background: "var(--accent)", color: "#fff", borderRadius: 6, padding: "7px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}
                >
                  Uložit jako skupinu
                </button>
              </div>
            )}

            <button
              onClick={() => setParamTerrainOpen((o) => !o)}
              style={{ display: "flex", alignItems: "center", gap: 4, background: "transparent", border: "none", color: "var(--accent-text)", fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0, marginTop: 8, textTransform: "uppercase", letterSpacing: 0.4 }}
            >
              <Plus size={12} /> Terén čísly (obdélník / zeď)
              <ChevronDown size={12} style={{ transform: paramTerrainOpen ? "rotate(180deg)" : "none" }} />
            </button>
            {paramTerrainOpen && (
              <div style={{ marginTop: 8, background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 8, padding: 10 }}>
                <SelectField
                  label="Tvar"
                  value={paramTerrain.mode}
                  onChange={(v) => setParamTerrain((s) => ({ ...s, mode: v }))}
                  options={[
                    { value: "rect", label: "Obdélník (dva rohy)" },
                    { value: "wall", label: "Zeď / úsečka (dva konce + tloušťka)" },
                  ]}
                  small
                />
                {paramTerrain.mode === "rect" && (
                  <div style={{ marginTop: 6 }}>
                    <SelectField
                      label="Vrstva"
                      value={paramTerrain.rectLayer}
                      onChange={(v) => setParamTerrain((s) => ({ ...s, rectLayer: v }))}
                      options={[
                        { value: "terrain", label: "Terén (nahoře)" },
                        { value: "base", label: "Podložka (dole, terén na ni stojí)" },
                      ]}
                      small
                    />
                  </div>
                )}
                <div style={{ marginTop: 6 }}>
                  <Row cols={2}>
                    <NumberField label={paramTerrain.mode === "wall" ? "Konec 1 – X" : "Roh 1 – X"} value={paramTerrain.x1} onChange={(v) => setParamTerrain((s) => ({ ...s, x1: v }))} small />
                    <NumberField label={paramTerrain.mode === "wall" ? "Konec 1 – Y" : "Roh 1 – Y"} value={paramTerrain.y1} onChange={(v) => setParamTerrain((s) => ({ ...s, y1: v }))} small />
                  </Row>
                </div>
                <div style={{ marginTop: 6 }}>
                  <Row cols={2}>
                    <NumberField label={paramTerrain.mode === "wall" ? "Konec 2 – X" : "Roh 2 – X"} value={paramTerrain.x2} onChange={(v) => setParamTerrain((s) => ({ ...s, x2: v }))} small />
                    <NumberField label={paramTerrain.mode === "wall" ? "Konec 2 – Y" : "Roh 2 – Y"} value={paramTerrain.y2} onChange={(v) => setParamTerrain((s) => ({ ...s, y2: v }))} small />
                  </Row>
                </div>
                {paramTerrain.mode === "wall" && (
                  <div style={{ marginTop: 6 }}>
                    <NumberField label="Tloušťka (in)" value={paramTerrain.thickness} onChange={(v) => setParamTerrain((s) => ({ ...s, thickness: Math.max(0.1, v) }))} min={0.1} small />
                  </div>
                )}
                <button
                  onClick={paramTerrain.mode === "wall" ? addParametricWall : addParametricRect}
                  className="wh40k-btn"
                  style={{ marginTop: 6, border: "none", background: "var(--accent)", color: "#fff", borderRadius: 6, padding: "6px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}
                >
                  Přidat na desku
                </button>
              </div>
            )}

            <button
              onClick={() => setCustomFormOpen((o) => !o)}
              style={{ display: "flex", alignItems: "center", gap: 4, background: "transparent", border: "none", color: "var(--accent-text)", fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0, marginTop: 8, textTransform: "uppercase", letterSpacing: 0.4 }}
            >
              <Plus size={12} /> Vytvořit vlastní terén / podložku
              <ChevronDown size={12} style={{ transform: customFormOpen ? "rotate(180deg)" : "none" }} />
            </button>
            {customFormOpen && (
              <div style={{ marginTop: 8, background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 8, padding: 10 }}>
                <TextField label="Název" value={customForm.name} onChange={(v) => setCustomForm((s) => ({ ...s, name: v }))} placeholder="např. Bunkr, Skalní podložka…" small />
                <Row cols={2}>
                  <SelectField
                    label="Vrstva"
                    value={customForm.layer}
                    onChange={(v) => setCustomForm((s) => ({ ...s, layer: v }))}
                    options={[
                      { value: "terrain", label: "Terén (nahoře)" },
                      { value: "base", label: "Podložka (dole, terén na ni stojí)" },
                      { value: "combo", label: "Podložka s terénem (obojí najednou)" },
                    ]}
                    small
                  />
                  <SelectField
                    label="Tvar"
                    value={customForm.shape}
                    onChange={(v) => setCustomForm((s) => ({ ...s, shape: v }))}
                    options={[
                      { value: "rect", label: "Obdélník" },
                      { value: "circle", label: "Kruh / ovál" },
                      { value: "triangle", label: "Trojúhelník" },
                    ]}
                    small
                  />
                </Row>
                <Row cols={3}>
                  <NumberField label={customForm.layer === "combo" ? "Šířka terénu (in)" : "Šířka (in)"} value={customForm.widthIn} onChange={(v) => setCustomForm((s) => ({ ...s, widthIn: Math.max(0.5, v) }))} min={0.5} small />
                  <NumberField label={customForm.layer === "combo" ? "Výška terénu (in)" : "Výška (in)"} value={customForm.heightIn} onChange={(v) => setCustomForm((s) => ({ ...s, heightIn: Math.max(0.5, v) }))} min={0.5} small />
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, color: "var(--label)", fontWeight: 600 }}>{customForm.layer === "combo" ? "Barva terénu" : "Barva"}</span>
                    <input
                      type="color"
                      value={customForm.color}
                      onChange={(e) => setCustomForm((s) => ({ ...s, color: e.target.value }))}
                      style={{ width: "100%", height: 30, border: "1px solid var(--field-border)", borderRadius: 6, background: "var(--field-bg)", padding: 2, cursor: "pointer" }}
                    />
                  </label>
                </Row>
                {customForm.layer === "combo" && (
                  <Row cols={2}>
                    <NumberField
                      label="Přesah podložky (in)"
                      value={customForm.baseMarginIn}
                      onChange={(v) => setCustomForm((s) => ({ ...s, baseMarginIn: Math.max(0.1, v) }))}
                      min={0.1}
                      hint="o kolik je podložka větší než terén na ní, na každou stranu"
                      small
                    />
                    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span style={{ fontSize: 11, color: "var(--label)", fontWeight: 600 }}>Barva podložky</span>
                      <input
                        type="color"
                        value={customForm.baseColor}
                        onChange={(e) => setCustomForm((s) => ({ ...s, baseColor: e.target.value }))}
                        style={{ width: "100%", height: 30, border: "1px solid var(--field-border)", borderRadius: 6, background: "var(--field-bg)", padding: 2, cursor: "pointer" }}
                      />
                    </label>
                  </Row>
                )}
                <button
                  onClick={() => {
                    if (!customForm.name.trim()) return;
                    const radius = customForm.shape === "circle" ? "50%" : 3;
                    // A triangle can't be done with border-radius, so it's a
                    // clip-path instead (apex up); rect/circle leave clipPath
                    // undefined and fall back to border-radius as before.
                    const clipPath = customForm.shape === "triangle" ? "polygon(50% 0%, 100% 100%, 0% 100%)" : undefined;
                    if (customForm.layer === "combo") {
                      addCustomPieceType({
                        label: customForm.name.trim(),
                        layer: "terrain",
                        combo: true,
                        widthIn: customForm.widthIn + 2 * customForm.baseMarginIn,
                        heightIn: customForm.heightIn + 2 * customForm.baseMarginIn,
                        bg: customForm.baseColor,
                        border: "1px solid rgba(255,255,255,0.65)",
                        radius,
                        terrainWidthIn: customForm.widthIn,
                        terrainHeightIn: customForm.heightIn,
                        terrainBg: customForm.color,
                        terrainBorder: "2px dashed rgba(255,255,255,0.5)",
                        terrainRadius: radius,
                        terrainClipPath: clipPath,
                      });
                    } else {
                      addCustomPieceType({
                        label: customForm.name.trim(),
                        layer: customForm.layer,
                        widthIn: customForm.widthIn,
                        heightIn: customForm.heightIn,
                        bg: customForm.color,
                        border: customForm.layer === "base" ? "1px solid rgba(255,255,255,0.65)" : "2px dashed rgba(255,255,255,0.5)",
                        radius,
                        clipPath,
                      });
                    }
                    setCustomForm((s) => ({ ...s, name: "" }));
                    setCustomFormOpen(false);
                  }}
                  disabled={!customForm.name.trim()}
                  className="wh40k-btn"
                  style={{
                    marginTop: 4,
                    border: "none",
                    background: customForm.name.trim() ? "var(--accent)" : "var(--field-border)",
                    color: customForm.name.trim() ? "#fff" : "var(--muted)",
                    borderRadius: 6,
                    padding: "7px 12px",
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: customForm.name.trim() ? "pointer" : "not-allowed",
                  }}
                >
                  Přidat do palety
                </button>
              </div>
            )}
          </div>

          <div style={{ marginTop: 10, marginBottom: 4, background: "var(--field-bg)", border: "1px dashed var(--field-border)", borderRadius: 8, padding: 10 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Moje podložky</div>
            <div style={{ fontSize: 10.5, color: "var(--muted)", marginBottom: 8 }}>
              Ulož rozměry + rozložení výsadku + rozestavěný terén (bez jednotek) jako pojmenovanou podložku — kdykoli ji zase načteš, nebo pošli soubor kamarádovi přes „Sdílet podložku“.
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
              <input
                type="text"
                value={newPresetName}
                onChange={(e) => setNewPresetName(e.target.value)}
                placeholder="Název podložky…"
                className="wh40k-input"
                style={{ flex: "1 1 140px", minWidth: 0, background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 6, color: "var(--text)", padding: "7px 9px", fontSize: 12.5 }}
              />
              <button
                onClick={() => {
                  if (!newPresetName.trim()) return;
                  saveBoardPreset(newPresetName);
                  setNewPresetName("");
                }}
                disabled={!newPresetName.trim()}
                className="wh40k-btn"
                style={{
                  border: "none",
                  background: newPresetName.trim() ? "var(--accent)" : "var(--field-border)",
                  color: newPresetName.trim() ? "#fff" : "var(--muted)",
                  borderRadius: 6,
                  padding: "7px 12px",
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: newPresetName.trim() ? "pointer" : "not-allowed",
                  whiteSpace: "nowrap",
                }}
              >
                Uložit jako podložku
              </button>
            </div>

            {boardPresetsLoaded && boardPresets.length === 0 && <div style={{ fontSize: 12, color: "var(--muted)" }}>Zatím žádné uložené podložky.</div>}
            {!boardPresetsLoaded && <div style={{ fontSize: 12, color: "var(--muted)" }}>Načítám podložky…</div>}
            {boardPresets.map((p) => (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 8, padding: "7px 9px", marginBottom: 6 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                  <div style={{ fontSize: 10.5, color: "var(--muted)" }}>
                    {p.widthIn}×{p.heightIn}″ · {(p.terrain || []).length} ks terénu
                  </div>
                </div>
                <button
                  onClick={() => loadBoardPreset(p.id)}
                  className="wh40k-btn"
                  style={{ border: "1px solid var(--accent)", background: "transparent", color: "var(--accent-text)", borderRadius: 6, padding: "5px 10px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}
                >
                  Načíst
                </button>
                <button
                  onClick={() => askConfirm(`Smazat podložku „${p.name}“?`, () => deleteBoardPreset(p.id))}
                  title="Smazat"
                  style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", padding: 4, flexShrink: 0 }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}

            <button
              onClick={() => setBoardShareOpen((o) => !o)}
              style={{ display: "flex", alignItems: "center", gap: 4, background: "transparent", border: "none", color: "var(--accent-text)", fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0, marginTop: 4, textTransform: "uppercase", letterSpacing: 0.4 }}
            >
              <Save size={12} /> Sdílet podložku
              <ChevronDown size={12} style={{ transform: boardShareOpen ? "rotate(180deg)" : "none" }} />
            </button>
            {boardShareOpen && (
              <BoardShareBox
                boardPresets={boardPresets}
                onImport={(presets) => {
                  const existingNames = new Set(boardPresets.map((p) => p.name));
                  let added = 0;
                  const withNewIds = presets.map((p) => {
                    added += 1;
                    let name = p.name || "Podložka";
                    if (existingNames.has(name)) name = `${name} (import)`;
                    return { ...p, id: crypto.randomUUID(), name };
                  });
                  persistBoardPresets([...boardPresets, ...withNewIds]);
                  return { added };
                }}
              />
            )}
          </div>
          </>
          )}

          {/* Always stacked, not the responsive wh40k-vs-columns 2-col grid —
              this now lives in the fixed-width sidebar, which is too narrow
              for two roster panels side by side regardless of screen size. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 10, marginBottom: 12 }}>
            {[
              ["mine", "Moje jednotky", "var(--accent)", "var(--accent-text)"],
              ["theirs", "Jednotky protihráče", "#c0392b", "#e0857c"],
            ].map(([side, title, borderColor, titleColor]) => {
              const army = armies.find((a) => a.id === boardArmySel[side]);
              const inArmy = army ? new Set(army.unitIds) : null;
              const grouped = {};
              (inArmy ? library.filter((u) => inArmy.has(u.id)) : library).forEach((u) => {
                const f = u.faction || "Bez frakce";
                if (!grouped[f]) grouped[f] = [];
                grouped[f].push(u);
              });
              const sideTokens = board.tokens.filter((t) => t.side === side).length;
              const smallBtn = { border: `1px solid ${borderColor}`, background: "transparent", color: titleColor, borderRadius: 6, padding: "4px 8px", fontSize: 11, fontWeight: 700, cursor: "pointer" };
              return (
                <div key={side} style={{ background: "var(--panel)", border: `1px solid ${borderColor}`, borderRadius: 10, padding: 12, maxHeight: boardImportSide === side ? 460 : 260, overflowY: "auto" }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: titleColor, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8, position: "sticky", top: 0, background: "var(--panel)" }}>
                    {title}
                  </div>
                  <select
                    value={army ? army.id : ""}
                    onChange={(e) => setBoardArmySel((st) => ({ ...st, [side]: e.target.value }))}
                    style={{ width: "100%", marginBottom: 6, background: "var(--field-bg)", color: "var(--text)", border: "1px solid var(--field-border)", borderRadius: 6, padding: "5px 6px", fontSize: 12 }}
                  >
                    <option value="">Všechny jednotky z knihovny</option>
                    {[...armies].sort((x, y) => x.name.localeCompare(y.name)).map((a) => (
                      <option key={a.id} value={a.id}>{a.name} ({a.unitIds.length})</option>
                    ))}
                  </select>
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>
                    {army && (
                      <button className="wh40k-btn" onClick={() => addUnitsToBoardSide(army.unitIds.filter((id) => library.some((u) => u.id === id)), side)} style={smallBtn}>
                        Dát celou armádu na desku
                      </button>
                    )}
                    {sideTokens > 0 && (
                      <button className="wh40k-btn" onClick={() => clearSideTokens(side)} style={smallBtn}>Odebrat tokeny ({sideTokens})</button>
                    )}
                    <button className="wh40k-btn" onClick={() => setBoardImportSide((cur) => (cur === side ? "" : side))} style={smallBtn}>
                      <Upload size={11} style={{ verticalAlign: "-1px" }} /> Nahrát z New Recruit (JSON)
                    </button>
                  </div>
                  {boardImportSide === side && (
                    <div style={{ marginBottom: 8 }}>
                      <ImportBox
                        onImport={(units, rosterName) => {
                          const r = importFromNewRecruit(units, rosterName);
                          if (r.armyId) setBoardArmySel((st) => ({ ...st, [side]: r.armyId }));
                          addUnitsToBoardSide(r.unitIds, side, r.units);
                          return r;
                        }}
                      />
                    </div>
                  )}
                  {Object.entries(grouped).map(([faction, units]) => (
                    <div key={faction} style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 9.5, fontWeight: 700, color: "var(--amber)", textTransform: "uppercase", marginBottom: 3 }}>{faction}</div>
                      {units.map((u) => (
                        <label key={u.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: "2px 0", cursor: "pointer" }}>
                          <input type="checkbox" checked={board.tokens.some((t) => t.unitId === u.id && t.side === side)} onChange={() => toggleUnitOnBoard(u.id, side)} />
                          {u.name}
                          <span style={{ fontSize: 10, color: "var(--muted)" }}>{String(u.baseSize || 32).startsWith("hull:") ? `hull ${String(u.baseSize).slice(5).replace("x", "×")}mm` : `${u.baseSize || 32}mm`}</span>
                        </label>
                      ))}
                    </div>
                  ))}
                  {library.length === 0 && <div style={{ fontSize: 12, color: "var(--muted)" }}>Knihovna je prázdná — nahraj armádu z New Recruit tlačítkem výše.</div>}
                  {library.length > 0 && Object.keys(grouped).length === 0 && <div style={{ fontSize: 12, color: "var(--muted)" }}>V téhle armádě nejsou žádné jednotky z knihovny.</div>}
                </div>
              );
            })}
          </div>
            </div>

            <div style={{ minWidth: 0 }}>
          {drawMode && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 8,
                background: "var(--accent-dim)",
                border: "1px solid var(--accent)",
                borderRadius: 10,
                padding: "8px 10px",
              }}
            >
              <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--accent-text)" }}>
                Kreslíš svou zónu — stiskni na desce a táhni jako štětcem ({drawPoints.length} {drawPoints.length === 1 ? "bod" : "body"})
              </span>
              <div style={{ flex: 1 }} />
              <button
                onClick={finishDrawingZone}
                disabled={drawPoints.length < 3}
                className="wh40k-btn"
                style={{
                  border: "none",
                  background: drawPoints.length < 3 ? "var(--field-border)" : "var(--accent)",
                  color: drawPoints.length < 3 ? "var(--muted)" : "#fff",
                  borderRadius: 6,
                  padding: "5px 10px",
                  fontSize: 11.5,
                  fontWeight: 700,
                  cursor: drawPoints.length < 3 ? "not-allowed" : "pointer",
                }}
              >
                Dokončit
              </button>
              <button
                onClick={cancelDrawingZone}
                style={{ border: "1px solid var(--field-border)", background: "transparent", color: "var(--text)", borderRadius: 6, padding: "5px 10px", fontSize: 11.5, cursor: "pointer" }}
              >
                Zrušit
              </button>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 10, padding: "6px 8px" }}>
            <button
              onClick={() => setShowBoardGrid((v) => !v)}
              title="Mřížka po 1 palci"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                border: `1px solid ${showBoardGrid ? "var(--accent)" : "var(--field-border)"}`,
                background: showBoardGrid ? "var(--accent-dim)" : "transparent",
                color: showBoardGrid ? "var(--accent-text)" : "var(--muted)",
                borderRadius: 6,
                padding: "5px 8px",
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              <LayoutGrid size={13} /> Mřížka
            </button>
            <button
              onClick={clearBoardTokens}
              disabled={board.tokens.length === 0}
              title="Vyčistit desku"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                border: "1px solid var(--field-border)",
                background: "transparent",
                color: board.tokens.length === 0 ? "var(--muted)" : "var(--text)",
                borderRadius: 6,
                padding: "5px 8px",
                fontSize: 11,
                fontWeight: 600,
                cursor: board.tokens.length === 0 ? "not-allowed" : "pointer",
              }}
            >
              <Trash2 size={13} /> Vyčistit
            </button>
            <button
              onClick={toggleTerrainLocked}
              title={terrainLocked ? "Terén je zamčený - klikni pro odemknutí (úpravy, přesun podložek)" : "Terén je odemčený - klikni pro zamknutí"}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                border: `1px solid ${terrainLocked ? "var(--accent)" : "var(--field-border)"}`,
                background: terrainLocked ? "var(--accent-dim)" : "transparent",
                color: terrainLocked ? "var(--accent-text)" : "var(--muted)",
                borderRadius: 6,
                padding: "5px 8px",
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {terrainLocked ? <Lock size={13} /> : <Unlock size={13} />} {terrainLocked ? "Terén zamčený" : "Terén odemčený"}
            </button>
            <button
              onClick={toggleMoveWholeUnit}
              title="Při tažení se hýbe celá jednotka, nebo jen jeden model. Držení Alt přepne na opak, Shift při tažení vezme vždy jen jeden model. Označit víc modelů: táhni myší po prázdné desce (Shift přidává). Kolečko myši nad modelem otáčí jednotku (Shift = jemně)."
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                border: `1px solid ${moveWholeUnit ? "var(--accent)" : "var(--field-border)"}`,
                background: moveWholeUnit ? "var(--accent-dim)" : "transparent",
                color: moveWholeUnit ? "var(--accent-text)" : "var(--muted)",
                borderRadius: 6,
                padding: "5px 8px",
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {moveWholeUnit ? "Táhne celá jednotka" : "Táhne jeden model"}
            </button>
            <button
              onClick={rotateBoardView}
              title="Otočit pohled na desku o 90° (jen vzhled, data se nemění)"
              style={{ display: "flex", alignItems: "center", gap: 5, border: "1px solid var(--field-border)", background: "transparent", color: "var(--text)", borderRadius: 6, padding: "5px 8px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}
            >
              <RotateCw size={13} /> Otočit {viewRot}°
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
              <button
                onClick={() => zoomBoardTo(boardZoom / 1.25)}
                disabled={boardZoom <= 1}
                title="Oddálit"
                style={{ display: "flex", border: "1px solid var(--field-border)", background: "transparent", color: boardZoom <= 1 ? "var(--muted)" : "var(--text)", borderRadius: 6, padding: "5px 6px", cursor: boardZoom <= 1 ? "not-allowed" : "pointer" }}
              >
                <ZoomOut size={14} />
              </button>
              <button
                onClick={() => zoomBoardTo(1)}
                title="Zoom 100 % (Ctrl + kolečko přibližuje kolem kurzoru)"
                style={{ border: "1px solid var(--field-border)", background: "transparent", color: "var(--text)", borderRadius: 6, padding: "5px 6px", fontSize: 11, fontWeight: 600, cursor: "pointer", minWidth: 42 }}
              >
                {Math.round(boardZoom * 100)} %
              </button>
              <button
                onClick={() => zoomBoardTo(boardZoom * 1.25)}
                disabled={boardZoom >= 4}
                title="Přiblížit"
                style={{ display: "flex", border: "1px solid var(--field-border)", background: "transparent", color: boardZoom >= 4 ? "var(--muted)" : "var(--text)", borderRadius: 6, padding: "5px 6px", cursor: boardZoom >= 4 ? "not-allowed" : "pointer" }}
              >
                <ZoomIn size={14} />
              </button>
            </div>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--mono)" }}>
              {board.widthIn}×{board.heightIn}″
            </span>
          </div>

          {selectedTokenIds.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, background: "var(--panel)", border: "1px solid #ffd54a", borderRadius: 10, padding: "6px 10px", fontSize: 12 }}>
              <span style={{ fontWeight: 700 }}>Označeno modelů: {selectedTokenIds.length}</span>
              <span style={{ color: "var(--muted)", fontSize: 11 }}>táhni libovolný z nich - hýbou se spolu</span>
              <div style={{ flex: 1 }} />
              <button onClick={() => setSelectedTokenIds([])} style={{ border: "1px solid var(--field-border)", background: "transparent", color: "var(--text)", borderRadius: 6, padding: "4px 8px", fontSize: 11, cursor: "pointer" }}>
                Zrušit označení
              </button>
              <button onClick={removeSelectedTokens} style={{ border: "1px solid #c0392b", background: "transparent", color: "#e0857c", borderRadius: 6, padding: "4px 8px", fontSize: 11, cursor: "pointer" }}>
                Odebrat označené
              </button>
            </div>
          )}
          <div
            ref={boardScrollRef}
            style={{ width: "100%", overflow: boardZoom > 1 ? "auto" : "visible", maxHeight: boardZoom > 1 ? "88vh" : undefined, borderRadius: 8 }}
          >
            <div
              ref={boardSizedRef}
              style={{
                position: "relative",
                width: `${boardZoom * 100}%`,
                maxWidth: `calc(88vh * ${viewRot % 180 === 0 ? board.widthIn : board.heightIn} / ${viewRot % 180 === 0 ? board.heightIn : board.widthIn} * ${boardZoom})`,
                aspectRatio: viewRot % 180 === 0 ? `${board.widthIn} / ${board.heightIn}` : `${board.heightIn} / ${board.widthIn}`,
                margin: "0 auto",
              }}
            >
          <div
            ref={boardContainerRef}
            data-view-rot={viewRot}
            className="wh40k-board"
            data-grid={showBoardGrid ? "1" : undefined}
            onPointerDown={(e) => {
              if (!drawMode) {
                // Empty board space: start a marquee (Shift adds to the selection).
                if (e.target.closest("[data-board-piece]")) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                const pt = boardPctPoint(e);
                marqueeStartRef.current = { x: pt.x, y: pt.y, add: e.shiftKey };
                setMarquee({ x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y });
                return;
              }
              e.currentTarget.setPointerCapture(e.pointerId);
              drawStrokeActiveRef.current = true;
              const { x: xPct, y: yPct } = boardPctPoint(e);
              lastDrawPointRef.current = { x: xPct, y: yPct };
              addDrawPoint(xPct, yPct);
            }}
            onPointerMove={(e) => {
              if (marqueeStartRef.current) {
                const pt = boardPctPoint(e);
                const st = marqueeStartRef.current;
                setMarquee({ x0: st.x, y0: st.y, x1: pt.x, y1: pt.y });
                return;
              }
              if (!drawMode || !drawStrokeActiveRef.current) return;
              const { x: xPct, y: yPct } = boardPctPoint(e);
              const last = lastDrawPointRef.current;
              // Sample by distance, not by every pointermove event — a fast
              // drag can fire dozens of these a second, which would flood
              // the point list (and React) with far more detail than the
              // shape actually needs.
              if (last && Math.hypot(xPct - last.x, yPct - last.y) < 1.2) return;
              lastDrawPointRef.current = { x: xPct, y: yPct };
              addDrawPoint(xPct, yPct);
            }}
            onPointerUp={(e) => {
              if (marqueeStartRef.current) finishMarquee(e);
              drawStrokeActiveRef.current = false;
              lastDrawPointRef.current = null;
            }}
            onPointerCancel={() => {
              marqueeStartRef.current = null;
              setMarquee(null);
              drawStrokeActiveRef.current = false;
              lastDrawPointRef.current = null;
            }}
            onClick={(e) => {
              if (drawMode) return;
              // Clicking empty board space (not a token/terrain piece)
              // clears whatever's currently selected.
              if (e.target === e.currentTarget) {
                setSelectedTerrainId(null);
              }
            }}
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              // Pre-rotation size: for a quarter turn the box is turned so
              // that, rotated, it exactly fills the wrapper (see boardSizedRef).
              width: viewRot % 180 === 0 ? "100%" : `${(board.widthIn / board.heightIn) * 100}%`,
              transform: `translate(-50%, -50%) rotate(${viewRot}deg)`,
              "--bw": board.widthIn,
              "--bh": board.heightIn,
              aspectRatio: `${board.widthIn} / ${board.heightIn}`,
              background: "#2b3a2e",
              backgroundImage: showBoardGrid
                ? "repeating-linear-gradient(to right, rgba(255,255,255,0.18) 0, rgba(255,255,255,0.18) 1px, transparent 1px, transparent 100%), repeating-linear-gradient(to bottom, rgba(255,255,255,0.18) 0, rgba(255,255,255,0.18) 1px, transparent 1px, transparent 100%)"
                : "none",
              // One grid cell = 1 real inch, in both directions independently
              // (matches how token/terrain sizing works — % of width for the
              // x-axis, % of height for the y-axis — so the cells stay
              // square regardless of the board's own aspect ratio).
              backgroundSize: `${100 / board.widthIn}% ${100 / board.heightIn}%`,
              border: "2px solid var(--field-border)",
              borderRadius: 8,
              overflow: "hidden",
              touchAction: "none",
            }}
          >
            {/* Deployment zones — picked from allLayouts (the user's own
                saved layouts, starting from the 5 default numbered slots) by
                its color/shape swatch. A custom customZones.<side> overrides
                that side's swatch shape independently of the other side; see
                resolveZoneClips for the array-of-clip-strings vs
                flat-points-array formats it accepts. */}
            {(() => {
              const layout = allLayouts.find((l) => l.id === board.layoutId) || allLayouts[0];
              const cz = board.customZones || {};
              const theirsClips = resolveZoneClips(cz.theirs, layout.theirsClip);
              const mineClips = resolveZoneClips(cz.mine, layout.mineClip);
              return (
                <>
                  {theirsClips.map((clip, i) => (
                    <div key={`theirs-${i}`} style={{ position: "absolute", inset: 0, background: "var(--accent)", opacity: 0.16, clipPath: clip, pointerEvents: "none" }} />
                  ))}
                  {mineClips.map((clip, i) => (
                    <div key={`mine-${i}`} style={{ position: "absolute", inset: 0, background: "#c0392b", opacity: 0.16, clipPath: clip, pointerEvents: "none" }} />
                  ))}
                </>
              );
            })()}
            {/* Ruler numbers every 5" along the top and left edges — tied to
                the same grid toggle, since they're a reference for it. */}
            {showBoardGrid && (
              <>
                {Array.from({ length: Math.floor(board.widthIn / 5) + 1 }, (_, i) => i * 5).map((n) => (
                  <div
                    key={`ruler-x-${n}`}
                    style={{
                      position: "absolute",
                      left: `${(n / board.widthIn) * 100}%`,
                      top: 1,
                      transform: `translateX(2px) rotate(${-viewRot}deg)`,
                      fontSize: 8,
                      lineHeight: 1,
                      color: "rgba(255,255,255,0.55)",
                      fontFamily: "var(--mono)",
                      pointerEvents: "none",
                    }}
                  >
                    {n}
                  </div>
                ))}
                {Array.from({ length: Math.floor(board.heightIn / 5) + 1 }, (_, i) => i * 5).map((n) => (
                  <div
                    key={`ruler-y-${n}`}
                    style={{
                      position: "absolute",
                      top: `${(n / board.heightIn) * 100}%`,
                      left: 1,
                      transform: `translateY(2px) rotate(${-viewRot}deg)`,
                      fontSize: 8,
                      lineHeight: 1,
                      color: "rgba(255,255,255,0.55)",
                      fontFamily: "var(--mono)",
                      pointerEvents: "none",
                    }}
                  >
                    {n}
                  </div>
                ))}
              </>
            )}
            {/* In-progress freehand drawing overlay — the points the person
                has clicked so far, plus the closed shape once there are
                enough to form a polygon. */}
            {drawMode && drawPoints.length > 0 && (
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 5 }}>
                {drawPoints.length >= 3 && (
                  <polygon
                    points={drawPoints.map((p) => `${p.x},${p.y}`).join(" ")}
                    fill="rgba(192,57,43,0.25)"
                    stroke="none"
                  />
                )}
                <polyline
                  points={drawPoints.map((p) => `${p.x},${p.y}`).join(" ")}
                  fill="none"
                  stroke="#e0857c"
                  strokeWidth="0.4"
                  vectorEffect="non-scaling-stroke"
                />
                {drawPoints.map((p, i) => (
                  <circle key={i} cx={p.x} cy={p.y} r="0.7" fill="#fff" stroke="#111" strokeWidth="0.15" />
                ))}
              </svg>
            )}
            {[...(board.terrain || [])]
              .sort((a, b) => {
                // Base-layer pieces (a plinth) always render under terrain,
                // no matter the order they were placed/dragged in.
                const la = pieceShape(a)?.layer === "base" ? 0 : 1;
                const lb = pieceShape(b)?.layer === "base" ? 0 : 1;
                return la - lb;
              })
              .map((p) => {
              const shape = pieceShape(p);
              if (!shape) return null;
              const sizePctW = Math.max(0.8, ((p.widthIn || shape.widthIn) / board.widthIn) * 100);
              const sizePctH = Math.max(0.8, ((p.heightIn || shape.heightIn) / board.heightIn) * 100);
              return (
                <TerrainPieceView
                  key={p.id}
                  piece={p}
                  shape={shape}
                  containerRef={boardContainerRef}
                  sizePctW={sizePctW}
                  sizePctH={sizePctH}
                  selected={p.id === selectedTerrainId}
                  locked={terrainLocked}
                  onMove={moveTerrainPiece}
                  onCommit={commitBoardTokenMove}
                  onRemove={removeTerrainPiece}
                  onSelect={setSelectedTerrainId}
                />
              );
            })}
            {board.tokens.map((t) => {
              const unit = library.find((u) => u.id === t.unitId);
              // {w, h} in mm — equal for a round base, different for an oval
              // one (e.g. "90x52") — each converted to inches on its own
              // board axis, same as everywhere else a physical size becomes a
              // board percentage. border-radius:50% on a non-square box
              // already renders as an ellipse, so no extra shape logic needed
              // in BoardTokenView itself for an oval base.
              const baseMm = parseBaseSizeMm(unit ? unit.baseSize : 32);
              const sizePctW = Math.max(1.2, (baseMm.w / 25.4 / board.widthIn) * 100);
              const sizePctH = Math.max(1.2, (baseMm.h / 25.4 / board.heightIn) * 100);
              return (
                <BoardTokenView
                  key={t.id}
                  token={t}
                  unit={unit}
                  containerRef={boardContainerRef}
                  sizePctW={sizePctW}
                  sizePctH={sizePctH}
                  rectBase={baseMm.rect}
                  viewRot={viewRot}
                  selected={t.id === boardAttackerTokenId}
                  multiSelected={selectedTokenIds.includes(t.id)}
                  onDragStart={beginTokenDrag}
                  onMove={moveBoardToken}
                  onCommit={commitBoardTokenMove}
                  onRemove={removeBoardToken}
                  onSelect={handleBoardTokenSelect}
                />
              );
            })}
            {uiTheme === "tactical" && (
              <>
                {/* compass (top-right) and a 6" scale bar (bottom-right) */}
                <svg viewBox="0 0 60 60" width="54" height="54" style={{ position: "absolute", right: 8, top: 8, pointerEvents: "none", zIndex: 4, opacity: 0.85 }}>
                  <circle cx="30" cy="30" r="22" fill="rgba(4,16,34,0.55)" stroke="#5fb0ff" strokeWidth="1" />
                  <path d="M30 6 L35 30 L30 54 L25 30 Z" fill="rgba(95,176,255,0.35)" stroke="#8fd0ff" strokeWidth="0.8" />
                  <path d="M6 30 L30 25 L54 30 L30 35 Z" fill="rgba(95,176,255,0.18)" stroke="#8fd0ff" strokeWidth="0.8" />
                  <text x="30" y="5" textAnchor="middle" fontSize="7" fontWeight="700" fill="#fff">N</text>
                  <text x="30" y="59" textAnchor="middle" fontSize="6" fill="#8fd0ff">S</text>
                  <text x="3" y="32" textAnchor="middle" fontSize="6" fill="#8fd0ff">W</text>
                  <text x="57" y="32" textAnchor="middle" fontSize="6" fill="#8fd0ff">E</text>
                </svg>
                <div style={{ position: "absolute", right: 10, bottom: 8, pointerEvents: "none", zIndex: 4, width: `${(6 / board.widthIn) * 100}%`, minWidth: 40, textAlign: "center", color: "#cfe8ff", fontSize: 10, fontWeight: 700, textShadow: "0 0 6px #000" }}>
                  6″
                  <div style={{ height: 5, borderLeft: "2px solid #8fd0ff", borderRight: "2px solid #8fd0ff", borderBottom: "2px solid #8fd0ff" }} />
                </div>
              </>
            )}
            {marquee && (
              <div
                style={{
                  position: "absolute",
                  left: `${Math.min(marquee.x0, marquee.x1)}%`,
                  top: `${Math.min(marquee.y0, marquee.y1)}%`,
                  width: `${Math.abs(marquee.x1 - marquee.x0)}%`,
                  height: `${Math.abs(marquee.y1 - marquee.y0)}%`,
                  border: "1px dashed #ffd54a",
                  background: "rgba(255,213,74,0.12)",
                  pointerEvents: "none",
                  zIndex: 5,
                }}
              />
            )}
          </div>
            </div>
          </div>

          {selectedTerrainId &&
            (() => {
              const piece = (board.terrain || []).find((p) => p.id === selectedTerrainId);
              const shape = piece && pieceShape(piece);
              if (!piece || !shape) return null;
              return (
                <div style={{ marginTop: 10, background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 10, padding: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ display: "inline-block", width: 16, height: 12, background: shape.bg, border: shape.border, borderRadius: shape.radius, clipPath: shape.clipPath }} />
                      {shape.label}
                    </div>
                    <button
                      onClick={() => setSelectedTerrainId(null)}
                      style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", padding: 0, fontSize: 13, lineHeight: 1 }}
                      title="Zavřít"
                    >
                      ✕
                    </button>
                  </div>
                  <Row cols={3}>
                    <NumberField
                      label="Šířka (in)"
                      value={piece.widthIn}
                      onChange={(v) => updateTerrainPiece(piece.id, { widthIn: Math.max(0.5, v) })}
                      min={0.5}
                      small
                    />
                    <NumberField
                      label="Výška (in)"
                      value={piece.heightIn}
                      onChange={(v) => updateTerrainPiece(piece.id, { heightIn: Math.max(0.5, v) })}
                      min={0.5}
                      small
                    />
                    <NumberField
                      label="Otočení (°)"
                      value={piece.rotationDeg || 0}
                      onChange={(v) => updateTerrainPiece(piece.id, { rotationDeg: ((v % 360) + 360) % 360 })}
                      small
                    />
                  </Row>
                  {(() => {
                    // Position by a chosen corner (or the center) of the piece,
                    // measured from that corner's OWN matching board edges — a
                    // top-left piece corner from the left+top board edges, a
                    // top-right corner from the right+top edges, etc. (like a
                    // dimensioned floor plan) — rather than always from the
                    // board's top-left. The piece is stored as its center +
                    // rotation, so the chosen point's offset from the center is
                    // worked out with the rotation applied.
                    const dirs = { tl: [-1, -1], tr: [1, -1], bl: [-1, 1], br: [1, 1], c: [-1, -1] };
                    const [sx, sy] = dirs[terrainAnchor] || dirs.tl;
                    const th = ((piece.rotationDeg || 0) * Math.PI) / 180;
                    const lx = (sx * piece.widthIn) / 2;
                    const ly = (sy * piece.heightIn) / 2;
                    const rx = lx * Math.cos(th) - ly * Math.sin(th);
                    const ry = lx * Math.sin(th) + ly * Math.cos(th);
                    const ax = (piece.xPct / 100) * board.widthIn + rx;
                    const ay = (piece.yPct / 100) * board.heightIn + ry;
                    const r2 = (n) => Math.round(n * 100) / 100;
                    // Right/bottom-anchored corners measure from the far edge
                    // inward, so the number shown is the gap to that edge.
                    const fromRight = terrainAnchor === "tr" || terrainAnchor === "br";
                    const fromBottom = terrainAnchor === "bl" || terrainAnchor === "br";
                    const xShown = fromRight ? board.widthIn - ax : ax;
                    const yShown = fromBottom ? board.heightIn - ay : ay;
                    const xToAx = (v) => (fromRight ? board.widthIn - v : v);
                    const yToAy = (v) => (fromBottom ? board.heightIn - v : v);
                    return (
                      <div style={{ marginTop: 8 }}>
                        <Row cols={3}>
                          <SelectField
                            label="Umístit bod"
                            value={terrainAnchor}
                            onChange={setTerrainAnchor}
                            options={[
                              { value: "tl", label: "Levý horní roh" },
                              { value: "tr", label: "Pravý horní roh" },
                              { value: "bl", label: "Levý dolní roh" },
                              { value: "br", label: "Pravý dolní roh" },
                              { value: "c", label: "Střed" },
                            ]}
                            small
                          />
                          <NumberField
                            label={`X od ${fromRight ? "pravého" : "levého"} okraje (in)`}
                            value={r2(xShown)}
                            step={0.25}
                            onChange={(v) => updateTerrainPiece(piece.id, { xPct: ((xToAx(v) - rx) / board.widthIn) * 100 })}
                            small
                          />
                          <NumberField
                            label={`Y od ${fromBottom ? "dolního" : "horního"} okraje (in)`}
                            value={r2(yShown)}
                            step={0.25}
                            onChange={(v) => updateTerrainPiece(piece.id, { yPct: ((yToAy(v) - ry) / board.heightIn) * 100 })}
                            small
                          />
                        </Row>
                      </div>
                    );
                  })()}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                    <button
                      onClick={() => duplicateTerrainPiece(piece.id)}
                      title="Zkopíruje kus (Ctrl+D; nebo Ctrl+C a Ctrl+V)"
                      style={{ display: "flex", alignItems: "center", gap: 5, border: "1px solid var(--accent)", background: "transparent", color: "var(--accent-text)", borderRadius: 6, padding: "6px 10px", fontSize: 12, cursor: "pointer" }}
                    >
                      <Copy size={13} /> Kopírovat kus
                    </button>
                    <button
                      onClick={() => removeTerrainPiece(piece.id)}
                      style={{ display: "flex", alignItems: "center", gap: 5, border: "1px solid #c0392b", background: "transparent", color: "#e0857c", borderRadius: 6, padding: "6px 10px", fontSize: 12, cursor: "pointer" }}
                    >
                      <Trash2 size={13} /> Odebrat kus terénu
                    </button>
                  </div>
                </div>
              );
            })()}

          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8, textAlign: "center" }}>
            {boardAttackerTokenId
              ? "Klikni na token protihráče pro rychlý výpočet souboje."
              : "Klikni na svůj token, pak na token protihráče, pro rychlý výpočet souboje."}
          </div>

          {boardMatchup && (
            <div style={{ marginTop: 10, background: "var(--panel)", border: "1px solid var(--accent)", borderRadius: 10, padding: 12 }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700 }}>
                  {boardMatchup.attackerUnit.name} <span style={{ color: "var(--muted)", fontWeight: 400 }}>→</span> {boardMatchup.defenderUnit.name}
                </div>
                <button
                  onClick={() => setBoardMatchup(null)}
                  style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", padding: 0, fontSize: 13, lineHeight: 1 }}
                  title="Zavřít"
                >
                  ✕
                </button>
              </div>
              <div style={{ display: "flex", gap: 16, marginTop: 8 }}>
                <div>
                  <div style={{ fontSize: 9.5, color: "var(--muted)", textTransform: "uppercase" }}>Zabité modely</div>
                  <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "var(--mono)", color: "var(--accent-text)" }}>{fmt(boardMatchup.res.killedModels)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 9.5, color: "var(--muted)", textTransform: "uppercase" }}>Damage</div>
                  <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "var(--mono)", color: "var(--text)" }}>{fmt(boardMatchup.res.totalDamage)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 9.5, color: "var(--muted)", textTransform: "uppercase" }}>Zbývá z jednotky</div>
                  <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "var(--mono)", color: "var(--text)" }}>{pct(boardMatchup.res.remainingPct)}</div>
                </div>
              </div>
              <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 6 }}>Jen vestavěné schopnosti obou jednotek, bez dalších bonusů/modifikátorů.</div>
              <button
                onClick={() => {
                  setAttackerUnitId(boardMatchup.attackerUnit.id);
                  setDefenderUnitId(boardMatchup.defenderUnit.id);
                  setCalcStep("setup");
                  setView("calculator");
                }}
                className="wh40k-btn"
                style={{ marginTop: 10, border: "none", background: "var(--accent)", color: "#fff", borderRadius: 6, padding: "7px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
              >
                Otevřít v kalkulačce (s modifikátory)
              </button>
            </div>
          )}
            </div>
          </div>
        </div>
      )}

      {/* BOTTOM NAV */}
      <div className="no-print" style={{ position: "absolute", bottom: 0, left: 0, right: 0, display: "flex", borderTop: "1px solid var(--field-border)", background: "rgba(8,14,23,0.97)", backdropFilter: "blur(8px)" }}>
        {[
          ["home", Home, "Domů"],
          ["calculator", Crosshair, "Kalkulačka"],
          ["board", MapIcon, "Herní deska"],
          ["library", SkullIcon, "Knihovna"],
          ["history", Clock, "Historie"],
          ["lists", List, "Cheat sheet"],
        ].map(([key, Icon, label]) => (
          <button
            key={key}
            onClick={() => setView(key)}
            style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "9px 0 10px", background: "transparent", border: "none", cursor: "pointer", color: view === key ? "var(--accent-text)" : "var(--muted)" }}
          >
            <Icon size={17} />
            <span style={{ fontSize: 8.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</span>
          </button>
        ))}
      </div>

      {/* Custom confirm/alert dialogs — replace window.confirm/alert, which can be
          unreliable inside a sandboxed artifact iframe. */}
      {(confirmDialog || alertMessage) && (
        <div
          className="no-print"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
            padding: 20,
          }}
        >
          <div style={{ background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 12, padding: 18, maxWidth: 320, boxShadow: "0 12px 32px rgba(0,0,0,0.5)" }}>
            <div style={{ fontSize: 13.5, color: "var(--text)", marginBottom: 16, lineHeight: 1.5 }}>{confirmDialog ? confirmDialog.message : alertMessage}</div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              {confirmDialog && (
                <button
                  onClick={() => setConfirmDialog(null)}
                  style={{ border: "1px solid var(--field-border)", background: "transparent", color: "var(--text)", borderRadius: 6, padding: "7px 14px", fontSize: 13, cursor: "pointer" }}
                >
                  Zrušit
                </button>
              )}
              <button
                onClick={() => {
                  if (confirmDialog) confirmDialog.onConfirm();
                  setConfirmDialog(null);
                  setAlertMessage(null);
                }}
                className="wh40k-btn"
                style={{ border: "none", background: confirmDialog ? "#c0413a" : "var(--accent)", color: "#fff", borderRadius: 6, padding: "7px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
              >
                {confirmDialog ? "Ano, smazat" : "OK"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

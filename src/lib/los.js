// Line of sight on the battlefield board.
//
// Rule modelled (the common "Obscuring ruins" convention): a model can see
// another if a straight line can be drawn from any part of its base to any part
// of the target's base without crossing a blocking terrain piece - except that
// a piece never blocks sight for a model standing inside it (you can see out of
// and into a ruin you are in). Other models never block sight. Which pieces
// block is per piece (`blocksLos`, default: everything except objective
// markers and plinths), because layouts and editions differ.
//
// All geometry here is in inches; tokens/pieces store board positions as
// percentages, converted by the helpers below.

const SAMPLE_ANGLES = 8;

// ---- terrain footprints --------------------------------------------------

// "polygon(10% 20%, 30% 40%, ...)" -> [[0.1,0.2],[0.3,0.4],...] (fractions of the box)
export function parsePolygonClip(clip) {
  if (typeof clip !== "string") return null;
  const m = /^\s*polygon\((.*)\)\s*$/i.exec(clip);
  if (!m) return null;
  const pts = m[1].split(",").map((pair) => {
    const nums = pair.trim().split(/\s+/);
    if (nums.length !== 2) return null;
    const [x, y] = nums.map((n) => (n.endsWith("%") ? parseFloat(n) / 100 : NaN));
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
  });
  return pts.length >= 3 && pts.every(Boolean) ? pts : null;
}

const RECT = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

export function blocksByDefault(piece, shape) {
  if (!shape) return false;
  if (String(shape.id || "").startsWith("obj-")) return false;
  if (shape.layer === "base") return false;
  return true;
}

// Footprints of everything that blocks sight, as polygons in inches.
// `shapeOf(piece)` returns the piece's shape definition (see pieceShape in App.jsx).
export function buildBlockers(terrain, boardW, boardH, shapeOf) {
  const out = [];
  (terrain || []).forEach((piece) => {
    const shape = shapeOf(piece);
    if (!shape) return;
    const blocks = piece.blocksLos === undefined ? blocksByDefault(piece, shape) : !!piece.blocksLos;
    if (!blocks) return;
    const w = piece.widthIn || shape.widthIn;
    const h = piece.heightIn || shape.heightIn;
    if (!(w > 0) || !(h > 0)) return;
    const cx = (piece.xPct / 100) * boardW;
    const cy = (piece.yPct / 100) * boardH;
    const rot = ((piece.rotationDeg || 0) * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    // box-fraction point -> board inches, rotating about the box centre (CSS: rotate clockwise, y down)
    const toBoard = ([fx, fy]) => {
      const lx = (fx - 0.5) * w;
      const ly = (fy - 0.5) * h;
      return [cx + lx * cos - ly * sin, cy + lx * sin + ly * cos];
    };

    let polys;
    if (shape.bare && Array.isArray(shape.parts) && shape.parts.length > 0) {
      // A bare piece has no plate: only its wall parts are solid.
      polys = shape.parts.map((pt) => {
        const x0 = pt.leftPct / 100;
        const y0 = pt.topPct / 100;
        const x1 = x0 + pt.widthPct / 100;
        const y1 = y0 + pt.heightPct / 100;
        return [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
        ];
      });
    } else {
      polys = [parsePolygonClip(shape.clipPath) || RECT];
    }
    polys.forEach((frac) => out.push({ id: piece.id, poly: frac.map(toBoard) }));
  });
  return out;
}

// ---- tokens ----------------------------------------------------------------

// Position and base size of a token in inches. `baseMm` is {w, h} (see parseBaseSizeMm).
export function tokenGeometry(token, baseMm, boardW, boardH) {
  return {
    id: token.id,
    cx: (token.xPct / 100) * boardW,
    cy: (token.yPct / 100) * boardH,
    rx: baseMm.w / 25.4 / 2,
    ry: baseMm.h / 25.4 / 2,
  };
}

function samplePoints(g, withEdge) {
  const pts = [[g.cx, g.cy]];
  if (withEdge) {
    for (let i = 0; i < SAMPLE_ANGLES; i++) {
      const a = (i / SAMPLE_ANGLES) * Math.PI * 2;
      pts.push([g.cx + g.rx * Math.cos(a), g.cy + g.ry * Math.sin(a)]);
    }
  }
  return pts;
}

// ---- segment / polygon tests ---------------------------------------------------

function orient(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}
function onSegment(ax, ay, bx, by, px, py) {
  return Math.min(ax, bx) - 1e-9 <= px && px <= Math.max(ax, bx) + 1e-9 && Math.min(ay, by) - 1e-9 <= py && py <= Math.max(ay, by) + 1e-9;
}
export function segmentsIntersect(p1, p2, p3, p4) {
  const d1 = orient(p3[0], p3[1], p4[0], p4[1], p1[0], p1[1]);
  const d2 = orient(p3[0], p3[1], p4[0], p4[1], p2[0], p2[1]);
  const d3 = orient(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
  const d4 = orient(p1[0], p1[1], p2[0], p2[1], p4[0], p4[1]);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (Math.abs(d1) < 1e-12 && onSegment(p3[0], p3[1], p4[0], p4[1], p1[0], p1[1])) return true;
  if (Math.abs(d2) < 1e-12 && onSegment(p3[0], p3[1], p4[0], p4[1], p2[0], p2[1])) return true;
  if (Math.abs(d3) < 1e-12 && onSegment(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1])) return true;
  if (Math.abs(d4) < 1e-12 && onSegment(p1[0], p1[1], p2[0], p2[1], p4[0], p4[1])) return true;
  return false;
}

export function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentCrossesPolygon(a, b, poly) {
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (segmentsIntersect(a, b, poly[j], poly[i])) return true;
  }
  return false;
}

// ---- visibility ---------------------------------------------------------------

// Can `observer` see `target`? Returns { visible, from } where `from`/`to` are
// the board points (inches) of a clear line when visible.
export function canSee(observer, target, blockers) {
  const oc = [observer.cx, observer.cy];
  const tc = [target.cx, target.cy];
  // Pieces either model stands in never block that pair.
  const active = blockers.filter((b) => !pointInPolygon(oc, b.poly) && !pointInPolygon(tc, b.poly));
  const obsPts = samplePoints(observer, true);
  const tgtPts = samplePoints(target, true);
  for (const a of obsPts) {
    for (const b of tgtPts) {
      if (!active.some((bl) => segmentCrossesPolygon(a, b, bl.poly))) return { visible: true, from: a, to: b };
    }
  }
  return { visible: false, from: oc, to: tc };
}

// Observer unit (all its models) against every target model. A target model is
// visible when at least one observer model sees it. Returns one entry per target.
export function computeLineOfSight(observers, targets, blockers) {
  return targets.map((target) => {
    let best = null;
    let nearest = null;
    let nearestD = Infinity;
    for (const obs of observers) {
      const r = canSee(obs, target, blockers);
      if (r.visible) {
        best = { observerId: obs.id, from: r.from, to: r.to };
        break;
      }
      const d = Math.hypot(obs.cx - target.cx, obs.cy - target.cy);
      if (d < nearestD) {
        nearestD = d;
        nearest = obs;
      }
    }
    if (best) return { targetId: target.id, visible: true, observerId: best.observerId };
    return { targetId: target.id, visible: false, observerId: nearest ? nearest.id : null };
  });
}

import { describe, it, expect } from "vitest";
import { buildBlockers, canSee, computeLineOfSight, parsePolygonClip, pointInPolygon, segmentsIntersect, tokenGeometry } from "../los.js";

const W = 44;
const H = 60;
const shapes = {
  ruin: { id: "ruin", layer: "terrain", widthIn: 8, heightIn: 5 },
  obj: { id: "obj-center", layer: "terrain", widthIn: 1.6, heightIn: 1.6 },
  plinth: { id: "plinth", layer: "base", widthIn: 6, heightIn: 6 },
};
const piece = (shapeId, xIn, yIn, extra = {}) => ({ id: `${shapeId}-${xIn}-${yIn}`, shapeId, xPct: (xIn / W) * 100, yPct: (yIn / H) * 100, ...extra });
const blockersFor = (pieces) => buildBlockers(pieces, W, H, (p) => shapes[p.shapeId]);
const tok = (id, xIn, yIn, mm = 32) => tokenGeometry({ id, xPct: (xIn / W) * 100, yPct: (yIn / H) * 100 }, { w: mm, h: mm }, W, H);

describe("geometry helpers", () => {
  it("segment intersection", () => {
    expect(segmentsIntersect([0, 0], [4, 4], [0, 4], [4, 0])).toBe(true);
    expect(segmentsIntersect([0, 0], [1, 1], [2, 2], [3, 3])).toBe(false);
    expect(segmentsIntersect([0, 0], [2, 0], [1, 0], [3, 0])).toBe(true); // collinear overlap
  });
  it("point in polygon", () => {
    const sq = [[0, 0], [4, 0], [4, 4], [0, 4]];
    expect(pointInPolygon([2, 2], sq)).toBe(true);
    expect(pointInPolygon([5, 2], sq)).toBe(false);
  });
  it("parses CSS polygon clip paths", () => {
    expect(parsePolygonClip("polygon(0% 0%, 100% 0%, 50% 100%)")).toEqual([[0, 0], [1, 0], [0.5, 1]]);
    expect(parsePolygonClip("circle(50%)")).toBeNull();
    expect(parsePolygonClip("polygon(0px 0px, 1px 1px, 2px 2px)")).toBeNull();
  });
});

describe("line of sight", () => {
  it("is clear on an open board", () => {
    expect(canSee(tok("a", 10, 10), tok("b", 30, 30), []).visible).toBe(true);
  });

  it("is blocked by a ruin between two models", () => {
    const bl = blockersFor([piece("ruin", 20, 20)]); // 8x5 box centred on (20,20)
    expect(canSee(tok("a", 20, 10), tok("b", 20, 30), bl).visible).toBe(false);
  });

  it("is clear when the ruin is not in the way", () => {
    const bl = blockersFor([piece("ruin", 40, 40)]);
    expect(canSee(tok("a", 20, 10), tok("b", 20, 30), bl).visible).toBe(true);
  });

  it("a model standing inside the ruin sees out of it", () => {
    const bl = blockersFor([piece("ruin", 20, 20)]);
    expect(canSee(tok("a", 20, 20), tok("b", 20, 40), bl).visible).toBe(true);
  });

  it("sees around the corner of a ruin using the edge of the base", () => {
    const bl = blockersFor([piece("ruin", 20, 20)]); // x 16..24, y 17.5..22.5
    // observer far to the left of the footprint, target just past the corner: clear line exists
    expect(canSee(tok("a", 5, 10), tok("b", 30, 40), bl).visible).toBe(true);
  });

  it("respects rotation of the piece", () => {
    // A thin ruin rotated 90deg stands north-south instead of east-west
    const flat = blockersFor([piece("ruin", 20, 20, { widthIn: 8, heightIn: 1, rotationDeg: 0 })]);
    const upright = blockersFor([piece("ruin", 20, 20, { widthIn: 8, heightIn: 1, rotationDeg: 90 })]);
    const a = tok("a", 20, 10);
    const b = tok("b", 20, 30);
    expect(canSee(a, b, flat).visible).toBe(false);
    expect(canSee(a, b, upright).visible).toBe(true);
  });

  it("objective markers and plinths never block; blocksLos can override", () => {
    const a = tok("a", 20, 10);
    const b = tok("b", 20, 30);
    expect(canSee(a, b, blockersFor([piece("obj", 20, 20)])).visible).toBe(true);
    expect(canSee(a, b, blockersFor([piece("plinth", 20, 20)])).visible).toBe(true);
    expect(canSee(a, b, blockersFor([piece("ruin", 20, 20, { blocksLos: false })])).visible).toBe(true);
    expect(canSee(a, b, blockersFor([piece("plinth", 20, 20, { blocksLos: true })])).visible).toBe(false);
  });

  it("a unit sees a target if any of its models does", () => {
    const bl = blockersFor([piece("ruin", 20, 20, { widthIn: 2, heightIn: 12 })]); // tall thin wall x 19..21
    const observers = [tok("o1", 18, 10), tok("o2", 30, 10)];
    const targets = [tok("t1", 18, 30), tok("t2", 28, 30)];
    const r = computeLineOfSight(observers, targets, bl);
    // o1 is on the left of the wall and cannot see t2 across it, but o2 (right side) can
    expect(r.find((x) => x.targetId === "t2").visible).toBe(true);
    expect(r.every((x) => x.visible)).toBe(true);
  });

  it("reports blocked targets with the nearest observer", () => {
    const bl = blockersFor([piece("ruin", 20, 20, { widthIn: 40, heightIn: 2 })]); // wall across the whole board width
    const r = computeLineOfSight([tok("o1", 20, 10)], [tok("t1", 20, 30)], bl);
    expect(r[0]).toEqual({ targetId: "t1", visible: false, observerId: "o1" });
  });
});

// Reading roster files exported from New Recruit / BattleScribe.
//
//   .json  - New Recruit JSON export (handled by parseBattleScribeJSON in App.jsx)
//   .rosz  - zipped BattleScribe roster (a .ros XML inside)
//   .ros   - BattleScribe roster XML
//
// The existing parser understands the JSON shape, so XML rosters are converted
// to exactly that shape here (roster.forces[].selections[] with profiles,
// characteristics as {name, $text}, categories, costs, rules) and handed over
// as JSON text. Nothing here talks to the network or the DOM except DOMParser.
import { unzipSync, strFromU8 } from "fflate";

const children = (el, tag) => Array.from(el.children).filter((c) => c.tagName === tag);
const childrenOf = (el, wrapperTag, itemTag) => {
  const wrapper = children(el, wrapperTag)[0];
  return wrapper ? children(wrapper, itemTag) : [];
};

function numberAttr(el, name, fallback) {
  const n = parseFloat(el.getAttribute(name));
  return Number.isFinite(n) ? n : fallback;
}

function selectionToJson(sel) {
  const out = {
    id: sel.getAttribute("id") || undefined,
    name: sel.getAttribute("name") || "",
    number: numberAttr(sel, "number", 1),
    type: sel.getAttribute("type") || "",
    profiles: childrenOf(sel, "profiles", "profile").map((p) => ({
      name: p.getAttribute("name") || "",
      typeName: p.getAttribute("typeName") || "",
      characteristics: childrenOf(p, "characteristics", "characteristic").map((c) => ({
        name: c.getAttribute("name") || "",
        $text: c.textContent || "",
      })),
    })),
    categories: childrenOf(sel, "categories", "category").map((c) => ({ name: c.getAttribute("name") || "" })),
    costs: childrenOf(sel, "costs", "cost").map((c) => ({ name: c.getAttribute("name") || "", value: numberAttr(c, "value", 0) })),
    rules: childrenOf(sel, "rules", "rule").map((r) => ({
      name: r.getAttribute("name") || "",
      description: (children(r, "description")[0] || { textContent: "" }).textContent || "",
    })),
    selections: childrenOf(sel, "selections", "selection").map(selectionToJson),
  };
  return out;
}

// Converts BattleScribe roster XML to the JSON text parseBattleScribeJSON reads.
export function rosterXmlToJsonText(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) throw new Error("Neplatné XML rosteru.");
  const root = doc.documentElement;
  if (!root || root.tagName !== "roster") throw new Error("Soubor není BattleScribe/New Recruit roster.");
  const forces = childrenOf(root, "forces", "force").map((f) => ({
    name: f.getAttribute("name") || "",
    catalogueName: f.getAttribute("catalogueName") || "",
    selections: childrenOf(f, "selections", "selection").map(selectionToJson),
  }));
  return JSON.stringify({ roster: { name: root.getAttribute("name") || "", forces } });
}

const isZip = (u8) => u8.length > 3 && u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04;

// Reads a roster file's bytes and returns text the import box understands:
// JSON text (for .json, or converted from .ros/.rosz) or plain text.
export function rosterBytesToText(bytes) {
  const u8 = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
  if (isZip(u8)) {
    const files = unzipSync(u8, { filter: (f) => /\.ros$/i.test(f.name) });
    const name = Object.keys(files)[0];
    if (!name) throw new Error("V archivu .rosz není žádný soubor .ros.");
    return rosterXmlToJsonText(strFromU8(files[name]));
  }
  const text = strFromU8(u8).replace(/^﻿/, "");
  if (text.trimStart().startsWith("<")) return rosterXmlToJsonText(text);
  return text;
}

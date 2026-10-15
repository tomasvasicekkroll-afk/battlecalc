// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { rosterBytesToText, rosterXmlToJsonText } from "../roster.js";
import { parseBattleScribeJSON } from "../../App.jsx";

// Fictional roster in the BattleScribe .ros shape - invented units and stats.
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<roster id="r1" name="Test Roster" battleScribeVersion="2.03">
  <forces>
    <force id="f1" name="Detachment" catalogueName="Imperium - Demo Legion">
      <selections>
        <selection id="u1" name="Demo Blasters" number="1" type="unit">
          <costs><cost name="pts" value="120"/></costs>
          <categories><category name="Infantry"/></categories>
          <profiles>
            <profile id="p1" name="Demo Blasters" typeName="Unit">
              <characteristics>
                <characteristic name="T">4</characteristic>
                <characteristic name="Sv">3+</characteristic>
                <characteristic name="W">2</characteristic>
              </characteristics>
            </profile>
          </profiles>
          <selections>
            <selection id="s1" name="Demo Rifle" number="5" type="upgrade">
              <profiles>
                <profile id="w1" name="Demo Rifle" typeName="Ranged Weapons">
                  <characteristics>
                    <characteristic name="Range">24"</characteristic>
                    <characteristic name="A">2</characteristic>
                    <characteristic name="BS">3+</characteristic>
                    <characteristic name="S">4</characteristic>
                    <characteristic name="AP">0</characteristic>
                    <characteristic name="D">1</characteristic>
                    <characteristic name="Keywords">Rapid Fire 1</characteristic>
                  </characteristics>
                </profile>
              </profiles>
            </selection>
            <selection id="m1" name="Demo Trooper" number="5" type="model"/>
          </selections>
        </selection>
      </selections>
    </force>
  </forces>
</roster>`;

// jsdom has its own Uint8Array, so bytes made by Node's TextEncoder must be
// re-wrapped or fflate (which checks instanceof) takes them for a nested folder.
const bytes = (str) => new Uint8Array(strToU8(str));

describe("roster files", () => {
  it("converts roster XML into the JSON shape the importer reads", () => {
    const json = JSON.parse(rosterXmlToJsonText(XML));
    expect(json.roster.name).toBe("Test Roster");
    const unit = json.roster.forces[0].selections[0];
    expect(unit.profiles[0].characteristics.find((c) => c.name === "T").$text).toBe("4");
    expect(unit.costs[0]).toEqual({ name: "pts", value: 120 });
    expect(unit.selections[0].number).toBe(5);
  });

  it("imports a unit with real stats from XML", () => {
    const units = parseBattleScribeJSON(rosterXmlToJsonText(XML));
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("Demo Blasters");
    expect(units[0].faction).toBe("Demo Legion");
    expect(units[0].points).toBe("120");
    expect(units[0].modelCount).toBe(5);
    const w = units[0].members[0].weapons[0];
    expect(w.hitX).toBe(3);
    expect(w.strength).toBe(4);
    expect(w.attacks).toBe(2);
  });

  it("reads a zipped .rosz", () => {
    const zip = zipSync({ "Test Roster.ros": bytes(XML) });
    const text = rosterBytesToText(zip);
    expect(JSON.parse(text).roster.forces[0].catalogueName).toContain("Demo Legion");
  });

  it("passes JSON and plain text through untouched", () => {
    expect(rosterBytesToText(bytes('{"roster":{"forces":[]}}'))).toBe('{"roster":{"forces":[]}}');
    expect(rosterBytesToText(bytes("1x Something (100 pts)"))).toBe("1x Something (100 pts)");
  });

  it("rejects non-roster XML and empty zips", () => {
    expect(() => rosterBytesToText(bytes("<foo/>"))).toThrow();
    expect(() => rosterBytesToText(zipSync({ "readme.txt": bytes("x") }))).toThrow();
  });
});

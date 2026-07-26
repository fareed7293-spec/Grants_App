import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { computeGrant, resolveRates } from "./calculator.js";

const scheme = JSON.parse(readFileSync(new URL("./scheme.json", import.meta.url)));
const rateTable = JSON.parse(readFileSync(new URL("./rates.json", import.meta.url)));

const ctrB = {
  centreType: "rural", caseload: 38, licenceActiveFullQuarter: true, coFunding: 4500,
  staff: [
    { role: "Senior Social Worker", qualified: true, onPayrollFullQuarter: true },
    { role: "Social Worker", qualified: true, onPayrollFullQuarter: true },
    { role: "Social Worker", qualified: true, onPayrollFullQuarter: true },
    { role: "Programme Assistant", qualified: true, onPayrollFullQuarter: true },
  ],
};

test("Scenario 1 matches hand-computed figures", () => {
  const rates = resolveRates(rateTable, "2026-07-01");
  const r = computeGrant(scheme, rates, ctrB);
  assert.equal(r.normativeCost, 56100);   // (6200*3)+(4800*3*2)+(2900*3)
  assert.equal(r.tierPercent, 0.90);      // rural, caseload 38 -> 20-39 band
  assert.equal(r.grossGrant, 50490);
  assert.equal(r.netGrant, 45990);
  const byParty = Object.fromEntries(r.split.map((s) => [s.party, s.amount]));
  assert.equal(byParty["Ministry"], 27594);
  assert.equal(byParty["Community Chest"], 11497.5);
  assert.equal(byParty["Town Council Social Support"], 6898.5);
  assert.equal(r.split.reduce((s, x) => s + x.amount, 0), r.netGrant);
});

test("re-running a past quarter after a rate revision uses the OLD rate, not today's", () => {
  assert.equal(resolveRates(rateTable, "2026-07-01")["Senior Social Worker"], 6200);
  assert.equal(resolveRates(rateTable, "2025-10-01")["Senior Social Worker"], 6000);
});

test("failing a gate yields zero, not an error", () => {
  const rates = resolveRates(rateTable, "2026-07-01");
  const r = computeGrant(scheme, rates, { ...ctrB, caseload: 5 });
  assert.equal(r.eligible, false);
  assert.equal(r.netGrant, 0);
});

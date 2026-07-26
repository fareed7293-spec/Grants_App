// Assumptions encoded here (see README "Discussion 1" for the full ambiguity list):
// - "monthly rate x 3" is per STAFF MEMBER, not once per role category.
// - Only staff with onPayrollFullQuarter=true count (no proration rule given).
// - Rounding happens once, at the split step, so parties sum exactly to the net grant.

export function resolveRates(rateTable, quarterStart) {
  const d = new Date(quarterStart);
  const v = rateTable.versions.find((v) => d >= new Date(v.from) && (!v.to || d < new Date(v.to)));
  if (!v) throw new Error(`no rate version covers ${quarterStart}`);
  return v.rates;
}

function gatePassed(gate, centre) {
  if (gate.type === "licenceActiveFullQuarter") return centre.licenceActiveFullQuarter === true;
  if (gate.type === "minCaseload") return centre.caseload >= gate.min;
  if (gate.type === "minQualifiedHeadcount")
    return centre.staff.filter((s) => s.role === gate.role && s.qualified && s.onPayrollFullQuarter).length >= gate.min;
  throw new Error(`unknown gate type: ${gate.type}`);
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export function computeGrant(scheme, rates, centre) {
  const eligible = scheme.gates.every((g) => gatePassed(g, centre));
  if (!eligible) return { eligible, netGrant: 0, split: scheme.split.map((s) => ({ party: s.party, amount: 0 })) };

  const normativeCost = centre.staff
    .filter((s) => s.onPayrollFullQuarter)
    .reduce((sum, s) => sum + rates[s.role] * 3, 0);

  const bands = scheme.tiersByCentreType[centre.centreType];
  const [, , tierPercent] = bands.find(([min, max]) => centre.caseload >= min && (max === null || centre.caseload <= max));

  const grossGrant = normativeCost * tierPercent;
  const netGrant = grossGrant - (centre.coFunding || 0);
  const split = scheme.split.map((s) => ({ party: s.party, amount: round2(netGrant * s.percent) }));

  return { eligible, normativeCost: round2(normativeCost), tierPercent, grossGrant: round2(grossGrant), netGrant: round2(netGrant), split };
}

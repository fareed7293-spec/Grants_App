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

const rates = resolveRates(rateTable, "2026-07-01"); // Q3 2026
console.log(JSON.stringify(computeGrant(scheme, rates, ctrB), null, 2));

import React, { useMemo, useRef, useState, useEffect } from "react";

// =============================
// Seller Financing Calculator – Pro Edition
// Includes:
// • True tax modeling (basis, selling costs, LTCG, state tax, depreciation recapture)
// • Installment-sale tax timing (gross profit ratio) vs all-cash
// • Amortization schedule + CSV export + printable schedule
// • Branding (logo + firm name) and sharable links
// • Save/load scenarios (localStorage) + side-by-side compare
// • NPV lens for apples-to-apples
// =============================

// ---------- Helpers ----------
const fmtUSD = (n) =>
  (Number(n) || 0).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
const fmtPct = (n) => `${(Number(n) || 0).toFixed(2)}%`;
const clamp = (n, min = 0) => (Number.isFinite(+n) ? Math.max(+n, min) : min);

const b64Encode = (obj) => {
  const s = JSON.stringify(obj);
  return btoa(unescape(encodeURIComponent(s)));
};
const b64Decode = (str, fallback) => {
  try {
    const s = decodeURIComponent(escape(atob(str)));
    return JSON.parse(s);
  } catch (e) {
    return fallback;
  }
};

function monthlyPaymentWithBalloon(P, rateAnnualPct, years, balloon = 0) {
  const r = rateAnnualPct / 100 / 12;
  const n = Math.round(years * 12);
  if (r === 0) return (P - balloon) / n;
  const pvBalloon = balloon / Math.pow(1 + r, n);
  const effectivePV = P - pvBalloon;
  return (effectivePV * r) / (1 - Math.pow(1 + r, -n));
}

function npvMonthly(cashflows, discountAnnualPct) {
  const r = discountAnnualPct / 100 / 12;
  return cashflows.reduce((acc, cf) => acc + cf.amount / Math.pow(1 + r, cf.month), 0);
}

function downloadCSV(filename, rows) {
  const csv = rows.map((r) => r.map((x) => `${String(x).replaceAll('"', '""')}`)).map((r)=> r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- Tiny UI primitives ----------
function NumberField({ label, value, onChange, min = 0, step = 1, suffix, prefix }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-gray-600 font-medium">{label}</span>
      <div className="flex items-center rounded-xl border border-gray-200 bg-white px-3 py-2 shadow-sm focus-within:ring-2 focus-within:ring-emerald-500/30">
        {prefix ? <span className="mr-1 text-gray-500">{prefix}</span> : null}
        <input
          type="number"
          className="w-full bg-transparent outline-none"
          value={Number.isFinite(value) ? value : 0}
          step={step}
          min={min}
          onChange={(e) => onChange(clamp(e.target.value))}
        />
        {suffix ? <span className="ml-1 text-gray-500">{suffix}</span> : null}
      </div>
    </label>
  );
}

function TextField({ label, value, onChange, placeholder }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-gray-600 font-medium">{label}</span>
      <input
        className="rounded-xl border border-gray-200 bg-white px-3 py-2 shadow-sm focus:ring-2 focus:ring-emerald-500/30"
        value={value || ""}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function Section({ title, children, tint = "white" }) {
  const colors =
    tint === "white"
      ? "bg-white border border-slate-100"
      : tint === "dark"
      ? "bg-slate-900 text-white"
      : "bg-emerald-700 text-white";
  return (
    <section className={`rounded-2xl p-4 shadow-sm ${colors}`}>{title && <h3 className="font-semibold mb-3">{title}</h3>}{children}</section>
  );
}

// ---------- Tax modeling ----------
function taxesAllCash({ price, sellingCosts, basis, recaptureAmt, recaptureRate, ltcgRate, stateGainRate }) {
  const amountRealized = price - sellingCosts;
  const gain = Math.max(0, amountRealized - basis);
  const recaptureTaxable = Math.min(recaptureAmt, gain);
  const recaptureTax = recaptureTaxable * (recaptureRate / 100);
  const remainingGain = Math.max(0, gain - recaptureTaxable);
  const capGainTax = remainingGain * ((ltcgRate + stateGainRate) / 100);
  const totalTax = recaptureTax + capGainTax;
  return { amountRealized, gain, recaptureTax, capGainTax, totalTax };
}

function buildInstallmentTaxes({
  schedule,
  price,
  sellingCosts,
  basis,
  recaptureAmt,
  recaptureRate,
  ltcgRate,
  stateGainRate,
  ordRate,
  stateOrdRate,
}) {
  const amountRealized = price - sellingCosts;
  const contractPrice = amountRealized;
  const grossProfit = Math.max(0, amountRealized - basis - recaptureAmt);
  const GPR = contractPrice > 0 ? grossProfit / contractPrice : 0;

  const rows = [];
  let totalCapGainTax = 0;
  let totalInterestTax = 0;

  const recaptureTax = Math.min(recaptureAmt, Math.max(0, amountRealized - basis)) * (recaptureRate / 100);
  rows.push({ month: 0, capGainTax: 0, interestTax: 0, recaptureTax });

  for (const r of schedule) {
    const gainRecognized = r.principal * GPR;
    const capTax = gainRecognized * ((ltcgRate + stateGainRate) / 100);
    const intTax = r.interest * ((ordRate + stateOrdRate) / 100);
    totalCapGainTax += capTax;
    totalInterestTax += intTax;
    rows.push({ month: r.month, capGainTax: capTax, interestTax: intTax, recaptureTax: 0 });
  }

  const totalTax = recaptureTax + totalCapGainTax + totalInterestTax;
  return { rows, GPR, totalCapGainTax, totalInterestTax, recaptureTax, totalTax };
}

// ---------- Amortization schedule ----------
function buildSchedule({ principal, ratePct, termYears, balloon = 0 }) {
  const n = Math.round(termYears * 12);
  const pmt = monthlyPaymentWithBalloon(principal, ratePct, termYears, balloon);
  const schedule = [];
  let bal = principal;
  const r = ratePct / 100 / 12;
  for (let m = 1; m <= n; m++) {
    const interest = bal * r;
    let principalPay = pmt - interest;
    if (m === n && balloon > 0) {
      principalPay = Math.max(0, bal - balloon);
    }
    bal = bal - principalPay;
    if (m === n && balloon > 0) {
      schedule.push({ month: m, payment: pmt, interest, principal: principalPay, balance: bal });
      schedule.push({ month: m, payment: balloon, interest: 0, principal: balloon, balance: 0, isBalloon: true });
      bal = 0;
      break;
    }
    if (m === n) {
      const adj = bal;
      principalPay += adj;
      bal = 0;
    }
    schedule.push({ month: m, payment: pmt, interest, principal: principalPay, balance: Math.max(0, bal) });
  }
  return { schedule, payment: pmt };
}

// ---------- Scenario persistence ----------
const LS_KEY = "seller-finance-scenarios-v1";
function saveScenario(name, state) {
  const all = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  all[name] = { name, state, savedAt: new Date().toISOString() };
  localStorage.setItem(LS_KEY, JSON.stringify(all));
}
function loadScenarios() {
  return JSON.parse(localStorage.getItem(LS_KEY) || "{}");
}
function deleteScenario(name) {
  const all = loadScenarios();
  delete all[name];
  localStorage.setItem(LS_KEY, JSON.stringify(all));
}

export default function App() {
  // Branding
  const [brandName, setBrandName] = useState("Your Firm Name");
  const [logoUrl, setLogoUrl] = useState("");

  // Deal basics
  const [purchasePrice, setPurchasePrice] = useState(1500000);
  const [sellingCosts, setSellingCosts] = useState(0);
  const [basis, setBasis] = useState(700000);

  // Taxes
  const [ltcgRate, setLtcgRate] = useState(20);
  const [stateGainRate, setStateGainRate] = useState(5);
  const [recaptureAmt, setRecaptureAmt] = useState(0);
  const [recaptureRate, setRecaptureRate] = useState(37);
  const [ordinaryRate, setOrdinaryRate] = useState(37);
  const [stateOrdRate, setStateOrdRate] = useState(5);

  // All-cash assumptions
  const [holdbackPct, setHoldbackPct] = useState(15);
  const [holdbackYears, setHoldbackYears] = useState(2);
  const [investRatePct, setInvestRatePct] = useState(20);
  const [investYears, setInvestYears] = useState(2);

  // Seller-financing terms
  const [downPct, setDownPct] = useState(10);
  const [ratePct, setRatePct] = useState(6);
  const [termYears, setTermYears] = useState(10);
  const [balloon, setBalloon] = useState(0);

  // Lens
  const [discountRate, setDiscountRate] = useState(8);

  // Save/compare
  const [scenarioName, setScenarioName] = useState("");
  const [compareNames, setCompareNames] = useState([]);
  const [scenarios, setScenarios] = useState({});

  const printRef = useRef(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const s = params.get("s");
    if (s) {
      const st = b64Decode(s, null);
      if (st) applyState(st);
    }
    setScenarios(loadScenarios());
  }, []);

  function currentState() {
    return {
      brandName,
      logoUrl,
      purchasePrice,
      sellingCosts,
      basis,
      ltcgRate,
      stateGainRate,
      recaptureAmt,
      recaptureRate,
      ordinaryRate,
      stateOrdRate,
      holdbackPct,
      holdbackYears,
      investRatePct,
      investYears,
      downPct,
      ratePct,
      termYears,
      balloon,
      discountRate,
    };
  }
  function applyState(st) {
    setBrandName(st.brandName ?? brandName);
    setLogoUrl(st.logoUrl ?? "");
    setPurchasePrice(st.purchasePrice ?? purchasePrice);
    setSellingCosts(st.sellingCosts ?? 0);
    setBasis(st.basis ?? basis);
    setLtcgRate(st.ltcgRate ?? ltcgRate);
    setStateGainRate(st.stateGainRate ?? stateGainRate);
    setRecaptureAmt(st.recaptureAmt ?? recaptureAmt);
    setRecaptureRate(st.recaptureRate ?? recaptureRate);
    setOrdinaryRate(st.ordinaryRate ?? ordinaryRate);
    setStateOrdRate(st.stateOrdRate ?? stateOrdRate);
    setHoldbackPct(st.holdbackPct ?? holdbackPct);
    setHoldbackYears(st.holdbackYears ?? holdbackYears);
    setInvestRatePct(st.investRatePct ?? investRatePct);
    setInvestYears(st.investYears ?? investYears);
    setDownPct(st.downPct ?? downPct);
    setRatePct(st.ratePct ?? ratePct);
    setTermYears(st.termYears ?? termYears);
    setBalloon(st.balloon ?? balloon);
    setDiscountRate(st.discountRate ?? discountRate);
  }

  const derived = useMemo(() => {
    // All-cash
    const holdback = (holdbackPct / 100) * purchasePrice;
    const netCashNow = purchasePrice - holdback;
    const interestOnCash = netCashNow * (investRatePct / 100) * investYears;
    const recoverHoldback = holdback;

    const allCashTax = taxesAllCash({
      price: purchasePrice,
      sellingCosts,
      basis,
      recaptureAmt,
      recaptureRate,
      ltcgRate,
      stateGainRate,
    });

    const sellerGetsAllCash = netCashNow + interestOnCash + recoverHoldback - allCashTax.totalTax;

    const cfAll = [
      { month: 0, amount: netCashNow - allCashTax.totalTax },
      { month: 12 * holdbackYears, amount: recoverHoldback },
    ];
    for (let y = 1; y <= investYears; y++) cfAll.push({ month: y * 12, amount: netCashNow * (investRatePct / 100) });
    const npvAllCash = npvMonthly(cfAll, discountRate);

    // Financing
    const downPayment = (downPct / 100) * purchasePrice;
    const principal = purchasePrice - downPayment;
    const { schedule, payment: pmt } = buildSchedule({ principal, ratePct, termYears, balloon });
    const totalPayments = schedule.reduce((a, r) => a + r.payment, 0);
    const totalInterest = schedule.reduce((a, r) => a + r.interest, 0);

    const inst = buildInstallmentTaxes({
      schedule,
      price: purchasePrice,
      sellingCosts,
      basis,
      recaptureAmt,
      recaptureRate,
      ltcgRate,
      stateGainRate,
      ordRate: ordinaryRate,
      stateOrdRate,
    });

    const finFlows = [];
    finFlows.push({ month: 0, amount: downPayment });
    for (const r of schedule) finFlows.push({ month: r.month, amount: r.payment });
    for (const r of inst.rows) {
      const tax = r.capGainTax + r.interestTax + r.recaptureTax;
      finFlows.push({ month: r.month, amount: -tax });
    }
    const npvFin = npvMonthly(finFlows, discountRate);

    const npvTaxesInst = npvMonthly(
      inst.rows.map((r) => ({ month: r.month, amount: r.capGainTax + r.interestTax + r.recaptureTax })),
      discountRate
    );
    const taxAdvantage = allCashTax.totalTax - npvTaxesInst;

    const totalValueToSeller = downPayment + totalPayments + taxAdvantage;
    const additionalValue = totalValueToSeller - sellerGetsAllCash;

    return {
      holdback,
      netCashNow,
      interestOnCash,
      recoverHoldback,
      sellerGetsAllCash,
      allCashTax,
      pmt,
      downPayment,
      principal,
      schedule,
      totalPayments,
      totalInterest,
      inst,
      taxAdvantage,
      totalValueToSeller,
      additionalValue,
      npvAllCash,
      npvFin,
      npvDelta: npvFin - npvAllCash,
    };
  }, [
    purchasePrice,
    sellingCosts,
    basis,
    ltcgRate,
    stateGainRate,
    recaptureAmt,
    recaptureRate,
    ordinaryRate,
    stateOrdRate,
    holdbackPct,
    investRatePct,
    investYears,
    holdbackYears,
    downPct,
    ratePct,
    termYears,
    balloon,
    discountRate,
  ]);

  function exportScheduleCSV() {
    const rows = [
      ["Month", "Payment", "Interest", "Principal", "Balance", "CapGainTax", "InterestTax", "RecaptureTax"],
    ];
    for (const r of derived.inst.rows) {
      if (r.month === 0) continue;
      const s = derived.schedule.find((x) => x.month === r.month);
      if (!s) continue;
      rows.push([
        r.month,
        s ? s.payment.toFixed(2) : 0,
        s ? s.interest.toFixed(2) : 0,
        s ? s.principal.toFixed(2) : 0,
        s ? s.balance.toFixed(2) : 0,
        r.capGainTax.toFixed(2),
        r.interestTax.toFixed(2),
        0,
      ]);
    }
    const rec0 = derived.inst.rows.find((x) => x.month === 0);
    if (rec0 && rec0.recaptureTax)
      rows.push([0, 0, 0, 0, derived.principal.toFixed(2), 0, 0, rec0.recaptureTax.toFixed(2)]);

    downloadCSV("amortization_schedule.csv", rows);
  }

  function printSchedule() {
    const w = window.open("", "_blank");
    const rows = derived.schedule
      .map(
        (r) =>
          `<tr><td>${r.month}</td><td>${fmtUSD(r.payment)}</td><td>${fmtUSD(r.interest)}</td><td>${fmtUSD(
            r.principal
          )}</td><td>${fmtUSD(r.balance)}</td></tr>`
      )
      .join("");
    w.document.write(`
      <html><head><title>Amortization Schedule</title>
      <style>body{font-family:ui-sans-serif,system-ui;padding:24px} table{border-collapse:collapse;width:100%} td,th{border:1px solid #ddd;padding:8px;text-align:right} th{text-align:left}</style>
      </head><body>
      <h2>${brandName} – Amortization Schedule</h2>
      <p><strong>Purchase Price:</strong> ${fmtUSD(purchasePrice)} &nbsp; <strong>Rate:</strong> ${ratePct}% &nbsp; <strong>Term:</strong> ${termYears} yrs</p>
      <table><thead><tr><th>Month</th><th>Payment</th><th>Interest</th><th>Principal</th><th>Balance</th></tr></thead><tbody>${rows}</tbody></table>
      </body></html>`);
    w.document.close();
    w.focus();
    w.print();
  }

  function copyShareLink() {
    const state = currentState();
    const code = b64Encode(state);
    const url = `${window.location.origin}${window.location.pathname}?s=${code}`;
    navigator.clipboard.writeText(url);
    alert("Sharable link copied to clipboard.");
  }

  function handleSave() {
    const name = scenarioName?.trim();
    if (!name) return alert("Name your scenario first.");
    saveScenario(name, currentState());
    setScenarios(loadScenarios());
    setScenarioName("");
  }

  function handleLoad(name) {
    const sc = scenarios[name];
    if (!sc) return;
    applyState(sc.state);
  }

  const compareList = useMemo(() => compareNames.map((n) => scenarios[n]).filter(Boolean), [compareNames, scenarios]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-10 backdrop-blur bg-white/75 border-b border-slate-200">
        <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {logoUrl ? (
              <img src={logoUrl} alt="logo" className="h-8 w-8 rounded-lg object-cover" />
            ) : (
              <div className="h-8 w-8 rounded-lg bg-emerald-600" />
            )}
            <h1 className="text-xl sm:text-2xl font-bold">{brandName || "Seller Financing Presentation"}</h1>
          </div>
          <div className="flex gap-2">
            <button onClick={() => window.print()} className="rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 text-sm shadow-sm">Download PDF</button>
            <button onClick={copyShareLink} className="rounded-xl bg-slate-800 hover:bg-slate-900 text-white px-4 py-2 text-sm shadow-sm">Share Link</button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 print:px-0">
        <div className="rounded-2xl bg-emerald-700 text-white p-6 shadow-sm">
          <p className="font-semibold text-center">Present to the Seller: Financing vs. All-Cash</p>
          <h2 className="text-center text-2xl sm:text-3xl font-extrabold mt-1">
            {((derived.additionalValue / Math.max(derived.sellerGetsAllCash, 1)) * 100).toFixed(1)}% More Money for the Seller
          </h2>
          <p className="text-center opacity-90 mt-2">
            Defers taxes via installment method • Shows guaranteed income • Compares apples-to-apples with NPV
          </p>
        </div>

        {/* Branding */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6 print:hidden">
          <Section title="Branding">
            <div className="grid grid-cols-2 gap-3">
              <TextField label="Firm Name" value={brandName} onChange={setBrandName} />
              <TextField label="Logo URL" value={logoUrl} onChange={setLogoUrl} placeholder="https://…/logo.png" />
            </div>
          </Section>

          <Section title="Scenario Save & Share">
            <div className="grid grid-cols-2 gap-3">
              <TextField label="Save Name" value={scenarioName} onChange={setScenarioName} />
              <button onClick={handleSave} className="rounded-xl bg-slate-900 text-white px-3 py-2">Save Scenario</button>
              <label className="text-sm text-slate-600 col-span-2">Load Saved</label>
              <div className="col-span-2 grid grid-cols-3 gap-2">
                {Object.keys(scenarios).length === 0 ? (
                  <div className="text-xs text-slate-500 col-span-3">No saved scenarios yet.</div>
                ) : (
                  Object.keys(scenarios).map((name) => (
                    <div key={name} className="flex items-center justify-between rounded-lg border p-2">
                      <button onClick={() => handleLoad(name)} className="text-left text-sm font-medium truncate max-w-[8rem]">{name}</button>
                      <div className="flex items-center gap-1">
                        <label className="text-xs flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={compareNames.includes(name)}
                            onChange={(e) => {
                              setCompareNames((prev) =>
                                e.target.checked ? [...new Set([...prev, name])] : prev.filter((x) => x !== name)
                              );
                            }}
                          />
                          Compare
                        </label>
                        <button onClick={() => { deleteScenario(name); setScenarios(loadScenarios()); }} className="text-xs text-rose-600">Delete</button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </Section>

          <Section title="Financial Lens">
            <div className="grid grid-cols-2 gap-3">
              <NumberField label="Discount Rate (NPV)" value={discountRate} onChange={setDiscountRate} step={0.25} suffix="%/yr" />
            </div>
          </Section>
        </div>

        {/* Inputs */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-6 print:hidden">
          <Section title="Deal Basics">
            <div className="grid grid-cols-2 gap-3">
              <NumberField label="Purchase Price" value={purchasePrice} onChange={setPurchasePrice} step={1000} prefix="$" />
              <NumberField label="Selling Costs" value={sellingCosts} onChange={setSellingCosts} step={500} prefix="$" />
              <NumberField label="Seller Basis" value={basis} onChange={setBasis} step={1000} prefix="$" />
            </div>
          </Section>

          <Section title="Tax Settings">
            <div className="grid grid-cols-2 gap-3">
              <NumberField label="Federal LTCG Rate" value={ltcgRate} onChange={setLtcgRate} step={0.25} suffix="%" />
              <NumberField label="State Gain Rate" value={stateGainRate} onChange={setStateGainRate} step={0.25} suffix="%" />
              <NumberField label="Depreciation Recapture Amt" value={recaptureAmt} onChange={setRecaptureAmt} step={1000} prefix="$" />
              <NumberField label="Recapture Rate (Ordinary)" value={recaptureRate} onChange={setRecaptureRate} step={0.25} suffix="%" />
              <NumberField label="Interest Ordinary Rate (Fed)" value={ordinaryRate} onChange={setOrdinaryRate} step={0.25} suffix="%" />
              <NumberField label="Interest Ordinary Rate (State)" value={stateOrdRate} onChange={setStateOrdRate} step={0.25} suffix="%" />
            </div>
          </Section>

          <Section title="All-Cash Assumptions">
            <div className="grid grid-cols-2 gap-3">
              <NumberField label="Holdback / Escrow" value={holdbackPct} onChange={setHoldbackPct} step={0.5} suffix="%" />
              <NumberField label="Holdback Released" value={holdbackYears} onChange={setHoldbackYears} step={0.5} suffix="yrs" />
              <NumberField label="Invest Proceeds @" value={investRatePct} onChange={setInvestRatePct} step={0.5} suffix="%/yr" />
              <NumberField label="Investment Horizon" value={investYears} onChange={setInvestYears} step={0.5} suffix="yrs" />
            </div>
          </Section>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-6 print:hidden">
          <Section title="Seller-Financing Terms">
            <div className="grid grid-cols-2 gap-3">
              <NumberField label="Down Payment" value={downPct} onChange={setDownPct} step={0.25} suffix="%" />
              <NumberField label="Interest Rate" value={ratePct} onChange={setRatePct} step={0.1} suffix="%" />
              <NumberField label="Term" value={termYears} onChange={setTermYears} step={0.25} suffix="years" />
              <NumberField label="Balloon Amount" value={balloon} onChange={setBalloon} step={5000} prefix="$" />
            </div>
          </Section>

          <Section title="Actions">
            <div className="grid grid-cols-2 gap-3">
              <button onClick={exportScheduleCSV} className="rounded-xl bg-slate-900 text-white px-3 py-2">Export Schedule (CSV)</button>
              <button onClick={printSchedule} className="rounded-xl bg-emerald-600 text-white px-3 py-2">Print Schedule (PDF)</button>
            </div>
            <p className="text-xs text-slate-500 mt-2">The PDF button opens a clean schedule and triggers the browser print dialog.</p>
          </Section>

          <Section title="Apples-to-Apples (NPV)">
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-xl bg-slate-50 border p-3 text-center">
                <div className="text-slate-600 text-sm">All-Cash NPV</div>
                <div className="text-xl font-bold">{fmtUSD(derived.npvAllCash)}</div>
              </div>
              <div className="rounded-xl bg-slate-50 border p-3 text-center">
                <div className="text-slate-600 text-sm">Seller-Financing NPV</div>
                <div className="text-xl font-bold">{fmtUSD(derived.npvFin)}</div>
              </div>
              <div className={`rounded-xl p-3 text-center ${derived.npvDelta >= 0 ? "bg-emerald-600/20" : "bg-rose-600/20"}`}>
                <div className="text-slate-800 text-sm">NPV Advantage</div>
                <div className="text-xl font-extrabold">{fmtUSD(derived.npvDelta)}</div>
              </div>
            </div>
          </Section>
        </div>

        {/* Presentation Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-6" ref={printRef}>
          <Section>
            <h3 className="font-semibold text-white bg-slate-700 rounded-xl px-3 py-2 inline-block">Show the Seller: All-Cash Scenario</h3>
            <ul className="mt-4 divide-y">
              <li className="py-2 flex justify-between"><span>Purchase Price</span><span className="font-semibold">{fmtUSD(purchasePrice)}</span></li>
              <li className="py-2 flex justify-between text-rose-600"><span>Selling Costs</span><span className="font-semibold">-{fmtUSD(sellingCosts)}</span></li>
              <li className="py-2 flex justify-between text-rose-600"><span>Taxes (Upfront)</span><span className="font-semibold">-{fmtUSD(derived.allCashTax.totalTax)}</span></li>
              <li className="py-2 flex justify-between text-rose-600"><span>Holdback ({holdbackPct}%)</span><span className="font-semibold">-{fmtUSD(derived.holdback)}</span></li>
              <li className="py-2 flex justify-between text-emerald-700"><span>Interest on Cash Proceeds</span><span className="font-semibold">+{fmtUSD(derived.interestOnCash)}</span></li>
              <li className="py-2 flex justify-between text-emerald-700"><span>Recover Holdback ({holdbackYears} yrs)</span><span className="font-semibold">+{fmtUSD(derived.recoverHoldback)}</span></li>
            </ul>
            <div className="mt-4 p-3 rounded-xl bg-slate-50 border text-slate-700 flex items-center justify-between">
              <span className="font-semibold">What the Seller Actually Gets</span>
              <span className="text-lg font-extrabold">{fmtUSD(derived.sellerGetsAllCash)}</span>
            </div>
          </Section>

          <Section>
            <h3 className="font-semibold text-white bg-emerald-700 rounded-xl px-3 py-2 inline-block">Present This Alternative: Seller Financing</h3>
            <ul className="mt-4 divide-y">
              <li className="py-2 flex justify-between"><span>Purchase Price</span><span className="font-semibold">{fmtUSD(purchasePrice)}</span></li>
              <li className="py-2 flex justify-between text-emerald-700"><span>Down Payment ({downPct}%)</span><span className="font-semibold">+{fmtUSD(derived.downPayment)}</span></li>
              <li className="py-2 flex justify-between"><span>Monthly Payment Stream</span><span className="font-semibold">{fmtUSD(derived.pmt)}/mo</span></li>
              <li className="py-2 flex justify-between text-slate-600"><span>Total Interest Income</span><span className="font-semibold">{fmtUSD(derived.totalInterest)}</span></li>
              {balloon > 0 && (
                <li className="py-2 flex justify-between text-emerald-700"><span>Balloon Payment</span><span className="font-semibold">+{fmtUSD(balloon)}</span></li>
              )}
              <li className="py-2 flex justify-between text-emerald-700"><span>Tax Advantages (NPV of deferral)</span><span className="font-semibold">+{fmtUSD(derived.taxAdvantage)}</span></li>
            </ul>
            <div className="mt-4 p-3 rounded-xl bg-slate-50 border text-slate-700 flex items-center justify-between">
              <span className="font-semibold">Total Value to Seller</span>
              <span className="text-lg font-extrabold">{fmtUSD(derived.totalValueToSeller)}</span>
            </div>
          </Section>
        </div>

        {/* Scenario Compare (basic fields) */}
        {compareList.length > 0 && (
          <Section title="Scenario Compare" tint="white">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left">
                    <th className="py-2 pr-6">Metric</th>
                    {compareList.map((s) => (
                      <th key={s.name} className="py-2 pr-6">{s.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["Price", (st) => st.state.purchasePrice, fmtUSD],
                    ["Down %", (st) => st.state.downPct, (x)=> fmtPct(x)],
                    ["Rate %", (st) => st.state.ratePct, (x)=> fmtPct(x)],
                    ["Term (yrs)", (st) => st.state.termYears, (x)=> x],
                    ["Balloon", (st) => st.state.balloon, fmtUSD],
                  ].map(([label, getter, fmt]) => (
                    <tr key={label}>
                      <td className="py-2 pr-6 text-slate-600">{label}</td>
                      {compareList.map((s) => (
                        <td key={s.name + label} className="py-2 pr-6">{fmt(getter(s))}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        <Section title="Amortization (summary)">
          <div className="max-h-72 overflow-auto rounded-xl border">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 sticky top-0">
                <tr>
                  <th className="text-left p-2">Month</th>
                  <th className="text-right p-2">Payment</th>
                  <th className="text-right p-2">Interest</th>
                  <th className="text-right p-2">Principal</th>
                  <th className="text-right p-2">Balance</th>
                </tr>
              </thead>
              <tbody>
                {derived.schedule.slice(0, 120).map((r) => (
                  <tr key={r.month} className="border-t">
                    <td className="p-2">{r.month}</td>
                    <td className="p-2 text-right">{fmtUSD(r.payment)}</td>
                    <td className="p-2 text-right">{fmtUSD(r.interest)}</td>
                    <td className="p-2 text-right">{fmtUSD(r.principal)}</td>
                    <td className="p-2 text-right">{fmtUSD(r.balance)}</td>
                  </tr>
                ))}
                {derived.schedule.length > 120 && (
                  <tr><td className="p-2 text-slate-500" colSpan={5}>…truncated for display. Use CSV/PDF for full table.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Section>

        <footer className="mt-10 text-center text-xs text-slate-500">
          Built for live seller conversations. Adjust assumptions; click <span className="font-semibold">Download PDF</span> for a polished handout.
        </footer>
      </main>
    </div>
  );
}

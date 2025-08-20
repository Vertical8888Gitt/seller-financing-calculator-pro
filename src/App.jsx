Nice! Your site is live 🎉
Next, let’s swap the starter screen for the full calculator UI.

⸻

Replace src/App.jsx (copy–paste)
	1.	Open your repo on GitHub → click src → click App.jsx.
	2.	Click the pencil icon (top-right) to edit.
	3.	Delete everything in that file.
	4.	Paste the code below (all of it).
	5.	Scroll down → Commit changes.
	6.	Vercel auto-deploys; wait ~1 min, then refresh your site
https://seller-financing-calculator-pro-ueyp-c5ccrf7qg.vercel.app.

src/App.jsx (full Pro calculator)

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
  const capGainTax = remainingGain * ((

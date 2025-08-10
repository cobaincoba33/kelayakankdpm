import React, { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';

/**
 * BizPlan Calculator – One-Page (IRR + Feasibility Verdict)
 * - Adds IRR calculation and feasibility verdict: "Layak", "Kurang Layak", "Tidak Layak"
 * - KPI explanations (tooltips)
 * - Enforce financing rules: plafon ≤ Rp3.000.000.000; total OPEX ≤ Rp500.000.000
 * - Excel export (multi-sheet)
 * - Self-tests for core finance helpers (do not remove)
 */

// ----------------- Helpers -----------------
const IDR = (n) =>
  new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(
    isFinite(n) ? n : 0
  );

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
const sum = (arr) => arr.reduce((a, b) => a + (Number.isFinite(+b) ? +b : 0), 0);

function anuitas(P, i, n) {
  if (n <= 0) return 0;
  if (i === 0) return P / n;
  return (P * i) / (1 - Math.pow(1 + i, -n));
}

function amortize({ principal, annualRate = 6, months = 72, graceMonths = 6, mode = 'pokok' }) {
  const i = annualRate / 100 / 12;
  let saldo = principal;
  const rows = [];

  // Grace phase
  for (let m = 1; m <= Math.min(graceMonths, months); m++) {
    const interest = saldo * i;
    if (mode === 'full') {
      // Capitalize interest
      saldo += interest;
      rows.push({ month: m, principal: 0, interest, payment: 0, balance: saldo });
    } else {
      rows.push({ month: m, principal: 0, interest, payment: interest, balance: saldo });
    }
  }

  const remain = Math.max(0, months - graceMonths);
  const A = anuitas(saldo, i, remain);
  for (let k = 1; k <= remain; k++) {
    const interest = saldo * i;
    const principalPay = Math.max(0, A - interest);
    saldo = Math.max(0, saldo - principalPay);
    rows.push({ month: graceMonths + k, principal: principalPay, interest, payment: A, balance: saldo });
  }
  return rows;
}

function npv(ratePerPeriod, cashflows) {
  return cashflows.reduce((acc, cf, t) => acc + cf / Math.pow(1 + ratePerPeriod, t), 0);
}

function irr(cashflows, guess = 0.01) {
  // Newton-Raphson
  let r = guess;
  for (let iter = 0; iter < 100; iter++) {
    let f = 0, df = 0;
    for (let t = 0; t < cashflows.length; t++) {
      const denom = Math.pow(1 + r, t);
      f += cashflows[t] / denom;
      if (t > 0) df += (-t * cashflows[t]) / (denom * (1 + r));
    }
    const step = f / (df || 1e-12);
    const next = r - step;
    if (!isFinite(next)) break;
    if (Math.abs(next - r) < 1e-8) return next;
    r = Math.max(next, -0.9999);
  }
  return NaN;
}

function paybackPeriod(cashflows) {
  let cum = 0;
  for (let i = 0; i < cashflows.length; i++) {
    cum += cashflows[i];
    if (cum >= 0) return i;
  }
  return Infinity;
}

// ----------------- Self Tests -----------------
(function tests() {
  const p = anuitas(1200, 0.01, 12);
  console.assert(Math.abs(p - 106.62) < 0.6, 'anuitas check');
  const sched0 = amortize({ principal: 1200, annualRate: 0, months: 12, graceMonths: 0 });
  console.assert(Math.abs(sched0[0].payment - 100) < 1e-6, 'amortize zero-rate');
  const cf = [-1000, 300, 300, 300, 300, 300];
  const r = irr(cf);
  console.assert(!isNaN(r) && r > 0, 'irr positive');
})();

// ----------------- Component -----------------
export default function BizPlanCalculator() {
  // Controls
  const [horizon, setHorizon] = useState(72); // bulan
  const [growthPct, setGrowthPct] = useState(0); // % per bulan
  const [diskontoPersen, setDiskontoPersen] = useState(10); // diskonto tahunan untuk evaluasi NPV/IRR

  // CAPEX (Rp) & OPEX (Rp/bulan)
  const [capex, setCapex] = useState([{ item: 'Rak & Etalase', nilai: 80_000_000, umur: 5 }]);
  const [opex, setOpex] = useState([
    { item: 'Gaji & Operasional', nilai: 200_000_000 },
    { item: 'Sewa & Utilitas', nilai: 150_000_000 },
  ]);

  // Revenue & Profit plan
  const [revenueStart, setRevenueStart] = useState(1_200_000_000);
  const [targetMarginPct, setTargetMarginPct] = useState(10);

  // Financing (rules enforced: plafon ≤ 3M)
  const [plafon, setPlafon] = useState(2_500_000_000);
  const [tenor, setTenor] = useState(72);
  const [bunga, setBunga] = useState(6);
  const [grace, setGrace] = useState(6);
  const [modeGrace, setModeGrace] = useState('pokok');

  // Derived totals & enforcement
  const totalCapex = useMemo(() => sum(capex.map((c) => +c.nilai || 0)), [capex]);
  const totalOpexRaw = useMemo(() => sum(opex.map((o) => +o.nilai || 0)), [opex]);
  const totalOpex = useMemo(() => Math.min(totalOpexRaw, 500_000_000), [totalOpexRaw]);
  const opexLimited = totalOpexRaw > 500_000_000;

  // Apply caps on-the-fly
  const plafonCapped = Math.min(plafon, 3_000_000_000);

  // Revenue projection
  const revenueSeries = useMemo(() => {
    const g = (Number(growthPct) || 0) / 100;
    return Array.from({ length: horizon }, (_, m) => revenueStart * Math.pow(1 + g, m));
  }, [revenueStart, growthPct, horizon]);

  // Loan schedule with capped plafon
  const loanSchedule = useMemo(
    () => amortize({ principal: plafonCapped, annualRate: bunga, months: tenor, graceMonths: grace, mode: modeGrace }),
    [plafonCapped, bunga, tenor, grace, modeGrace]
  );

  // Depreciation (straight-line)
  const penyusutanBulanan = useMemo(() => sum(capex.map((c) => (c.umur > 0 ? (+c.nilai || 0) / (c.umur * 12) : 0))), [capex]);

  // Projection rows
  const cashflowRows = useMemo(() => {
    const rows = [];
    for (let m = 1; m <= horizon; m++) {
      const pendapatan = revenueSeries[m - 1] || 0;
      const ebitda = pendapatan - totalOpex;
      const ebit = ebitda - penyusutanBulanan;
      const debt = loanSchedule[m - 1] || { interest: 0, payment: 0, balance: plafonCapped };
      const labaSebelumPajak = ebit - debt.interest; // pajak 0% (MVP)
      const cfo = labaSebelumPajak + penyusutanBulanan;
      const cff = -debt.payment;
      const netCF = cfo + cff;
      rows.push({ bulan: m, pendapatan, opex: totalOpex, penyusutan: penyusutanBulanan, bunga: debt.interest, angsuran: debt.payment, cfo, netCF, saldoPinjaman: debt.balance });
    }
    // Initial CF (equity-centric by default): -CAPEX + Pencairan Pinjaman
    const initialCF = -totalCapex + plafonCapped;
    return { rows, initialCF };
  }, [horizon, revenueSeries, totalOpex, penyusutanBulanan, loanSchedule, plafonCapped, totalCapex]);

  // KPI calculations
  const diskontoBulanan = (diskontoPersen || 0) / 100 / 12;
  const cashflowsForEval = useMemo(() => [cashflowRows.initialCF, ...cashflowRows.rows.map((r) => r.netCF)], [cashflowRows]);
  const NPV = useMemo(() => npv(diskontoBulanan, cashflowsForEval), [diskontoBulanan, cashflowsForEval]);
  const IRR_m = useMemo(() => irr(cashflowsForEval), [cashflowsForEval]);
  const IRR_y = useMemo(() => (isFinite(IRR_m) ? Math.pow(1 + IRR_m, 12) - 1 : NaN), [IRR_m]);
  const payback = useMemo(() => paybackPeriod(cashflowsForEval), [cashflowsForEval]);
  const targetLabaBulanan = useMemo(() => (targetMarginPct / 100) * (revenueStart || 0), [targetMarginPct, revenueStart]);

  // Verdict rules (can be tuned):
  // Layak   : NPV >= 0 AND IRR_y >= diskontoPersen AND payback <= 36 months AND DSCR_avg >= 1.2
  // Kurang  : setidaknya 2 dari 4 terpenuhi
  // Tidak   : selain itu
  const years = useMemo(() => {
    const chunks = [];
    for (let i = 0; i < cashflowRows.rows.length; i += 12) chunks.push(cashflowRows.rows.slice(i, i + 12));
    return chunks;
  }, [cashflowRows]);
  const dscrAvg = useMemo(() => {
    const ds = years.map((yr) => sum(yr.map((r) => r.cfo)) / Math.max(1, sum(yr.map((r) => r.angsuran))));
    return ds.length ? sum(ds) / ds.length : 0;
  }, [years]);

  const criteria = {
    npv: NPV >= 0,
    irr: isFinite(IRR_y) && IRR_y >= (diskontoPersen || 0) / 100,
    payback: isFinite(payback) && payback <= 36,
    dscr: dscrAvg >= 1.2,
  };
  const score = Object.values(criteria).filter(Boolean).length;
  const verdict = score === 4 ? 'Layak' : score >= 2 ? 'Kurang Layak' : 'Tidak Layak';
  const verdictColor = verdict === 'Layak' ? 'bg-emerald-100 text-emerald-800' : verdict === 'Kurang Layak' ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800';

  // ---------- Export Excel ----------
  const exportExcel = () => {
    const wb = XLSX.utils.book_new();

    // KPI Sheet
    const kpiRows = [
      { KPI: 'Verdict', Value: verdict },
      { KPI: 'NPV (diskonto/bulan)', Value: Math.round(NPV) },
      { KPI: 'IRR (bulanan)', Value: isFinite(IRR_m) ? IRR_m : null },
      { KPI: 'IRR (tahunan)', Value: isFinite(IRR_y) ? IRR_y : null },
      { KPI: 'Payback (bulan ke-)', Value: isFinite(payback) ? payback : null },
      { KPI: 'DSCR rata-rata', Value: dscrAvg },
      { KPI: 'Penyusutan/bulan', Value: penyusutanBulanan },
      { KPI: 'OPEX/bulan', Value: totalOpex },
      { KPI: 'CAPEX', Value: totalCapex },
      { KPI: 'Plafon (capped)', Value: plafonCapped },
    ];
    const wsKPI = XLSX.utils.json_to_sheet(kpiRows);
    XLSX.utils.book_append_sheet(wb, wsKPI, 'KPI');

    // CAPEX, OPEX
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(capex), 'CAPEX');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(opex), 'OPEX');

    // Loan
    const loanRows = loanSchedule.map((r) => ({ Bulan: r.month, Pokok: Math.round(r.principal), Bunga: Math.round(r.interest), Angsuran: Math.round(r.payment), Saldo: Math.round(r.balance) }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(loanRows), 'Pinjaman');

    // Cashflow
    const cfRows = cashflowRows.rows.map((r) => ({ Bulan: r.bulan, Pendapatan: Math.round(r.pendapatan), OPEX: Math.round(r.opex), Penyusutan: Math.round(r.penyusutan), Bunga: Math.round(r.bunga), Angsuran: Math.round(r.angsuran), CFO: Math.round(r.cfo), NetCF: Math.round(r.netCF), SaldoPinjaman: Math.round(r.saldoPinjaman) }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cfRows), 'Cashflow');

    XLSX.writeFile(wb, 'Kalkulator_Kelayakan_Bisnis.xlsx');
  };

  // ---------- Handlers ----------
  const addCapexRow = () => setCapex([...capex, { item: '', nilai: 0, umur: 5 }]);
  const addOpexRow = () => setOpex([...opex, { item: '', nilai: 0 }]);
  const handleCapexChange = (i, field, v) => { const arr = [...capex]; arr[i][field] = field === 'nilai' || field === 'umur' ? Number(v) : v; setCapex(arr); };
  const handleOpexChange = (i, field, v) => { const arr = [...opex]; arr[i][field] = field === 'nilai' ? Number(v) : v; setOpex(arr); };

  // ---------- UI ----------
  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* LEFT: Inputs */}
        <section className="bg-white border rounded-2xl shadow-sm p-6">
          <h2 className="text-xl font-bold">Kalkulator Kelayakan – 1 Halaman</h2>
          <p className="text-slate-500 text-sm mt-1">Isi data di kiri • KPI & kesimpulan di kanan • Export Excel tersedia</p>

          <div className="grid md:grid-cols-3 gap-3 mt-4">
            <label className="text-sm">Horizon (bulan)
              <input type="number" min={1} max={120} value={horizon} onChange={(e) => setHorizon(clamp(+e.target.value, 1, 120))} className="mt-1 w-full border rounded-xl px-3 py-2" />
            </label>
            <label className="text-sm">Growth Pendapatan (%/bln)
              <input type="number" value={growthPct} onChange={(e) => setGrowthPct(+e.target.value)} className="mt-1 w-full border rounded-xl px-3 py-2" />
            </label>
            <label className="text-sm" title="Digunakan untuk evaluasi NPV/IRR (diskonto tahunan)">Diskonto (%/th)
              <input type="number" value={diskontoPersen} onChange={(e) => setDiskontoPersen(+e.target.value)} className="mt-1 w-full border rounded-xl px-3 py-2" />
            </label>
          </div>

          {/* CAPEX */}
          <div className="mt-5">
            <div className="flex items-center justify-between"><h3 className="font-semibold">CAPEX (Belanja Modal)</h3><button className="px-3 py-2 border rounded-xl" onClick={addCapexRow}>+ Tambah</button></div>
            <p className="text-xs text-slate-500 mt-1">Aset jangka panjang (mesin, kendaraan, renovasi). Metode penyusutan: garis lurus (umur → tahun).</p>
            <div className="mt-2 space-y-2">
              {capex.map((row, i) => (
                <div key={i} className="grid grid-cols-7 gap-2">
                  <input placeholder="Item" value={row.item} onChange={(e) => handleCapexChange(i, 'item', e.target.value)} className="col-span-3 border rounded-xl px-3 py-2" />
                  <input type="number" placeholder="Nilai (Rp)" value={row.nilai} onChange={(e) => handleCapexChange(i, 'nilai', e.target.value)} className="col-span-2 border rounded-xl px-3 py-2" />
                  <input type="number" placeholder="Umur (tahun)" value={row.umur} onChange={(e) => handleCapexChange(i, 'umur', e.target.value)} className="col-span-1 border rounded-xl px-3 py-2" />
                  <button className="col-span-1 border rounded-xl" onClick={(ev) => { ev.preventDefault(); const arr = [...capex]; arr.splice(i, 1); setCapex(arr); }}>✕</button>
                </div>
              ))}
            </div>
            <div className="text-xs text-slate-600 mt-2">Total CAPEX: <b>{IDR(totalCapex)}</b> • Penyusutan/bulan: <b>{IDR(penyusutanBulanan)}</b></div>
          </div>

          {/* OPEX */}
          <div className="mt-6">
            <div className="flex items-center justify-between"><h3 className="font-semibold">OPEX (Operasional Bulanan)</h3><button className="px-3 py-2 border rounded-xl" onClick={addOpexRow}>+ Tambah</button></div>
            <p className="text-xs text-slate-500 mt-1">Biaya berulang: gaji, listrik, sewa, bahan baku, logistik, dll. <b>Dibatasi ≤ {IDR(500_000_000)}</b> per aturan.</p>
            <div className="mt-2 space-y-2">
              {opex.map((row, i) => (
                <div key={i} className="grid grid-cols-6 gap-2">
                  <input placeholder="Item" value={row.item} onChange={(e) => handleOpexChange(i, 'item', e.target.value)} className="col-span-4 border rounded-xl px-3 py-2" />
                  <input type="number" placeholder="Nilai (Rp/bln)" value={row.nilai} onChange={(e) => handleOpexChange(i, 'nilai', e.target.value)} className="col-span-1 border rounded-xl px-3 py-2" />
                  <button className="col-span-1 border rounded-xl" onClick={(ev) => { ev.preventDefault(); const arr = [...opex]; arr.splice(i, 1); setOpex(arr); }}>✕</button>
                </div>
              ))}
            </div>
            <div className={`text-xs mt-2 ${opexLimited ? 'text-rose-700' : 'text-slate-600'}`}>
              Total OPEX: <b>{IDR(totalOpex)}</b> {opexLimited && '(dibatasi ke 500 juta sesuai aturan)'}
            </div>
          </div>

          {/* Financing */}
          <div className="mt-6">
            <h3 className="font-semibold">Rencana Pengembalian Pinjaman</h3>
            <div className="grid md:grid-cols-5 gap-3 mt-2">
              <label className="text-sm" title="Maksimal 3 miliar (otomatis dibatasi)">Plafon (Rp)
                <input type="number" value={plafon} onChange={(e) => setPlafon(+e.target.value)} className="mt-1 w-full border rounded-xl px-3 py-2" />
              </label>
              <label className="text-sm">Tenor (bln)
                <input type="number" min={1} max={120} value={tenor} onChange={(e) => setTenor(clamp(+e.target.value, 1, 120))} className="mt-1 w-full border rounded-xl px-3 py-2" />
              </label>
              <label className="text-sm">Bunga (%/th)
                <input type="number" value={bunga} onChange={(e) => setBunga(+e.target.value)} className="mt-1 w-full border rounded-xl px-3 py-2" />
              </label>
              <label className="text-sm">Grace (bln)
                <input type="number" min={0} max={12} value={grace} onChange={(e) => setGrace(clamp(+e.target.value, 0, 12))} className="mt-1 w-full border rounded-xl px-3 py-2" />
              </label>
              <label className="text-sm">Mode Grace
                <select value={modeGrace} onChange={(e) => setModeGrace(e.target.value)} className="mt-1 w-full border rounded-xl px-3 py-2">
                  <option value="pokok">Bayar bunga saja</option>
                  <option value="full">Full grace (kapitalisasi bunga)</option>
                </select>
              </label>
            </div>
            <div className="text-xs text-slate-600 mt-2">Plafon diterapkan: <b>{IDR(plafonCapped)}</b> (maks. 3 miliar)</div>
          </div>

          <div className="mt-6">
            <button onClick={exportExcel} className="px-4 py-2 rounded-xl bg-emerald-600 text-white">Export Excel</button>
          </div>
        </section>

        {/* RIGHT: Dashboard */}
        <section className="bg-white border rounded-2xl shadow-sm p-6">
          <h2 className="text-xl font-bold">Dashboard & KPI</h2>

          {/* KPI Cards */}
          <div className="grid md:grid-cols-3 gap-3 mt-4 text-sm">
            <div className="p-4 rounded-xl bg-slate-100" title="Selisih nilai kini dari arus kas (diskonto bulanan). NPV ≥ 0 umumnya dianggap layak.">
              <div className="font-semibold">NPV</div>
              <div className="text-2xl">{IDR(NPV)}</div>
            </div>
            <div className="p-4 rounded-xl bg-slate-100" title="Tingkat pengembalian internal. Bandingkan dengan diskonto tahunan.">
              <div className="font-semibold">IRR (th)</div>
              <div className="text-2xl">{isFinite(IRR_y) ? `${(IRR_y*100).toFixed(2)}%` : '–'}</div>
            </div>
            <div className="p-4 rounded-xl bg-slate-100" title="Waktu ketika akumulasi arus kas ≥ 0. Semakin cepat semakin baik.">
              <div className="font-semibold">Payback</div>
              <div className="text-2xl">{isFinite(payback) ? `${payback} bln` : '> horizon'}</div>
            </div>
            <div className="p-4 rounded-xl bg-slate-100" title="Rata-rata kemampuan bayar: CFO / Angsuran. ≥ 1,2 dianggap aman.">
              <div className="font-semibold">DSCR Avg</div>
              <div className="text-2xl">{dscrAvg.toFixed(2)}</div>
            </div>
            <div className="p-4 rounded-xl bg-slate-100" title="Penyusutan metode garis lurus berdasarkan umur ekonomis aset.">
              <div className="font-semibold">Penyusutan/bln</div>
              <div className="text-2xl">{IDR(penyusutanBulanan)}</div>
            </div>
            <div className="p-4 rounded-xl bg-slate-100" title="Biaya operasional bulanan (dibatasi aturan ≤ Rp500 juta).">
              <div className="font-semibold">OPEX/bln</div>
              <div className="text-2xl">{IDR(totalOpex)}</div>
            </div>
          </div>

          {/* Verdict */}
          <div className={`mt-4 p-4 rounded-xl ${verdictColor}`}>
            <div className="font-semibold">Kesimpulan: {verdict}</div>
            <div className="text-sm mt-1 text-black/70">
              Kriteria terpenuhi: {Object.entries(criteria).map(([k,v])=> v? k.toUpperCase(): null).filter(Boolean).join(', ') || '–'}.
              
              <div className="mt-2 text-xs">
                <b>Aturan ringkas:</b> NPV ≥ 0, IRR (th) ≥ Diskonto, Payback ≤ 36 bln, DSCR ≥ 1,2. 4 terpenuhi → Layak; ≥2 → Kurang Layak; lainnya → Tidak Layak.
              </div>
            </div>
          </div>

          {/* Loan snapshot */}
          <div className="mt-6">
            <h3 className="font-semibold">Rencana Pengembalian (12 bln pertama)</h3>
            <div className="overflow-auto mt-2">
              <table className="min-w-full text-xs">
                <thead>
                  <tr className="bg-slate-100">
                    <th className="p-2 text-left">Bulan</th>
                    <th className="p-2 text-right">Pokok</th>
                    <th className="p-2 text-right">Bunga</th>
                    <th className="p-2 text-right">Angsuran</th>
                    <th className="p-2 text-right">Saldo</th>
                  </tr>
                </thead>
                <tbody>
                  {loanSchedule.slice(0, 12).map((r) => (
                    <tr key={r.month} className="odd:bg-white even:bg-slate-50">
                      <td className="p-2">{r.month}</td>
                      <td className="p-2 text-right">{IDR(r.principal)}</td>
                      <td className="p-2 text-right">{IDR(r.interest)}</td>
                      <td className="p-2 text-right">{IDR(r.payment)}</td>
                      <td className="p-2 text-right">{IDR(r.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="text-xs text-slate-500 mt-2">Detail lengkap tersedia di Export Excel.</div>
            </div>
          </div>

          {/* Cashflow snapshot */}
          <div className="mt-6">
            <h3 className="font-semibold">Cashflow Projection (12 bln pertama)</h3>
            <div className="overflow-auto mt-2">
              <table className="min-w-full text-xs">
                <thead>
                  <tr className="bg-slate-100">
                    <th className="p-2 text-left">Bulan</th>
                    <th className="p-2 text-right">Pendapatan</th>
                    <th className="p-2 text-right">OPEX</th>
                    <th className="p-2 text-right">Penyusutan</th>
                    <th className="p-2 text-right">Bunga</th>
                    <th className="p-2 text-right">Angsuran</th>
                    <th className="p-2 text-right">Net CF</th>
                  </tr>
                </thead>
                <tbody>
                  {cashflowRows.rows.slice(0, 12).map((r) => (
                    <tr key={r.bulan} className="odd:bg-white even:bg-slate-50">
                      <td className="p-2">{r.bulan}</td>
                      <td className="p-2 text-right">{IDR(r.pendapatan)}</td>
                      <td className="p-2 text-right">{IDR(r.opex)}</td>
                      <td className="p-2 text-right">{IDR(r.penyusutan)}</td>
                      <td className="p-2 text-right">{IDR(r.bunga)}</td>
                      <td className="p-2 text-right">{IDR(r.angsuran)}</td>
                      <td className="p-2 text-right">{IDR(r.netCF)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="text-xs text-slate-500 mt-2">Arus kas awal (bulan 0) = -CAPEX + Pinjaman = {IDR(-totalCapex + plafonCapped)}</div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

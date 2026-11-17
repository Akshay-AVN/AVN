/**
 * AVN EcoPlates — Business Dashboard
 * Single-file React component · Tailwind CSS · lucide-react · Recharts
 *
 * How the business is modelled
 *  - Raw materials: Leaf 12″, Leaf 14″, Cargation Sheet 12″ / 14″ and Paper Roll (bought by kg,
 *    converted to papers at a papers-per-kg rate, default 120). Every purchase is
 *    kept as its own batch with its own price, so history is never overwritten.
 *  - One plate = 1 leaf + 1 base (cargation sheet, or paper for sitting plates — see PRODUCTS), pressed on the hydraulic machine,
 *    plus a making charge. Sitting plates use the SAME leaf stock as the normal plate of that size (one shared pool).
 *    plus a making charge per plate.
 *        e.g. 14″ plate: leaf ₹0.90 + sheet ₹3.10 + making ₹0.70 = ₹4.70 cost → sold at ₹6.20 → ₹1.50 profit
 *  - Production runs (plates pressed but not sold) take leaf + base out of raw stock and become ready-to-sell
 *    plates at their real cost. Orders use ready plates first, then are made to order from raw stock.
 *  - Raw stock is used first-in, first-out (oldest batch first), so each order's cost reflects the
 *    exact batches it used. Each order also stores the price and making charge used at the time.
 *  - Investments & expenses: Machinery (one-time, recovered through profits), Labour, Transport, Other.
 *  - Profit on sales      = Sales − (leaf + sheet + making) − labour/transport/other   [selected dates]
 *  - Overall profit/loss  = Sales to date + stock in hand (at cost) − all money invested to date
 */
import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  PieChart, Pie, Cell, LineChart, ReferenceLine,
} from 'recharts';
import {
  Leaf, IndianRupee, TrendingUp, TrendingDown, Package, Wallet, ShoppingCart, Plus, Upload, Calendar, X,
  Pencil, Trash2, Layers, Calculator, Info, AlertTriangle, CheckCircle2, Clock, RotateCcw, FileSpreadsheet,
  Database, Boxes, Search, LayoutDashboard, Settings, Copy, Phone, Target, PiggyBank, Wrench, Factory, ScrollText,
} from 'lucide-react';
import { createClient } from '@supabase/supabase-js';

/* ────────────────────────────── Shared online database (optional) ──────────────────────────────
 * Fill these two values from Supabase → Project Settings → API Keys to share data between team members with a login.
 * Leave them blank and the dashboard keeps all data in this browser only (as before).
 * The publishable key is meant to be public: Row Level Security (see supabase-setup.sql) lets only your team in.
 * NEVER put a secret / service_role key here — it bypasses all security.
 */
const SUPABASE_URL = 'https://kdqagnlcmwkcvzfkpxuv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_DuySrWozvkw4-FgT0cKIQw_-6oATsRI'; // the publishable key, starts with sb_publishable_ (or a legacy "anon" key)

/* ────────────────────────────── Business reference data ────────────────────────────── */

const MATERIALS = {
  leaf12: { label: 'Leaf 12″', prefix: 'L12', unit: 'leaves', each: 'leaf', color: '#059669' },
  leaf14: { label: 'Leaf 14″', prefix: 'L14', unit: 'leaves', each: 'leaf', color: '#0284c7' },
  sheet12: { label: 'Cargation Sheet 12″', prefix: 'CS12', unit: 'sheets', each: 'sheet', color: '#6366f1' },
  sheet14: { label: 'Cargation Sheet 14″', prefix: 'CS14', unit: 'sheets', each: 'sheet', color: '#a21caf' },
  // Bought by weight; stock is tracked in papers (kg × papers-per-kg).
  paper: { label: 'Paper Roll', prefix: 'PR', unit: 'papers', each: 'paper', color: '#ca8a04', byKg: true },
};

const EXPENSE_CATS = {
  machinery: { label: 'Machinery', capital: true, hint: 'One-time investment (press, dies). Recovered through profits — not deducted from each sale.' },
  labour: { label: 'Labour', hint: 'Wages, loading / pressing crew. Deducted from profit on the date paid.' },
  transport: { label: 'Transport', hint: 'Freight for material or deliveries. Deducted from profit on the date paid.' },
  other: { label: 'Other (rent, power…)', hint: 'Any other running cost. Deducted from profit on the date paid.' },
};

const PRODUCTS = {
  // `leaf` and `sheet` (the base pressed under the leaf) point at stock items. Sitting plates share the
  // same leaf stock as the normal plate of that size, and use paper from the paper roll as their base.
  P12: { name: '12″ Leaf Plate', leaf: 'leaf12', sheet: 'sheet12' },
  P14: { name: '14″ Leaf Plate', leaf: 'leaf14', sheet: 'sheet14' },
  P12S: { name: '12″ Sitting Plate', leaf: 'leaf12', sheet: 'paper' },
  P14S: { name: '14″ Sitting Plate', leaf: 'leaf14', sheet: 'paper' },
};
/** Bill of materials: one leaf + one base. An order keeps the base it was made with (`base`), so history never changes. */
const bomOf = (code, base) => [{ mat: PRODUCTS[code].leaf, qty: 1 }, { mat: base || PRODUCTS[code].sheet, qty: 1 }];
/** Base each plate used before the paper roll was introduced — applied to orders saved without a `base`. */
/** Plates that draw on the same stock item (e.g. 14″ plate and 14″ sitting plate both use Leaf 14″). */
const usersOf = (mat) => Object.entries(PRODUCTS).filter(([, p]) => p.leaf === mat || p.sheet === mat).map(([, p]) => p.name);
const LEGACY_BASE = { P12: 'sheet12', P14: 'sheet14', P12S: 'paper', P14S: 'sheet14' };
const SCHEMA = 3;

const DEFAULT_SETTINGS = {
  products: { P12: { making: 0.7, price: 5.3 }, P14: { making: 0.7, price: 6.2 }, P12S: { making: 0.7, price: 6.0 }, P14S: { making: 0.7, price: 7.2 } },
  targetMargin: 25,
  lowStockQty: 5000,
  recoverMonths: 6,
  papersPerKg: 120,
};

const SEED_PURCHASES = [
  { id: 'L14-001', date: '2026-11-01', material: 'leaf14', supplier: 'Chaitanya', qty: 50000, unitPrice: 1.75, payment: 'Paid' },
  { id: 'L12-001', date: '2026-11-01', material: 'leaf12', supplier: 'Chaitanya', qty: 30000, unitPrice: 1.25, payment: 'Paid' },
  { id: 'CS12-001', date: '2026-11-01', material: 'sheet12', supplier: 'Shree Packaging', qty: 25000, unitPrice: 2.6, payment: 'Paid' },
  { id: 'CS14-001', date: '2026-11-01', material: 'sheet14', supplier: 'Shree Packaging', qty: 40000, unitPrice: 3.2, payment: 'Paid' },
  { id: 'PR-001', date: '2026-11-04', material: 'paper', supplier: 'Sri Lakshmi Paper', qty: 7200, unitPrice: 6600 / 7200, kg: 60, papersPerKg: 120, perKg: 110, payment: 'Paid' },
  { id: 'L14-002', date: '2026-11-14', material: 'leaf14', supplier: 'Basudev', qty: 300000, unitPrice: 0.9, payment: 'Pending' },
  { id: 'CS14-002', date: '2026-11-14', material: 'sheet14', supplier: 'Shree Packaging', qty: 70000, unitPrice: 3.1, payment: 'Paid' },
  { id: 'CS12-002', date: '2026-11-14', material: 'sheet12', supplier: 'Shree Packaging', qty: 30000, unitPrice: 2.6, payment: 'Paid' },
  { id: 'L12-002', date: '2026-11-14', material: 'leaf12', supplier: 'Basudev', qty: 50000, unitPrice: 0.8, payment: 'Pending' },
  { id: 'PR-002', date: '2026-11-14', material: 'paper', supplier: 'Sri Lakshmi Paper', qty: 6000, unitPrice: 5500 / 6000, kg: 50, papersPerKg: 120, perKg: 110, payment: 'Paid' },
];

const SEED_EXPENSES = [
  { id: 'EX-001', date: '2026-11-03', category: 'machinery', item: 'Machine 2 die', payee: 'Precision Dies & Tools', amount: 180000, payment: 'Paid' },
  { id: 'EX-002', date: '2026-11-10', category: 'labour', item: 'Pressing & loading crew', payee: 'Crew wages', amount: 20000, payment: 'Paid' },
  { id: 'EX-003', date: '2026-11-14', category: 'transport', item: 'Transport — Basudev leaf lot', payee: 'Mahalakshmi Transport', amount: 28000, payment: 'Paid' },
];

const S = (id, date, customer, product, qty, price, payment = 'Paid') => ({ id, date, customer, phone: '', product, base: PRODUCTS[product].sheet, qty, price, making: 0.7, payment });
const SEED_SALES = [
  S('SO-1001', '2026-11-02', 'Green Leaf Caterers', 'P14', 5000, 6.2),
  S('SO-1002', '2026-11-03', 'Annapoorna Events', 'P12', 4000, 5.3),
  S('SO-1003', '2026-11-04', 'Hotel Udupi Grand', 'P14', 6000, 6.3),
  S('SO-1004', '2026-11-05', 'Sai Temple Trust', 'P14S', 3000, 7.2),
  S('SO-1005', '2026-11-06', 'EcoMart Retail', 'P12', 5000, 5.4),
  S('SO-1006', '2026-11-08', 'Shubh Mangal Decorators', 'P14', 8000, 6.1),
  S('SO-1007', '2026-11-09', 'Sai Temple Trust', 'P14S', 4000, 7.0),
  S('SO-1008', '2026-11-10', 'Hotel Udupi Grand', 'P12', 6000, 5.25),
  S('SO-1009', '2026-11-11', 'Green Leaf Caterers', 'P14', 9000, 6.2),
  S('SO-1010', '2026-11-12', 'Annapoorna Events', 'P12', 5000, 5.5),
  S('SO-1011', '2026-11-13', 'EcoMart Retail', 'P14', 5000, 6.4),
  S('SO-1012', '2026-11-15', 'Green Leaf Caterers', 'P14', 12000, 6.2),
  S('SO-1013', '2026-11-15', 'Annapoorna Events', 'P12', 8000, 5.3),
  S('SO-1014', '2026-11-16', 'Hotel Udupi Grand', 'P12', 6000, 5.3, 'Pending'),
  S('SO-1015', '2026-11-16', 'Sai Temple Trust', 'P14', 15000, 6.3, 'Pending'),
  S('SO-1018', '2026-11-16', 'Shubh Mangal Decorators', 'P12S', 1500, 6.0, 'Pending'),
  S('SO-1016', '2026-11-17', 'EcoMart Retail', 'P14S', 2000, 7.2, 'Pending'),
  S('SO-1017', '2026-11-17', 'Hotel Udupi Grand', 'P14', 10000, 6.2, 'Pending'),
];

// Plates pressed ahead of orders (ready to sell). SO-1017 on 17 Nov takes 10,000 of PD-001; 5,000 + 4,000 stay ready.
const SEED_PRODUCTIONS = [
  { id: 'PD-001', date: '2026-11-16', createdAt: '2026-11-16T12:00:00.000Z', product: 'P14', base: 'sheet14', qty: 15000, making: 0.7, note: '' },
  { id: 'PD-002', date: '2026-11-16', createdAt: '2026-11-16T12:00:00.000Z', product: 'P12', base: 'sheet12', qty: 4000, making: 0.7, note: '' },
];

const SEED = { schema: SCHEMA, purchases: SEED_PURCHASES, expenses: SEED_EXPENSES, sales: SEED_SALES, productions: SEED_PRODUCTIONS, settings: DEFAULT_SETTINGS };
const STORAGE_KEY = 'avn-ecoplates-dashboard-v2';

const C = { revenue: '#059669', cost: '#e11d48', expense: '#fda4af', profit: '#4f46e5', invested: '#e11d48', recovered: '#059669', grid: '#e2e8f0', axis: '#64748b' };
const DIST_COLORS = {
  'Leaf 12″': '#059669', 'Leaf 14″': '#0284c7', 'Cargation Sheet 12″': '#6366f1', 'Cargation Sheet 14″': '#a21caf', 'Paper Roll': '#ca8a04',
  'Making charges': '#0d9488', Machinery: '#475569', Labour: '#e11d48', Transport: '#78716c', 'Other (rent, power…)': '#94a3b8',
};

/* ────────────────────────────── Utilities ────────────────────────────── */

const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const toUTC = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const fromUTC = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const addDays = (iso, n) => fromUTC(toUTC(iso) + n * 86400000);
const diffDays = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 86400000);
const maxISO = (a, b) => (a > b ? a : b);
const fmtDate = (iso) => { if (!iso) return '—'; const [y, m, d] = iso.split('-'); return `${+d} ${MONTHS[+m - 1]} ${y}`; };
const fmtShort = (iso) => { const [, m, d] = iso.split('-'); return `${+d} ${MONTHS[+m - 1]}`; };
const weekStart = (iso) => addDays(iso, -((new Date(toUTC(iso)).getUTCDay() + 6) % 7));
const isISODate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

const inr0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numFmt = new Intl.NumberFormat('en-IN');
const fmtINR = (n) => inr0.format(Math.round(n || 0));
const fmtINR2 = (n) => inr2.format(n || 0);
const fmtNum = (n) => numFmt.format(Math.round(n || 0));
const fmtPct = (n) => (Number.isFinite(n) ? `${n.toFixed(1)}%` : '—');
const fmtCompact = (n) => {
  const a = Math.abs(n || 0); const s = n < 0 ? '−' : '';
  if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${s}₹${(a / 1e3).toFixed(1)}K`;
  return `${s}₹${a.toFixed(0)}`;
};
const byDateId = (a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id));
const sum = (arr, f) => arr.reduce((t, x) => t + (f ? f(x) : x), 0);
const round2 = (n) => Math.round(n * 100) / 100;

function nextId(prefix, list) {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  const max = list.reduce((m, r) => { const mt = re.exec(r.id); return mt ? Math.max(m, +mt[1]) : m; }, prefix === 'SO' ? 1000 : 0);
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

const BACKUP_KEY = `${STORAGE_KEY}-autobackup`;

/**
 * Reads saved data and upgrades older formats in place — nothing is ever dropped.
 *  - Before upgrading, the untouched saved copy is kept under BACKUP_KEY (a restore point from the last session).
 *  - Unreadable data is left exactly where it is (status 'unreadable'); the app will not overwrite it.
 */
function loadState() {
  let raw = null;
  try { raw = window.localStorage.getItem(STORAGE_KEY); } catch (e) { return { status: 'empty' }; }
  if (!raw) return { status: 'empty' };
  try {
    const p = JSON.parse(raw);
    if (!(Array.isArray(p?.purchases) && Array.isArray(p?.expenses) && Array.isArray(p?.sales))) return { status: 'unreadable', raw };
    try { window.localStorage.setItem(BACKUP_KEY, JSON.stringify({ savedAt: new Date().toISOString(), raw })); } catch (e) { /* ignore */ }
    const notes = [];
    // v2 had one "Cargation Sheet" — those batches become 14″ sheets.
    const legacySheets = p.purchases.filter((x) => x.material === 'sheet').length;
    if (legacySheets) notes.push(`${legacySheets} cargation sheet purchase(s) were moved to "Cargation Sheet 14″" — edit any that were 12″.`);
    // Sitting plates use the same 14″ leaf — earlier "Leaf 14″ Sitting" batches join the Leaf 14″ stock (kept as their own batches).
    const sittingLeaf = p.purchases.filter((x) => x.material === 'leaf14s').length;
    if (sittingLeaf) notes.push(`${sittingLeaf} "Leaf 14″ Sitting" purchase(s) now count as Leaf 14″ stock — sitting and normal 14″ plates share one leaf stock.`);
    const purchases = p.purchases.map((x) => (x.material === 'sheet' ? { ...x, material: 'sheet14' } : x.material === 'leaf14s' ? { ...x, material: 'leaf14' } : x));
    // Orders saved before the paper roll keep the base they were costed with.
    const old = (p.schema || 0) < SCHEMA;
    let keptOnSheet = 0;
    const sales = p.sales.map((x) => {
      if (x.base) return x;
      const base = old ? LEGACY_BASE[x.product] : PRODUCTS[x.product]?.sheet;
      if (old && x.product === 'P14S') keptOnSheet += 1;
      return { ...x, base };
    });
    if (keptOnSheet) notes.push(`${keptOnSheet} earlier 14″ sitting order(s) stay costed on 14″ cargation sheets as recorded. New sitting orders use the paper roll.`);
    return {
      status: 'ok', notes,
      data: { ...p, schema: SCHEMA, purchases, sales, productions: Array.isArray(p.productions) ? p.productions : [], settings: { ...DEFAULT_SETTINGS, ...p.settings, products: { ...DEFAULT_SETTINGS.products, ...p.settings?.products } } },
    };
  } catch (e) {
    return { status: 'unreadable', raw };
  }
}
function saveState(state) {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
}

/* ────────────────────────────── Shared database helpers ────────────────────────────── */

const CLOUD_CACHE_KEY = `${STORAGE_KEY}-cloud-copy`; // last data seen from the shared database, kept in this browser as a safety copy
const LIST_KEYS = ['purchases', 'expenses', 'sales', 'productions'];
const LIST_KIND = { purchases: 'purchase', expenses: 'expense', sales: 'sale', productions: 'production' };
const KIND_LIST = { purchase: 'purchases', expense: 'expenses', sale: 'sales', production: 'productions' };

let cloudClient = null;
const cloudConfig = () => (typeof window !== 'undefined' && window.AVN_CLOUD) || { url: SUPABASE_URL, key: SUPABASE_ANON_KEY };
/** True for keys that must never be in a website (they bypass all database security). */
function isSecretKey(key) {
  if (!key) return false;
  if (/^sb_secret_/.test(key)) return true;
  try { return JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'service_role'; } catch (e) { return false; }
}
function getCloud() {
  const cfg = cloudConfig();
  if (isSecretKey(cfg.key)) return null;
  if (!cfg.url || !cfg.key) return null;
  if (!cloudClient) cloudClient = createClient(cfg.url, cfg.key);
  return cloudClient;
}
const mergeSettings = (st) => ({ ...DEFAULT_SETTINGS, ...(st || {}), products: { ...DEFAULT_SETTINGS.products, ...(st?.products || {}) } });
const toRow = (listKey, rec) => ({ kind: LIST_KIND[listKey], id: rec.id, data: rec, deleted: false });

/** Apply one changed database row (from a live update) to the dashboard data. */
function applyRow(d, row) {
  if (row.kind === 'settings') return row.deleted ? d : { ...d, settings: mergeSettings(row.data) };
  const key = KIND_LIST[row.kind];
  if (!key) return d;
  const rest = (d[key] || []).filter((x) => x.id !== row.id);
  return { ...d, [key]: row.deleted ? rest : [...rest, { ...row.data, id: row.id }] };
}

/** Read every (not deleted) record, 1,000 at a time. */
async function cloudLoadAll(db) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('records').select('kind,id,data').eq('deleted', false).range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const out = { schema: SCHEMA, purchases: [], expenses: [], sales: [], productions: [], settings: null };
  rows.forEach((r) => { if (r.kind === 'settings') out.settings = r.data; else if (KIND_LIST[r.kind]) out[KIND_LIST[r.kind]].push({ ...r.data, id: r.id }); });
  return { data: { ...out, settings: mergeSettings(out.settings) }, empty: rows.length === 0 };
}

/** Write many rows (insert or replace), 500 at a time. */
async function cloudUpsertAll(db, rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from('records').upsert(rows.slice(i, i + 500), { onConflict: 'kind,id' });
    if (error) throw error;
  }
}

/* ────────────────────────────── FIFO stock engine ────────────────────────────── */

/**
 * Replays production runs and orders in date order (same day: in the order they were entered).
 *  - A production run turns raw stock (leaf + base, oldest batch first) into ready plates at their real cost.
 *  - An order takes ready plates of that type first (oldest run first); anything still needed is made to order
 *    from raw stock on the order date, with the order's own making charge.
 * A batch / run can only be used on or after its own date.
 */
function runFifo(purchases, sales, productions = []) {
  const lots = {};
  const lotIndex = {};
  purchases.slice().sort(byDateId).forEach((p) => {
    if (!MATERIALS[p.material]) return;
    const qty = Number(p.qty) || 0;
    const lot = { id: p.id, mat: p.material, date: p.date, supplier: p.supplier, qty, unitCost: Number(p.unitPrice) || 0, remaining: qty, used: [] };
    (lots[p.material] = lots[p.material] || []).push(lot);
    lotIndex[p.id] = lot;
  });

  const takeRaw = (mat, need, date, ref, prefer) => {
    const taken = [];
    const pool = lots[mat] || [];
    // A chosen batch (e.g. a particular leaf vendor) is used first; anything more comes from the oldest stock.
    const chosen = prefer && lotIndex[prefer] && lotIndex[prefer].mat === mat ? lotIndex[prefer] : null;
    for (const lot of chosen ? [chosen, ...pool.filter((l) => l !== chosen)] : pool) {
      if (need <= 0) break;
      if (lot.date > date || lot.remaining <= 0) continue;
      const t = Math.min(need, lot.remaining);
      lot.remaining -= t; need -= t;
      lot.used.push({ date, qty: t, ref });
      taken.push({ batchId: lot.id, supplier: lot.supplier, qty: t, unitCost: lot.unitCost });
    }
    if (need > 0) {
      // Not enough stock on that date — cost the gap at the latest known price and flag it.
      const r = pool.slice().reverse().find((l) => l.date <= date) || pool[pool.length - 1];
      taken.push({ batchId: null, supplier: 'Not in stock', qty: need, unitCost: r ? r.unitCost : 0, est: true });
    }
    return { taken, short: need > 0 ? need : 0, cost: sum(taken, (t) => t.qty * t.unitCost) };
  };
  const makeFromRaw = (product, base, qty, date, ref, leafLot) => {
    const out = { lines: {}, unitMat: {}, shortfall: {}, materialCost: 0 };
    bomOf(product, base).forEach((b) => {
      const r = takeRaw(b.mat, qty * b.qty, date, ref, b.mat === PRODUCTS[product].leaf ? leafLot : null);
      out.lines[b.mat] = r.taken;
      if (r.short) out.shortfall[b.mat] = r.short;
      out.materialCost += r.cost;
      out.unitMat[b.mat] = qty ? r.cost / qty : 0;
    });
    return out;
  };

  const fg = {}; const fgIndex = {}; const prodAllocs = {}; const allocs = {};
  const events = [
    ...productions.filter((x) => PRODUCTS[x.product]).map((rec) => ({ kind: 0, rec })),
    ...sales.filter((x) => PRODUCTS[x.product]).map((rec) => ({ kind: 1, rec })),
    // Same day: records in the order they were entered (older records without a save time count as earliest),
    // so an order only uses ready plates that were recorded before it.
  ].sort((a, b) => a.rec.date.localeCompare(b.rec.date) || (a.rec.createdAt || '').localeCompare(b.rec.createdAt || '') || a.kind - b.kind || String(a.rec.id).localeCompare(String(b.rec.id)));

  events.forEach(({ kind, rec }) => {
    const qty = Number(rec.qty) || 0;
    const making = Number(rec.making) || 0;
    if (kind === 0) {
      const r = makeFromRaw(rec.product, rec.base, qty, rec.date, rec.id, rec.leafLot);
      const unitCost = qty ? r.materialCost / qty + making : 0;
      const lot = { id: rec.id, product: rec.product, date: rec.date, createdAt: rec.createdAt, qty, remaining: qty, unitCost, unitMat: r.unitMat, making, used: [] };
      (fg[rec.product] = fg[rec.product] || []).push(lot);
      fgIndex[rec.id] = lot;
      prodAllocs[rec.id] = { ...r, makingCost: qty * making, unitCost };
      return;
    }
    const price = Number(rec.price) || 0;
    let need = qty;
    const fromStock = [];
    for (const lot of fg[rec.product] || []) {
      if (need <= 0) break;
      if (lot.date > rec.date || lot.remaining <= 0) continue;
      const t = Math.min(need, lot.remaining);
      lot.remaining -= t; need -= t;
      lot.used.push({ date: rec.date, qty: t, ref: rec.id });
      fromStock.push({ prodId: lot.id, qty: t, unitCost: lot.unitCost, unitMat: lot.unitMat, making: lot.making });
    }
    const made = need > 0 ? makeFromRaw(rec.product, rec.base, need, rec.date, rec.id, rec.leafLot) : { lines: {}, unitMat: {}, shortfall: {}, materialCost: 0 };
    const stockCost = sum(fromStock, (x) => x.qty * x.unitCost);
    const stockMaking = sum(fromStock, (x) => x.qty * x.making);
    const res = {
      fromStock, madeQty: need, lines: made.lines, shortfall: made.shortfall,
      materialCost: stockCost - stockMaking + made.materialCost,
      makingPaid: need * making, // making charge paid at order time (made to order)
    };
    res.makingCost = stockMaking + res.makingPaid;
    res.unitMat = {};
    new Set([...Object.keys(made.unitMat), ...fromStock.flatMap((x) => Object.keys(x.unitMat))]).forEach((mm) => {
      res.unitMat[mm] = qty ? (sum(fromStock, (x) => x.qty * (x.unitMat[mm] || 0)) + (made.unitMat[mm] || 0) * need) / qty : 0;
    });
    res.making = qty ? res.makingCost / qty : 0;
    res.cogs = res.materialCost + res.makingCost;
    res.unitCost = qty ? res.cogs / qty : 0;
    res.revenue = qty * price;
    res.profit = res.revenue - res.cogs;
    allocs[rec.id] = res;
  });
  return { lots, lotIndex, allocs, fg, fgIndex, prodAllocs };
}

const usedAsOf = (lot, date) => sum(lot.used.filter((u) => u.date <= date), (u) => u.qty);
const remainingAsOf = (lot, date) => (lot.date <= date ? lot.qty - usedAsOf(lot, date) : 0);

/** Stock on hand for one material as of a date. */
function stockOf(fifo, mat, date) {
  const ls = (fifo.lots[mat] || []).filter((l) => l.date <= date);
  const qty = sum(ls, (l) => remainingAsOf(l, date));
  const value = sum(ls, (l) => remainingAsOf(l, date) * l.unitCost);
  return { qty, value, lots: ls };
}

/** Ready (pressed, unsold) plates of one type as of a date. */
function readyOf(fifo, product, date) {
  const ls = (fifo.fg[product] || []).filter((l) => l.date <= date);
  const qty = sum(ls, (l) => remainingAsOf(l, date));
  const value = sum(ls, (l) => remainingAsOf(l, date) * l.unitCost);
  return { qty, value, lots: ls };
}

/** Price of the next unit that will be used (oldest batch with stock left), else the latest purchase price. */
function nextUnitCost(fifo, mat) {
  const ls = fifo.lots[mat] || [];
  const next = ls.find((l) => l.remaining > 0);
  return next ? next.unitCost : (ls.length ? ls[ls.length - 1].unitCost : 0);
}
const latestPrice = (fifo, mat) => { const ls = fifo.lots[mat] || []; return ls.length ? ls[ls.length - 1].unitCost : 0; };

function basisOf(alloc, mat) {
  const stock = alloc?.fromStock || [];
  const lines = alloc?.lines?.[mat] || [];
  if (stock.length) {
    const detail = [...stock.map((x) => `${fmtNum(x.qty)} ready from ${x.prodId} @ ₹${x.unitCost.toFixed(2)}/plate`),
      ...lines.map((l) => `${fmtNum(l.qty)} made to order with ${l.batchId || 'no stock'} @ ₹${l.unitCost.toFixed(2)}`)].join(' + ');
    return lines.length ? { kind: 'blended', label: 'Ready stock + made to order', detail } : { kind: 'stock', label: `Ready stock (${stock.map((x) => x.prodId).join(', ')})`, detail };
  }
  if (!lines.length) return { kind: 'none', label: '—', detail: '' };
  const detail = lines.map((l) => `${fmtNum(l.qty)} × ${l.batchId || 'no stock'} @ ₹${l.unitCost.toFixed(2)}`).join(' + ');
  if (lines.some((l) => l.est)) return { kind: 'short', label: 'Short of stock', detail };
  if (lines.length === 1) return { kind: 'single', label: `${lines[0].supplier} @ ₹${lines[0].unitCost.toFixed(2)}`, detail };
  const q = sum(lines, (l) => l.qty); const c = sum(lines, (l) => l.qty * l.unitCost);
  return { kind: 'blended', label: `Mixed batches @ ₹${(c / q).toFixed(2)}`, detail };
}

/* ────────────────────────────── CSV helpers ────────────────────────────── */

const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCSV = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
function parseCSV(text) {
  const rows = []; let row = []; let field = ''; let q = false;
  const t = text.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}
function downloadFile(name, content) {
  try {
    const blob = new Blob(['﻿' + content], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch (e) { return false; }
}
const DATA_HEADER = ['record_type', 'id', 'date', 'type', 'item', 'party', 'phone', 'qty', 'unit_price', 'making_charge', 'payment_status', 'kg', 'papers_per_kg', 'price_per_kg', 'base', 'created_at', 'leaf_batch'];

/* ────────────────────────────── Small UI pieces ────────────────────────────── */

const BADGE_TONES = {
  emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20', rose: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/20', indigo: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
  slate: 'bg-slate-100 text-slate-600 ring-slate-500/20',
};
function Badge({ tone = 'slate', icon: Icon, children, title }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${BADGE_TONES[tone]}`}>
      {Icon && <Icon className="h-3 w-3" aria-hidden="true" />}{children}
    </span>
  );
}
const PaymentBadge = ({ status }) => (status === 'Paid' ? <Badge tone="emerald" icon={CheckCircle2}>Paid</Badge> : <Badge tone="amber" icon={Clock}>Pending</Badge>);
function BasisBadge({ basis }) {
  const map = { single: ['emerald', Leaf], blended: ['indigo', Layers], stock: ['amber', Package], short: ['rose', AlertTriangle], none: ['slate', null] };
  const [tone, icon] = map[basis.kind] || map.none;
  return <Badge tone={tone} icon={icon} title={basis.detail}>{basis.label}</Badge>;
}

function Card({ title, subtitle, icon: Icon, actions, children, className = '', bodyClass = 'p-4 sm:p-5' }) {
  return (
    <section className={`min-w-0 rounded-2xl border border-slate-200 bg-white shadow-sm ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-start gap-2.5">
            {Icon && <span className="mt-0.5 rounded-lg bg-indigo-50 p-1.5 text-indigo-600"><Icon className="h-4 w-4" aria-hidden="true" /></span>}
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
              {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
            </div>
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

const KPI_TONES = { emerald: 'bg-emerald-50 text-emerald-600', rose: 'bg-rose-50 text-rose-600', indigo: 'bg-indigo-50 text-indigo-600', amber: 'bg-amber-50 text-amber-600', slate: 'bg-slate-100 text-slate-600' };
function KpiCard({ icon: Icon, label, value, tone = 'slate', children, badge, scope }) {
  return (
    <div className="flex min-w-0 flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</span>
        <span className={`rounded-lg p-1.5 ${KPI_TONES[tone]}`}><Icon className="h-4 w-4" aria-hidden="true" /></span>
      </div>
      {scope && <span className="text-[10px] text-slate-400">{scope}</span>}
      <div className="mt-1.5 flex flex-wrap items-baseline gap-2">
        <span className="text-2xl font-semibold tracking-tight text-slate-900 tabular-nums">{value}</span>{badge}
      </div>
      <div className="mt-2 space-y-1 text-xs text-slate-500">{children}</div>
    </div>
  );
}
const KpiRow = ({ label, value, dot, strong }) => (
  <div className="flex items-center justify-between gap-2">
    <span className="flex items-center gap-1.5">{dot && <span className="h-2 w-2 rounded-full" style={{ background: dot }} />}{label}</span>
    <span className={`tabular-nums ${strong ? 'font-semibold text-slate-800' : 'font-medium text-slate-700'}`}>{value}</span>
  </div>
);

const inputCls = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:bg-slate-50';
function Field({ label, hint, error, children, className = '' }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-xs font-medium text-slate-700">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-rose-600">{error}</span> : hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}
    </label>
  );
}

const btn = {
  primary: 'inline-flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2',
  emerald: 'inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2',
  ghost: 'inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
  danger: 'inline-flex items-center justify-center gap-1.5 rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-rose-700',
  icon: 'rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
};

function Modal({ title, subtitle, icon: Icon, onClose, children, footer, wide }) {
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-[2px]" onClick={onClose} />
      <div className={`relative flex max-h-[94vh] w-full flex-col rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'}`}>
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="flex items-start gap-3">
            {Icon && <span className="rounded-lg bg-indigo-50 p-2 text-indigo-600"><Icon className="h-5 w-5" aria-hidden="true" /></span>}
            <div><h3 className="text-base font-semibold text-slate-900">{title}</h3>{subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}</div>
          </div>
          <button type="button" onClick={onClose} className={btn.icon} aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-5 py-3 sm:rounded-b-2xl">{footer}</div>}
      </div>
    </div>
  );
}
function ConfirmDialog({ title, message, confirmLabel = 'Delete', onConfirm, onClose }) {
  return (
    <Modal title={title} icon={AlertTriangle} onClose={onClose}
      footer={<><button className={btn.ghost} onClick={onClose}>Cancel</button><button className={btn.danger} onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</button></>}>
      <p className="text-sm text-slate-600">{message}</p>
    </Modal>
  );
}

function ChartTooltip({ active, payload, label, labelFormatter, valueFormatter = fmtINR }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white/95 px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 font-semibold text-slate-800">{labelFormatter ? labelFormatter(label, payload) : label}</div>
      {payload.map((p) => (
        <div key={p.dataKey || p.name} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5 text-slate-600"><span className="h-2 w-2 rounded-full" style={{ background: p.color || p.payload?.fill }} />{p.name}</span>
          <span className="font-medium tabular-nums text-slate-900">{valueFormatter(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

const Th = ({ children, right, className = '' }) => (
  <th scope="col" className={`whitespace-nowrap px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 ${right ? 'text-right' : 'text-left'} ${className}`}>{children}</th>
);
const Td = ({ children, right, className = '', title }) => (
  <td title={title} className={`whitespace-nowrap px-3 py-2.5 text-sm ${right ? 'text-right tabular-nums' : ''} ${className}`}>{children}</td>
);
function RowActions({ onEdit, onDelete, onHistory }) {
  return (
    <div className="flex justify-end gap-0.5">
      {onHistory && <button className={btn.icon} onClick={onHistory} aria-label="History" title="See every change to this record"><ScrollText className="h-4 w-4" /></button>}
      <button className={btn.icon} onClick={onEdit} aria-label="Edit"><Pencil className="h-4 w-4" /></button>
      <button className={`${btn.icon} hover:!text-rose-600`} onClick={onDelete} aria-label="Delete"><Trash2 className="h-4 w-4" /></button>
    </div>
  );
}
const EmptyState = ({ text }) => <div className="flex h-40 flex-col items-center justify-center gap-2 text-sm text-slate-500"><Calendar className="h-6 w-6 text-slate-300" />{text}</div>;

/** Quantity + per-unit price + total, kept in sync (enter either per-unit or total). */
function PriceInputs({ qty, unitPrice, onQty, onUnit, unitLabel, errors = {} }) {
  const total = Number(qty) > 0 && Number(unitPrice) > 0 ? round2(Number(qty) * Number(unitPrice)) : '';
  return (
    <>
      <Field label={`Quantity (${unitLabel})`} error={errors.qty}>
        <input type="number" min="0" step="1" inputMode="numeric" className={inputCls} value={qty} onChange={(e) => onQty(e.target.value)} placeholder="e.g. 300000" />
      </Field>
      <Field label="Buying price per unit (₹)" error={errors.unitPrice}>
        <input type="number" min="0" step="0.01" inputMode="decimal" className={inputCls} value={unitPrice} onChange={(e) => onUnit(e.target.value)} placeholder="e.g. 0.90" />
      </Field>
      <Field label="…or total amount paid (₹)" hint="Typing a total works out the per-unit price" className="sm:col-span-2">
        <input type="number" min="0" step="1" inputMode="decimal" className={inputCls} value={total}
          onChange={(e) => { const t = Number(e.target.value); if (Number(qty) > 0 && t >= 0) onUnit(String(round2(t / Number(qty)) || '')); }}
          placeholder={Number(qty) > 0 ? 'e.g. 270000' : 'Enter quantity first'} disabled={!(Number(qty) > 0)} />
      </Field>
    </>
  );
}

/* ────────────────────────────── Forms ────────────────────────────── */

/** Paper roll purchase: weight (kg) × papers per kg = papers; price per kg or total → cost per paper. */
function PaperInputs({ kg, ppk, perKg, onKg, onPpk, onPerKg, errors = {} }) {
  const K = Number(kg); const P = Number(ppk); const R = Number(perKg);
  const total = K > 0 && R > 0 ? round2(K * R) : '';
  const papers = K > 0 && P > 0 ? Math.round(K * P) : 0;
  return (
    <>
      <Field label="Weight bought (kg)" error={errors.kg}>
        <input type="number" min="0" step="0.5" inputMode="decimal" className={inputCls} value={kg} onChange={(e) => onKg(e.target.value)} placeholder="e.g. 50" />
      </Field>
      <Field label="Papers per kg" error={errors.ppk} hint="Default from Settings">
        <input type="number" min="1" step="1" inputMode="numeric" className={inputCls} value={ppk} onChange={(e) => onPpk(e.target.value)} />
      </Field>
      <Field label="Buying price per kg (₹)" error={errors.perKg}>
        <input type="number" min="0" step="0.5" inputMode="decimal" className={inputCls} value={perKg} onChange={(e) => onPerKg(e.target.value)} placeholder="e.g. 110" />
      </Field>
      <Field label="…or total amount paid (₹)" hint="Typing a total works out the price per kg">
        <input type="number" min="0" step="1" inputMode="decimal" className={inputCls} value={total}
          onChange={(e) => { const t = Number(e.target.value); if (K > 0 && t >= 0) onPerKg(String(round2(t / K) || '')); }}
          placeholder={K > 0 ? 'e.g. 5500' : 'Enter weight first'} disabled={!(K > 0)} />
      </Field>
      <div className="grid grid-cols-2 gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm sm:col-span-2">
        <div><div className="text-xs text-amber-800">Papers you get</div><div className="font-semibold tabular-nums text-slate-900">{papers ? fmtNum(papers) : '—'}</div><div className="text-[11px] text-amber-800">{K > 0 && P > 0 ? `${K} kg × ${P} per kg` : ''}</div></div>
        <div><div className="text-xs text-amber-800">Cost per paper (per plate)</div><div className="font-semibold tabular-nums text-slate-900">{papers && total ? fmtINR2(total / papers) : '—'}</div><div className="text-[11px] text-amber-800">{papers && total ? `${fmtINR(total)} ÷ ${fmtNum(papers)} papers` : ''}</div></div>
      </div>
    </>
  );
}

function StockModal({ initial, purchases, fifo, papersPerKg, onSave, onClose }) {
  const editing = !!initial;
  const [f, setF] = useState(() => (initial
    ? { ...initial, qty: String(initial.qty), unitPrice: String(initial.unitPrice), kg: String(initial.kg ?? ''), ppk: String(initial.papersPerKg ?? papersPerKg), perKg: String(initial.perKg ?? '') }
    : { material: 'leaf14', date: todayISO(), supplier: '', qty: '', unitPrice: '', kg: '', ppk: String(papersPerKg), perKg: '', payment: 'Paid' }));
  const [touched, setTouched] = useState(false);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const mat = MATERIALS[f.material];
  const byKg = !!mat.byKg;
  const kg = Number(f.kg); const ppk = Number(f.ppk); const perKg = Number(f.perKg);
  const qty = byKg ? Math.round(kg * ppk) : Number(f.qty);
  const price = byKg ? (qty > 0 ? (kg * perKg) / qty : 0) : Number(f.unitPrice);
  const lot = editing ? fifo.lotIndex[initial.id] : null;
  const used = lot ? lot.qty - lot.remaining : 0;
  const prev = purchases.filter((p) => p.material === f.material && p.id !== initial?.id).sort(byDateId).pop();
  const inStock = stockOf(fifo, f.material, '9999-12-31');
  const usedMsg = used > qty && f.material === initial?.material ? `${fmtNum(used)} ${mat.unit} already used by orders` : null;

  const errors = byKg ? {
    date: !isISODate(f.date) && 'Pick a date',
    kg: !(kg > 0) ? 'Enter the weight in kg' : usedMsg,
    ppk: !(ppk > 0) && 'Enter papers per kg',
    perKg: !(perKg > 0) && 'Enter the price per kg (or the total)',
  } : {
    date: !isISODate(f.date) && 'Pick a date',
    qty: !(qty > 0) ? 'Enter a quantity above 0' : usedMsg,
    unitPrice: !(price > 0) && 'Enter the buying price',
  };
  const valid = !Object.values(errors).some(Boolean);
  const err = (k) => (touched ? errors[k] : null);
  const submit = (e) => {
    e.preventDefault(); setTouched(true);
    if (!valid) return;
    const rec = { id: initial?.id, date: f.date, material: f.material, supplier: f.supplier.trim() || '—', qty, unitPrice: price, payment: f.payment };
    onSave(byKg ? { ...rec, kg, papersPerKg: ppk, perKg } : rec);
  };

  return (
    <Modal title={editing ? `Edit ${initial.id}` : 'Add Stock (Raw Material Purchase)'} icon={Package} onClose={onClose}
      subtitle="Each purchase is saved as its own batch at its own price — older prices are never overwritten."
      footer={<><button type="button" className={btn.ghost} onClick={onClose}>Cancel</button><button type="submit" form="stock-form" className={btn.primary}><CheckCircle2 className="h-4 w-4" />{editing ? 'Save changes' : 'Add to stock'}</button></>}>
      <form id="stock-form" onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Raw material" className="sm:col-span-2" hint={editing && used > 0 && f.material !== initial.material ? 'Orders that used this batch will be re-costed from the right stock.' : null}>
          <select className={inputCls} value={f.material} onChange={(e) => set('material', e.target.value)}>
            {Object.entries(MATERIALS).map(([k, m]) => <option key={k} value={k}>{m.label}{m.byKg ? ' (in kg)' : ''}</option>)}
          </select>
        </Field>
        <Field label="Purchase date" error={err('date')}><input type="date" className={inputCls} value={f.date} onChange={(e) => set('date', e.target.value)} /></Field>
        <Field label="Payment status"><select className={inputCls} value={f.payment} onChange={(e) => set('payment', e.target.value)}><option>Paid</option><option>Pending</option></select></Field>
        <Field label="Supplier (optional)" className="sm:col-span-2">
          <input className={inputCls} value={f.supplier} onChange={(e) => set('supplier', e.target.value)} placeholder="e.g. Basudev" list="avn-suppliers" />
          <datalist id="avn-suppliers">{[...new Set(purchases.map((p) => p.supplier))].map((s) => <option key={s} value={s} />)}</datalist>
        </Field>
        {byKg
          ? <PaperInputs kg={f.kg} ppk={f.ppk} perKg={f.perKg} onKg={(v) => set('kg', v)} onPpk={(v) => set('ppk', v)} onPerKg={(v) => set('perKg', v)} errors={{ kg: err('kg'), ppk: err('ppk'), perKg: err('perKg') }} />
          : <PriceInputs qty={f.qty} unitPrice={f.unitPrice} onQty={(v) => set('qty', v)} onUnit={(v) => set('unitPrice', v)} unitLabel={mat.unit} errors={{ qty: err('qty'), unitPrice: err('unitPrice') }} />}
      </form>
      <div className="mt-4 grid grid-cols-1 gap-2 rounded-xl bg-slate-50 p-3 text-xs text-slate-600 sm:grid-cols-2">
        <div>Currently in stock: <b className="text-slate-800">{fmtNum(inStock.qty)} {mat.unit}</b></div>
        <div>After this purchase: <b className="text-slate-800">{fmtNum(inStock.qty + (editing ? (qty || 0) - (lot?.qty || 0) : qty || 0))}</b></div>
        {prev && <div className="sm:col-span-2">Last bought {fmtDate(prev.date)} @ <b>₹{prev.unitPrice.toFixed(2)}</b> per {mat.each}{prev.perKg ? ` (₹${prev.perKg}/kg)` : ''}
          {price > 0 && Math.abs(price - prev.unitPrice) >= 0.005 && <span className={price < prev.unitPrice ? 'text-emerald-700' : 'text-rose-700'}> · {price < prev.unitPrice ? '▼ cheaper' : '▲ costlier'} by ₹{Math.abs(price - prev.unitPrice).toFixed(2)} per {mat.each}</span>}</div>}
      </div>
    </Modal>
  );
}

function ExpenseModal({ initial, onSave, onClose }) {
  const editing = !!initial;
  const [f, setF] = useState(() => (initial ? { ...initial, amount: String(initial.amount) } : { category: 'machinery', date: todayISO(), item: '', payee: '', amount: '', payment: 'Paid' }));
  const [touched, setTouched] = useState(false);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const amount = Number(f.amount);
  const errors = { date: !isISODate(f.date) && 'Pick a date', item: !f.item.trim() && 'Required', amount: !(amount > 0) && 'Enter the amount' };
  const valid = !Object.values(errors).some(Boolean);
  const err = (k) => (touched ? errors[k] : null);
  const submit = (e) => { e.preventDefault(); setTouched(true); if (valid) onSave({ id: initial?.id, date: f.date, category: f.category, item: f.item.trim(), payee: f.payee.trim() || '—', amount, payment: f.payment }); };
  return (
    <Modal title={editing ? `Edit ${initial.id}` : 'Add Investment / Expense'} icon={PiggyBank} onClose={onClose}
      subtitle="Machinery, labour and other money put into the business (raw material goes in Add Stock)."
      footer={<><button type="button" className={btn.ghost} onClick={onClose}>Cancel</button><button type="submit" form="exp-form" className={btn.primary}><CheckCircle2 className="h-4 w-4" />{editing ? 'Save changes' : 'Add'}</button></>}>
      <form id="exp-form" onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Type" className="sm:col-span-2" hint={EXPENSE_CATS[f.category].hint}>
          <select className={inputCls} value={f.category} onChange={(e) => set('category', e.target.value)}>
            {Object.entries(EXPENSE_CATS).map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}
          </select>
        </Field>
        <Field label="Description" error={err('item')} className="sm:col-span-2"><input className={inputCls} value={f.item} onChange={(e) => set('item', e.target.value)} placeholder={f.category === 'machinery' ? 'e.g. Hydraulic press / Machine 2 die' : 'e.g. Weekly wages'} /></Field>
        <Field label="Date" error={err('date')}><input type="date" className={inputCls} value={f.date} onChange={(e) => set('date', e.target.value)} /></Field>
        <Field label="Amount (₹)" error={err('amount')}><input type="number" min="0" step="1" className={inputCls} value={f.amount} onChange={(e) => set('amount', e.target.value)} placeholder="e.g. 180000" /></Field>
        <Field label="Paid to (optional)"><input className={inputCls} value={f.payee} onChange={(e) => set('payee', e.target.value)} /></Field>
        <Field label="Payment status"><select className={inputCls} value={f.payment} onChange={(e) => set('payment', e.target.value)}><option>Paid</option><option>Pending</option></select></Field>
      </form>
    </Modal>
  );
}

function OrderModal({ initial, purchases, sales, productions, settings, onSave, onClose }) {
  const editing = !!initial;
  const lastPrice = (code) => sales.filter((s) => s.product === code && s.id !== initial?.id).sort(byDateId).pop()?.price;
  const suggested = (code) => lastPrice(code) ?? settings.products[code].price;
  const [f, setF] = useState(() => (initial
    ? { ...initial, base: initial.base || PRODUCTS[initial.product].sheet, leafLot: initial.leafLot || '', qty: String(initial.qty), price: String(initial.price), making: String(initial.making) }
    : { date: todayISO(), customer: '', phone: '', product: 'P14', base: PRODUCTS.P14.sheet, leafLot: '', qty: '', price: String(suggested('P14')), making: String(settings.products.P14.making), payment: 'Pending' }));
  const [touched, setTouched] = useState(false);
  const [copied, setCopied] = useState(false);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const pickProduct = (code) => setF((p) => ({ ...p, product: code, base: PRODUCTS[code].sheet, leafLot: PRODUCTS[code].leaf === PRODUCTS[p.product].leaf ? p.leafLot : '', price: String(suggested(code)), making: String(settings.products[code].making) }));
  const qty = Number(f.qty); const price = Number(f.price); const making = Number(f.making) || 0;

  const est = useMemo(() => {
    if (!isISODate(f.date)) return null;
    const others = sales.filter((s) => s.id !== initial?.id);
    const base = runFifo(purchases, others, productions);
    const leafMat = PRODUCTS[f.product].leaf;
    // Ready plates of this type available on this date, after all other recorded orders.
    const ready = sum((base.fg[f.product] || []).filter((l) => l.date < f.date || (l.date === f.date && (l.createdAt || '') <= (initial ? initial.createdAt || '' : '9999'))), (l) => l.remaining);
    // Stock that can serve an order on this date, after all other recorded orders.
    // For a past date: what was in stock on that day (later orders don't count against it).
    const past = f.date < todayISO();
    const avail = (mat) => sum((base.lots[mat] || []).filter((l) => l.date <= f.date), (l) => Math.max(0, past ? remainingAsOf(l, f.date) : l.remaining));
    const sheetMat = f.base;
    const leafAvail = avail(leafMat); const sheetAvail = avail(sheetMat);
    const canMake = Math.min(leafAvail, sheetAvail);
    const limitedBy = leafAvail <= sheetAvail ? MATERIALS[leafMat].label : MATERIALS[sheetMat].label;
    const q = qty > 0 ? qty : 1;
    const draft = { id: initial?.id || 'ZZ-DRAFT', createdAt: initial ? initial.createdAt : '9999', date: f.date, product: f.product, base: f.base, leafLot: f.leafLot || undefined, qty: q, price: price || 0, making };
    const run = runFifo(purchases, [...others, draft], productions);
    const a = run.allocs[draft.id];
    const newlyShort = others.filter((s) => Object.keys(run.allocs[s.id]?.shortfall || {}).length && !Object.keys(base.allocs[s.id]?.shortfall || {}).length);
    // Leaf batches (vendor @ price) bought on or before the order date, with what is left after the other orders.
    const leafLots = (base.lots[leafMat] || []).filter((l) => l.date <= f.date || l.id === f.leafLot)
      .map((l) => ({ ...l, left: Math.max(0, remainingAsOf(l, f.date)) }));
    const fromChosen = sum((a.lines[leafMat] || []).filter((t) => f.leafLot && t.batchId === f.leafLot), (t) => t.qty);
    // This order's own gap: plates whose raw material wasn't in stock on the order date (costed at the latest price).
    const ownShort = Math.max(0, ...Object.values(a.shortfall || {}));
    const shortMats = Object.keys(a.shortfall || {});
    return { a, leafMat, sheetMat, ready, leafAvail, sheetAvail, canMake, available: ready + canMake, limitedBy, newlyShort, leafLots, fromChosen, ownShort, shortMats, basis: basisOf(a, leafMat) };
  }, [f.date, f.product, f.base, f.leafLot, qty, price, making, purchases, sales, productions, initial]);

  const a = est?.a;
  const unitCost = a?.unitCost || 0;
  const breakEven = unitCost;
  const targetPrice = unitCost / (1 - settings.targetMargin / 100);
  const profitPerPlate = price - unitCost;
  const total = qty > 0 ? qty * price : 0;
  const totalCost = qty > 0 ? qty * unitCost : 0;
  const margin = price > 0 ? (profitPerPlate / price) * 100 : NaN;
  const isPast = isISODate(f.date) && f.date < todayISO();
  // Today / future: can we still deliver it from what's left? Past: was the material for it in the records on that date?
  const short = qty > 0 && est && !isPast && qty > est.available;
  const pastGap = qty > 0 && est && isPast ? est.ownShort : 0;
  const chosenLot = est?.leafLots.find((l) => l.id === f.leafLot);
  const chosenNeed = est ? Math.max(0, (qty > 0 ? qty : 0) - (est.a.fromStock || []).reduce((t, x) => t + x.qty, 0)) : 0;
  const lp = lastPrice(f.product);

  const errors = { date: !isISODate(f.date) && 'Pick a date', customer: !f.customer.trim() && 'Required', qty: !(qty > 0) && 'Enter quantity', price: !(price > 0) && 'Enter selling price' };
  const valid = !Object.values(errors).some(Boolean);
  const err = (k) => (touched ? errors[k] : null);
  const submit = (e) => { e.preventDefault(); setTouched(true); if (valid) onSave({ id: initial?.id, date: f.date, customer: f.customer.trim(), phone: f.phone.trim(), product: f.product, base: f.base, leafLot: f.leafLot || undefined, qty, price, making, payment: f.payment }); };

  const quote = `AVN EcoPlates — Quotation\n${PRODUCTS[f.product].name} × ${fmtNum(qty || 0)} @ ${fmtINR2(price)} per plate\nTotal: ${fmtINR(total)}`;
  const copyQuote = async () => {
    try { await navigator.clipboard.writeText(quote); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch (e) { setCopied(false); }
  };
  const chip = (label, value, tone) => value > 0 && (
    <button type="button" key={label} onClick={() => set('price', String(round2(value)))}
      className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${Math.abs(price - value) < 0.005 ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>
      {label} <span className={tone}>{fmtINR2(value)}</span>
    </button>
  );

  return (
    <Modal title={editing ? `Edit order ${initial.id}` : 'New Order (Phone)'} icon={ShoppingCart} onClose={onClose} wide
      subtitle="Pick the plate and quantity — cost, price and profit fill in automatically so you can quote the customer."
      footer={<>
        <button type="button" className={`${btn.ghost} mr-auto`} onClick={copyQuote} disabled={!(qty > 0)}>{copied ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}{copied ? 'Copied' : 'Copy quote'}</button>
        <button type="button" className={btn.ghost} onClick={onClose}>Cancel</button>
        <button type="submit" form="order-form" className={btn.emerald}><CheckCircle2 className="h-4 w-4" />{editing ? 'Save changes' : 'Save order'}</button>
      </>}>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-5">
        <form id="order-form" onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:col-span-3">
          <Field label="Plate type" className="sm:col-span-2">
            <select className={inputCls} value={f.product} onChange={(e) => pickProduct(e.target.value)}>
              {Object.entries(PRODUCTS).map(([k, p]) => <option key={k} value={k}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Quantity (plates)" error={err('qty')} className="sm:col-span-2"
            hint={est ? `${est.ready ? `${fmtNum(est.ready)} ready to sell + ` : ''}${fmtNum(est.canMake)} more can be made from raw stock${f.date < todayISO() ? ` on ${fmtDate(f.date)}` : ''} (limited by ${est.limitedBy})${Object.entries(PRODUCTS).some(([c, q]) => c !== f.product && q.leaf === est.leafMat) ? ` · uses the same ${MATERIALS[est.leafMat].label} stock as ${Object.entries(PRODUCTS).filter(([c, q]) => c !== f.product && q.leaf === est.leafMat).map(([, q]) => q.name).join(', ')}` : ''}` : null}>
            <input type="number" min="0" step="100" inputMode="numeric" className={inputCls} value={f.qty} onChange={(e) => set('qty', e.target.value)} placeholder="e.g. 10000" autoFocus={!editing} />
          </Field>
          <Field label="Selling price per plate (₹)" error={err('price')} className="sm:col-span-2">
            <input type="number" min="0" step="0.05" inputMode="decimal" className={inputCls} value={f.price} onChange={(e) => set('price', e.target.value)} />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {chip('Break-even', breakEven, 'text-rose-700')}
              {chip(lp !== undefined ? 'Last sold' : 'List', lp ?? settings.products[f.product].price, 'text-slate-800')}
              {chip(`${settings.targetMargin}% margin`, targetPrice, 'text-emerald-700')}
            </div>
          </Field>
          <Field label={`${MATERIALS[PRODUCTS[f.product].leaf].label} from (vendor @ buying price)`} className="sm:col-span-2"
            hint={!f.leafLot ? 'Automatic uses the oldest leaf in stock first. Pick a vendor if you know which leaf went into this order.'
              : chosenLot && chosenLot.date > f.date ? `This batch was bought on ${fmtDate(chosenLot.date)}, after the order date, so it can't be used — the oldest stock is used instead.`
              : chosenLot && chosenNeed > est.fromChosen ? `Only ${fmtNum(est.fromChosen)} of this batch was left on ${fmtDate(f.date)} — the other ${fmtNum(chosenNeed - est.fromChosen)} come from the oldest stock.`
              : (est?.a.fromStock || []).length ? 'Ready plates are used first; this vendor applies to the plates made for this order.' : null}>
            <select className={inputCls} value={f.leafLot} onChange={(e) => set('leafLot', e.target.value)}>
              <option value="">Automatic — oldest stock first</option>
              {(est?.leafLots || []).map((l) => (
                <option key={l.id} value={l.id}>{l.supplier} @ {fmtINR2(l.unitCost)} · bought {fmtDate(l.date)} · {fmtNum(l.left)} left ({l.id})</option>
              ))}
            </select>
          </Field>
          {f.base !== PRODUCTS[f.product].sheet && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-800 sm:col-span-2">
              <Info className="h-4 w-4 shrink-0" />
              <span className="flex-1">This order was recorded using {MATERIALS[f.base].label}. It stays that way unless you switch it.</span>
              <button type="button" className="font-medium underline" onClick={() => set('base', PRODUCTS[f.product].sheet)}>Switch to {MATERIALS[PRODUCTS[f.product].sheet].label}</button>
            </div>
          )}
          <Field label="Customer name" error={err('customer')}>
            <input className={inputCls} value={f.customer} onChange={(e) => set('customer', e.target.value)} list="avn-customers" placeholder="e.g. Green Leaf Caterers" />
            <datalist id="avn-customers">{[...new Set(sales.map((s) => s.customer))].map((c) => <option key={c} value={c} />)}</datalist>
          </Field>
          <Field label="Phone (optional)"><input type="tel" className={inputCls} value={f.phone} onChange={(e) => set('phone', e.target.value)} placeholder="98xxxxxxxx" /></Field>
          <Field label="Order date" error={err('date')}><input type="date" className={inputCls} value={f.date} onChange={(e) => set('date', e.target.value)} /></Field>
          <Field label="Payment"><select className={inputCls} value={f.payment} onChange={(e) => set('payment', e.target.value)}><option>Pending</option><option>Paid</option></select></Field>
          <Field label="Making charge per plate (₹)" hint="Filled from Settings; saved with this order" className="sm:col-span-2">
            <input type="number" min="0" step="0.05" className={inputCls} value={f.making} onChange={(e) => set('making', e.target.value)} />
          </Field>
        </form>

        <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm md:col-span-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500"><Calculator className="h-3.5 w-3.5" />Auto-calculated</div>
          {est && (
            <>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                <dt className="text-slate-500">Leaf</dt><dd className="text-right tabular-nums">{fmtINR2(a.unitMat[est.leafMat])}</dd>
                <dt className="text-slate-500">{MATERIALS[est.sheetMat].label}</dt><dd className="text-right tabular-nums">{fmtINR2(a.unitMat[est.sheetMat])}</dd>
                <dt className="text-slate-500">Making charge</dt><dd className="text-right tabular-nums">{fmtINR2(a.making)}</dd>
                <dt className="border-t border-slate-200 pt-1.5 font-semibold text-slate-800">Cost per plate</dt><dd className="border-t border-slate-200 pt-1.5 text-right font-semibold tabular-nums">{fmtINR2(unitCost)}</dd>
                <dt className="text-slate-500">Selling price</dt><dd className="text-right tabular-nums">{fmtINR2(price)}</dd>
                <dt className="text-slate-500">Profit per plate</dt><dd className={`text-right font-medium tabular-nums ${profitPerPlate >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{fmtINR2(profitPerPlate)}</dd>
              </dl>
              <div className="text-[11px] text-slate-500">Leaf from: <BasisBadge basis={est.basis} /></div>
              {qty > 0 && (
                <div className={`rounded-lg p-3 ${profitPerPlate >= 0 ? 'bg-emerald-50' : 'bg-rose-50'}`}>
                  <div className="flex justify-between text-xs text-slate-600"><span>Order value</span><b className="tabular-nums text-slate-900">{fmtINR(total)}</b></div>
                  <div className="flex justify-between text-xs text-slate-600"><span>Total cost</span><span className="tabular-nums">{fmtINR(totalCost)}</span></div>
                  <div className="mt-1 flex items-baseline justify-between">
                    <span className="text-xs text-slate-600">Profit</span>
                    <span className={`text-xl font-semibold tabular-nums ${profitPerPlate >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{fmtINR(total - totalCost)}</span>
                  </div>
                  <div className="text-right text-xs text-slate-600">{fmtPct(margin)} margin</div>
                </div>
              )}
              {profitPerPlate < 0 && price > 0 && <Warn tone="rose">This price is below cost — you lose {fmtINR2(-profitPerPlate)} on every plate.</Warn>}
              {short && <Warn tone="rose">Not enough stock: {fmtNum(est.ready)} ready + {fmtNum(est.canMake)} can be made ({fmtNum(est.leafAvail)} {MATERIALS[est.leafMat].label}, {fmtNum(est.sheetAvail)} {MATERIALS[est.sheetMat].label}). {fmtNum(qty - est.available)} plates short — buy more raw material before delivery.</Warn>}
              {pastGap > 0 && <Warn tone="amber">Past order: your stock records on {fmtDate(f.date)} don't cover {fmtNum(pastGap)} of these plates ({est.shortMats.map((m) => MATERIALS[m].label).join(', ')}). You can still save it — those plates are costed at the latest buying price. If that material was bought earlier, add it under Stock with its real purchase date so the cost is exact.</Warn>}
              {est.newlyShort.length > 0 && <Warn tone="amber">Back-dating this order leaves {est.newlyShort.length} later order(s) short of stock ({est.newlyShort.map((s) => s.id).join(', ')}).</Warn>}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
const Warn = ({ tone, children }) => (
  <div className={`flex gap-2 rounded-lg p-2 text-xs ${tone === 'rose' ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-800'}`}><AlertTriangle className="h-4 w-4 shrink-0" />{children}</div>
);

function ProductionModal({ initial, purchases, sales, productions, settings, onSave, onClose }) {
  const editing = !!initial;
  const [f, setF] = useState(() => (initial
    ? { ...initial, qty: String(initial.qty), making: String(initial.making) }
    : { date: todayISO(), product: 'P14', base: PRODUCTS.P14.sheet, qty: '', making: String(settings.products.P14.making), note: '' }));
  const [touched, setTouched] = useState(false);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const pick = (code) => setF((p) => ({ ...p, product: code, base: PRODUCTS[code].sheet, making: String(settings.products[code].making) }));
  const qty = Number(f.qty); const making = Number(f.making) || 0;

  const est = useMemo(() => {
    if (!isISODate(f.date)) return null;
    const others = productions.filter((x) => x.id !== initial?.id);
    const base = runFifo(purchases, sales, others);
    const leafMat = PRODUCTS[f.product].leaf; const sheetMat = f.base;
    const avail = (mat) => sum((base.lots[mat] || []).filter((l) => l.date <= f.date), (l) => l.remaining);
    const leafAvail = avail(leafMat); const sheetAvail = avail(sheetMat);
    const draft = { id: initial?.id || 'ZZ-DRAFT', createdAt: initial ? initial.createdAt : '9999', date: f.date, product: f.product, base: f.base, qty: qty > 0 ? qty : 1, making };
    const run = runFifo(purchases, sales, [...others, draft]);
    const pa = run.prodAllocs[draft.id];
    const newlyShort = sales.filter((s) => Object.keys(run.allocs[s.id]?.shortfall || {}).length && !Object.keys(base.allocs[s.id]?.shortfall || {}).length);
    return { pa, leafMat, sheetMat, leafAvail, sheetAvail, canMake: Math.min(leafAvail, sheetAvail), newlyShort };
  }, [f.date, f.product, f.base, qty, making, purchases, sales, productions, initial]);

  const sold = editing ? (() => { const run = runFifo(purchases, sales, productions); const lot = run.fgIndex[initial.id]; return lot ? lot.qty - lot.remaining : 0; })() : 0;
  const errors = {
    date: !isISODate(f.date) && 'Pick a date',
    qty: !(qty > 0) ? 'Enter how many plates were made' : (sold > qty ? `${fmtNum(sold)} of these are already sold` : null),
  };
  const valid = !Object.values(errors).some(Boolean);
  const err = (k) => (touched ? errors[k] : null);
  const submit = (e) => { e.preventDefault(); setTouched(true); if (valid) onSave({ id: initial?.id, date: f.date, product: f.product, base: f.base, qty, making, note: (f.note || '').trim() }); };
  const pa = est?.pa;
  const short = est && qty > est.canMake;

  return (
    <Modal title={editing ? `Edit production ${initial.id}` : 'Record Production (ready to sell)'} icon={Factory} onClose={onClose}
      subtitle="Plates pressed but not sold yet. Their leaves and sheets / paper leave raw stock now, so raw stock stays exact."
      footer={<><button type="button" className={btn.ghost} onClick={onClose}>Cancel</button><button type="submit" form="prod-form" className={btn.primary}><CheckCircle2 className="h-4 w-4" />{editing ? 'Save changes' : 'Add to ready stock'}</button></>}>
      <form id="prod-form" onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Plate type" className="sm:col-span-2">
          <select className={inputCls} value={f.product} onChange={(e) => pick(e.target.value)}>
            {Object.entries(PRODUCTS).map(([k, p]) => <option key={k} value={k}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Plates made" error={err('qty')} hint={est ? `Raw stock allows up to ${fmtNum(est.canMake)} (${fmtNum(est.leafAvail)} ${MATERIALS[est.leafMat].label}, ${fmtNum(est.sheetAvail)} ${MATERIALS[est.sheetMat].label})` : null}>
          <input type="number" min="0" step="100" inputMode="numeric" className={inputCls} value={f.qty} onChange={(e) => set('qty', e.target.value)} placeholder="e.g. 5000" autoFocus={!editing} />
        </Field>
        <Field label="Date made" error={err('date')}><input type="date" className={inputCls} value={f.date} onChange={(e) => set('date', e.target.value)} /></Field>
        <Field label="Making charge per plate (₹)" hint="Paid when the plates are pressed">
          <input type="number" min="0" step="0.05" className={inputCls} value={f.making} onChange={(e) => set('making', e.target.value)} />
        </Field>
        <Field label="Note (optional)"><input className={inputCls} value={f.note || ''} onChange={(e) => set('note', e.target.value)} placeholder="e.g. Batch for wedding season" /></Field>
      </form>
      {pa && (
        <div className="mt-4 space-y-2 rounded-xl bg-slate-50 p-3 text-sm">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            <span className="text-slate-500">{MATERIALS[est.leafMat].label}</span><span className="text-right tabular-nums">{fmtINR2(pa.unitMat[est.leafMat])}</span>
            <span className="text-slate-500">{MATERIALS[est.sheetMat].label}</span><span className="text-right tabular-nums">{fmtINR2(pa.unitMat[est.sheetMat])}</span>
            <span className="text-slate-500">Making charge</span><span className="text-right tabular-nums">{fmtINR2(making)}</span>
            <span className="border-t border-slate-200 pt-1 font-semibold">Cost per ready plate</span><span className="border-t border-slate-200 pt-1 text-right font-semibold tabular-nums">{fmtINR2(pa.unitCost)}</span>
            {qty > 0 && <><span className="text-slate-500">Value of this batch</span><span className="text-right tabular-nums">{fmtINR(pa.unitCost * qty)}</span></>}
          </div>
          {short && <Warn tone="rose">Raw stock only allows {fmtNum(est.canMake)} plates on this date — add the missing leaves / {MATERIALS[est.sheetMat].unit} in Add Stock first.</Warn>}
          {est.newlyShort.length > 0 && <Warn tone="amber">This uses raw stock that {est.newlyShort.length} recorded order(s) were made from ({est.newlyShort.map((x) => x.id).join(', ')}). Those orders will show as short.</Warn>}
        </div>
      )}
    </Modal>
  );
}

function SettingsModal({ settings, onSave, onClose }) {
  const [f, setF] = useState(() => JSON.parse(JSON.stringify(settings)));
  const setP = (code, k, v) => setF((p) => ({ ...p, products: { ...p.products, [code]: { ...p.products[code], [k]: v } } }));
  const submit = (e) => {
    e.preventDefault();
    const products = {};
    Object.keys(PRODUCTS).forEach((c) => { products[c] = { making: Math.max(0, Number(f.products[c].making) || 0), price: Math.max(0, Number(f.products[c].price) || 0) }; });
    onSave({ products, targetMargin: Math.min(90, Math.max(0, Number(f.targetMargin) || 0)), lowStockQty: Math.max(0, Number(f.lowStockQty) || 0), recoverMonths: Math.max(1, Number(f.recoverMonths) || 1), papersPerKg: Math.max(1, Number(f.papersPerKg) || 120) });
  };
  return (
    <Modal title="Plates & Pricing Settings" icon={Settings} onClose={onClose}
      subtitle="Defaults used when you take a new order. Old orders keep the values they were saved with."
      footer={<><button type="button" className={btn.ghost} onClick={onClose}>Cancel</button><button type="submit" form="settings-form" className={btn.primary}><CheckCircle2 className="h-4 w-4" />Save settings</button></>}>
      <form id="settings-form" onSubmit={submit} className="space-y-4">
        <div className="overflow-hidden rounded-xl border border-slate-200">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50"><tr><Th>Plate</Th><Th>Making charge ₹</Th><Th>List price ₹</Th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {Object.entries(PRODUCTS).map(([c, p]) => (
                <tr key={c}>
                  <td className="px-3 py-2 font-medium text-slate-700">{p.name}</td>
                  <td className="px-3 py-2"><input type="number" step="0.05" min="0" className={inputCls} value={f.products[c].making} onChange={(e) => setP(c, 'making', e.target.value)} aria-label={`${p.name} making charge`} /></td>
                  <td className="px-3 py-2"><input type="number" step="0.05" min="0" className={inputCls} value={f.products[c].price} onChange={(e) => setP(c, 'price', e.target.value)} aria-label={`${p.name} list price`} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Field label="Paper roll: papers per kg" hint="Default for new paper-roll purchases. Past purchases keep the rate they were saved with.">
          <input type="number" min="1" step="1" className={inputCls} value={f.papersPerKg} onChange={(e) => setF({ ...f, papersPerKg: e.target.value })} />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Target margin %" hint="Used for suggested prices"><input type="number" min="0" max="90" className={inputCls} value={f.targetMargin} onChange={(e) => setF({ ...f, targetMargin: e.target.value })} /></Field>
          <Field label="Low-stock alert below" hint="Leaves, sheets or papers"><input type="number" min="0" step="500" className={inputCls} value={f.lowStockQty} onChange={(e) => setF({ ...f, lowStockQty: e.target.value })} /></Field>
          <Field label="Recover investment in" hint="Months"><input type="number" min="1" className={inputCls} value={f.recoverMonths} onChange={(e) => setF({ ...f, recoverMonths: e.target.value })} /></Field>
        </div>
      </form>
    </Modal>
  );
}

/* ────────────────────────────── Stock panels ────────────────────────────── */

function CapacityStrip({ capacity, lowStockQty }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {capacity.map((c) => (
        <div key={c.code} className="rounded-xl border border-slate-200 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-600">{c.name}</span>
            {c.ready + c.canMake <= 0 ? <Badge tone="rose">Out of stock</Badge> : c.ready + c.canMake < lowStockQty ? <Badge tone="amber" icon={AlertTriangle}>Low</Badge> : <Badge tone="emerald">Available</Badge>}
          </div>
          <div className="mt-1 flex items-baseline gap-1.5"><span className="text-2xl font-semibold tabular-nums text-slate-900">{fmtNum(c.ready + c.canMake)}</span><span className="text-[11px] text-slate-500">plates you can supply</span></div>
          <div className="mt-1 grid grid-cols-2 gap-2 text-[11px]">
            <div className="rounded-md bg-amber-50 px-2 py-1 text-amber-900"><b className="tabular-nums">{fmtNum(c.ready)}</b> ready to sell</div>
            <div className="rounded-md bg-slate-100 px-2 py-1 text-slate-700"><b className="tabular-nums">{fmtNum(c.canMake)}</b> can make from raw</div>
          </div>
          <div className="mt-1 text-[11px] text-slate-500">Raw stock limited by {c.limitedBy}</div>
          {c.sharesWith.length > 0 && <div className="mt-1 text-[11px] text-amber-700">Shares {MATERIALS[c.leaf].label} with {c.sharesWith.join(', ')} — not extra stock</div>}
        </div>
      ))}
    </div>
  );
}

function MaterialCard({ mat, stock, asOf, lowStockQty, latest, first, papersPerKg }) {
  const m = MATERIALS[mat];
  const total = sum(stock.lots, (l) => l.qty);
  const avg = stock.qty ? stock.value / stock.qty : 0;
  const low = stock.qty < lowStockQty;
  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold text-slate-800"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: m.color }} />{m.label}</span>
        {stock.qty <= 0 ? <Badge tone="rose">Out of stock</Badge> : low ? <Badge tone="amber" icon={AlertTriangle}>Low Stock</Badge> : <Badge tone="emerald">In Stock</Badge>}
      </div>
      <div className="mt-0.5 text-[11px] text-slate-400">Used by: {usersOf(mat).join(', ')}</div>
      <div className="mt-2 flex items-baseline gap-1.5"><span className="text-2xl font-semibold tabular-nums text-slate-900">{fmtNum(stock.qty)}</span><span className="text-xs text-slate-500">{m.unit} available{m.byKg && papersPerKg ? ` (≈ ${(stock.qty / papersPerKg).toFixed(1)} kg)` : ''}</span></div>
      <div className="mt-1 grid grid-cols-2 gap-x-2 text-xs text-slate-500">
        <span>Value <b className="text-slate-700">{fmtINR(stock.value)}</b></span>
        <span className="text-right">Avg <b className="text-slate-700">{stock.qty ? fmtINR2(avg) : '—'}</b></span>
        <span>Latest buy <b className="text-slate-700">{latest ? fmtINR2(latest) : '—'}</b></span>
        {first && latest && first !== latest && <span className={`text-right ${latest < first ? 'text-emerald-700' : 'text-rose-700'}`}>{latest < first ? '▼' : '▲'} from ₹{first.toFixed(2)}</span>}
      </div>
      {stock.lots.length > 0 && (
        <>
          <div className="mt-3 flex w-full gap-0.5 overflow-hidden rounded-md" role="img" aria-label={`${m.label} batches, used versus left`}>
            {stock.lots.map((l) => {
              const left = remainingAsOf(l, asOf); const pct = l.qty ? ((l.qty - left) / l.qty) * 100 : 0;
              return (
                <div key={l.id} className="relative h-3 min-w-[10px]" style={{ flex: `${Math.max(l.qty, total * 0.08)} 1 0`, background: m.color }} title={`${l.id}: ${fmtNum(left)} left of ${fmtNum(l.qty)} @ ₹${l.unitCost.toFixed(2)}`}>
                  <div className="absolute inset-y-0 left-0 bg-slate-300" style={{ width: `${pct}%`, backgroundImage: 'repeating-linear-gradient(135deg, rgba(255,255,255,.5) 0 3px, transparent 3px 6px)' }} />
                </div>
              );
            })}
          </div>
          <ul className="mt-2 space-y-1 text-xs">
            {stock.lots.map((l) => {
              const left = remainingAsOf(l, asOf);
              return (
                <li key={l.id} className={`flex items-center justify-between gap-2 ${left <= 0 ? 'text-slate-400' : 'text-slate-600'}`}>
                  <span className="truncate">{l.id} · {l.supplier} · {fmtShort(l.date)}</span>
                  <span className="shrink-0 tabular-nums">₹{l.unitCost.toFixed(2)} · {left <= 0 ? 'used up' : `${fmtNum(left)} left`}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

/* ────────────────────────────── Pricing panels ────────────────────────────── */

function BreakEvenTable({ rows, targetMargin, compact }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-100">
        <thead className="bg-slate-50/70"><tr>
          <Th>Plate</Th><Th right>Leaf</Th><Th right>Sheet / paper</Th><Th right>Making</Th><Th right>Cost / plate<br /><span className="font-normal normal-case">= break-even price</span></Th>
          <Th right>Last sold</Th><Th right>Profit / plate</Th><Th right>{targetMargin}% margin price</Th>{!compact && <Th right>Price to recover investment</Th>}<Th>Status</Th>
        </tr></thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.code}>
              <Td className="font-medium text-slate-800">{r.name}</Td>
              <Td right>{fmtINR2(r.leaf)}</Td><Td right>{fmtINR2(r.sheet)}</Td><Td right>{fmtINR2(r.making)}</Td>
              <Td right className="font-semibold text-rose-700">{fmtINR2(r.cost)}</Td>
              <Td right>{r.lastPrice ? fmtINR2(r.lastPrice) : '—'}</Td>
              <Td right className={r.profit >= 0 ? 'font-medium text-emerald-700' : 'font-medium text-rose-700'}>{r.lastPrice ? `${fmtINR2(r.profit)} (${fmtPct(r.marginPct)})` : '—'}</Td>
              <Td right className="text-indigo-700">{fmtINR2(r.targetPrice)}</Td>
              {!compact && <Td right>{r.recoverPrice === 0 ? <span className="text-emerald-700">Recovered</span> : r.recoverPrice ? fmtINR2(r.recoverPrice) : '—'}</Td>}
              <Td>{!r.lastPrice ? <Badge tone="slate">No sales yet</Badge> : r.profit < 0 ? <Badge tone="rose" icon={TrendingDown}>Selling at a loss</Badge> : r.marginPct < targetMargin ? <Badge tone="amber">Below target</Badge> : <Badge tone="emerald" icon={TrendingUp}>Profitable</Badge>}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NumSlider({ label, value, set, min, max, step }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium text-slate-700">{label}</span>
        <input type="number" step={step} min="0" value={value} onChange={(e) => set(Number(e.target.value) || 0)} className="w-24 rounded-md border border-slate-300 px-2 py-1 text-right text-xs tabular-nums focus:border-indigo-500 focus:outline-none" aria-label={label} />
      </div>
      <input type="range" min={min} max={max} step={step} value={Math.min(max, Math.max(min, value))} onChange={(e) => set(Number(e.target.value))} className="mt-1.5 w-full accent-indigo-600" aria-label={`${label} slider`} />
    </div>
  );
}

const STAT_TONES = { emerald: 'text-emerald-700', rose: 'text-rose-700', indigo: 'text-indigo-700', slate: 'text-slate-900' };
const Stat = ({ label, value, note, tone = 'slate' }) => (
  <div className="rounded-xl border border-slate-200 bg-white p-3">
    <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
    <div className={`mt-1 text-lg font-semibold tabular-nums ${STAT_TONES[tone]}`}>{value}</div>
    {note && <div className="text-[11px] text-slate-500">{note}</div>}
  </div>
);

function PriceCalculator({ defaults, targetMargin, toRecover }) {
  const [code, setCode] = useState('P14');
  const d = defaults[code];
  const [leaf, setLeaf] = useState(d.leaf);
  const [sheet, setSheet] = useState(d.sheet);
  const [making, setMaking] = useState(d.making);
  const [price, setPrice] = useState(d.price);
  const pick = (c) => { setCode(c); const x = defaults[c]; setLeaf(x.leaf); setSheet(x.sheet); setMaking(x.making); setPrice(x.price); };
  const cost = leaf + sheet + making;
  const profit = price - cost;
  const margin = price ? (profit / price) * 100 : 0;
  const target = cost / (1 - targetMargin / 100);
  const platesToRecover = profit > 0 && toRecover > 0 ? Math.ceil(toRecover / profit) : null;
  return (
    <Card title="What-if Price Calculator" icon={Calculator} subtitle="Try a new leaf / sheet price or selling price before you buy or quote. Starts from your latest purchase prices.">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 sm:grid-cols-4">
            {Object.entries(PRODUCTS).map(([c, p]) => (
              <button key={c} type="button" onClick={() => pick(c)} className={`rounded-md px-2 py-1.5 text-xs font-medium ${code === c ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}>{p.name.replace(' Plate', '')}</button>
            ))}
          </div>
          <NumSlider label={`${MATERIALS[PRODUCTS[code].leaf].label} cost (₹)`} value={leaf} set={setLeaf} min={0.5} max={3} step={0.05} />
          <NumSlider label={`${MATERIALS[PRODUCTS[code].sheet].label} — per ${MATERIALS[PRODUCTS[code].sheet].each} (₹)`} value={sheet} set={setSheet} min={0.5} max={5} step={0.05} />
          <NumSlider label="Making charge (₹)" value={making} set={setMaking} min={0.3} max={1.5} step={0.05} />
          <NumSlider label="Selling price (₹)" value={price} set={setPrice} min={3} max={10} step={0.05} />
          <button type="button" onClick={() => pick(code)} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800"><RotateCcw className="h-3 w-3" />Reset to latest prices</button>
        </div>
        <div className="space-y-3">
          <div className="rounded-xl bg-slate-50 p-4 text-sm">
            <div className="text-xs text-slate-600">{fmtINR2(leaf)} leaf + {fmtINR2(sheet)} {MATERIALS[PRODUCTS[code].sheet].each} + {fmtINR2(making)} making</div>
            <div className="mt-1 flex items-baseline justify-between"><span className="text-slate-700">Cost per plate</span><span className="text-xl font-semibold tabular-nums">{fmtINR2(cost)}</span></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Profit per plate" value={fmtINR2(profit)} tone={profit >= 0 ? 'emerald' : 'rose'} note={`${fmtPct(margin)} margin`} />
            <Stat label="Profit per 10,000 plates" value={fmtINR(profit * 10000)} tone={profit >= 0 ? 'emerald' : 'rose'} note={`Sales ${fmtINR(price * 10000)}`} />
            <Stat label="Break-even price" value={fmtINR2(cost)} tone="rose" note="Sell above this to profit" />
            <Stat label={`Price for ${targetMargin}% margin`} value={fmtINR2(target)} tone="indigo" note="Target margin from Settings" />
          </div>
          <div className={`rounded-xl p-3 text-xs ${platesToRecover ? 'bg-indigo-50 text-indigo-900' : 'bg-slate-50 text-slate-600'}`}>
            <Target className="mr-1 inline h-3.5 w-3.5" />
            {toRecover <= 0 ? 'Your investment is already recovered — every plate sold above cost is profit.'
              : platesToRecover ? <>At this price you need to sell <b>{fmtNum(platesToRecover)}</b> more plates to recover the remaining <b>{fmtINR(toRecover)}</b>.</>
                : <>At this price you never recover the remaining <b>{fmtINR(toRecover)}</b> — raise the price above {fmtINR2(cost)}.</>}
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ────────────────────────────── Main dashboard ────────────────────────────── */

const PRESETS = [{ k: 'all', label: 'All Time' }, { k: 'month', label: 'This Month' }, { k: '30d', label: 'Last 30 Days' }, { k: 'custom', label: 'Custom' }];
const TABS = [
  { k: 'overview', label: 'Overview', icon: LayoutDashboard },
  { k: 'stock', label: 'Stock', icon: Boxes },
  { k: 'orders', label: 'Orders', icon: ShoppingCart },
  { k: 'pricing', label: 'Pricing & Break-even', icon: Target },
  { k: 'investments', label: 'Investments', icon: PiggyBank },
];

/* ────────────────────────────── Change history (shared database only) ────────────────────────────── */

const HIST_KIND = { sale: 'Order', purchase: 'Purchase', expense: 'Investment', production: 'Production', settings: 'Settings' };
const HIST_TONE = { created: 'emerald', edited: 'indigo', deleted: 'rose', restored: 'amber' };
const FIELD_LABELS = {
  date: 'Date', customer: 'Customer', phone: 'Phone', product: 'Plate', base: 'Base', qty: 'Quantity', price: 'Selling price',
  making: 'Making charge', payment: 'Payment', material: 'Material', supplier: 'Supplier', unitPrice: 'Price / unit', kg: 'Weight (kg)',
  papersPerKg: 'Papers per kg', perKg: 'Price per kg', category: 'Type', item: 'Description', payee: 'Paid to', amount: 'Amount', note: 'Note', leafLot: 'Leaf batch',
  targetMargin: 'Target margin %', lowStockQty: 'Low-stock alert', recoverMonths: 'Recover investment in (months)',
};
const HIDDEN_FIELDS = new Set(['id', 'createdAt', 'enteredBy', 'editedBy']);
function fmtField(k, v) {
  if (v === undefined || v === null || v === '') return '—';
  if (k === 'product') return PRODUCTS[v]?.name || v;
  if (k === 'material' || k === 'base') return MATERIALS[v]?.label || v;
  if (k === 'category') return EXPENSE_CATS[v]?.label || v;
  if (['price', 'making', 'unitPrice', 'perKg'].includes(k)) return fmtINR2(Number(v));
  if (k === 'leafLot') return v;
  if (k === 'amount') return fmtINR(Number(v));
  if (k === 'qty') return fmtNum(v);
  if (k === 'date' && isISODate(v)) return fmtDate(v);
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}
const flatten = (o, pre = '') => Object.entries(o || {}).reduce((acc, [k, v]) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.assign(acc, flatten(v, `${pre}${k}.`)) : Object.assign(acc, { [`${pre}${k}`]: v })), {});
function fieldLabel(key) {
  const parts = key.split('.');
  if (parts[0] === 'products' && PRODUCTS[parts[1]]) return `${PRODUCTS[parts[1]].name} ${parts[2] === 'price' ? 'list price' : 'making charge'}`;
  return FIELD_LABELS[parts[parts.length - 1]] || key;
}
/** What changed between two versions of a record, as readable "field: old → new" lines. */
function diffOf(kind, a, b) {
  const A = kind === 'settings' ? flatten(a) : (a || {});
  const B = kind === 'settings' ? flatten(b) : (b || {});
  return [...new Set([...Object.keys(A), ...Object.keys(B)])]
    .filter((k) => !HIDDEN_FIELDS.has(k) && JSON.stringify(A[k]) !== JSON.stringify(B[k]))
    .map((k) => { const f = k.split('.').pop(); const money = kind === 'settings' && f === 'price'; return { k, label: fieldLabel(k), from: money ? fmtINR2(A[k]) : fmtField(f, A[k]), to: money ? fmtINR2(B[k]) : fmtField(f, B[k]) }; });
}
function summaryOf(kind, d) {
  if (!d) return '';
  if (kind === 'sale') return `${d.customer} · ${fmtNum(d.qty)} × ${PRODUCTS[d.product]?.name || d.product} @ ${fmtINR2(d.price)} · ${fmtDate(d.date)}`;
  if (kind === 'purchase') return `${MATERIALS[d.material]?.label || d.material} · ${fmtNum(d.qty)} @ ${fmtINR2(d.unitPrice)} · ${d.supplier} · ${fmtDate(d.date)}`;
  if (kind === 'expense') return `${EXPENSE_CATS[d.category]?.label || d.category} · ${d.item} · ${fmtINR(d.amount)} · ${fmtDate(d.date)}`;
  if (kind === 'production') return `${fmtNum(d.qty)} × ${PRODUCTS[d.product]?.name || d.product} made · ${fmtDate(d.date)}`;
  return 'Plates & pricing settings';
}
const fmtWhen = (iso) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

function HistoryPanel({ cloud, data, focusId, setFocusId, onRestored }) {
  const PAGE = 200;
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [kind, setKind] = useState('all');
  const [who, setWho] = useState('all');
  const [action, setAction] = useState('all');
  const [restoring, setRestoring] = useState('');

  const load = async (from = 0) => {
    setStatus('loading'); setError('');
    try {
      let q = cloud.db.from('record_history').select('hid,at,by_email,action,kind,id,old_data,new_data');
      if (focusId) q = q.eq('id', focusId);
      const { data: got, error: err } = await q.order('at', { ascending: false }).range(from, from + PAGE - 1);
      if (err) throw err;
      setRows((r) => (from ? [...r, ...(got || [])] : (got || [])));
      setHasMore((got || []).length === PAGE);
      setStatus('ready');
    } catch (e) {
      setError(/record_history|relation|schema cache/i.test(e.message || '') ? 'History is not switched on yet — run supabase-history.sql in Supabase → SQL Editor.' : (e.message || 'Could not load history.'));
      setStatus('error');
    }
  };
  useEffect(() => { load(0); }, [focusId]); // eslint-disable-line react-hooks/exhaustive-deps

  const present = (k, id) => (k === 'settings' ? true : (data[KIND_LIST[k]] || []).some((x) => x.id === id));
  const restore = async (r) => {
    setRestoring(r.id);
    const row = { kind: r.kind, id: r.id, data: r.new_data, deleted: false };
    const { error: err } = await cloud.db.from('records').upsert([row], { onConflict: 'kind,id' });
    setRestoring('');
    if (err) { setError(`Not restored — ${err.message}`); return; }
    onRestored(row);
    load(0);
  };

  const people = [...new Set(rows.map((r) => r.by_email).filter(Boolean))];
  const shown = rows.filter((r) => (kind === 'all' || r.kind === kind) && (who === 'all' || r.by_email === who) && (action === 'all' || r.action === action));
  const sel = 'rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs';

  return (
    <Card title={focusId ? `History of ${focusId}` : 'Change History'} icon={ScrollText} bodyClass="p-0"
      subtitle="Every record created, edited, deleted or restored — who did it and when. Written by the database itself; it can't be edited or removed. (The date filter above doesn't apply here.)"
      actions={<>
        {focusId && <button className={btn.ghost} onClick={() => setFocusId('')}><X className="h-4 w-4" />Show all records</button>}
        <select className={sel} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Record type">
          <option value="all">All types</option>{Object.entries(HIST_KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select className={sel} value={action} onChange={(e) => setAction(e.target.value)} aria-label="Change type">
          <option value="all">All changes</option>{Object.keys(HIST_TONE).map((a) => <option key={a} value={a}>{a[0].toUpperCase() + a.slice(1)}</option>)}
        </select>
        <select className={sel} value={who} onChange={(e) => setWho(e.target.value)} aria-label="Person">
          <option value="all">Everyone</option>{people.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <button className={btn.ghost} onClick={() => load(0)}><RotateCcw className="h-4 w-4" />Refresh</button>
      </>}>
      {error && <div className="p-4"><Warn tone="rose">{error}</Warn></div>}
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-100">
          <thead className="bg-slate-50/70"><tr><Th>When</Th><Th>Who</Th><Th>Change</Th><Th>Record</Th><Th>Details</Th><Th right><span className="sr-only">Actions</span></Th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {status === 'loading' && rows.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-sm text-slate-500">Loading history…</td></tr>}
            {status !== 'loading' && shown.length === 0 && !error && <tr><td colSpan={6} className="px-3 py-8 text-center text-sm text-slate-500">No changes recorded yet.</td></tr>}
            {shown.map((r) => {
              const changes = r.action === 'edited' ? diffOf(r.kind, r.old_data, r.new_data) : [];
              const canRestore = r.action === 'deleted' && !present(r.kind, r.id);
              return (
                <tr key={r.hid} className="align-top hover:bg-slate-50/60">
                  <Td className="text-xs text-slate-600">{fmtWhen(r.at)}</Td>
                  <Td className="text-xs">{r.by_email || '—'}</Td>
                  <Td><Badge tone={HIST_TONE[r.action] || 'slate'}>{r.action[0].toUpperCase() + r.action.slice(1)}</Badge></Td>
                  <Td>
                    {r.kind === 'settings' ? <span className="text-sm">Settings</span> : (
                      <button className="text-left text-sm hover:underline" onClick={() => setFocusId(r.id)} title="Show every change to this record">
                        <span className="text-xs text-slate-500">{HIST_KIND[r.kind]}</span> <b className="text-slate-800">{r.id}</b>
                      </button>
                    )}
                  </Td>
                  <td className="px-3 py-2.5 text-sm text-slate-700">
                    <div className="whitespace-normal">{summaryOf(r.kind, r.new_data)}</div>
                    {changes.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-xs">
                        {changes.map((c) => <li key={c.k}><span className="text-slate-500">{c.label}:</span> <span className="text-rose-700 line-through decoration-rose-300">{c.from}</span> → <b className="text-emerald-700">{c.to}</b></li>)}
                      </ul>
                    )}
                    {r.action === 'edited' && changes.length === 0 && <div className="mt-1 text-xs text-slate-400">Saved again with no visible change</div>}
                  </td>
                  <Td right>{canRestore && <button className={btn.ghost} disabled={restoring === r.id} onClick={() => restore(r)}><RotateCcw className="h-4 w-4" />{restoring === r.id ? 'Restoring…' : 'Restore'}</button>}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hasMore && !focusId && <div className="border-t border-slate-100 p-3 text-center"><button className={btn.ghost} onClick={() => load(rows.length)} disabled={status === 'loading'}>Load older changes</button></div>}
    </Card>
  );
}

/* ────────────────────────────── Sign-in & shared-database screens ────────────────────────────── */

function CenterCard({ children }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10 text-slate-900 antialiased">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-3">
          <span className="rounded-xl bg-emerald-600 p-2 text-white shadow-sm"><Leaf className="h-6 w-6" aria-hidden="true" /></span>
          <div><h1 className="text-lg font-semibold tracking-tight">AVN EcoPlates</h1><p className="text-xs text-slate-500">Areca Leaf Plates · Stock, Orders & Profit</p></div>
        </div>
        {children}
      </div>
    </div>
  );
}

function LoginScreen({ db }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setError(''); setBusy(true);
    const { error: err } = await db.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (err) setError(/invalid/i.test(err.message) ? 'Wrong email or password.' : err.message);
  };
  return (
    <CenterCard>
      <form onSubmit={submit} className="space-y-3">
        <h2 className="text-base font-semibold">Sign in</h2>
        <Field label="Email"><input type="email" autoComplete="username" required className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Password"><input type="password" autoComplete="current-password" required className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        {error && <Warn tone="rose">{error}</Warn>}
        <button type="submit" className={`${btn.primary} w-full`} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="text-xs text-slate-500">Only team members added by the owner can sign in. Forgot your password? Ask the owner to reset it.</p>
      </form>
    </CenterCard>
  );
}

function FirstTimeSetup({ db, email, onDone }) {
  const [local] = useState(() => loadState());
  const localData = local.status === 'ok' ? local.data : null;
  const count = localData ? LIST_KEYS.reduce((t, k) => t + (localData[k] || []).length, 0) : 0;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (rows) => {
    setBusy(true); setError('');
    try { await cloudUpsertAll(db, rows); onDone(); } catch (e) { setError(e.message || 'Could not reach the database.'); setBusy(false); }
  };
  const uploadLocal = () => run([
    ...LIST_KEYS.flatMap((k) => (localData[k] || []).map((rec) => toRow(k, { ...rec, enteredBy: rec.enteredBy || email }))),
    { kind: 'settings', id: 'settings', data: mergeSettings(localData.settings), deleted: false },
  ]);
  const startEmpty = () => run([{ kind: 'settings', id: 'settings', data: DEFAULT_SETTINGS, deleted: false }]);
  return (
    <CenterCard>
      <h2 className="text-base font-semibold">Set up your shared data</h2>
      <p className="mt-1 text-sm text-slate-600">The shared database is empty. Choose how to start — you only do this once.</p>
      <div className="mt-4 space-y-3">
        {count > 0 && (
          <button className={`${btn.primary} w-full`} disabled={busy} onClick={uploadLocal}>
            <Upload className="h-4 w-4" />Upload the {fmtNum(count)} records saved in this browser
          </button>
        )}
        <button className={`${btn.ghost} w-full`} disabled={busy} onClick={startEmpty}>Start empty (then use Import for a backup file)</button>
        {busy && <p className="text-xs text-slate-500">Saving…</p>}
        {error && <Warn tone="rose">{error}</Warn>}
        <p className="text-xs text-slate-500">{count > 0 ? 'Uploading copies your records; the copy in this browser is left untouched.' : 'No records were found in this browser.'}</p>
      </div>
    </CenterCard>
  );
}

function CloudApp({ db }) {
  const [session, setSession] = useState(undefined); // undefined = still checking
  const [state, setState] = useState({ status: 'idle' });
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let alive = true;
    db.auth.getSession().then(({ data }) => { if (alive) setSession(data?.session || null); });
    const { data: sub } = db.auth.onAuthStateChange((_event, s) => setSession(s || null));
    return () => { alive = false; sub?.subscription?.unsubscribe(); };
  }, [db]);
  const email = session?.user?.email || '';
  useEffect(() => {
    if (!session) { setState({ status: 'idle' }); return undefined; }
    let alive = true;
    setState({ status: 'loading' });
    (async () => {
      try {
        const { data: member, error } = await db.rpc('is_member');
        if (error) throw error;
        if (!member) { if (alive) setState({ status: 'notMember' }); return; }
        const res = await cloudLoadAll(db);
        if (alive) setState(res.empty ? { status: 'empty' } : { status: 'ready', data: res.data });
      } catch (e) {
        if (alive) setState({ status: 'error', message: e.message || 'Could not reach the database.' });
      }
    })();
    return () => { alive = false; };
  }, [db, session?.user?.id, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (session === undefined || state.status === 'loading' || (session && state.status === 'idle')) {
    return <CenterCard><p className="text-sm text-slate-600">Loading your shared data…</p></CenterCard>;
  }
  if (!session) return <LoginScreen db={db} />;
  if (state.status === 'notMember') {
    return (
      <CenterCard>
        <Warn tone="rose">{email} is signed in but isn't on the team list, so no data is shown. Ask the owner to add this email in Supabase (team_members).</Warn>
        <button className={`${btn.ghost} mt-4 w-full`} onClick={() => db.auth.signOut()}>Sign out</button>
      </CenterCard>
    );
  }
  if (state.status === 'error') {
    return (
      <CenterCard>
        <Warn tone="rose">Couldn't load the shared data: {state.message}. Check your internet connection.</Warn>
        <div className="mt-4 flex gap-2">
          <button className={`${btn.primary} flex-1`} onClick={() => setReloadKey((k) => k + 1)}>Try again</button>
          <button className={btn.ghost} onClick={() => db.auth.signOut()}>Sign out</button>
        </div>
      </CenterCard>
    );
  }
  if (state.status === 'empty') return <FirstTimeSetup db={db} email={email} onDone={() => setReloadKey((k) => k + 1)} />;
  return <Dashboard key={session.user.id} cloud={{ db, email }} initialData={state.data} />;
}

export default function AVNEcoPlatesDashboard() {
  if (isSecretKey(cloudConfig().key)) {
    return (
      <CenterCard>
        <Warn tone="rose">A secret (service_role) key has been put in this dashboard. It gives full access to all your data, so the dashboard will not start. Replace it with the publishable key (starts with sb_publishable_) and generate a new secret key in Supabase.</Warn>
      </CenterCard>
    );
  }
  const db = getCloud();
  return db ? <CloudApp db={db} /> : <Dashboard />;
}

function Dashboard({ cloud = null, initialData = null }) {
  const [initial] = useState(() => (cloud ? { status: 'ok', data: initialData, notes: [] } : loadState()));
  const [data, setData] = useState(() => (initial.status === 'ok' ? initial.data : SEED));
  const { purchases, expenses, sales, settings } = data;
  const productions = useMemo(() => data.productions || [], [data.productions]);
  // Never overwrite saved data the app could not read — saving stays off until the user decides.
  const [canSave, setCanSave] = useState(initial.status !== 'unreadable');
  useEffect(() => {
    if (cloud) { try { window.localStorage.setItem(CLOUD_CACHE_KEY, JSON.stringify({ savedAt: new Date().toISOString(), data })); } catch (e) { /* ignore */ } return; }
    if (canSave) saveState(data);
  }, [data, canSave, cloud]);
  // Live updates: apply changes your team member makes, as they happen.
  useEffect(() => {
    if (!cloud) return undefined;
    const ch = cloud.db.channel('records-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'records' }, (payload) => { if (payload.new && payload.new.kind) setData((d) => applyRow(d, payload.new)); })
      .subscribe();
    return () => { cloud.db.removeChannel(ch); };
  }, [cloud]);
  const busyRef = useRef(false);
  const [historyFocus, setHistoryFocus] = useState('');
  const tabs = cloud ? [...TABS, { k: 'history', label: 'History', icon: ScrollText }] : TABS;
  const startFresh = () => {
    try { window.localStorage.setItem(`${STORAGE_KEY}-unreadable-${Date.now()}`, initial.raw); } catch (e) { /* ignore */ }
    setCanSave(true);
  };

  const [tab, setTab] = useState('overview');
  const [preset, setPreset] = useState('all');
  const [custom, setCustom] = useState({ start: '', end: '' });
  const [modal, setModal] = useState(null); // { kind: 'stock'|'expense'|'order'|'settings', record? }
  const [confirm, setConfirm] = useState(null);
  const [toast, setToast] = useState(() => (initial.notes?.length ? { tone: 'amber', msg: initial.notes.join(' ') } : null));
  const [orderQuery, setOrderQuery] = useState('');
  const [orderProduct, setOrderProduct] = useState('all');
  const [trendProduct, setTrendProduct] = useState('P14');
  const [platesPerMonth, setPlatesPerMonth] = useState(null);
  const fileRef = useRef(null);
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(null), 4500); return () => clearTimeout(t); }, [toast]);

  const today = todayISO();

  /* ── Date range ── */
  const bounds = useMemo(() => {
    const dates = [...purchases, ...expenses, ...sales, ...productions].map((r) => r.date).filter(isISODate).sort();
    return { min: dates[0] || today, max: dates[dates.length - 1] || today };
  }, [purchases, expenses, sales, productions, today]);
  const range = useMemo(() => {
    let r;
    if (preset === 'month') r = { start: `${today.slice(0, 8)}01`, end: today };
    else if (preset === '30d') r = { start: addDays(today, -29), end: today };
    else if (preset === 'custom') r = { start: custom.start || bounds.min, end: custom.end || today };
    else r = { start: bounds.min, end: maxISO(bounds.max, today) };
    return r.start > r.end ? { start: r.end, end: r.start } : r;
  }, [preset, custom, today, bounds]);
  const inRange = (d) => d >= range.start && d <= range.end;
  const setRangeField = (k, v) => { if (!isISODate(v)) return; setPreset('custom'); setCustom({ ...range, [k]: v }); };

  /* ── Engine ── */
  const fifo = useMemo(() => runFifo(purchases, sales, productions), [purchases, sales, productions]);

  /* ── Metrics ── */
  const m = useMemo(() => {
    const A = (s) => fifo.allocs[s.id];
    const rs = sales.filter((s) => inRange(s.date) && A(s));
    const revenue = sum(rs, (s) => A(s).revenue);
    const materialCost = sum(rs, (s) => A(s).materialCost);
    const makingCost = sum(rs, (s) => A(s).makingCost);
    const cogs = materialCost + makingCost;
    const units = sum(rs, (s) => s.qty);
    const byProduct = Object.keys(PRODUCTS).map((k) => {
      const ps = rs.filter((s) => s.product === k);
      const q = sum(ps, (s) => s.qty); const rev = sum(ps, (s) => A(s).revenue); const c = sum(ps, (s) => A(s).cogs);
      return { code: k, name: PRODUCTS[k].name, qty: q, revenue: rev, cogs: c, profit: rev - c, avgPrice: q ? rev / q : 0 };
    });
    const re = expenses.filter((e) => inRange(e.date));
    const runningExp = sum(re.filter((e) => !EXPENSE_CATS[e.category]?.capital), (e) => e.amount);
    const gross = revenue - cogs;
    const opProfit = gross - runningExp;
    const rp = purchases.filter((p) => inRange(p.date));
    const materialSpend = sum(rp, (p) => p.qty * p.unitPrice);
    const receivable = sum(rs.filter((s) => s.payment === 'Pending'), (s) => A(s).revenue);

    // To date (as of range end) — the owner's overall position
    const E = range.end;
    const sTD = sales.filter((s) => s.date <= E && A(s));
    const revenueTD = sum(sTD, (s) => A(s).revenue);
    // Making charges actually paid: on production runs, plus on plates made to order at sale time.
    const makingTD = sum(productions.filter((x) => x.date <= E), (x) => x.qty * x.making) + sum(sTD, (s) => A(s).makingPaid);
    const makingPaidRange = sum(productions.filter((x) => inRange(x.date)), (x) => x.qty * x.making) + sum(rs, (s) => A(s).makingPaid);
    const materialsTD = sum(purchases.filter((p) => p.date <= E), (p) => p.qty * p.unitPrice);
    const machineryTD = sum(expenses.filter((e) => e.date <= E && EXPENSE_CATS[e.category]?.capital), (e) => e.amount);
    const runningTD = sum(expenses.filter((e) => e.date <= E && !EXPENSE_CATS[e.category]?.capital), (e) => e.amount);
    const investedTD = materialsTD + makingTD + machineryTD + runningTD;
    const stock = Object.fromEntries(Object.keys(MATERIALS).map((k) => [k, stockOf(fifo, k, E)]));
    const ready = Object.fromEntries(Object.keys(PRODUCTS).map((k) => [k, readyOf(fifo, k, E)]));
    const rawValue = sum(Object.values(stock), (s) => s.value);
    const readyValue = sum(Object.values(ready), (r) => r.value);
    const stockValue = rawValue + readyValue;
    const position = revenueTD + stockValue - investedTD;
    const recoveredPct = investedTD ? ((revenueTD + stockValue) / investedTD) * 100 : 0;

    const capacity = Object.entries(PRODUCTS).map(([code, p]) => {
      const leafQ = stock[p.leaf].qty; const sheetQ = stock[p.sheet].qty;
      const sharesWith = Object.entries(PRODUCTS).filter(([c2, q]) => c2 !== code && q.leaf === p.leaf).map(([, q]) => q.name);
      return { code, name: p.name, leaf: p.leaf, sharesWith, ready: ready[code].qty, readyValue: ready[code].value, canMake: Math.max(0, Math.min(leafQ, sheetQ)), limitedBy: leafQ <= sheetQ ? MATERIALS[p.leaf].label : MATERIALS[p.sheet].label };
    });

    return { rs, revenue, materialCost, makingCost, cogs, units, byProduct, runningExp, gross, opProfit, materialSpend, receivable,
      revenueTD, makingTD, makingPaidRange, materialsTD, machineryTD, runningTD, investedTD, stock, ready, rawValue, readyValue, stockValue, position, recoveredPct, capacity,
      marginPct: revenue ? (opProfit / revenue) * 100 : NaN };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sales, purchases, expenses, productions, fifo, range]);

  /* ── Sales vs cost in range ── */
  const plSeries = useMemo(() => {
    const days = diffDays(range.start, range.end) + 1;
    const weekly = days > 92;
    const keyOf = (d) => (weekly ? weekStart(d) : d);
    const map = new Map();
    for (let i = 0; i < days; i++) { const d = addDays(range.start, i); const k = keyOf(d); if (!map.has(k)) map.set(k, { key: k, label: weekly ? `Wk ${fmtShort(k)}` : fmtShort(k), sales: 0, cogs: 0, expense: 0 }); }
    m.rs.forEach((s) => { const b = map.get(keyOf(s.date)); if (b) { b.sales += fifo.allocs[s.id].revenue; b.cogs += fifo.allocs[s.id].cogs; } });
    expenses.filter((e) => inRange(e.date) && !EXPENSE_CATS[e.category]?.capital).forEach((e) => { const b = map.get(keyOf(e.date)); if (b) b.expense += e.amount; });
    return { weekly, data: [...map.values()].map((b) => ({ ...b, profit: b.sales - b.cogs - b.expense })) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, m.rs, fifo, expenses]);

  /* ── Business trend: money invested vs (sales + stock in hand), from day one to range end ── */
  const trend = useMemo(() => {
    const start = bounds.min; const end = range.end;
    const days = diffDays(start, end) + 1;
    if (days <= 0) return { data: [], breakEven: null };
    const step = days > 120 ? 7 : 1;
    const out = []; let breakEven = null; let prevPos = null;
    for (let i = 0; ; i += step) {
      const d = i >= days - 1 ? end : addDays(start, i);
      const sTD = sales.filter((s) => s.date <= d && fifo.allocs[s.id]);
      const rev = sum(sTD, (s) => fifo.allocs[s.id].revenue);
      const invested = sum(purchases.filter((p) => p.date <= d), (p) => p.qty * p.unitPrice)
        + sum(productions.filter((x) => x.date <= d), (x) => x.qty * x.making) + sum(sTD, (s) => fifo.allocs[s.id].makingPaid)
        + sum(expenses.filter((e) => e.date <= d), (e) => e.amount);
      const stockV = sum(Object.keys(MATERIALS), (k) => stockOf(fifo, k, d).value) + sum(Object.keys(PRODUCTS), (k) => readyOf(fifo, k, d).value);
      const recovered = rev + stockV;
      const pos = recovered - invested;
      if (prevPos !== null && prevPos < 0 && pos >= 0) breakEven = d;
      if (pos < 0) breakEven = null;
      prevPos = pos;
      out.push({ label: fmtShort(d), invested, recovered, position: pos });
      if (d === end) break;
    }
    return { data: out, breakEven };
  }, [bounds.min, range.end, sales, purchases, expenses, productions, fifo]);

  /* ── Where the money went (range, cash basis) ── */
  const distribution = useMemo(() => {
    const rows = Object.entries(MATERIALS).map(([k, mm]) => ({ name: mm.label, value: sum(purchases.filter((p) => p.material === k && inRange(p.date)), (p) => p.qty * p.unitPrice) }));
    rows.push({ name: 'Making charges', value: m.makingPaidRange });
    Object.entries(EXPENSE_CATS).forEach(([k, c]) => rows.push({ name: c.label, value: sum(expenses.filter((e) => e.category === k && inRange(e.date)), (e) => e.amount) }));
    return rows.filter((r) => r.value > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purchases, expenses, range, m.makingPaidRange]);
  const distTotal = sum(distribution, (d) => d.value);

  /* ── Break-even pricing ── */
  const toRecover = Math.max(0, -m.position);
  const recentPlates = useMemo(() => {
    const from = addDays(range.end, -29);
    return sum(sales.filter((s) => s.date >= from && s.date <= range.end), (s) => s.qty);
  }, [sales, range.end]);
  const ppm = platesPerMonth ?? recentPlates;
  const extraPerPlate = toRecover > 0 && ppm > 0 ? toRecover / (ppm * settings.recoverMonths) : 0;

  const pricingRows = useMemo(() => Object.entries(PRODUCTS).map(([code, p]) => {
    const leaf = nextUnitCost(fifo, p.leaf); const sheet = nextUnitCost(fifo, p.sheet); const making = settings.products[code].making;
    const cost = leaf + sheet + making;
    const lastPrice = sales.filter((s) => s.product === code).sort(byDateId).pop()?.price;
    const profit = lastPrice ? lastPrice - cost : 0;
    return { code, name: p.name, leaf, sheet, making, cost, lastPrice, profit, marginPct: lastPrice ? (profit / lastPrice) * 100 : NaN,
      targetPrice: cost / (1 - settings.targetMargin / 100), recoverPrice: toRecover > 0 ? (ppm > 0 ? cost + extraPerPlate : null) : 0 };
  }), [fifo, sales, settings, toRecover, ppm, extraPerPlate]);

  const calcDefaults = useMemo(() => Object.fromEntries(Object.entries(PRODUCTS).map(([code, p]) => {
    const last = sales.filter((s) => s.product === code).sort(byDateId).pop();
    return [code, { leaf: latestPrice(fifo, p.leaf), sheet: latestPrice(fifo, p.sheet), making: settings.products[code].making, price: last?.price ?? settings.products[code].price }];
  })), [fifo, sales, settings]);

  const priceTrend = useMemo(() => m.rs.filter((s) => s.product === trendProduct).slice().sort(byDateId)
    .map((s) => ({ label: `${fmtShort(s.date)} · ${s.id}`, price: s.price, cost: round2(fifo.allocs[s.id].unitCost) })), [m.rs, trendProduct, fifo]);

  /* ── Tables ── */
  const batchRows = useMemo(() => purchases.filter((p) => p.date <= range.end).slice().sort((a, b) => -byDateId(a, b)).map((p) => {
    const lot = fifo.lotIndex[p.id];
    return { ...p, left: lot ? remainingAsOf(lot, range.end) : p.qty, inRange: inRange(p.date) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [purchases, fifo, range]);
  const productionRows = useMemo(() => productions.filter((x) => x.date <= range.end).slice().sort((x, y) => -byDateId(x, y)), [productions, range.end]);
  const expenseRows = useMemo(() => expenses.filter((e) => e.date <= range.end).slice().sort((a, b) => -byDateId(a, b)), [expenses, range.end]);
  const orderRows = useMemo(() => {
    const q = orderQuery.trim().toLowerCase();
    return m.rs.filter((s) => (orderProduct === 'all' || s.product === orderProduct) && (!q || `${s.customer} ${s.id} ${s.phone}`.toLowerCase().includes(q)))
      .slice().sort((a, b) => -byDateId(a, b));
  }, [m.rs, orderQuery, orderProduct]);
  const orderTotals = { qty: sum(orderRows, (s) => s.qty), rev: sum(orderRows, (s) => fifo.allocs[s.id].revenue), profit: sum(orderRows, (s) => fifo.allocs[s.id].profit) };

  /* ── Mutations ── */
  const upsert = async (listKey, rec, prefix, message) => {
    let msg = message;
    if (busyRef.current) return; // ignore double clicks while saving
    const cur = data[listKey] || [];
    const old = rec.id ? cur.find((x) => x.id === rec.id) : null;
    let full = rec.id
      ? { ...rec, ...(old?.createdAt ? { createdAt: old.createdAt } : {}), ...(old?.enteredBy ? { enteredBy: old.enteredBy } : {}), ...(cloud ? { editedBy: cloud.email } : {}) }
      : { ...rec, id: nextId(prefix, cur), createdAt: new Date().toISOString(), ...(cloud ? { enteredBy: cloud.email } : {}) };
    if (cloud) {
      busyRef.current = true;
      setToast({ tone: 'amber', msg: 'Saving to the shared database…' });
      try {
        if (rec.id) {
          const { error } = await cloud.db.from('records').upsert([toRow(listKey, full)], { onConflict: 'kind,id' });
          if (error) throw error;
        } else {
          // Two people may create a record at the same moment: if the number is taken, use the next one.
          const taken = cur.map((x) => x.id);
          const firstId = full.id;
          for (let attempt = 0; ; attempt += 1) {
            const { error } = await cloud.db.from('records').insert([toRow(listKey, full)]);
            if (!error) break;
            if (error.code !== '23505' || attempt > 50) throw error;
            taken.push(full.id);
            full = { ...full, id: nextId(prefix, taken.map((id) => ({ id }))) };
          }
          if (full.id !== firstId) msg = `${msg} (saved as ${full.id} — ${firstId} was just used by your team member)`;
        }
      } catch (e) {
        busyRef.current = false;
        setToast({ tone: 'rose', msg: `Not saved — ${e.message || 'no internet connection'}. Please try again.` });
        return;
      }
      busyRef.current = false;
    }
    setData((d) => ({ ...d, [listKey]: [...(d[listKey] || []).filter((x) => x.id !== full.id), full] }));
    setToast({ tone: 'emerald', msg });
    setModal(null);
  };
  const saveStock = (r) => upsert('purchases', r, MATERIALS[r.material].prefix, r.id ? `Updated ${r.id}` : `Added ${fmtNum(r.qty)} ${MATERIALS[r.material].label} @ ₹${r.unitPrice.toFixed(2)} to stock`);
  const saveExpense = (r) => upsert('expenses', r, 'EX', r.id ? `Updated ${r.id}` : `${EXPENSE_CATS[r.category].label} of ${fmtINR(r.amount)} added`);
  const saveOrder = (r) => upsert('sales', { ...r, base: r.base || PRODUCTS[r.product].sheet }, 'SO', r.id ? `Updated ${r.id}` : `Order saved — ${fmtNum(r.qty)} × ${PRODUCTS[r.product].name}`);
  const saveProduction = (r) => upsert('productions', r, 'PD', r.id ? `Updated ${r.id}` : `${fmtNum(r.qty)} × ${PRODUCTS[r.product].name} added to ready stock — raw stock reduced`);
  const saveSettings = async (s) => {
    if (cloud) {
      const { error } = await cloud.db.from('records').upsert([{ kind: 'settings', id: 'settings', data: s, deleted: false }], { onConflict: 'kind,id' });
      if (error) { setToast({ tone: 'rose', msg: `Settings not saved — ${error.message}` }); return; }
    }
    setData((d) => ({ ...d, settings: s })); setToast({ tone: 'emerald', msg: 'Settings saved — applies to new orders' }); setModal(null);
  };
  const historyFor = (id) => (cloud ? () => { setHistoryFocus(id); setTab('history'); window.scrollTo(0, 0); } : undefined);
  const askDelete = (listKey, rec, what) => setConfirm({
    title: `Delete ${rec.id}?`,
    message: `${what} Stock and profit figures will be recalculated.${cloud ? ' It is hidden for everyone, but kept in the database so it can be recovered.' : ''}`,
    onConfirm: async () => {
      if (cloud) {
        const { error } = await cloud.db.from('records').upsert([{ ...toRow(listKey, rec), deleted: true }], { onConflict: 'kind,id' });
        if (error) { setToast({ tone: 'rose', msg: `Not deleted — ${error.message}` }); return; }
      }
      setData((d) => ({ ...d, [listKey]: (d[listKey] || []).filter((x) => x.id !== rec.id) }));
    },
  });

  /* ── CSV ── */
  const exportReport = () => {
    const rows = [
      ['AVN EcoPlates — Business Summary'],
      ['Generated', new Date().toLocaleString('en-IN')],
      ['Date range', `${range.start} to ${range.end}`, PRESETS.find((p) => p.k === preset)?.label],
      [],
      ['IN SELECTED DATES', 'Value'],
      ['Plates sold', m.units],
      ...m.byProduct.map((b) => [`  ${b.name}`, b.qty, `sales ₹${b.revenue.toFixed(2)}`, `profit ₹${b.profit.toFixed(2)}`, `avg price ₹${b.avgPrice.toFixed(2)}`]),
      ['Sales (₹)', m.revenue.toFixed(2)],
      ['Raw material used (₹)', m.materialCost.toFixed(2)],
      ['Making charges (₹)', m.makingCost.toFixed(2)],
      ['Labour, transport & other (₹)', m.runningExp.toFixed(2)],
      ['Profit on sales (₹)', m.opProfit.toFixed(2)],
      ['Profit margin (%)', Number.isFinite(m.marginPct) ? m.marginPct.toFixed(2) : ''],
      ['Raw material bought (₹)', m.materialSpend.toFixed(2)],
      ...Object.entries(MATERIALS).map(([k, mm]) => {
        const ps = purchases.filter((p) => p.material === k && inRange(p.date)); const q = sum(ps, (p) => p.qty); const v = sum(ps, (p) => p.qty * p.unitPrice);
        return [`  ${mm.label} bought`, q, `₹${v.toFixed(2)}`, q ? `avg ₹${(v / q).toFixed(2)}` : ''];
      }),
      [],
      [`TO DATE (up to ${range.end})`, 'Value'],
      ['Total money invested (₹)', m.investedTD.toFixed(2)],
      ['  Machinery', m.machineryTD.toFixed(2)], ['  Raw material', m.materialsTD.toFixed(2)], ['  Making charges', m.makingTD.toFixed(2)], ['  Labour, transport & other', m.runningTD.toFixed(2)],
      ['Total sales (₹)', m.revenueTD.toFixed(2)],
      ['Stock in hand at cost (₹)', m.stockValue.toFixed(2)],
      ['  Raw material (₹)', m.rawValue.toFixed(2)],
      ['  Ready plates, not sold (₹)', m.readyValue.toFixed(2)],
      ['Overall profit / loss (₹)', m.position.toFixed(2)],
      ['Investment recovered (%)', m.recoveredPct.toFixed(1)],
      [],
      ['STOCK IN HAND', 'Quantity', 'Value (₹)'],
      ...Object.entries(MATERIALS).map(([k, mm]) => [mm.label, m.stock[k].qty, m.stock[k].value.toFixed(2)]),
      ...m.capacity.map((c) => [`${c.name} — ready to sell / can make from raw`, c.ready, c.canMake]),
      [],
      ['BREAK-EVEN PRICES', 'Cost per plate (break-even)', `${settings.targetMargin}% margin price`, 'Last sold'],
      ...pricingRows.map((r) => [r.name, r.cost.toFixed(2), r.targetPrice.toFixed(2), r.lastPrice ?? '']),
      [],
      ['ORDERS IN SELECTED DATES'],
      ['Date', 'Order', 'Customer', 'Phone', 'Plate', 'Qty', 'Price', 'Sales', 'Cost/plate', 'Profit', 'Payment'],
      ...m.rs.slice().sort(byDateId).map((s) => { const a = fifo.allocs[s.id]; return [s.date, s.id, s.customer, s.phone, PRODUCTS[s.product].name, s.qty, s.price, a.revenue.toFixed(2), a.unitCost.toFixed(4), a.profit.toFixed(2), s.payment]; }),
      [],
      ['PURCHASES (stock left as of end date)'],
      ['Date', 'Batch', 'Material', 'Supplier', 'Qty', 'Unit', 'Price/unit', 'Total', 'Left', 'Payment', 'Kg', 'Papers/kg', 'Price/kg'],
      ...batchRows.slice().reverse().map((b) => [b.date, b.id, MATERIALS[b.material].label, b.supplier, b.qty, MATERIALS[b.material].unit, b.unitPrice.toFixed(4), (b.qty * b.unitPrice).toFixed(2), b.left, b.payment, b.kg ?? '', b.papersPerKg ?? '', b.perKg ?? '']),
      [],
      ['PRODUCTION (ready plates)'],
      ['Date', 'Run', 'Plate', 'Made', 'Cost/plate', 'Sold from it', 'Ready left'],
      ...productions.filter((x) => x.date <= range.end).slice().sort(byDateId).map((x) => { const lot = fifo.fgIndex[x.id]; const left = lot ? remainingAsOf(lot, range.end) : 0; return [x.date, x.id, PRODUCTS[x.product]?.name, x.qty, lot ? lot.unitCost.toFixed(4) : '', x.qty - left, left]; }),
      [],
      ['INVESTMENTS & EXPENSES'],
      ['Date', 'ID', 'Type', 'Description', 'Paid to', 'Amount', 'Payment'],
      ...expenseRows.slice().reverse().map((e) => [e.date, e.id, EXPENSE_CATS[e.category]?.label, e.item, e.payee, e.amount, e.payment]),
    ];
    const ok = downloadFile(`avn-ecoplates-report_${range.start}_to_${range.end}.csv`, toCSV(rows));
    setToast(ok ? { tone: 'emerald', msg: 'Summary report downloaded' } : { tone: 'rose', msg: 'Download blocked by the browser' });
  };
  const exportData = () => {
    const rows = [DATA_HEADER,
      ...purchases.map((p) => ['purchase', p.id, p.date, p.material, '', p.supplier, '', p.qty, p.unitPrice, '', p.payment, p.kg ?? '', p.papersPerKg ?? '', p.perKg ?? '', '', p.createdAt || '']),
      ...expenses.map((e) => ['expense', e.id, e.date, e.category, e.item, e.payee, '', 1, e.amount, '', e.payment, '', '', '', '', e.createdAt || '']),
      ...sales.map((s) => ['sale', s.id, s.date, s.product, '', s.customer, s.phone, s.qty, s.price, s.making, s.payment, '', '', '', s.base || PRODUCTS[s.product].sheet, s.createdAt || '', s.leafLot || '']),
      ...Object.entries(settings.products).map(([c, p]) => ['setting', c, '', 'product', '', '', '', '', p.price, p.making, '']),
      ['setting', 'targetMargin', '', 'value', '', '', '', settings.targetMargin, '', '', ''],
      ['setting', 'lowStockQty', '', 'value', '', '', '', settings.lowStockQty, '', '', ''],
      ['setting', 'recoverMonths', '', 'value', '', '', '', settings.recoverMonths, '', '', ''],
      ['setting', 'papersPerKg', '', 'value', '', '', '', settings.papersPerKg, '', '', ''],
      ...productions.map((x) => ['production', x.id, x.date, x.product, x.note || '', '', '', x.qty, '', x.making, '', '', '', '', x.base || PRODUCTS[x.product].sheet, x.createdAt || '', x.leafLot || '']),
    ];
    const ok = downloadFile(`avn-ecoplates-backup_${today}.csv`, toCSV(rows));
    setToast(ok ? { tone: 'emerald', msg: 'Backup downloaded — keep it safe, you can import it later' } : { tone: 'rose', msg: 'Download blocked by the browser' });
  };
  const importData = (file) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const rows = parseCSV(String(reader.result));
        const hi = rows.findIndex((r) => r[0]?.trim().toLowerCase() === 'record_type');
        if (hi < 0) throw new Error('Not a backup file (missing "record_type" header).');
        const h = rows[hi].map((x) => x.trim().toLowerCase());
        const col = (r, k) => (r[h.indexOf(k)] ?? '').trim();
        const P = []; const E = []; const Sa = []; const Pd = []; const errs = [];
        const st = JSON.parse(JSON.stringify(settings));
        rows.slice(hi + 1).forEach((r, i) => {
          const type = col(r, 'record_type').toLowerCase(); const line = hi + i + 2;
          const date = col(r, 'date'); const qty = Number(col(r, 'qty')); const price = Number(col(r, 'unit_price'));
          const payment = /pending/i.test(col(r, 'payment_status')) ? 'Pending' : 'Paid';
          const created = col(r, 'created_at'); const ca = created ? { createdAt: created } : {};
          if (type === 'setting') {
            const id = col(r, 'id');
            if (PRODUCTS[id]) st.products[id] = { price: price || st.products[id].price, making: Number(col(r, 'making_charge')) || st.products[id].making };
            else if (id in st && qty >= 0) st[id] = qty;
            return;
          }
          if (!isISODate(date) || !(qty > 0) || !(price >= 0)) { errs.push(line); return; }
          if (type === 'purchase') {
            const material = ({ sheet: 'sheet14', leaf14s: 'leaf14' })[col(r, 'type')] || col(r, 'type'); if (!MATERIALS[material]) { errs.push(line); return; }
            const kgV = Number(col(r, 'kg'));
            P.push({ id: col(r, 'id'), date, material, supplier: col(r, 'party') || '—', qty, unitPrice: price, payment, ...ca,
              ...(kgV > 0 ? { kg: kgV, papersPerKg: Number(col(r, 'papers_per_kg')) || Math.round(qty / kgV), perKg: Number(col(r, 'price_per_kg')) || round2((qty * price) / kgV) } : {}) });
          } else if (type === 'expense') {
            const category = col(r, 'type'); if (!EXPENSE_CATS[category]) { errs.push(line); return; }
            E.push({ id: col(r, 'id'), date, category, item: col(r, 'item') || EXPENSE_CATS[category].label, payee: col(r, 'party') || '—', amount: price * qty, payment, ...ca });
          } else if (type === 'sale') {
            const product = col(r, 'type'); if (!PRODUCTS[product]) { errs.push(line); return; }
            const mk = col(r, 'making_charge');
            const baseV = col(r, 'base');
            // Backups made before the paper roll had no base column — keep those orders on the base they used then.
            const base = MATERIALS[baseV] ? baseV : (h.includes('base') ? PRODUCTS[product].sheet : LEGACY_BASE[product]);
            Sa.push({ id: col(r, 'id'), date, customer: col(r, 'party') || '—', phone: col(r, 'phone'), product, base, qty, price, making: mk === '' ? st.products[product].making : Number(mk) || 0, payment, ...ca, ...(col(r, 'leaf_batch') ? { leafLot: col(r, 'leaf_batch') } : {}) });
          } else if (type === 'production') {
            const product = col(r, 'type'); if (!PRODUCTS[product]) { errs.push(line); return; }
            const baseV = col(r, 'base');
            Pd.push({ id: col(r, 'id'), date, product, base: MATERIALS[baseV] ? baseV : PRODUCTS[product].sheet, qty, making: Number(col(r, 'making_charge')) || 0, note: col(r, 'item'), ...ca, ...(col(r, 'leaf_batch') ? { leafLot: col(r, 'leaf_batch') } : {}) });
          } else errs.push(line);
        });
        if (!P.length && !E.length && !Sa.length && !Pd.length) throw new Error('No valid rows found.');
        const written = []; // [listKey, record] pairs actually imported (for the shared database)
        const merge = (cur, inc, pref, key) => {
          const out = [...cur];
          inc.forEach((rec) => { const id = rec.id || nextId(typeof pref === 'function' ? pref(rec) : pref, out); const i = out.findIndex((x) => x.id === id); const full = { ...rec, id }; if (i >= 0) out[i] = full; else out.push(full); written.push([key, full]); });
          return out;
        };
        const next = { schema: SCHEMA, purchases: merge(data.purchases, P, (r) => MATERIALS[r.material].prefix, 'purchases'), expenses: merge(data.expenses, E, 'EX', 'expenses'), sales: merge(data.sales, Sa, 'SO', 'sales'), productions: merge(data.productions || [], Pd, 'PD', 'productions'), settings: st };
        if (cloud) {
          const rows = [...written.map(([key, rec]) => toRow(key, rec)), { kind: 'settings', id: 'settings', data: st, deleted: false }];
          setToast({ tone: 'amber', msg: `Uploading ${rows.length} records to the shared database…` });
          await cloudUpsertAll(cloud.db, rows);
        } else if (!canSave) startFresh();
        setData(next);
        setToast({ tone: errs.length ? 'amber' : 'emerald', msg: `Imported ${P.length} purchases, ${E.length} investments/expenses, ${Sa.length} orders, ${Pd.length} production runs${errs.length ? ` · skipped ${errs.length} bad row(s) (line ${errs.slice(0, 4).join(', ')}${errs.length > 4 ? '…' : ''})` : ''}` });
      } catch (e) { setToast({ tone: 'rose', msg: `Import failed: ${e.message}` }); }
    };
    reader.readAsText(file);
  };

  const days = diffDays(range.start, range.end) + 1;
  const inProfit = m.position >= 0;
  const asOfNote = `to date · up to ${fmtDate(range.end)}`;

  /* ── Reusable blocks ── */
  const trendChart = (
    <Card title="Business Trend — Money In vs Money Invested" icon={TrendingUp}
      subtitle="From day one. Stock in hand counts at cost (buying stock isn't a loss until it's used or wasted). When the green line rises above the red one, the business has broken even."
      actions={inProfit ? <Badge tone="emerald" icon={CheckCircle2}>{trend.breakEven ? `Broke even on ${fmtDate(trend.breakEven)}` : 'In profit'}</Badge>
        : <Badge tone="amber">{fmtINR(toRecover)} to recover</Badge>}>
      {trend.data.length === 0 ? <EmptyState text="No data yet." /> : (
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trend.data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={C.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: C.axis }} tickLine={false} axisLine={{ stroke: C.grid }} minTickGap={20} />
              <YAxis tick={{ fontSize: 11, fill: C.axis }} tickFormatter={fmtCompact} tickLine={false} axisLine={false} width={60} />
              <Tooltip content={<ChartTooltip />} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
              <ReferenceLine y={0} stroke="#94a3b8" />
              <Line type="stepAfter" dataKey="invested" name="Money invested" stroke={C.invested} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              <Line type="linear" dataKey="recovered" name="Sales + stock in hand" stroke={C.recovered} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              <Line type="linear" dataKey="position" name="Overall profit / loss" stroke={C.profit} strokeWidth={2} strokeDasharray="5 4" dot={false} activeDot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );

  const salesChart = (
    <Card title={`${plSeries.weekly ? 'Weekly' : 'Daily'} Sales vs Cost vs Profit`} icon={IndianRupee}
      subtitle="Cost = leaf + sheet + making for plates sold, plus labour / transport / other. Machinery appears in the business trend, not here.">
      {m.rs.length === 0 && m.runningExp === 0 ? <EmptyState text="No orders in these dates." /> : (
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={plSeries.data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2}>
              <CartesianGrid stroke={C.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: C.axis }} tickLine={false} axisLine={{ stroke: C.grid }} minTickGap={16} />
              <YAxis tick={{ fontSize: 11, fill: C.axis }} tickFormatter={fmtCompact} tickLine={false} axisLine={false} width={60} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(99,102,241,0.06)' }} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
              <ReferenceLine y={0} stroke="#94a3b8" />
              <Bar dataKey="sales" name="Sales" fill={C.revenue} radius={[4, 4, 0, 0]} maxBarSize={22} />
              <Bar dataKey="cogs" name="Plate cost" stackId="c" fill={C.cost} stroke="#fff" strokeWidth={1} maxBarSize={22} />
              <Bar dataKey="expense" name="Labour & other" stackId="c" fill={C.expense} stroke="#fff" strokeWidth={1} radius={[4, 4, 0, 0]} maxBarSize={22} />
              <Line type="linear" dataKey="profit" name="Profit" stroke={C.profit} strokeWidth={2} dot={{ r: 3, fill: C.profit, stroke: '#fff', strokeWidth: 1.5 }} activeDot={{ r: 5 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 antialiased">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="rounded-xl bg-emerald-600 p-2 text-white shadow-sm"><Leaf className="h-6 w-6" aria-hidden="true" /></span>
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-slate-900">AVN EcoPlates</h1>
              <p className="text-xs text-slate-500">Areca Leaf Plates · Stock, Orders & Profit</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className={btn.emerald} onClick={() => setModal({ kind: 'order' })}><Phone className="h-4 w-4" />New Order</button>
            <button className={btn.primary} onClick={() => setModal({ kind: 'stock' })}><Plus className="h-4 w-4" />Add Stock</button>
            <button className={btn.ghost} onClick={() => setModal({ kind: 'production' })}><Factory className="h-4 w-4" />Record Production</button>
            <button className={btn.ghost} onClick={() => setModal({ kind: 'expense' })}><PiggyBank className="h-4 w-4" />Add Investment</button>
            <div className="flex items-center rounded-lg border border-slate-300 bg-white shadow-sm">
              <button className="flex items-center gap-1.5 rounded-l-lg px-2.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50" onClick={exportReport} title="Download a summary report (CSV)"><FileSpreadsheet className="h-4 w-4" /><span className="hidden lg:inline">Report</span></button>
              <button className="flex items-center gap-1.5 border-l border-slate-200 px-2.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50" onClick={exportData} title="Download a backup of all data (CSV)"><Database className="h-4 w-4" /><span className="hidden lg:inline">Backup</span></button>
              <button className="flex items-center gap-1.5 border-l border-slate-200 px-2.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50" onClick={() => fileRef.current?.click()} title="Import a backup file (CSV)"><Upload className="h-4 w-4" /><span className="hidden lg:inline">Import</span></button>
              <button className={`flex items-center gap-1.5 border-l border-slate-200 px-2.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 ${cloud ? 'rounded-r-lg' : ''}`} onClick={() => setModal({ kind: 'settings' })} title="Making charges, list prices & targets"><Settings className="h-4 w-4" /><span className="hidden lg:inline">Settings</span></button>
              {!cloud && <button className="flex items-center gap-1.5 rounded-r-lg border-l border-slate-200 px-2.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50" title="Replace everything with sample data" aria-label="Load sample data"
                onClick={() => setConfirm({ title: 'Load sample data?', message: 'Everything saved in this browser will be replaced with the sample purchases and orders. Download a backup first if you need your data.', confirmLabel: 'Replace with sample', onConfirm: () => { if (!canSave) startFresh(); setData(SEED); } })}>
                <RotateCcw className="h-4 w-4" /></button>}
            </div>
            {cloud && (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs text-emerald-800">
                <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
                <span className="max-w-[160px] truncate" title={`Signed in as ${cloud.email} · shared data, live`}>{cloud.email}</span>
                <button className="font-medium underline" onClick={() => cloud.db.auth.signOut()}>Sign out</button>
              </div>
            )}
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importData(f); e.target.value = ''; }} />
          </div>
        </div>
        <nav className="mx-auto flex max-w-[1440px] gap-1 overflow-x-auto px-4 sm:px-6" aria-label="Sections">
          {tabs.map((t) => (
            <button key={t.k} onClick={() => setTab(t.k)} aria-current={tab === t.k ? 'page' : undefined}
              className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition ${tab === t.k ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
              <t.icon className="h-4 w-4" aria-hidden="true" />{t.label}
            </button>
          ))}
        </nav>
      </header>

      {/* Date filter */}
      <div className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-3 px-4 py-2.5 sm:px-6">
          <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1" role="group" aria-label="Date presets">
            {PRESETS.map((p) => (
              <button key={p.k} aria-pressed={preset === p.k} onClick={() => { if (p.k === 'custom') setCustom({ ...range }); setPreset(p.k); }}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${preset === p.k ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}>{p.label}</button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Calendar className="h-4 w-4 text-slate-400" aria-hidden="true" />
            <input type="date" aria-label="Start date" value={range.start} max={range.end} onChange={(e) => setRangeField('start', e.target.value)} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-800 focus:border-indigo-500 focus:outline-none" />
            <span className="text-slate-400">to</span>
            <input type="date" aria-label="End date" value={range.end} min={range.start} onChange={(e) => setRangeField('end', e.target.value)} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-800 focus:border-indigo-500 focus:outline-none" />
            <span className="rounded-md bg-slate-100 px-2 py-1 text-slate-600">{days} day{days === 1 ? '' : 's'}</span>
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-[1440px] space-y-6 px-4 py-6 sm:px-6">
        {!canSave && (
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800" role="alert">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            <span className="min-w-0 flex-1">Your saved data couldn't be read, so it has <b>not</b> been changed or overwritten. You're seeing sample data, and nothing you do now is saved. Import a backup file, or start fresh (the unreadable copy is kept).</span>
            <button className={btn.ghost} onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4" />Import backup</button>
            <button className={btn.danger} onClick={startFresh}>Start fresh</button>
          </div>
        )}
        {/* ───────── OVERVIEW ───────── */}
        {tab === 'overview' && (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
              <KpiCard icon={inProfit ? TrendingUp : TrendingDown} label="Overall Profit / Loss" tone={inProfit ? 'emerald' : 'rose'} scope={asOfNote}
                value={`${inProfit ? '' : '−'}${fmtCompact(Math.abs(m.position))}`}
                badge={<Badge tone={inProfit ? 'emerald' : 'amber'}>{inProfit ? 'In profit' : `${m.recoveredPct.toFixed(0)}% recovered`}</Badge>}>
                <KpiRow label="Sales to date" value={fmtINR(m.revenueTD)} dot={C.revenue} />
                <KpiRow label="+ Stock in hand (at cost)" value={fmtINR(m.stockValue)} dot="#6366f1" />
                <KpiRow label="− Money invested" value={fmtINR(m.investedTD)} dot={C.invested} />
              </KpiCard>
              <KpiCard icon={PiggyBank} label="Money Invested" tone="rose" scope={asOfNote} value={fmtCompact(m.investedTD)}>
                <KpiRow label="Machinery" value={fmtINR(m.machineryTD)} />
                <KpiRow label="Raw material" value={fmtINR(m.materialsTD)} />
                <KpiRow label="Making charges" value={fmtINR(m.makingTD)} />
                <KpiRow label="Labour & other" value={fmtINR(m.runningTD)} />
              </KpiCard>
              <KpiCard icon={IndianRupee} label="Sales" tone="emerald" scope="selected dates" value={fmtCompact(m.revenue)}>
                <KpiRow label="Plates sold" value={fmtNum(m.units)} />
                <KpiRow label="Orders" value={m.rs.length} />
                <KpiRow label="Payment pending" value={fmtINR(m.receivable)} />
              </KpiCard>
              <KpiCard icon={m.opProfit >= 0 ? TrendingUp : TrendingDown} label="Profit on Sales" tone={m.opProfit >= 0 ? 'emerald' : 'rose'} scope="selected dates"
                value={fmtCompact(m.opProfit)} badge={<Badge tone={m.opProfit >= 0 ? 'emerald' : 'rose'}>{fmtPct(m.marginPct)}</Badge>}>
                <KpiRow label="Sales − plate cost" value={fmtINR(m.gross)} />
                <KpiRow label="− Labour, transport, other" value={fmtINR(m.runningExp)} />
                <KpiRow label="Avg profit / plate" value={m.units ? fmtINR2(m.opProfit / m.units) : '—'} />
              </KpiCard>
              <KpiCard icon={Boxes} label="Stock in Hand" tone="indigo" scope={`as of ${fmtDate(range.end)}`} value={fmtCompact(m.stockValue)}>
                <KpiRow label="Raw material / ready plates" value={`${fmtINR(m.rawValue)} / ${fmtINR(m.readyValue)}`} />
                {m.capacity.map((c) => <KpiRow key={c.code} label={`${c.name.replace(' Plate', '')} — ready + can make`} value={`${fmtNum(c.ready)} + ${fmtNum(c.canMake)}`} />)}
                <KpiRow label="Sheets 12″ / 14″" value={`${fmtNum(m.stock.sheet12.qty)} / ${fmtNum(m.stock.sheet14.qty)}`} />
                <KpiRow label="Paper (roll)" value={`${fmtNum(m.stock.paper.qty)} papers`} />
              </KpiCard>
            </div>

            {trendChart}

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
              <div className="min-w-0 xl:col-span-2">{salesChart}</div>
              <Card title="Where the Money Went" icon={Wallet} subtitle="Purchases, making charges & expenses in selected dates">
                {distTotal === 0 ? <EmptyState text="Nothing spent in these dates." /> : (
                  <>
                    <div className="relative h-44">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie data={distribution} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="92%" paddingAngle={1.5} stroke="#fff" strokeWidth={2}>
                            {distribution.map((d) => <Cell key={d.name} fill={DIST_COLORS[d.name]} />)}
                          </Pie>
                          <Tooltip content={<ChartTooltip labelFormatter={(l, p) => p?.[0]?.name} />} />
                        </PieChart>
                      </ResponsiveContainer>
                      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                        <span className="text-[11px] uppercase tracking-wide text-slate-500">Total</span>
                        <span className="text-lg font-semibold tabular-nums">{fmtCompact(distTotal)}</span>
                      </div>
                    </div>
                    <ul className="mt-3 space-y-1.5">
                      {distribution.slice().sort((a, b) => b.value - a.value).map((d) => (
                        <li key={d.name} className="flex items-center justify-between gap-2 text-xs">
                          <span className="flex items-center gap-2 text-slate-600"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: DIST_COLORS[d.name] }} />{d.name}</span>
                          <span className="tabular-nums text-slate-800">{fmtINR(d.value)} <span className="ml-1 inline-block w-11 text-right text-slate-500">{((d.value / distTotal) * 100).toFixed(1)}%</span></span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </Card>
            </div>

            <Card title="At What Price Do You Make Money?" icon={Target} bodyClass="p-0"
              subtitle="Cost per plate uses the next stock you'll use (oldest batch first). Sell above the red number to make a profit."
              actions={<button className={btn.ghost} onClick={() => setTab('pricing')}><Calculator className="h-4 w-4" />Full pricing</button>}>
              <BreakEvenTable rows={pricingRows} targetMargin={settings.targetMargin} compact />
            </Card>

            <Card title="Stock Available for New Orders" icon={Boxes} subtitle={`As of ${fmtDate(range.end)} · each plate needs 1 leaf + 1 cargation sheet (sitting plates: same leaf + 1 paper). Plates sharing a leaf draw on one stock — the numbers are alternatives, not added together.`}
              actions={<button className={btn.ghost} onClick={() => setTab('stock')}><Boxes className="h-4 w-4" />Stock details</button>}>
              <CapacityStrip capacity={m.capacity} lowStockQty={settings.lowStockQty} />
            </Card>
          </>
        )}

        {/* ───────── STOCK ───────── */}
        {tab === 'stock' && (
          <>
            <Card title="Plates You Can Supply Right Now" icon={Boxes} subtitle={`As of ${fmtDate(range.end)} · sitting plates use the same leaves as normal plates, plus paper from the roll`}
              actions={<button className={btn.primary} onClick={() => setModal({ kind: 'stock' })}><Plus className="h-4 w-4" />Add Stock</button>}>
              <CapacityStrip capacity={m.capacity} lowStockQty={settings.lowStockQty} />
            </Card>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {Object.keys(MATERIALS).map((k) => {
                const ls = fifo.lots[k] || [];
                return <MaterialCard key={k} mat={k} stock={m.stock[k]} asOf={range.end} lowStockQty={settings.lowStockQty} latest={ls[ls.length - 1]?.unitCost} first={ls[0]?.unitCost} papersPerKg={settings.papersPerKg} />;
              })}
            </div>
            <Card title="Ready to Sell (pressed, not sold)" icon={Factory} bodyClass="p-0"
              subtitle={`Plates already made, as of ${fmtDate(range.end)}. Orders use these first, oldest run first. Worth ${fmtINR(m.readyValue)} at cost.`}
              actions={<button className={btn.primary} onClick={() => setModal({ kind: 'production' })}><Factory className="h-4 w-4" />Record Production</button>}>
              <div className="grid grid-cols-2 gap-px border-b border-slate-100 bg-slate-100 xl:grid-cols-4">
                {Object.entries(PRODUCTS).map(([k, p]) => (
                  <div key={k} className="bg-white px-4 py-3">
                    <div className="text-xs font-medium text-slate-600">{p.name}</div>
                    <div className="mt-0.5 text-xl font-semibold tabular-nums text-slate-900">{fmtNum(m.ready[k].qty)}</div>
                    <div className="text-[11px] text-slate-500">{m.ready[k].qty ? `₹${(m.ready[k].value / m.ready[k].qty).toFixed(2)}/plate · ${fmtINR(m.ready[k].value)}` : 'none ready'}</div>
                  </div>
                ))}
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-100">
                  <thead className="bg-slate-50/70"><tr>
                    <Th>Date made</Th><Th>Run</Th><Th>Plate</Th><Th right>Plates made</Th><Th right>Cost / plate</Th><Th right>Sold from it</Th><Th>Ready left</Th><Th>Note</Th><Th right><span className="sr-only">Actions</span></Th>
                  </tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {productionRows.length === 0 && <tr><td colSpan={9} className="px-3 py-8 text-center text-sm text-slate-500">No production recorded. Use Record Production for plates pressed ahead of orders.</td></tr>}
                    {productionRows.map((x) => {
                      const lot = fifo.fgIndex[x.id]; const pa = fifo.prodAllocs[x.id];
                      const left = lot ? remainingAsOf(lot, range.end) : 0;
                      const leafMat = PRODUCTS[x.product].leaf; const baseMat = x.base || PRODUCTS[x.product].sheet;
                      return (
                        <tr key={x.id} className="hover:bg-slate-50/60">
                          <Td>{fmtDate(x.date)}</Td><Td className="font-medium text-slate-800">{x.id}</Td><Td>{PRODUCTS[x.product].name}</Td>
                          <Td right>{fmtNum(x.qty)}</Td>
                          <Td right title={pa ? `${MATERIALS[leafMat].label} ${fmtINR2(pa.unitMat[leafMat])} + ${MATERIALS[baseMat].label} ${fmtINR2(pa.unitMat[baseMat])} + Making ${fmtINR2(x.making)}` : ''}><span className="cursor-help border-b border-dotted border-slate-300">{lot ? fmtINR2(lot.unitCost) : '—'}</span>{pa && Object.keys(pa.shortfall).length > 0 && <Badge tone="rose" icon={AlertTriangle}>raw short</Badge>}</Td>
                          <Td right>{fmtNum(x.qty - left)}</Td>
                          <Td>{left > 0 ? <Badge tone="amber" icon={Package}>{fmtNum(left)} ready</Badge> : <Badge tone="slate">all sold</Badge>}</Td>
                          <Td className="text-xs text-slate-500">{x.note || ''}</Td>
                          <Td right><RowActions onHistory={historyFor(x.id)} onEdit={() => setModal({ kind: 'production', record: x })} onDelete={() => askDelete('productions', x, `This removes ${fmtNum(x.qty)} ready ${PRODUCTS[x.product].name}s; their leaves and ${MATERIALS[baseMat].unit} go back to raw stock and any orders that used them are made to order instead.`)} /></Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card title="Purchase History" icon={Package} bodyClass="p-0" subtitle="Every purchase at the price paid. Stock is used oldest batch first.">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-100">
                  <thead className="bg-slate-50/70"><tr>
                    <Th>Date</Th><Th>Batch</Th><Th>Material</Th><Th>Supplier</Th><Th right>Qty bought</Th><Th right>Price / unit</Th><Th right>Total paid</Th><Th>Left in stock</Th><Th>Payment</Th><Th right><span className="sr-only">Actions</span></Th>
                  </tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {batchRows.length === 0 && <tr><td colSpan={10} className="px-3 py-8 text-center text-sm text-slate-500">No purchases yet — click Add Stock.</td></tr>}
                    {batchRows.map((b) => {
                      const pct = b.qty ? (b.left / b.qty) * 100 : 0;
                      return (
                        <tr key={b.id} className={`hover:bg-slate-50/60 ${b.inRange ? '' : 'text-slate-500'}`}>
                          <Td>{fmtDate(b.date)}</Td><Td className="font-medium text-slate-800">{b.id}</Td>
                          <Td><span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: MATERIALS[b.material].color }} />{MATERIALS[b.material].label}</span></Td>
                          <Td>{b.supplier}</Td>
                          <Td right>{fmtNum(b.qty)}{b.kg ? <div className="text-[11px] text-slate-400">{b.kg} kg × {b.papersPerKg}/kg</div> : null}</Td>
                          <Td right className="font-medium text-slate-800">{fmtINR2(b.unitPrice)}{b.perKg ? <div className="text-[11px] font-normal text-slate-400">₹{b.perKg}/kg</div> : null}</Td><Td right>{fmtINR(b.qty * b.unitPrice)}</Td>
                          <Td><div className="flex min-w-[150px] items-center gap-2"><div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} /></div><span className="tabular-nums">{b.left > 0 ? fmtNum(b.left) : <span className="text-slate-400">used up</span>}</span></div></Td>
                          <Td><PaymentBadge status={b.payment} /></Td>
                          <Td right><RowActions onHistory={historyFor(b.id)} onEdit={() => setModal({ kind: 'stock', record: b })} onDelete={() => askDelete('purchases', b, `This removes ${fmtNum(b.qty)} ${MATERIALS[b.material].label} bought from ${b.supplier}.`)} /></Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}

        {/* ───────── ORDERS ───────── */}
        {tab === 'orders' && (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {m.byProduct.map((b) => (
                <div key={b.code} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{b.name}</div>
                  <div className="mt-1 text-2xl font-semibold tabular-nums">{fmtNum(b.qty)} <span className="text-xs font-normal text-slate-500">plates sold</span></div>
                  <div className="mt-1 grid grid-cols-2 gap-1 text-xs text-slate-500">
                    <span>Sales <b className="text-slate-700">{fmtINR(b.revenue)}</b></span>
                    <span className="text-right">Avg price <b className="text-slate-700">{b.qty ? fmtINR2(b.avgPrice) : '—'}</b></span>
                    <span>Profit <b className={b.profit >= 0 ? 'text-emerald-700' : 'text-rose-700'}>{fmtINR(b.profit)}</b></span>
                    <span className="text-right">per plate <b className="text-slate-700">{b.qty ? fmtINR2(b.profit / b.qty) : '—'}</b></span>
                  </div>
                </div>
              ))}
            </div>
            <Card title="Orders" icon={ShoppingCart} bodyClass="p-0"
              subtitle="Each order keeps its price, making charge and the stock batches it used. Profit = sales − (leaf + sheet + making)."
              actions={<>
                <div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" /><input value={orderQuery} onChange={(e) => setOrderQuery(e.target.value)} placeholder="Customer, phone or ID" aria-label="Search orders" className="w-44 rounded-lg border border-slate-300 py-2 pl-8 pr-3 text-xs focus:border-indigo-500 focus:outline-none" /></div>
                <select value={orderProduct} onChange={(e) => setOrderProduct(e.target.value)} aria-label="Filter by plate" className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs">
                  <option value="all">All plates</option>{Object.entries(PRODUCTS).map(([k, p]) => <option key={k} value={k}>{p.name}</option>)}
                </select>
                <button className={btn.emerald} onClick={() => setModal({ kind: 'order' })}><Phone className="h-4 w-4" />New Order</button>
              </>}>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-100">
                  <thead className="bg-slate-50/70"><tr>
                    <Th>Date</Th><Th>Order</Th><Th>Customer</Th><Th>Plate</Th><Th>Leaf from</Th><Th right>Qty</Th><Th right>Price</Th><Th right>Cost / plate</Th><Th right>Sales</Th><Th right>Profit</Th><Th>Payment</Th><Th right><span className="sr-only">Actions</span></Th>
                  </tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {orderRows.length === 0 && <tr><td colSpan={12} className="px-3 py-8 text-center text-sm text-slate-500">No orders in these dates.</td></tr>}
                    {orderRows.map((s) => {
                      const a = fifo.allocs[s.id]; const leafMat = PRODUCTS[s.product].leaf;
                      const mg = a.revenue ? (a.profit / a.revenue) * 100 : 0;
                      return (
                        <tr key={s.id} className="hover:bg-slate-50/60">
                          <Td>{fmtDate(s.date)}</Td><Td className="font-medium text-slate-800">{s.id}</Td>
                          <Td><div>{s.customer}</div>{s.phone && <div className="text-[11px] text-slate-400">{s.phone}</div>}{cloud && s.enteredBy && <div className="text-[11px] text-slate-400">by {s.enteredBy}</div>}</Td>
                          <Td>{PRODUCTS[s.product].name}</Td>
                          <Td><div className="flex gap-1"><BasisBadge basis={basisOf(a, leafMat)} />{a.shortfall[s.base || PRODUCTS[s.product].sheet] && <Badge tone="rose" icon={AlertTriangle}>{MATERIALS[s.base || PRODUCTS[s.product].sheet].label} short</Badge>}</div></Td>
                          <Td right>{fmtNum(s.qty)}</Td><Td right>{fmtINR2(s.price)}</Td>
                          <Td right title={`Leaf ${fmtINR2(a.unitMat[leafMat])} + ${MATERIALS[s.base || PRODUCTS[s.product].sheet].label} ${fmtINR2(a.unitMat[s.base || PRODUCTS[s.product].sheet])} + Making ${fmtINR2(a.making)}`}><span className="cursor-help border-b border-dotted border-slate-300">{fmtINR2(a.unitCost)}</span></Td>
                          <Td right>{fmtINR(a.revenue)}</Td>
                          <Td right><span className={a.profit >= 0 ? 'font-medium text-emerald-700' : 'font-medium text-rose-700'}>{fmtINR(a.profit)}</span><span className="ml-1 text-[11px] text-slate-400">{mg.toFixed(0)}%</span></Td>
                          <Td><PaymentBadge status={s.payment} /></Td>
                          <Td right><RowActions onHistory={historyFor(s.id)} onEdit={() => setModal({ kind: 'order', record: s })} onDelete={() => askDelete('sales', s, `This removes the ${fmtNum(s.qty)}-plate order for ${s.customer}; its stock goes back into inventory.`)} /></Td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {orderRows.length > 0 && (
                    <tfoot className="bg-slate-50/70 text-sm font-semibold text-slate-800"><tr>
                      <Td>Total</Td><Td /><Td /><Td /><Td className="text-xs font-normal text-slate-500">{orderRows.length} orders</Td>
                      <Td right>{fmtNum(orderTotals.qty)}</Td><Td /><Td /><Td right>{fmtINR(orderTotals.rev)}</Td>
                      <Td right className={orderTotals.profit >= 0 ? 'text-emerald-700' : 'text-rose-700'}>{fmtINR(orderTotals.profit)}</Td><Td /><Td />
                    </tr></tfoot>
                  )}
                </table>
              </div>
            </Card>
          </>
        )}

        {/* ───────── PRICING ───────── */}
        {tab === 'pricing' && (
          <>
            <Card title="Break-even & Target Prices" icon={Target} bodyClass="p-0"
              subtitle="Cost per plate = next leaf + next sheet from stock (oldest batch first) + making charge. Any price above it makes a profit."
              actions={<button className={btn.ghost} onClick={() => setModal({ kind: 'settings' })}><Settings className="h-4 w-4" />Making charges & target</button>}>
              <BreakEvenTable rows={pricingRows} targetMargin={settings.targetMargin} />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-100 px-4 py-3 text-xs text-slate-600 sm:px-5">
                <span><Target className="mr-1 inline h-3.5 w-3.5 text-indigo-600" />{toRecover > 0 ? <>Still to recover: <b>{fmtINR(toRecover)}</b>.</> : <b className="text-emerald-700">Investment fully recovered.</b>}</span>
                {toRecover > 0 && (
                  <>
                    <label className="flex items-center gap-1.5">Selling
                      <input type="number" min="0" step="1000" value={ppm} onChange={(e) => setPlatesPerMonth(Math.max(0, Number(e.target.value) || 0))} className="w-24 rounded-md border border-slate-300 px-2 py-1 text-right tabular-nums" aria-label="Plates per month" />
                      plates/month for <b>{settings.recoverMonths}</b> months
                    </label>
                    <span>→ charge <b>{ppm > 0 ? fmtINR2(extraPerPlate) : '—'}</b> per plate above cost to recover it.</span>
                    {platesPerMonth !== null && <button className="text-indigo-600 hover:underline" onClick={() => setPlatesPerMonth(null)}>use last 30 days ({fmtNum(recentPlates)})</button>}
                  </>
                )}
              </div>
            </Card>

            <PriceCalculator key={JSON.stringify(calcDefaults)} defaults={calcDefaults} targetMargin={settings.targetMargin} toRecover={toRecover} />

            <Card title="Selling Price vs Cost per Order" icon={TrendingUp} subtitle="How each order's price compared with what that plate cost you (selected dates)"
              actions={<select value={trendProduct} onChange={(e) => setTrendProduct(e.target.value)} aria-label="Plate" className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs">{Object.entries(PRODUCTS).map(([k, p]) => <option key={k} value={k}>{p.name}</option>)}</select>}>
              {priceTrend.length === 0 ? <EmptyState text="No orders for this plate in these dates." /> : (
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={priceTrend} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                      <CartesianGrid stroke={C.grid} strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: C.axis }} tickLine={false} axisLine={{ stroke: C.grid }} minTickGap={24} />
                      <YAxis tick={{ fontSize: 11, fill: C.axis }} tickFormatter={(v) => `₹${v.toFixed(2)}`} tickLine={false} axisLine={false} width={56} domain={['auto', 'auto']} />
                      <Tooltip content={<ChartTooltip valueFormatter={fmtINR2} />} />
                      <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
                      <Line type="linear" dataKey="price" name="Selling price" stroke={C.revenue} strokeWidth={2} dot={{ r: 3 }} />
                      <Line type="linear" dataKey="cost" name="Cost per plate" stroke={C.cost} strokeWidth={2} dot={{ r: 3 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Card>
          </>
        )}

        {/* ───────── INVESTMENTS ───────── */}
        {tab === 'history' && cloud && (
          <HistoryPanel cloud={cloud} data={data} focusId={historyFocus} setFocusId={setHistoryFocus}
            onRestored={(row) => { setData((d) => applyRow(d, row)); setToast({ tone: 'emerald', msg: `${row.id} restored` }); }} />
        )}

        {tab === 'investments' && (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Stat label="Total money invested" value={fmtINR(m.investedTD)} note={asOfNote} tone="rose" />
              <Stat label="Machinery" value={fmtINR(m.machineryTD)} note="One-time" />
              <Stat label="Raw material + making" value={fmtINR(m.materialsTD + m.makingTD)} note="Leaves, sheets, paper, making charges" />
              <Stat label="Recovered so far" value={`${m.recoveredPct.toFixed(0)}%`} tone={inProfit ? 'emerald' : 'indigo'} note={inProfit ? `In profit by ${fmtINR(m.position)}` : `${fmtINR(toRecover)} to go`} />
            </div>
            {trendChart}
            <Card title="Investments & Expenses" icon={Wrench} bodyClass="p-0"
              subtitle="Machinery is recovered over time. Labour, transport and other costs are taken off profit when paid. Raw material is under Stock."
              actions={<button className={btn.primary} onClick={() => setModal({ kind: 'expense' })}><Plus className="h-4 w-4" />Add Investment</button>}>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-100">
                  <thead className="bg-slate-50/70"><tr><Th>Date</Th><Th>ID</Th><Th>Type</Th><Th>Description</Th><Th>Paid to</Th><Th right>Amount</Th><Th>Payment</Th><Th right><span className="sr-only">Actions</span></Th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {expenseRows.length === 0 && <tr><td colSpan={8} className="px-3 py-8 text-center text-sm text-slate-500">Nothing yet — click Add Investment.</td></tr>}
                    {expenseRows.map((e) => (
                      <tr key={e.id} className="hover:bg-slate-50/60">
                        <Td>{fmtDate(e.date)}</Td><Td className="font-medium text-slate-800">{e.id}</Td>
                        <Td><Badge tone={EXPENSE_CATS[e.category]?.capital ? 'indigo' : 'rose'}>{EXPENSE_CATS[e.category]?.label}</Badge></Td>
                        <Td>{e.item}</Td><Td>{e.payee}</Td><Td right className="font-medium text-slate-800">{fmtINR(e.amount)}</Td>
                        <Td><PaymentBadge status={e.payment} /></Td>
                        <Td right><RowActions onHistory={historyFor(e.id)} onEdit={() => setModal({ kind: 'expense', record: e })} onDelete={() => askDelete('expenses', e, `This removes "${e.item}" (${fmtINR(e.amount)}).`)} /></Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}

        <p className="flex items-start gap-2 pb-4 text-xs text-slate-500"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {cloud ? 'Data is saved in your shared online database and updates live for everyone signed in. Backup still downloads a copy for safekeeping.' : 'Data is saved in this browser only. Use Backup regularly to keep a copy you can import later.'}</p>
      </main>

      {modal?.kind === 'stock' && <StockModal initial={modal.record} purchases={purchases} fifo={fifo} papersPerKg={settings.papersPerKg} onSave={saveStock} onClose={() => setModal(null)} />}
      {modal?.kind === 'expense' && <ExpenseModal initial={modal.record} onSave={saveExpense} onClose={() => setModal(null)} />}
      {modal?.kind === 'order' && <OrderModal initial={modal.record} purchases={purchases} sales={sales} productions={productions} settings={settings} onSave={saveOrder} onClose={() => setModal(null)} />}
      {modal?.kind === 'production' && <ProductionModal initial={modal.record} purchases={purchases} sales={sales} productions={productions} settings={settings} onSave={saveProduction} onClose={() => setModal(null)} />}
      {modal?.kind === 'settings' && <SettingsModal settings={settings} onSave={saveSettings} onClose={() => setModal(null)} />}
      {confirm && <ConfirmDialog {...confirm} onClose={() => setConfirm(null)} />}
      {toast && (
        <div className="fixed bottom-4 left-1/2 z-[60] w-max max-w-[calc(100vw-2rem)] -translate-x-1/2" role="status">
          <div className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm text-white shadow-lg ${toast.tone === 'rose' ? 'bg-rose-600' : toast.tone === 'amber' ? 'bg-amber-600' : 'bg-slate-900'}`}>
            {toast.tone === 'emerald' ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}{toast.msg}
          </div>
        </div>
      )}
    </div>
  );
}

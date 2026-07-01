#!/usr/bin/env node
/* ============================================================
   validate.js ── dac システムの回帰ランナー
   90_golden_cases.json を実エンジン(core)で照合する。
   - 判定: verdict / provisional / labels / band4 / accepted_rules / rejected_rules / open_literals
   - 不変条件: L ⊆ DEF ⊆ U（judge の invariant_ok）
   - 義務: triggered / role / roleAssumed / provisional / includes / minCount
   - シミュレーション: verdictFlipsTo / flipLiteralsInclude
   使い方: node test/validate.js
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const { loadPack } = require("../core/loader.js");
const { judge } = require("../core/engine.js");
const { obligations } = require("../core/obligations.js");
const { simulate } = require("../core/simulate.js");

const GC = JSON.parse(fs.readFileSync(path.join(__dirname, "90_golden_cases.json"), "utf8"));

// packs/ 配下の全パックを rulepack.id をキーに自動ロード
const PACKS_DIR = path.join(__dirname, "..", "packs");
const RULEPACKS = {};
for (const name of fs.readdirSync(PACKS_DIR)) {
  const dir = path.join(PACKS_DIR, name);
  if (!fs.statSync(dir).isDirectory()) continue;
  if (!fs.existsSync(path.join(dir, "30_rulepack.json"))) continue;
  const pack = loadPack(dir);
  RULEPACKS[pack.rulepack.id] = pack;
}

function argsByRule(r, ruleId) { return (r.debug.args || []).filter(a => a.ruleId === ruleId); }
function bandsByClaim(r, claim) { return (r.dual.bands || []).filter(b => b.claim === claim); }

function runCase(c) {
  const pack = c.inline_rulepack ? { rulepack: c.inline_rulepack, literals: { literals: [] } } : RULEPACKS[c.rulepack_ref];
  if (!pack) return { id: c.id, ok: false, errs: [`unknown rulepack_ref: ${c.rulepack_ref}`] };
  const rb = pack.rulepack;

  let r;
  try { r = judge(c.facts, rb); }
  catch (e) { return { id: c.id, ok: false, errs: [`engine error: ${e.message}`] }; }

  const e = c.expect || {};
  const errs = [];

  if (e.verdict !== undefined && r.verdict !== e.verdict) errs.push(`verdict: expected ${e.verdict}, got ${r.verdict}`);
  if (e.provisional !== undefined && r.provisional !== e.provisional) errs.push(`provisional: expected ${e.provisional}, got ${r.provisional}`);

  for (const [ruleId, want] of Object.entries(e.labels || {})) {
    const aa = argsByRule(r, ruleId);
    if (!aa.length) errs.push(`labels: rule ${ruleId} に該当引数なし`);
    else for (const a of aa) if (a.label !== want) errs.push(`labels: ${ruleId} expected ${want}, got ${a.label}`);
  }
  for (const [claim, want] of Object.entries(e.band4 || {})) {
    const bb = bandsByClaim(r, claim);
    if (!bb.length) errs.push(`band4: claim ${claim} に該当バンドなし`);
    else for (const b of bb) if ((b.band4 || b.band) !== want) errs.push(`band4: ${claim} expected ${want}, got ${b.band4 || b.band}`);
  }
  for (const ruleId of e.accepted_rules || [])
    if (!argsByRule(r, ruleId).some(a => a.label === "IN")) errs.push(`accepted_rules: ${ruleId} に IN 引数がない`);
  for (const ruleId of e.rejected_rules || [])
    if (!argsByRule(r, ruleId).some(a => a.label === "OUT")) errs.push(`rejected_rules: ${ruleId} に OUT 引数がない`);
  for (const lit of e.open_literals || [])
    if (!(r.openIssues || []).some(o => o.literal === lit)) errs.push(`open_literals: ${lit} が openIssues にない`);
  if (e.invariant === true && !r.invariant_ok) errs.push(`invariant L⊆DEF⊆U 違反: ${r.invariant_bad.join("; ")}`);

  // obligations
  if (e.obligations) {
    const o = obligations(c.facts, rb, r);
    const eo = e.obligations;
    if (eo.triggered !== undefined && o.triggered !== eo.triggered) errs.push(`obligations.triggered: expected ${eo.triggered}, got ${o.triggered}`);
    if (eo.role !== undefined && o.role !== eo.role) errs.push(`obligations.role: expected ${eo.role}, got ${o.role}`);
    if (eo.roleAssumed !== undefined && o.roleAssumed !== eo.roleAssumed) errs.push(`obligations.roleAssumed: expected ${eo.roleAssumed}, got ${o.roleAssumed}`);
    if (eo.provisional !== undefined && o.provisional !== eo.provisional) errs.push(`obligations.provisional: expected ${eo.provisional}, got ${o.provisional}`);
    if (eo.minCount !== undefined && o.applicable.length < eo.minCount) errs.push(`obligations.minCount: expected >=${eo.minCount}, got ${o.applicable.length}`);
    for (const id of eo.includes || [])
      if (!o.applicable.some(a => a.id === id)) errs.push(`obligations.includes: ${id} が適用義務にない`);
  }

  // simulation
  if (e.simulation) {
    const sim = simulate(c.facts, rb, pack.literals);
    const es = e.simulation;
    if (es.verdictFlipsTo) {
      const flips = sim.whatif.filter(w => w.verdict === es.verdictFlipsTo && w.verdictChanged);
      if (!flips.length) errs.push(`simulation: どの単一条件でも ${es.verdictFlipsTo} に反転しない`);
      for (const lit of es.flipLiteralsInclude || [])
        if (!flips.some(w => w.literal === lit)) errs.push(`simulation: ${lit} の確定で ${es.verdictFlipsTo} に反転しない`);
    }
  }

  return { id: c.id, kind: c.kind, ok: errs.length === 0, errs, invOk: r.invariant_ok };
}

console.log("=".repeat(64));
console.log(" dac システム ゴールデンケース回帰 (判定 + 義務 + シミュレーション)");
console.log("=".repeat(64));
let failures = 0;
const lines = [];
for (const c of GC.cases) {
  const res = runCase(c);
  lines.push(`[${res.ok ? "PASS" : "FAIL"}] ${res.id}  (${res.kind || "-"})  inv=${res.invOk ? "ok" : "NG"}`);
  if (!res.ok) { failures++; for (const m of res.errs) lines.push(`        - ${m}`); }
}
console.log(lines.join("\n"));
console.log("-".repeat(64));
console.log(`ケース数: ${GC.cases.length}  /  失敗: ${failures}`);
console.log(failures === 0 ? "✓ 全ケース合格。" : "✗ 不一致あり（上記参照）。");
process.exit(failures === 0 ? 0 : 1);

#!/usr/bin/env node
/* ============================================================
   validate_multi.js ── 複数規制同時判定の回帰
   tools/multi_classify.js のロジック（独立評価＋義務合算＋label.ja 重複検出）を
   固定の事案（cases/40_facts.multi_smart_credit_device.json）で検証する。
   使い方: node test/validate_multi.js
   ============================================================ */
"use strict";
const path = require("path");
const { loadPack, loadFacts } = require("../core/loader.js");
const { classify } = require("../core/classify.js");

let fails = 0;
function assert(cond, msg) {
  if (!cond) { fails++; console.log("  ✗ ASSERT FAIL: " + msg); }
  else console.log("  ✓ " + msg);
}

const ROOT = path.join(__dirname, "..");
const fc = loadFacts(path.join(ROOT, "cases", "40_facts.multi_smart_credit_device.json"));
const packDirs = ["eu_ai_act_art6", "cra", "gdpr_art35"];
const results = packDirs.map(id => {
  const pack = loadPack(path.join(ROOT, "packs", id));
  return { packId: id, ...classify(fc.facts, pack, { simulate: false }) };
});
const byId = Object.fromEntries(results.map(r => [r.packId, r]));

console.log("=".repeat(64));
console.log(" 複数規制同時判定 回帰テスト（ルールパックの直和）");
console.log("=".repeat(64));

assert(byId.eu_ai_act_art6.judgement.verdict === "HIGH_RISK", "AI Act: HIGH_RISK");
assert(byId.eu_ai_act_art6.judgement.invariant_ok, "AI Act: 不変条件 ok");
assert(byId.eu_ai_act_art6.obligations.applicable.length === 13, "AI Act: 義務13件");

assert(byId.cra.judgement.verdict === "IN_SCOPE", "CRA: IN_SCOPE");
assert(byId.cra.judgement.dual.band4Verdict === "ESTABLISHED_IN_SCOPE", "CRA: ESTABLISHED_IN_SCOPE");
assert(byId.cra.obligations.applicable.length === 8, "CRA: 義務8件");

assert(byId.gdpr_art35.judgement.verdict === "DPIA_REQUIRED", "GDPR: DPIA_REQUIRED");
assert(byId.gdpr_art35.obligations.applicable.some(o => o.id === "obl_prior_consultation"), "GDPR: 事前協議(Art36)を含む");
assert(byId.gdpr_art35.obligations.applicable.length === 4, "GDPR: 義務4件");

const combined = results.flatMap(r => r.obligations.applicable.map(o => ({ regulation: r.packId, ...o })));
assert(combined.length === 25, "合算義務: 25件（13+8+4）");

const byLabel = {};
for (const o of combined) (byLabel[o.label.ja] = byLabel[o.label.ja] || []).push(o.regulation);
const overlaps = Object.entries(byLabel).filter(([, regs]) => new Set(regs).size > 1).map(([label]) => label);
assert(overlaps.includes("技術文書"), "重複候補: 技術文書（AI Act + CRA）");
assert(overlaps.includes("EU適合宣言"), "重複候補: EU適合宣言（AI Act + CRA）");
assert(overlaps.includes("CEマーキング"), "重複候補: CEマーキング（AI Act + CRA）");
assert(overlaps.length === 3, "重複候補は3組のみ（GDPRとの重複は無い）");

console.log("\n" + "=".repeat(64));
console.log(fails === 0 ? "✓ 全表明に合格。" : ("✗ 表明失敗 " + fails + " 件。"));
console.log("=".repeat(64));
process.exit(fails === 0 ? 0 : 1);

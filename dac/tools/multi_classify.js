#!/usr/bin/env node
/* ============================================================
   multi_classify.js ── 複数規制の同時判定（ルールパックの直和）
   1つの事案記述（facts）を、複数の規制パックそれぞれに独立にかけ、
   結果を1枚のレポートに統合する。SystemTheory.md §7 の展望
   「複数規制の同時判定はルールパックの直和として自然に定式化できる」の実装。

   範囲の限定（誠実に明示する）:
   - 各パックの judge() は完全に独立に実行する。規制間で攻撃関係（conflicts/
     superiority）を共有しない＝規制間の優先順位や抵触法的な調整は行わない
     （「規制間優先」は SystemTheory が将来課題として残す部分）。
   - 統合が行うのは (1) 結果の並列表示 (2) 義務の合算 (3) 同一の label.ja を
     持つ義務をラベル一致として束ね、規制を跨いだ重複候補として提示すること、
     の3点だけ。「同じ実質要求が複数の窓口から来ている」ことの検出に有用だが、
     実質的に同一の義務かどうかの判断（翻訳管轄）は人間に残す。

   使い方:
     node tools/multi_classify.js <facts.json> <packDir1> [<packDir2> ...] [--json]
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const { loadPack, loadFacts } = require("../core/loader.js");
const { classify } = require("../core/classify.js");

function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter(a => a.startsWith("--")));
  const pos = args.filter(a => !a.startsWith("--"));
  if (pos.length < 2) {
    console.error("usage: node tools/multi_classify.js <facts.json> <packDir1> [<packDir2> ...] [--json]");
    process.exit(2);
  }
  const fc = loadFacts(path.resolve(pos[0]));
  const packDirs = pos.slice(1);

  const results = packDirs.map(d => {
    const pack = loadPack(path.resolve(d));
    const out = classify(fc.facts, pack, { simulate: false });
    return { packId: pack.rulepack.id, packDir: d, pack, ...out };
  });

  // 義務を合算し、規制タグを付ける
  const combinedObligations = [];
  for (const r of results) {
    for (const o of r.obligations.applicable || []) {
      combinedObligations.push({ regulation: r.packId, verdict: r.judgement.verdict, ...o });
    }
  }
  // label.ja が一致するものを重複候補としてグルーピング
  const byLabel = {};
  for (const o of combinedObligations) {
    const key = (o.label && o.label.ja) || o.id;
    (byLabel[key] = byLabel[key] || []).push(o);
  }
  const overlaps = Object.entries(byLabel)
    .filter(([, list]) => new Set(list.map(o => o.regulation)).size > 1)
    .map(([label, list]) => ({ label, items: list }));

  if (flags.has("--json")) {
    console.log(JSON.stringify({ case_id: fc.case_id, results, combinedObligations, overlaps }, null, 2));
    return;
  }
  printReport(fc, results, combinedObligations, overlaps);
}

function bar(c = "─", n = 64) { return c.repeat(n); }

function printReport(fc, results, combinedObligations, overlaps) {
  console.log(bar("="));
  console.log(" 規制論証システム ── 複数規制 同時判定レポート（ルールパックの直和）");
  console.log(` 事案: ${fc.case_id}`);
  console.log(bar("="));

  console.log("\n【1】規制ごとの判定（各規制は独立に評価。規制間の優先順位調整は行っていない）\n");
  for (const r of results) {
    const j = r.judgement, o = r.obligations;
    console.log(`  ▶ ${r.packId}@${r.pack.rulepack.version}`);
    console.log(`     verdict : ${j.verdict}${j.provisional ? "  [暫定]" : ""}   四帯: ${j.dual.band4Verdict}   不変条件: ${j.invariant_ok ? "ok" : "NG"}`);
    console.log(`     義務   : ${o.triggered ? o.applicable.length + " 件" : "なし（" + j.verdict + "）"}`);
    if (j.openIssues.length) console.log(`     要確認 : ${j.openIssues.map(x => x.literal + "[" + x.confidence + "]").join(", ")}`);
    console.log();
  }

  console.log("【2】合算された義務（規制を跨いだ単純な集合。重複の解消はしていない）\n");
  console.log(`  合計 ${combinedObligations.length} 件（規制別: ${results.map(r => `${r.packId}=${r.obligations.applicable.length}`).join(", ")}）`);
  for (const o of combinedObligations)
    console.log(`    - [${o.regulation} / ${o.ref}] ${o.label.ja}`);

  console.log("\n【3】規制を跨いだ重複候補（同一の label.ja を持つ義務。実質的に同一かは人間判断）\n");
  if (!overlaps.length) console.log("  重複候補なし。");
  for (const ov of overlaps) {
    console.log(`  ⚠ 「${ov.label}」が ${ov.items.length} 規制から要求されている:`);
    for (const it of ov.items) console.log(`      - ${it.regulation} [${it.ref}]: ${it.text}`);
  }
  console.log("\n" + bar("="));
}

main();

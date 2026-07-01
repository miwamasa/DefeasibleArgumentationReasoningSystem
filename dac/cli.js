#!/usr/bin/env node
/* ============================================================
   cli.js ── 規制論証システム CLI
   使い方:
     node cli.js <packDir> <facts.json> [--no-sim] [--json]
   例:
     node cli.js packs/eu_ai_act_art6 cases/40_facts.credit_scoring.json
   ============================================================ */
"use strict";
const path = require("path");
const { loadPack, loadFacts } = require("./core/loader.js");
const { classify } = require("./core/classify.js");

function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter(a => a.startsWith("--")));
  const pos = args.filter(a => !a.startsWith("--"));
  if (pos.length < 2) {
    console.error("usage: node cli.js <packDir> <facts.json> [--no-sim] [--json]");
    process.exit(2);
  }
  const packDir = path.resolve(pos[0]);
  const pack = loadPack(packDir);
  const fc = loadFacts(path.resolve(pos[1]));

  // --beta=skeptical|defensible|credulous でルールパックの policy_beta を上書き（探索用）
  const betaFlag = args.find(a => a.startsWith("--beta="));
  if (betaFlag) pack.rulepack = { ...pack.rulepack, policy_beta: betaFlag.split("=")[1] };

  const out = classify(fc.facts, pack, { simulate: !flags.has("--no-sim") });

  if (flags.has("--json")) {
    console.log(JSON.stringify({ case_id: fc.case_id, ...out }, null, 2));
    return;
  }
  printReport(fc, pack, out);
}

function labelJa(pack, litId) {
  const d = (pack.literals.literals || []).find(l => l.id === litId);
  return d && d.label ? d.label.ja : litId;
}
function bar(c = "─", n = 64) { return c.repeat(n); }

function printReport(fc, pack, out) {
  const j = out.judgement, o = out.obligations, s = out.simulation;
  console.log(bar("="));
  console.log(" 規制論証システム ── 判定レポート");
  console.log(` ルールパック: ${pack.rulepack.id}@${pack.rulepack.version}   事案: ${fc.case_id}`);
  console.log(bar("="));

  // (1) 判定
  console.log("\n【1】判定（該当するか）");
  console.log(`  verdict        : ${j.verdict}${j.provisional ? "  [暫定]" : ""}`);
  console.log(`  理由           : ${j.verdictReason}`);
  console.log(`  四帯           : ${j.dual.band4Verdict}`);
  console.log(`  　              ${j.dual.band4Reason}`);
  console.log(`  三読み         : 懐疑(L)=${j.dual.readings.skeptical} / 擁護可(DEF)=${j.dual.readings.defensible} / 反駁不能(U)=${j.dual.readings.credulous}`);
  console.log(`  適用β          : ${j.policy_beta}（verdict はこの読みを採用）`);
  console.log(`  不変条件L⊆DEF⊆U: ${j.invariant_ok ? "ok" : "違反 " + j.invariant_bad.join("; ")}`);

  console.log("\n  結論バンド:");
  for (const b of j.dual.bands)
    console.log(`    - ${b.claim} [${b.rule}]  ${b.band4}  (label=${b.label}, defensible=${b.defensible})`);
  if (j.accepted.length)
    console.log("  採用(IN)         : " + j.accepted.map(a => `${a.rule}→${a.claim} [${a.reference}]`).join(", "));
  if (j.rejected.length)
    console.log("  棄却(OUT)        : " + j.rejected.map(a => `${a.rule}→${a.claim} (by ${a.defeatedBy[0] ? a.defeatedBy[0].rule : "?"})`).join(", "));
  if (j.openIssues.length)
    console.log("  要確認(openIssues): " + j.openIssues.map(x => `${x.literal}[${x.confidence}]`).join(", "));

  // (2) 義務
  console.log("\n【2】義務（該当する場合に何をしないといけないか）");
  console.log("  " + o.summary);
  if (o.triggered) {
    console.log(`  役割           : ${o.role}${o.roleAssumed ? "（仮定: 提供者）" : ""}`);
    console.log("  適用される義務:");
    for (const a of o.applicable)
      console.log(`    - [${a.ref}] ${a.label.ja}: ${a.text}${a.assumed ? "  (役割仮定)" : ""}`);
    if (o.conditional.length) {
      console.log("  条件付きで生じる義務:");
      for (const c of o.conditional)
        console.log(`    - [${c.ref}] ${c.label.ja}  (${c.appliesIf} が成立する場合)`);
    }
  }

  // (3) シミュレーション
  if (s) {
    console.log("\n【3】不足条件のシミュレーション");
    if (!s.openLiterals.length) {
      console.log("  不足している関連条件はありません（全関連入力が確定済み）。");
    } else {
      console.log("  未確定の関連条件: " + s.openLiterals.map(l => `${l.id}${l.open_texture ? "*" : ""}`).join(", ") + "   (* = 解釈の幅あり)");
      console.log("\n  ▶ 1条件ずつ確定させた場合（代表例; ★=判定が変化）:");
      for (const w of s.whatif) {
        const star = w.verdictChanged ? "★" : " ";
        const tier = w.tier ? ` [${w.tier}]` : "";
        console.log(`   ${star} ${w.literal}=${JSON.stringify(w.value)}${w.note ? "(" + w.note + ")" : ""} → ${w.verdict}${tier} / 義務${w.obligationCount}件${w.obligationsChanged ? " (義務変化)" : ""}`);
      }
      console.log(`\n  ▶ 真偽条件 [${s.sweep.variables.join(", ")}] の総当り ${s.sweep.combinations} 通り → 結果クラス ${s.sweep.classes.length} 種:`);
      for (const c of s.sweep.classes) {
        const a = Object.entries(c.representativeAssignment).map(([k, v]) => `${k}=${v ? "T" : "F"}`).join(",");
        const tier = c.tier ? ` [${c.tier}]` : "";
        console.log(`     - ${c.verdict}${tier} / 義務${c.obligationCount}件  [${c.count}通り]  代表: ${a || "(なし)"}`);
      }
      if (s.sweep.truncated) console.log("     （変数が多いため一部のみ総当り）");
    }
  }
  console.log("\n" + bar("="));
}

main();

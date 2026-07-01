#!/usr/bin/env node
/* ============================================================
   extract_facts.js ── LLM 事実認定ハーネス
   自然言語の事案記述から、20_literals の input リテラルと llm_prompt を使って
   40_facts.<case>.json（構造化テキスト2）を生成する。ニューロ・シンボリック分担の
   「事実認定（LLM）／論理（エンジン）」の境界を、データ駆動で実装する部分
   （DataModels.md §0、SystemTheory §1 / 定理8）。

   使い方:
     node tools/extract_facts.js <packDir> <case.txt|--text="..."> [options]
   options:
     --id=<case_id>      出力の case_id（既定: 入力ファイル名 or case_<日時>）
     --out=<path>        出力先（既定: cases/40_facts.<id>.json）
     --model=<id>        モデル（既定: $ANTHROPIC_MODEL or claude-sonnet-4-6）
     --dry-run           API を呼ばず、組み立てたプロンプトだけ表示（鍵不要）
     --from-json=<file>  保存済みの LLM 応答 JSON を使い API を呼ばず再処理（オフライン）
     --print             生成した facts を stdout にも表示

   必要環境変数: ANTHROPIC_API_KEY（--dry-run 以外）
   ネットワーク: api.anthropic.com への HTTPS。プロキシ環境では HTTPS_PROXY を
     解する起動方法（例: グローバル fetch がプロキシを見る設定）で実行すること。
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const { loadPack } = require("../core/loader.js");

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

function buildPrompt(pack, caseText) {
  const inputs = (pack.literals.literals || []).filter(l => l.kind === "input");
  const lines = inputs.map(l => {
    const t = l.datatype === "enum" ? `enum（候補: ${(l.enum || []).join(", ")}）` : "boolean";
    const q = l.llm_prompt || l.definition || "";
    return `- ${l.id} [${t}]: ${q}`;
  }).join("\n");

  return `あなたは規制コンプライアンスの事実認定アシスタントです。以下の事案記述を読み、各リテラルの真偽（または該当コード）を判定してください。

# 事案記述
${caseText}

# 認定するリテラル（${pack.rulepack.id}）
${lines}

# 指示
- 各リテラルについて、事案記述から判定できるものだけを返す（判定できないものは省略可、または confidence="unknown"）。
- boolean は true/false。enum は候補から該当コード（文字列）、該当なしは false。
- confidence は事案記述からの確からしさ: "confirmed"（明確）/ "presumed"（推定）/ "unknown"（不明）。
- evidence に根拠（事案記述中の該当箇所の要約）を短く添える。
- 解釈の幅がある述語（大規模・体系的・体系的監視 等）は安易に confirmed にせず presumed にする。

# 出力（厳格な JSON。前後に説明文を付けない）
{
  "<リテラルid>": { "value": <true|false|"enumコード">, "confidence": "confirmed|presumed|unknown", "evidence": "..." },
  ...
}`;
}

async function callAnthropic(prompt, model) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY が未設定です（--dry-run でプロンプトのみ確認できます）");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
}

function extractJSON(text) {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("応答に JSON が見つかりません:\n" + text);
  return JSON.parse(text.slice(s, e + 1));
}

function normalizeFacts(raw, pack) {
  const inputIds = new Set((pack.literals.literals || []).filter(l => l.kind === "input").map(l => l.id));
  const facts = {};
  const dropped = [];
  for (const [k, v] of Object.entries(raw)) {
    if (!inputIds.has(k)) { dropped.push(k); continue; }
    const o = (v && typeof v === "object") ? v : { value: v };
    const conf = ["confirmed", "presumed", "unknown"].includes(o.confidence) ? o.confidence : "presumed";
    const entry = { value: o.value, confidence: conf };
    if (o.evidence) entry.evidence = o.evidence;
    facts[k] = entry;
  }
  return { facts, dropped };
}

async function main() {
  const args = process.argv.slice(2);
  const flags = args.filter(a => a.startsWith("--"));
  const pos = args.filter(a => !a.startsWith("--"));
  const getFlag = name => { const f = flags.find(x => x.startsWith(name + "=")); return f ? f.slice(name.length + 1) : null; };

  if (pos.length < 1) {
    console.error('usage: node tools/extract_facts.js <packDir> <case.txt|--text="..."> [--id=..] [--out=..] [--model=..] [--dry-run] [--print]');
    process.exit(2);
  }
  const packDir = path.resolve(pos[0]);
  const pack = loadPack(packDir);

  let caseText = getFlag("--text");
  let caseId = getFlag("--id");
  if (!caseText && pos[1]) {
    const p = path.resolve(pos[1]);
    if (fs.existsSync(p)) { caseText = fs.readFileSync(p, "utf8"); if (!caseId) caseId = path.basename(p).replace(/\.[^.]+$/, ""); }
    else caseText = pos[1];
  }
  if (!caseText) { console.error("事案記述がありません（ファイルか --text= で渡す）"); process.exit(2); }
  if (!caseId) caseId = "case_" + new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);

  const prompt = buildPrompt(pack, caseText.trim());

  if (flags.includes("--dry-run")) {
    console.log("===== 組み立てたプロンプト（--dry-run。API は呼んでいません）=====\n");
    console.log(prompt);
    console.log("\n===== このプロンプトを LLM に渡し、返った JSON を facts として 40_facts に保存します =====");
    return;
  }

  const model = getFlag("--model") || DEFAULT_MODEL;
  // --from-json=<file>: 保存済みの LLM 応答を使い、API を呼ばずに再処理（オフライン検証用）
  const fromJson = getFlag("--from-json");
  const text = fromJson ? fs.readFileSync(path.resolve(fromJson), "utf8") : await callAnthropic(prompt, model);
  const raw = extractJSON(text);
  const { facts, dropped } = normalizeFacts(raw, pack);

  const out = {
    case_id: caseId,
    rulepack_ref: `${pack.rulepack.id}@${pack.rulepack.version}`,
    description: caseText.trim().slice(0, 200),
    facts
  };
  const outPath = getFlag("--out") || path.join(packDir, "..", "..", "cases", `40_facts.${caseId}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`✓ ${Object.keys(facts).length} 件の事実を認定し、${path.relative(process.cwd(), outPath)} に書き出しました（model=${model}）。`);
  if (dropped.length) console.log(`  ⚠ 未知のリテラルを無視: ${dropped.join(", ")}`);
  console.log(`  次の一手: node tools/lint.js --facts && node cli.js ${pos[0]} ${path.relative(process.cwd(), outPath)}`);
  if (flags.includes("--print")) console.log(JSON.stringify(out, null, 2));
}

main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });

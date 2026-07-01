#!/usr/bin/env node
/* ============================================================
   lint.js ── ルールパックの整合性リンタ（ゼロ依存）
   構造チェック（必須フィールド・列挙値）に加え、参照整合チェックを行う:
     - rule id の一意性
     - rule body / head のリテラルが 20_literals に宣言されているか
     - undercut.target.ruleId が実在し、target.via が対象ルールの {any} に含まれるか
     - conflicts / superiority が実在する claim / rule を指すか
     - verdict_map の結論リテラルが宣言され、かつ規則の head として導出可能か
     - obligations の trigger_claim が verdict_map の結論を指すか、role が input か
     - すべての backing が 10_source_nodes の id に解決するか
     - derived リテラルの derivation が strict ルール id を指すか
   使い方:
     node tools/lint.js                 # packs/ 配下を全てリント
     node tools/lint.js packs/gdpr_art35 # 個別パック
     node tools/lint.js --facts          # cases/ の facts もリント
     node tools/lint.js --strict         # 警告もエラー扱い（exit 1）
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
function loadJSON(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }
function exists(p) { return fs.existsSync(p); }

function bodyLiterals(body) {
  const out = [];
  for (const it of body || []) {
    if (typeof it === "string") out.push(it);
    else if (it && Array.isArray(it.any)) it.any.forEach(l => out.push(l));
  }
  return out;
}

function lintPack(dir) {
  const R = { dir, errors: [], warnings: [] };
  const err = m => R.errors.push(m);
  const warn = m => R.warnings.push(m);

  const p30 = path.join(dir, "30_rulepack.json");
  if (!exists(p30)) { err(`30_rulepack.json が無い`); return R; }

  let rb, lit = null, src = null;
  try { rb = loadJSON(p30); } catch (e) { err(`30_rulepack.json パース失敗: ${e.message}`); return R; }
  const p20 = path.join(dir, "20_literals.json");
  const p10 = path.join(dir, "10_source_nodes.json");
  if (exists(p20)) { try { lit = loadJSON(p20); } catch (e) { err(`20_literals.json パース失敗: ${e.message}`); } }
  else warn(`20_literals.json なし: リテラル参照は未検証`);
  if (exists(p10)) { try { src = loadJSON(p10); } catch (e) { err(`10_source_nodes.json パース失敗: ${e.message}`); } }
  else warn(`10_source_nodes.json なし: backing は未検証`);

  // ---- インデックス構築 ----
  const sourceIds = new Set((src && src.nodes || []).map(n => n.id));
  const litById = {};
  (lit && lit.literals || []).forEach(l => { litById[l.id] = l; });
  const litIds = new Set(Object.keys(litById));
  const inputLits = new Set(Object.values(litById).filter(l => l.kind === "input").map(l => l.id));
  const conclLits = new Set(Object.values(litById).filter(l => l.kind === "conclusion").map(l => l.id));

  const allRules = [...(rb.strict || []), ...(rb.defeasible || []), ...(rb.undercut || [])];
  const ruleById = {};
  const seenRule = new Set();
  for (const r of allRules) {
    if (!r.id) { err(`id の無いルールがある`); continue; }
    if (seenRule.has(r.id)) err(`rule id が重複: ${r.id}`);
    seenRule.add(r.id);
    ruleById[r.id] = r;
  }
  const headSet = new Set([...(rb.strict || []), ...(rb.defeasible || [])].map(r => r.head));

  const checkLit = (id, where) => {
    if (!lit) return;
    if (!litIds.has(id)) warn(`${where}: リテラル '${id}' が 20_literals に未宣言`);
  };
  const checkBacking = (arr, where) => {
    if (!src || !arr) return;
    for (const b of arr) if (!sourceIds.has(b)) err(`${where}: backing '${b}' が 10_source_nodes に無い`);
  };

  // ---- 30 構造 ----
  if (!rb.id) err(`30: id が無い`);
  if (!rb.version) warn(`30: version が無い`);
  const vm = rb.verdict_map;
  if (!vm) err(`30: verdict_map が無い`);
  else {
    if (!vm.labels || !vm.labels.positive || !vm.labels.negative || !vm.labels.undetermined)
      err(`30: verdict_map.labels に positive/negative/undetermined が必要`);
    const conclFromVM = [...(vm.positive || []), ...(vm.negative || []), ...(vm.classes || [])];
    for (const c of conclFromVM) {
      checkLit(c, "verdict_map");
      if (lit && litById[c] && litById[c].kind !== "conclusion")
        warn(`verdict_map: '${c}' は kind=${litById[c].kind}（conclusion 推奨）`);
      if (!headSet.has(c)) warn(`verdict_map: 結論 '${c}' を head に持つ規則が無い（導出不能）`);
    }
  }

  // ---- 規則の body/head/backing ----
  for (const r of [...(rb.strict || []), ...(rb.defeasible || [])]) {
    bodyLiterals(r.body).forEach(l => checkLit(l, `rule ${r.id} body`));
    if (r.head) checkLit(r.head, `rule ${r.id} head`);
    if (!r.ref) warn(`rule ${r.id}: ref（人可読の引用）が無い`);
    checkBacking(r.backing, `rule ${r.id}`);
  }

  // ---- undercut ----
  for (const u of rb.undercut || []) {
    bodyLiterals(u.body).forEach(l => checkLit(l, `undercut ${u.id} body`));
    checkBacking(u.backing, `undercut ${u.id}`);
    const t = u.target || {};
    if (!t.ruleId) { err(`undercut ${u.id}: target.ruleId が無い`); continue; }
    const tr = ruleById[t.ruleId];
    if (!tr) { err(`undercut ${u.id}: target.ruleId '${t.ruleId}' が実在しない`); continue; }
    if (t.via) {
      const anyOpts = new Set();
      bodyLiterals(tr.body); // ensure parse
      for (const it of tr.body || []) if (it && Array.isArray(it.any)) it.any.forEach(o => anyOpts.add(o));
      if (!anyOpts.has(t.via)) err(`undercut ${u.id}: target.via '${t.via}' が対象ルール ${t.ruleId} の {any} に無い`);
    }
  }

  // ---- conflicts ----
  for (const pair of rb.conflicts || []) {
    for (const claim of pair) {
      if (!headSet.has(claim))
        warn(`conflicts: claim '${claim}' を head に持つ規則が無い`);
    }
  }
  // ---- superiority ----
  for (const pair of rb.superiority || []) {
    for (const rid of pair) if (!ruleById[rid]) err(`superiority: rule '${rid}' が実在しない`);
  }

  // ---- derived リテラルの derivation ----
  for (const l of Object.values(litById)) {
    if (l.kind === "derived") {
      if (!l.derivation) warn(`literal ${l.id}: derived だが derivation（strict ルール id）が無い`);
      else if (!(rb.strict || []).some(r => r.id === l.derivation))
        err(`literal ${l.id}: derivation '${l.derivation}' が strict ルールに無い`);
    }
    checkBacking(l.backing, `literal ${l.id}`);
  }

  // ---- obligations ----
  const vmConcl = new Set([...((vm && vm.positive) || []), ...((vm && vm.negative) || []), ...((vm && vm.classes) || [])]);
  const seenObl = new Set();
  for (const o of rb.obligations || []) {
    if (!o.id) { err(`obligations: id の無い義務がある`); continue; }
    if (seenObl.has(o.id)) err(`obligations: id 重複 ${o.id}`);
    seenObl.add(o.id);
    if (!o.label) warn(`obligation ${o.id}: label が無い`);
    if (!o.ref) warn(`obligation ${o.id}: ref が無い`);
    if (o.trigger_claim) {
      if (!vmConcl.has(o.trigger_claim))
        err(`obligation ${o.id}: trigger_claim '${o.trigger_claim}' が verdict_map の結論に無い（発火しない）`);
    } else if (o.trigger && o.trigger !== "positive") {
      err(`obligation ${o.id}: trigger '${o.trigger}' は未対応（"positive" か trigger_claim）`);
    }
    if (o.role && lit && !inputLits.has(o.role))
      warn(`obligation ${o.id}: role '${o.role}' が input リテラルでない`);
    checkBacking(o.backing, `obligation ${o.id}`);
  }

  // ---- 10 の親子参照 ----
  if (src) {
    for (const n of src.nodes || []) {
      if (n.parent_id && !sourceIds.has(n.parent_id))
        err(`10: node '${n.id}' の parent_id '${n.parent_id}' が無い`);
    }
  }

  return R;
}

function lintFactsFile(file, packsById) {
  const R = { dir: file, errors: [], warnings: [] };
  let fc;
  try { fc = loadJSON(file); } catch (e) { R.errors.push(`パース失敗: ${e.message}`); return R; }
  const facts = fc.facts || fc;
  let pack = null;
  if (fc.rulepack_ref) {
    const id = String(fc.rulepack_ref).split("@")[0];
    pack = packsById[id];
    if (!pack) R.warnings.push(`rulepack_ref '${fc.rulepack_ref}' に対応するパックが見つからない`);
  }
  const inputLits = pack ? new Set(Object.values(pack.litById).filter(l => l.kind === "input").map(l => l.id)) : null;
  for (const [k, v] of Object.entries(facts)) {
    if (inputLits && !inputLits.has(k)) R.warnings.push(`fact '${k}' が input リテラルに無い`);
    if (v && v.confidence && !["confirmed", "presumed", "unknown"].includes(v.confidence))
      R.errors.push(`fact '${k}': confidence '${v.confidence}' が不正`);
  }
  return R;
}

function buildLitIndex(dir) {
  const p20 = path.join(dir, "20_literals.json");
  const litById = {};
  if (exists(p20)) { try { (loadJSON(p20).literals || []).forEach(l => litById[l.id] = l); } catch (e) {} }
  const p30 = path.join(dir, "30_rulepack.json");
  let id = path.basename(dir);
  if (exists(p30)) { try { id = loadJSON(p30).id || id; } catch (e) {} }
  return { id, litById };
}

function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter(a => a.startsWith("--")));
  const pos = args.filter(a => !a.startsWith("--"));

  const packsDir = path.join(ROOT, "packs");
  let packDirs;
  if (pos.length) packDirs = pos.map(p => path.resolve(p));
  else packDirs = fs.readdirSync(packsDir).map(n => path.join(packsDir, n))
    .filter(d => fs.statSync(d).isDirectory() && exists(path.join(d, "30_rulepack.json")));

  const packsById = {};
  for (const d of packDirs) { const ix = buildLitIndex(d); packsById[ix.id] = ix; }

  console.log("=".repeat(64));
  console.log(" dac ルールパック整合性リンタ");
  console.log("=".repeat(64));

  let totalErr = 0, totalWarn = 0;
  const reports = [];
  for (const d of packDirs) reports.push(lintPack(d));

  if (flags.has("--facts")) {
    const casesDir = path.join(ROOT, "cases");
    if (exists(casesDir)) {
      for (const f of fs.readdirSync(casesDir).filter(f => f.endsWith(".json")))
        reports.push(lintFactsFile(path.join(casesDir, f), packsById));
    }
  }

  for (const R of reports) {
    const name = path.relative(ROOT, R.dir);
    const ok = R.errors.length === 0;
    console.log(`\n[${ok ? (R.warnings.length ? "WARN" : "OK") : "ERROR"}] ${name}`);
    for (const m of R.errors) console.log(`   ✗ ${m}`);
    for (const m of R.warnings) console.log(`   ⚠ ${m}`);
    totalErr += R.errors.length;
    totalWarn += R.warnings.length;
  }

  console.log("\n" + "-".repeat(64));
  console.log(`対象 ${reports.length} 件  /  エラー ${totalErr}  /  警告 ${totalWarn}`);
  const fail = totalErr > 0 || (flags.has("--strict") && totalWarn > 0);
  console.log(fail ? "✗ 問題あり。" : "✓ 整合性チェック合格。");
  process.exit(fail ? 1 : 0);
}

main();

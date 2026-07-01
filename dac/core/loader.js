/* ============================================================
   loader.js ── ルールパック/語彙/出典台帳の読み込みと参照解決
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

function loadJSON(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }

// packDir 配下の 10/20/30 を読み込む。10/20 は任意（無くても 30 で judge できる）。
function loadPack(packDir) {
  const rulepack = loadJSON(path.join(packDir, "30_rulepack.json"));
  let literals = { literals: [] };
  let sources = { nodes: [] };
  const litPath = path.join(packDir, "20_literals.json");
  const srcPath = path.join(packDir, "10_source_nodes.json");
  if (fs.existsSync(litPath)) literals = loadJSON(litPath);
  if (fs.existsSync(srcPath)) sources = loadJSON(srcPath);
  const sourceById = Object.fromEntries((sources.nodes || []).map(n => [n.id, n]));
  return { rulepack, literals, sources, sourceById };
}

// facts ファイルの読み込み（{case_id, facts:{...}} 形式 or 素の {lit:{value,...}}）
function loadFacts(p) {
  const raw = loadJSON(p);
  return raw.facts ? raw : { case_id: path.basename(p), facts: raw };
}

module.exports = { loadPack, loadFacts, loadJSON };

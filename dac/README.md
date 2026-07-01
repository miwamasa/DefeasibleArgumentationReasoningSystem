# dac ── 規制論証システム（Regulatory Argumentation System）

`instructions.md` の要請を実装したシステム。法規制を構造化テキスト＋論証ロジックとして
表し、対象システムの記述（事実）と突き合わせて論証を行い、

1. **該当するか**（判定 / verdict・四帯）、
2. **該当する場合に何をしないといけないか**（義務 / obligations）、
3. **条件が不足する場合に、追加条件で判定・義務がどう変わるか**（シミュレーション / simulation）

を生成する。推論基盤は `references/`（DAC v6 四帯理論 `L ⊆ DEF ⊆ U ⊆ A`）に基づく。
**エンジン・コアは規制非依存**で、規制固有性は `packs/<regulation>/` のデータに閉じる
（`references/DataModels.md`、SystemTheory A8）。

## ディレクトリ

```
dac/
  core/
    engine.js       推論コア（規制非依存）: judge(facts, rulepack) → 四帯裁定
    obligations.js  義務確定: 裁定 + rulepack.obligations → 適用/条件付き義務
    simulate.js     不足条件のシミュレーション（what-if + 総当りsweep）
    classify.js     統合ドライバ: judge + obligations + simulate
    loader.js       10/20/30 と facts の読み込み
  packs/
    eu_ai_act_art6/         EU AI Act 6(2)/Annex III（用途経路B・高リスク分類）パック
      10_source_nodes.json  出典台帳（L1。backing の戻り先）
      20_literals.json      リテラル辞書（語彙 + LLM 辞書）
      30_rulepack.json      ルールパック（規則 + ロジック + verdict_map + obligations）
    eu_ai_act_art6_1/       EU AI Act 6(1)/Annex I（安全コンポーネント経路A）パック
      10/20/30_*.json       安全機能∨故障危険=安全コンポーネント、自己評価免除と整合規格義務化による復権
    cra/                    EU Cyber Resilience Act（部分実装）パック
      10/20/30_*.json       適用範囲＋除外＋適合性評価ティア（4段階）＋製造者義務
    gdpr_art35/             GDPR Art 35 DPIA要否 + Art 36 事前協議 パック
      10/20/30_*.json       原則(35(1)/35(3))＋除外(35(5)/35(10))＋復権(35(10)但書/35(4))＋義務
  cases/
    40_facts.<case>.json    事案ごとの事実真偽表 Φ（構造化テキスト2）
  schemas/                  各データ形式の JSON Schema（10/20/30/40/90）
  tools/
    lint.js                 整合性リンタ（構造 + 参照整合チェック、ゼロ依存）
    extract_facts.js        LLM 事実認定ハーネス（自然文 → 40_facts.json）
    multi_classify.js       複数規制の同時判定（ルールパックの直和、§の末尾を参照）
  test/
    90_golden_cases.json    ゴールデンケース（判定 + 義務 + シミュレーション期待）
    validate.js             回帰ランナー
  cli.js                    CLI（人可読レポート / --json）
```

`instructions.md` の対応:

| instructions.md | 本システム |
|---|---|
| 法規制 → 構造化テキスト1(json) + 論証ロジック | `packs/.../10,20,30_*.json`（30 に規則・攻撃グラフ・義務） |
| 対象システムの記述 → 構造化テキスト2(json) | `cases/40_facts.<case>.json` |
| 論証を行い推論構造を作成・判定 | `core/engine.js`（grounded labeling + 四帯 + 論証ゲーム木） |
| 該当する場合の義務を明確化 | `core/obligations.js`（`30_rulepack.obligations`） |
| 条件不足時に追加条件で判定・義務がどう変わるかを例示・シミュレーション | `core/simulate.js` |

## 使い方

```bash
cd dac

# 1事案を判定（判定 + 義務 + シミュレーションを人可読で）
node cli.js packs/eu_ai_act_art6 cases/40_facts.credit_scoring.json

# シミュレーションを省く / JSON 出力
node cli.js packs/eu_ai_act_art6 cases/40_facts.cv_screening.json --no-sim
node cli.js packs/eu_ai_act_art6 cases/40_facts.cv_screening.json --json

# 回帰テスト
node test/validate.js

# 整合性リント（パックを書いたら/直したらまず実行）
node tools/lint.js                  # packs/ を全てリント
node tools/lint.js packs/gdpr_art35 # 個別パック
node tools/lint.js --facts          # cases/ の facts も検査
node tools/lint.js --strict         # 警告もエラー扱い（CI 向け）
```

## データ形式の検証（schemas/ と tools/lint.js）

新しい規制パックを書くときは、まず `tools/lint.js` を通す。リンタは2層でチェックする。

1. **構造チェック**：必須フィールド・列挙値（`schemas/*.schema.json` が形式の定義。ajv 等の
   JSON Schema 検証器にもそのまま渡せる）。
2. **参照整合チェック**（リンタ本体の価値）：手書きデータで壊れやすい箇所を起動前に検出する。
   - rule id の一意性、`undercut.target.ruleId` の実在と `via` が対象ルールの `{any}` に含まれるか
   - rule body / head のリテラルが `20_literals` に宣言されているか
   - `conflicts` / `superiority` が実在する claim / rule を指すか
   - `verdict_map` の結論リテラルが宣言され、かつ規則の head として導出可能か
   - `obligations.trigger_claim` が `verdict_map` の結論を指すか（指さないと発火しない）、`role` が input か
   - すべての `backing` が `10_source_nodes` の id に解決するか、derived の `derivation` が strict ルールか

エラーが出れば exit 1。`--strict` で警告もエラー扱いにできるので、CI に組み込める。

## β（立証責任方針）── 中間二帯をどちらに倒すか

`30_rulepack.policy_beta`（既定 `skeptical`）が、UNDEC（中間二帯）の肯定結論を verdict にどう反映するかを決める。
エンジンは常に三読み（懐疑 L / 擁護可 DEF / 反駁不能 U）を計算しており、β はそのどれを official な verdict に採るかの選択である（SystemTheory §1・§3、Duality §5）。

- `skeptical`（L基準）: 確定成立（IN）した肯定結論のみ採用。未決は UNDETERMINED として人間へ差し戻す。
- `defensible`（DEF基準）: 擁護可能な肯定結論があれば採用（予防原則寄り）。
- `credulous`（U基準）: 反駁不能な肯定結論があれば採用（最も該当を広く取る）。

CLI で一時上書きして読み比べできる:

```bash
node cli.js packs/gdpr_art35 cases/40_facts.gdpr_blacklist_vs_legalbasis.json --beta=skeptical   # UNDETERMINED
node cli.js packs/gdpr_art35 cases/40_facts.gdpr_blacklist_vs_legalbasis.json --beta=credulous   # DPIA_REQUIRED
```

規範衝突（ブラックリスト vs 法律免除）のケースは、β=skeptical では「決められない」、β=credulous/defensible では「DPIA必要」に倒れる。
どちらに倒すかは数学ではなく規範的選択であり、β としてただ一箇所に局在している（A6）。

## LLM 事実認定（自然文 → 40_facts）

`tools/extract_facts.js` は、`20_literals` の `llm_prompt` を使って、自然言語の事案記述から事実真偽表を生成する
（ニューロ・シンボリック分担の「事実認定＝LLM」側）。

```bash
# プロンプトの確認だけ（API 鍵不要）
node tools/extract_facts.js packs/gdpr_art35 --text="採用応募者を自動スコアリングするAI。特別カテゴリ不使用、EU域内数万人規模。" --dry-run

# 実行（要 ANTHROPIC_API_KEY。既定モデルは $ANTHROPIC_MODEL or claude-sonnet-4-6）
export ANTHROPIC_API_KEY=sk-...
node tools/extract_facts.js packs/gdpr_art35 case.txt --id=case_hr
# → cases/40_facts.case_hr.json を生成。続けて lint → 判定:
node tools/lint.js --facts && node cli.js packs/gdpr_art35 cases/40_facts.case_hr.json
```

LLM が返すのは input リテラルの真偽・信認・根拠だけで、結論や義務は作らない（役割分担の核）。
未知のリテラルは無視し、解釈の幅がある述語は `presumed` に倒すよう指示している。保存済み応答を使った
オフライン再処理は `--from-json=<file>`。プロキシ環境では `HTTPS_PROXY` を解する起動方法で実行すること。

## 複数規制の同時判定（ルールパックの直和）

`tools/multi_classify.js` は、1つの事案記述を**複数の規制パックに独立にかけ**、結果を1枚のレポートに統合する
（`SystemTheory.md` §7 が展望として挙げる「ルールパックの直和」の実装）。

```bash
node tools/multi_classify.js cases/40_facts.multi_smart_credit_device.json \
  packs/eu_ai_act_art6 packs/cra packs/gdpr_art35
```

統合が行うのは (1) 規制ごとの判定の並列表示 (2) 義務の合算 (3) 同一の `label.ja` を持つ義務を
**規制を跨いだ重複候補**として束ねること、の3点だけ。各パックの `judge()` は完全に独立に実行し、
規制間で攻撃関係（`conflicts`/`superiority`）は共有しない＝規制間の優先順位・抵触法的な調整は行わない。
「実質的に同一の義務か」の判断（翻訳管轄）は人間に残す、という設計。回帰は `test/validate_multi.js`。

### 出力の読み方

- **判定**: `verdict`（HIGH_RISK / NOT_HIGH_RISK / UNDETERMINED）と四帯
  `ESTABLISHED / DEFENSIBLE / NOT_DISPROVEN / EXCLUDED`、三読み（懐疑 L / 擁護可 DEF / 反駁不能 U）。
  不変条件 `L ⊆ DEF ⊆ U` は毎回自己検査される（`invariant_ok`）。
- **義務**: 高リスクに該当する場合の適用義務（各 `ref`/`backing` で原文に戻る）。
  役割（提供者/デプロイヤ）が未指定なら提供者と仮定して提示し、その仮定を明示する
  （`role_provider` / `role_deployer` を facts に与えると確定）。
- **シミュレーション**: 規則に関与するが未確定の入力条件を `open` として列挙し、
  (a) 1条件ずつ確定させた場合の判定・義務の変化（★=判定が変化）、
  (b) ピボタルな真偽条件の総当りを「結果クラス（判定×義務集合）」に圧縮して代表例を示す。

## 他規制への移植

`packs/<new_regulation>/` に `10/20/30` を新規作成するだけで、`core/` は不変のまま再利用できる。
`30_rulepack.verdict_map` で結論リテラル→verdict を、`obligations` で該当時の義務を外出しするため、
エンジンは規制内容を一切含まない（SystemTheory A8 / DataModels.md §8）。

### 例: CRA パック（多値分類のデモ）

`packs/cra/` は CRA（Regulation (EU) 2024/2847）の部分実装。AI Act の二値（高リスク/否）と違い、
**4段階の適合性評価ティア**を扱う:

- **適用範囲**: `in_scope`（デジタル要素を持つ製品＋データ接続）⇔ `out_of_scope`（MDR 等で適用除外）。
  除外は `superiority [rExcl, rScope]` で `in_scope` を rebut し、ティア各則を undercut で無効化する。
- **ティア（上位クラス優先＝lex specialis）**: `tier_default`（自己評価, Art 32(1)）＜ `tier_class_I`
  （Annex III(I)）＜ `tier_class_II`（第三者評価, Annex III(II)）＜ `tier_critical`（欧州認証, Annex IV）。
  これは `verdict_map.classes` で結論として扱い、`conflicts` + `superiority` で「複数該当時は最上位」を表す。
- **義務**: 全 in-scope 製品の基礎義務（必須要件・脆弱性処理/SBOM・技術文書・Art 14 報告・CE 等）は
  `trigger: "positive"`、適合性評価ルートはティア別に `trigger_claim`（例 `tier_class_II` → 第三者評価）。

```bash
node cli.js packs/cra cases/40_facts.cra_os_firewall.json --no-sim   # クラスII → 第三者評価
node cli.js packs/cra cases/40_facts.cra_excluded_medical.json --no-sim  # MDR で OUT_OF_SCOPE
node cli.js packs/cra cases/40_facts.cra_iot_uncertain.json          # 不足条件→ティアが割れる様子をシミュレーション
```

多値分類のためにコアに加えた一般化は `verdict_map.classes`（verdict には効かないが結論として扱う
分類リテラル）と、義務の `trigger_claim`（特定結論が IN のとき適用）の2点のみ。AI Act パックは無改変で動く。

### 例: GDPR Art 35 パック（復権と真の規範衝突のデモ）

`packs/gdpr_art35/` は GDPR Art 35（DPIA 要否）＋ Art 36（事前協議）の実装。**例外と例外の例外（復権）**が
最も綺麗に出る規制で、四帯（特に UNDETERMINED/DEFENSIBLE）の実例にもなる:

- **原則**: 35(3)(a)-(c) の特定類型・35(1) 一般条項（WP248 の9基準）・35(4) 監督機関ブラックリスト → `dpia_required`。
- **除外**: 35(5) ホワイトリスト・35(10) 法的根拠＋立法段階での実施 → `dpia_not_required`（`superiority` で原則を rebut）。
- **例外の例外（復権）**:
  - 35(10) 但書「加盟国が必要と判断する場合」= `ms_deems_necessary` が **undercut** で免除規則を無効化し DPIA を復権（深さ2）。
  - 35(4) ブラックリストは `superiority [r35_4, r35_5]` でホワイトリストに優越し DPIA を復権。
- **真の規範衝突**: ブラックリスト(35(4)) と法的根拠免除(35(10)) は優劣を付けていないため、両立時は
  相互 rebut で **UNDETERMINED**（四帯では両結論が `DEFENSIBLE`）＝「責任配分 β と人間判断に委ねる論点」を計算して申告する。
- **義務**: DPIA 実施(35(1))・最低限の内容(35(7))・DPO 助言(35(2)) は `trigger: "positive"`、
  事前協議(36(1)) は残存高リスク → `prior_consultation_required` を経て `trigger_claim` で適用。

```bash
node cli.js packs/gdpr_art35 cases/40_facts.gdpr_credit_profiling.json --no-sim       # 35(3)(a) → DPIA必要 + 事前協議
node cli.js packs/gdpr_art35 cases/40_facts.gdpr_legalbasis_msdeems.json --no-sim      # 35(10)免除を但書が復権
node cli.js packs/gdpr_art35 cases/40_facts.gdpr_blacklist_vs_legalbasis.json --no-sim # 真の規範衝突 → UNDETERMINED
node cli.js packs/gdpr_art35 cases/40_facts.gdpr_uncertain.json                        # 不足条件 → 要否をシミュレーション
```

### 例: EU AI Act 6(1) パック（Annex I 安全コンポーネント経路、ガイドライン準拠）

`packs/eu_ai_act_art6_1/` は、欧州委員会のドラフト・ガイドライン（Article 6 分類、Annex I 章）を精読して
モデル化した Art 6(1)（経路A）パック。既存の `eu_ai_act_art6`（6(2)/Annex III の用途経路B）と対をなす。

- **安全コンポーネント（Art 3(14)）**は2シナリオの選言: `intended_safety_function`（意図目的が安全）∨
  `failure_endangers`（故障が健康・安全・財産を危険にさらす）を strict ルール `s_sc` で導出。
- **原則** `rHR`: Annex I 規制製品であって製品自体又は安全コンポーネントであるAIは高リスク。
- **例外** `rSelfExempt`: モジュールA（内部統制の自己評価）で足りるなら非該当と主張しうる（`superiority` で原則に優越）。
- **例外の例外（復権）**: `eThirdParty`（第三者評価が必要）／`eHarmonised`（モジュールAが整合規格の義務的適用を条件）が
  `rSelfExempt` を undercut。とくに `eHarmonised` はガイドライン para 56-59・玩具安全規則 Recital 15 の
  「整合規格適用でモジュールAにオプトアウトできても高リスク分類は維持」を**復権**として実装している。

事案はすべてガイドラインの具体例に対応:

```bash
node cli.js packs/eu_ai_act_art6_1 cases/40_facts.a61_machinery_safe_stop.json --no-sim      # 安全機能 → 高リスク
node cli.js packs/eu_ai_act_art6_1 cases/40_facts.a61_lift_door.json --no-sim                # 故障危険 → 高リスク
node cli.js packs/eu_ai_act_art6_1 cases/40_facts.a61_smart_thermostat.json --no-sim         # 安全コンポーネントでない → 非該当
node cli.js packs/eu_ai_act_art6_1 cases/40_facts.a61_toy_module_a_harmonised.json --no-sim  # 整合規格義務化で復権 → 高リスク(para 59)
node cli.js packs/eu_ai_act_art6_1 cases/40_facts.a61_red_self_assessment.json --no-sim      # 自己評価で足りる → 非該当
```

## 理論的背景

`references/Theory/*`（Theory / Duality / SystemTheory）と `references/v6example/DAC_v6_textbook.md`、
データ形式は `references/DataModels.md` を参照。`core/engine.js` は
`references/implementation/engine.js` を規制非依存化（`verdict_map` による結論判定の外部化、
不変条件のランタイム自己検査）したもの。

# #12878 生成 SQL 标识符引号统一（复制提取器补齐 + 主开关联动 + 数据视图 SELECT）— 认领/PR 工作文档

- Issue: https://github.com/t8y2/dbx/issues/12878 （Feature：默认的 sql 生成表字段能不能不带双引号；报告者 hyy993840266，Oracle，v0.6.49）
- 认领：https://github.com/t8y2/dbx/issues/12878#issuecomment-6328695969 （/claim，dbx-bot 已 assignee Conastin，2026-10-22）
- 回复：https://github.com/t8y2/dbx/issues/12878#issuecomment-6328777475 （含临时方案 + 三层修复计划承诺，配图 2 张）
- 截图分支：fork `Conastin/dbx` `screens/issue-12878`（12878-copy-menu-path.png、12878-extractor-quote-checkbox.png、12878-editor-quote-identifiers.png）
- 分支：`fix/quote-identifiers-unify`（基于 upstream/main b160d1305，2026-10-22）
- 状态：**L1/L2/L3 已实现并全测试**；三个 commit：`fix(data-grid)` 复制提取器、`feat(sql-dialect)` 数据视图开关、`feat(desktop)` 前端联动

## 时间线

- 10-20 报告者提 issue（要开关）→ 我方引导回复（指路编辑器开关，当时判断"现有功能已覆盖"——**不完整**）
- 10-21 报告者反驳：关了开关后复制的 INSERT 和底部 SQL 预览仍全引号（3 张截图）
- 10-22 我方复现核实（查询 tab 复现不出 ≠ 不存在问题，入口在数据视图）；/claim + 回复

## 现状结论（全部已对代码核实，非推测）

两个开关、四类生成面，只有一个交集：

| 生成面 | 编辑器主开关 `generateSqlQuoteIdentifiers` | 复制开关 `dataGridExtractorOptions.sql.quoteIdentifiers` |
|---|---|---|
| 新建查询 / DDL 展示 / 编辑器补全 | ✓（newQueryContext.ts / queryStore.ts:3448 / useQueryEditorCompletion.ts） | 不涉及 |
| 复制 INSERT / DELETEs-INSERTs | ✗ 不读 | ✓ |
| 复制 UPDATE / WHERE / SELECT | ✗ 不读 | ✗（漏适配 bug） |
| 数据视图加载 SELECT（状态栏「当前页 SQL」） | ✗ 不读 | ✗ 不读（无任何开关） |

### 复制提取器覆盖明细（crates/dbx-sql-data/src/data_grid_extractors/sql.rs，Oracle 视角）

- **INSERT** ✓ ：90-100 unquote 闭包（d4b4cf827，2026-10-03，**已在 v0.6.49**）
- **DELETEs/INSERTs** 半适配：表名 ：319-327 ✓、INSERT 半边 ：283-293 ✓（f382082c7，10-17，已在 v0.6.49）；**DELETE 的 WHERE 谓词 ✗** ：344-348 用 `quote=None` 想去引号，但 `quote_table_data_identifier(Oracle, name, None)` 经 `uses_connection_identifier_quote`=false 分支 fallback 到 `quote_table_identifier` → 仍输出 `"ID" = 1`。`quote=None` 手法只对 Kingbase/JDBC/Spanner/Kyuubi/Informix/Gauss/PG 系有效（见 table_select.rs:682 `uses_connection_identifier_quote`），对 Oracle、MySQL 反引号族无效
- **UPDATE** ✗ ：194-202 `build_data_grid_copy_update_statements` 无 formatter/unquote 钩子（对比 INSERT 有 `_with_formatters` 变体）
- **WHERE 条件** ✗ ：595-602 直接透传 `identifier_quote`，不判断开关
- **SELECT** ✗ ：表名 ：640-648 不 unquote；谓词两条路（cells → 658 复用 write_where_clause；单行 → 708-715）都不判断

安全 unquote 判定逻辑现成：`data_grid_extractors/sql_identifiers.rs` 的 `can_unquote`（Oracle：全大写 + `[A-Z0-9_$#]` + 非保留字才剥；另有 Dameng / PG 系 / MySQL 系分支），INSERT 路径已用。

### 数据视图加载 SELECT：无开关，恒引号

- `TableDataSelectSqlOptions`（dbx-sql-dialect/src/sql_dialect/types.rs:21）**没有 quote_identifiers 字段**
- 投影 table_select.rs:160-164 无条件 `quote_table_data_identifier`；Oracle 走 `quote_table_identifier` catch-all 臂 → 恒 `"COL"`；表名 `table_data_qualified_table_name` 同样恒引号
- 探针实证（当前 main，2026-10-22，`build_table_data_select_sql` Oracle+schema+列清单）：
  `SELECT "ID", "API_TYPE", "SYSTEM_FROM" FROM (SELECT "ID", "API_TYPE", "SYSTEM_FROM" FROM "GSPUSH"."SP_EC_API_LOG") WHERE ROWNUM <= 100`
- 前端调用点均不传（TS 侧 `BuildTableSelectSqlOptions.quoteIdentifiers` 声明了但没人给）：useSidebarDataOpenRuntime.ts:407（首开）、useDataGridActions.ts:129（翻页/刷新重建）、DataGrid.vue:9098（syncUserFacingSql 状态栏重建）
- 状态栏机制（DataGrid.vue:9062-9119，`showDataGridStatusSql` 默认开）：**查询 tab** 的 userFacingSql = 执行语句原文回显（9080-9084，非 table-data 上下文不重建）→ 用户写什么显示什么，复现不出；**数据 tab** 才显示生成的 SELECT。报告者截图里 `WHERE (id > 1058)` 是筛选栏手写条件原样注入、`ORDER BY "ID"` 是点列头生成——与该机制吻合
- **复现入口：侧边栏 Oracle 表 → 点「数据」→ 底部状态栏「当前页 SQL」**

### 报告者两个痛点的根因

1. 复制 INSERT 带引号：INSERT 本身已适配复制开关，但他关的是**编辑器主开关**——复制路径根本不读它（两套开关互不相通 + 复制开关藏得深）
2. 底部 SQL 预览带引号：数据视图生成 SELECT 无任何开关（见上）

### 未承诺项（待实现时决策，未写进 issue 回复）

- 网格编辑的**保存/回滚语句预览**（openSqlPreview 面板 + prepareDataGridSave 路径，data_grid_sql.rs 同样无引号选项恒引号）：同类缺口，是否并入本 PR 待定（并入则三层变四层；不并入可留后续 issue）

## 实现记录（2026-10-22，与上面计划的偏差与落地细节）

### 落地与计划的差异

- **can_unquote 家族搬到 `dbx-sql-dialect/src/sql_dialect/identifier_unquote.rs`**（`pub fn can_unquote_identifier`），dbx-sql-data 的 tokenize 版 `unquote_optional_identifiers` 改为消费它（单一真相源，L1/L3 共用；零新依赖——tokenize 仍留 dbx-sql-data）
- dialect 侧新增 `unquote_qualified_table_reference`（引号外 `.` 分段 + 逐段 can_unquote；双写关闭符 `""`/```` `` ````/`]]` 视为转义保守保留）与 `projection_or_bare` helper（各构建点保留自己原引号路径作为闭包，避免改变 JDBC/Gauss 等方言的既有行为）
- L1 UPDATE 用 `_with_formatters` 变体（表名/SET 列/WHERE 谓词全过 formatter）；谓词走新增 `build_column_predicate_with_reference_formatter`（`_with_plain` 拆出 `_formatted` 内核，保存路径 3645 恒等不受影响）；四处复制面统一用 extractors/sql.rs 的 `sql_reference_formatter` helper（原来 INSERT 两处内联闭包也换成了它）
- **DELETE 谓词的 `quote=None` 手法废弃**（注释写明原因：Oracle/MySQL 引号路径从不读该参数）
- L3 投影构建点全部穿参：`quoted_table_columns_or_star`/`build_select_columns`/`build_sqlserver/db2/questdb_table_select_sql` 加 `(identifier_quote, quote_identifiers)`；大值预览 marker 别名**恒引号**（can_unquote 首字符规则天然挡住，测试钉住）；`build_table_select_sql`（TableSelectSqlOptions 入口）传恒 true
- **`TableDataSelectSqlOptions` 手写 `Default` impl**：derive 的 bool 默认 false 会把 dbx-core 的 `..Default::default()` 构造（agent_tools/csv_export/query）静默反转成剥引号——手写与 serde default 对齐为 true，这是本次最关键的隐性坑
- L2 落点比草稿更优：不只在 DataGrid.vue 两处，而是在 **`useDataGridExtractor.ts buildRequest`**（所有复制 extract 请求的唯一构造点，303-305 行 includeDatabaseName merge 先例旁）读主开关 merge，覆盖 export/insert 等全部路径
- L3 前端：7 处 `buildTableSelectSql` 调用点全部传开关（DataGrid.vue ×5：保存行刷新 4525/排序 7709/WHERE 7752/状态栏 9098/外键 lookup 13331 + useSidebarDataOpenRuntime 407 + useDataGridActions 129）；`queryColumnRef`（ORDER BY/结构化排序）与 `resolveTableDefaultSort`（默认排序）关时走 `quoteTableIdentifierIfNeeded`
- **不扩展 `shouldRebuildSql`**（状态栏重建条件保持 marker/includeDatabaseName）：保证「展示=实际执行」同一份，改开关后翻页/重开生效（与 includeDatabaseName 行为一致）
- 结构化筛选条件（buildDataGridContextFilterCondition，后端生成谓词）未接开关——超出承诺范围，报告者场景（手写 WHERE 原样注入）不受影响；后续 issue 可做
- 复制配置对话框：「表名和字段名加引号」勾选框从 inserts/deletes-inserts 专属块提到 `isSql` 公共区（UPDATE 也生效了）；主开关关闭时显示 `copyExtractorQuoteIdentifiersHint` 提示（组件用 `getActivePinia()` 守卫，无 pinia 的测试挂载不炸）
- i18n：`generateSqlQuoteIdentifiersDescription` 14 语言全量更新（覆盖复制/数据视图 SQL）；hint 新增 6 语言（其余走 en fallback）

### 测试与验证（全部通过，2026-10-22）

- Rust：dbx-sql-dialect 166（含 3 个新用例：Oracle 剥引号+大小写/保留字保留、PG marker 恒引号、serde default true 兼容旧 agent）；dbx-sql-data 684（含 4 个新用例：UPDATE/WHERE/SELECT/DELETEs-INSERTs 的 unquote 断言 + `insert_policies_do_not_change_other_extractors` 更新——SqlUpdates/WhereClause 从"不变"列表移出，这是**语义反转点**）；dbx-core lib 3450/3451（唯一失败 `secret_migration_running_state_resumes_after_reopen` 在 upstream/main 基线同样失败，预存环境问题）；dbx-web 177；clippy 0 警告
- 前端：vue-tsc ✓（本机需 `NODE_OPTIONS=--max-old-space-size=8192`，裸跑 OOM）；oxlint 58/61 ✓；vitest grid/composables/table 3000+ ✓（含新 spec：DataGridExtractorDialog #12878 联动 1 例、useDataGridExtractor.quoteIdentifiers 4 例）
- **本机环境坑（复用）**：`cargo test -p dbx-core` 必须带 `RUST_MIN_STACK=8388608`（栈溢出）；全 workspace 并行测试会把 Windows 页面文件打爆（os error 1455 → rlib mmap 失败 → 连锁 ICE 假象）——限 `-j 2` 分 crate 跑
- **真机（Oracle 11.2 MESPRD.API_REQUEST_RESPONSE，无 PK 基表 ROWID 路径）**：CDP + `__TAURI_INTERNALS__.invoke('save_editor_settings')` 关主开关（**localStorage 只是 legacy 迁移源，设置真身在 Tauri 后端命令**；`window.__TAURI__` 未暴露、CDP replMode 会吞 async 返回值）：
  - before：`SELECT "__DBX_ROWID", "REQUEST_ID", … FROM (SELECT ROWIDTOCHAR(t.ROWID) AS "__DBX_ROWID", t.* FROM "MESPRD"."API_REQUEST_RESPONSE" t) WHERE ROWNUM <= 100`
  - after：`SELECT "__DBX_ROWID", REQUEST_ID, … FROM (SELECT ROWIDTOCHAR(t.ROWID) AS "__DBX_ROWID", t.* FROM MESPRD.API_REQUEST_RESPONSE t WHERE (COST_MS > 0)) WHERE ROWNUM <= 100` —— 普通列/表名全裸、**`__DBX_ROWID` 机制列保引号**、无引号 SQL 真机执行成功（语义等价验证）；截图 issue-assets/12878-after-status-sql.png（脱敏后可入 PR）
  - 注意：数据 tab「刷新」按钮**重放旧 SQL**（既有语义，emit("reload", props.sql)），验证开关须走 WHERE 应用/翻页/重开表等重建路径
  - 验证完已恢复本机设置（开关 true、移除注入的 legacy localStorage key）

## Review 轮（2026-10-23，t8y2 CHANGES_REQUESTED，已全部处理）

Review 肯定方向与测试覆盖，提三点 + 两条流程（全按其建议第二选项修复，commit `7bb364bbb fix(sql-dialect): bound execution-surface unquoting to verified dialects`）：

1. **（medium）兜底分支保留字表不按方言**：`mysql_reserved` 是 PG∪MySQL 合并表，数据视图 SELECT 是首次把剥引号用于"被执行 SQL"——SQL Server 列名 `TOP`/`PERCENT` 不在表里会直接语法错误。**修法（选 review 的选项二）**：新增 `dialect_supports_unquoted_execution`（Oracle/OceanbaseOracle/Dameng/Postgres/Gaussdb/OpenGauss/Kingbase/Jdbc/Mysql 白名单），`build_table_data_select_sql_with_database` 入口对白名单外方言把 `quote_identifiers` 压回 true——一处收口覆盖表名/投影/子构建器/大值预览全部路径；第 2 点（Db2 折叠大小写）随之自动解决。**为什么不补保留字表**（用户问过）：保留字只是兜底分支三件套（字符集+折叠+保留字）之一，补表救不了折叠洞；兜底分支服务十几个方言，没有 SQL Server/Db2 真机，抄错=静默生产事故；兜底分支原设计就是合并保守（宁可多引号）。新方言加入路径：在 `can_unquote_identifier` 长出已验证专属分支 + 进白名单。
2. **（low）Db2 折叠**：随①自动解决（Db2 不在白名单）。
3. **（low）marker 注释失实 + 纵深防御**：`can_unquote_identifier` 开头显式排除 `__DBX_` 前缀（新常量 `types::DBX_IDENTIFIER_PREFIX`；此前只有大小写折叠分支恰好拒绝小写 marker，MySQL 族兜底分支会放过）；修正 `table_select.rs` marker 注释。

测试：dialect 新增 3 用例（SqlServer `[TOP]`/Db2 offset 页 `"MyCol"` 保引号、MySQL 大值预览白名单内剥+marker 反引号、`__DBX_` 前缀全方言 false）→ 169 全过；data 694 全过；clippy 仅剩 upstream bd469c49f（MariaDB UUID chunks_exact）自带警告，非本 PR。

流程：rebase 至 upstream/main 29722c2f2（落后 65 commit；唯一冲突在 useSidebarDataOpenRuntime——upstream #12647 引入 `buildOpenSql(withRowId)` 工厂，合并=保留工厂+插入 quoteIdentifiers 行）；i18n bot 曾直接 push `41fef7f08`（rebase 自动带上）；`--force-with-lease` 推送；新 head CI 已排队（agent-checks/frontend 全套）。惯例实证（13073/13062/12917）：**用 commit 回应 review、不写解释性评论**，reviewer 会自行"跟进复审"；CI 误报才评论澄清（13014 先例）。PR 现 MERGEABLE，等跟进复审。

- **CI（head `80a95a63c`，2026-10-23）**：首轮 frontend-checks 红在 oxfmt——i18n bot 的 pt-BR autofill 内嵌双引号不合格式（`style(i18n)` commit 改单引号包裹修复；教训：push 前先本地跑 `pnpm exec oxfmt`）；修复后 CI 全套 50/50 job 全绿（含 agent-checks/frontend-test/windows-win7-bundle）。至此 review 三点 + rebase + exact-head CI 全部满足。另按用户要求发了逐点解释性评论（issuecomment-6363590448，说明选项二理由/`__DBX_` 纵深防御/rebase），当前 BLOCKED 仅因 CHANGES_REQUESTED 粘性——等 t8y2 跟进复审 Approve 即解（对照 13073/13062：修完 1h~15h 复审，但 #12249 证明轮次内也有 4 天长尾）。

## 修复方案（对 issue 已承诺的三层；落地情况见上面「实现记录」）

### L1 复制提取器补齐（bug fix）

- UPDATE：给 `build_data_grid_copy_update_statements` 加 reference formatter 钩子（对齐 INSERT 的 `_with_formatters` 模式），或调用侧逐标识符过 unquote——倾向前者，语义与 INSERT 一致
- WHERE / SELECT：谓词构建读 `quote_identifiers`，关时对标识符走 `unquote_optional_identifiers`；SELECT 表名同 ：319-327 现成手法
- DELETE 谓词：废弃 `quote=None` 手法，统一走 `unquote_optional_identifiers`（保留字自动保引号，Oracle/MySQL 也真正生效）
- `sql_identifiers.rs` 现为 `pub(super)`，需提升可见性（或搬到 dbx-sql-dialect 供 L3 共用）

### L2 主开关联动（设计：主开关为上界）

- 语义：编辑器开关关 → 所有生成面（含复制）一律不加引号；开 → 复制配置里的勾选仍可细调
- 实现倾向前端 merge：构造 extract 请求处（DataGrid.vue:9168 extractorOptions / :9395 sqlInsertExtractorOptions）把 `generateSqlQuoteIdentifiers && dataGridExtractorOptions.sql.quoteIdentifiers` 合并传入——一处改动，Rust 契约不动
- 复制配置对话框「表名和字段名加引号」加跟随提示文案（i18n 各语言）

### L3 数据视图 SELECT 接主开关

- `TableDataSelectSqlOptions` 加 `quote_identifiers`（`#[serde(default = ...)]` true，旧 agent 不认字段时保持现状，向后兼容）
- 构建处投影/表名在关时过 unquote；**内部机制列（`__DBX_LARGE_VALUE_BYTES_*` marker 别名）必须保持引号**——`can_unquote` Oracle 分支要求首字符大写，小写下划线开头的 marker 自动保留，客户端按列名匹配不断（加测试钉住此不变量）
- 前端三处调用点传 `settingsStore.editorSettings.generateSqlQuoteIdentifiers`
- 设置项说明文案更新：现文案「关闭后，新建查询中的表引用将不再使用数据库方言引号…」→ 覆盖复制 SQL 与数据视图 SQL（i18n 全量）

## 风险与注意

- **#13105（LOB 预览 PR）同改 table_select.rs**：本分支必须基于最新 upstream main；若 #13105 先合，rebase 时投影构建处冲突概率高（那边刚重构过 `build_large_value_preview_items`）
- 状态栏 SQL「展示 = 实际执行」同一份：剥引号后执行无引号版本，`can_unquote` 仅语义等价时剥，安全；**只用现成方言规则，不新写**
- 版本偏差：desktop ↔ 本地/远端 agent，新字段 serde default 兜底
- 测试面：dbx-sql-dialect cargo test（含新增 quote 开关用例 + marker 保持引号用例）+ dbx-sql-data 提取器用例（UPDATE/WHERE/SELECT 补 `quote_identifiers=false` 断言，现有 tests.rs:213-302 已有 INSERT 模式可仿）+ 前端 vitest + 本地 Oracle 真机（11.2/12.1，dbx-agent-oracle-local.exe）
- PR before/after 截图需脱敏（RapidOCR 定位），可走 screens/issue-12878 分支补

## 流程状态

- [x] /claim（6328695969，assignee 已生效）
- [x] issue 回复（6328777475，含临时方案截图与修复计划）
- [x] 分支 `fix/quote-identifiers-unify`（基于 upstream/main b160d1305）+ L1/L2/L3 实现 + 全测试
- [x] **PR #13118**（2026-10-22 提交，中文正文、Fixes #12878、含 Oracle 11g before/after；正文底稿 upstream-drafts/pr-12878.md）
- [x] Review 轮（2026-10-23）：t8y2 CHANGES_REQUESTED 三点全修（见「Review 轮」节）+ rebase 29722c2f2 + 新 head CI；待跟进复审
- [x] PR 链接已补回 issue（6330820948）
- [ ] 待 review；若需要 before/after 截图素材：after 原图 issue-assets/12878-after-status-sql.png（需脱敏后传 fork screens/issue-12878 分支再贴）

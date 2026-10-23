# #12877 Oracle 数据 tab LOB 预览（SQL 层截断 + 点开取全值）— PR 工作文档

- Issue: https://github.com/t8y2/dbx/issues/12877 （P0，Feature：打开含 CLOB/BLOB 的表加载慢，期望默认不加载、点开才显示）
- **PR：https://github.com/t8y2/dbx/pull/13105（2026-10-22 提交）**，正文中文（上游惯例：英文标题+中文正文，抽样 5 个近期 PR 确认），未附截图（生产数据 + ui-preview 自动录屏，reviewer 要求可补）
- 状态：已提交。提交前 rebase 到 b160d1305（上游推进 209 commit，其中 #12943 Oracle ROWNUM 导出等 5 个 commit 触及相关文件但无冲突），rebase 后回归：方言 168 全绿（上游新增 1 用例）+ 前端 172 全绿
- 分支：`fix/oracle-table-data-lob-preview`（基于 upstream/main cad6ccb0c）

## 路线决策（为什么是 SQL 截断而不是 deferLobs 占位符）

- deferLobs 占位符（`CASE ... '<CLOB>'` + 'D:1' marker）也可行且改动更小，但首屏只有一个占位文本、不知道 LOB 总大小；
- SQL 截断与 mysql/pg/db2 数据 tab 现有机制同族（LEFT/SUBSTR + marker 列 + 点开按主键取全值），首屏可见真实内容前 N 字节 + 总大小，UX 明显更好；
- 两条路线共用同一条"点开取全值"链路（marker 剥离 → large_value_cells → 按 PK/`__DBX_ROWID` 重取），不互斥。

## 已实现的改动

### 1. Rust 方言层 `crates/dbx-sql-dialect/src/sql_dialect/table_select.rs`

- `large_value_preview_kind` 加 Oracle 臂：CLOB/NCLOB → Text、BLOB → Binary；XMLTYPE/BFILE/LONG/对象列不匹配（无 SUBSTR 重载，保持现状）。
- 投影构建器重构为 `build_large_value_preview_items`（projection + alias 条目）：
  - Text：`DBMS_LOB.SUBSTR(col, N+1, 1) AS col`，marker `'T:N:' || DBMS_LOB.GETLENGTH(col)`（GETLENGTH 只读元数据；NULL LOB → marker NULL → 不登记大值单元格）；
  - Binary：`'0x' || RAWTOHEX(DBMS_LOB.SUBSTR(col, N+1, 1))`（客户端二进制截断要求 0x 前缀，db2 同款形态）；
  - **硬钳制**（跨版本一致的 SQL 上限，覆盖通用 8192 预算）：Text preview_size ≤ 999（amount 1000 字符 × 4 字节 UTF-8 = VARCHAR2 4000 字节）；Binary preview_size ≤ 1998（amount 1999 字节 ≤ RAW 2000，hex 3998 + "0x" ≤ 4000）。marker 记录钳制后的 preview_size，保住 +1 截断信号。
- Rownum 分页接线：oracle 预览时内层投影 = [ROWIDTOCHAR 前缀（无 PK 基表）] + 截断/marker 表达式，**外层投影按别名重选全部列 + marker 列**（旧代码外层是显式列名会丢 marker；offset>0 三层嵌套经 dbx_inner.* 透传）。
- 无主键基表链路闭合（已在代码里核实，非推测）：`editablePrimaryKeys`（tableEditing.ts:34）对 oracle 无 PK 基表合成 `[__DBX_ROWID]` → data tab meta → SQL 带 ROWIDTOCHAR → 点开取值白名单（useDataGridLargeValues.ts:598）已含 oracle，refetch SQL 同带 `__DBX_ROWID` 投影按同一标识匹配。视图无 PK → 自然不启用。

### 2. Go agent `agents/drivers/oracle-go/main.go`

- 新增 `deferLobsForQuery(sqlText, requested)`：SQL 已含 `__DBX_LARGE_VALUE_BYTES_` marker 列时**不启用 deferLobs**（两处调用点 ：4221 分页 / :4439 普通）。
- 原因：marker 剥离受 `table_data_preview` 门控（dbx-core mod.rs:400），该 flag 同时映射为 agent `deferLobs`（:1297/:1327）。若 deferLobs=true，agent 走"单星号穿透"路径（:4722-4724）会**跳过嵌套 value rewrite**——XMLTYPE→XMLSERIALIZE、SDO_GEOMETRY→WKT、opaque 对象列的转换全部丢失（opaque 列甚至 scan panic）。互斥后：截断 SQL 原样放行（`rewriteDirectOracleSelectSQL` 对 FROM 子查询 :4890 直接 not-ok；表达式投影不被 `parseOracleColumnSelectItem` 匹配），嵌套改写照常处理 XMLTYPE/几何/opaque 裸列，与现状完全一致。
- query tab 的 deferLobs（用户 SQL，无 marker）与 oceanbase-oracle 数据 tab 均不受影响。
- ⚠️→✅ Go 1.27.3 已装（C:\Program Files\Go\bin，不在 Git Bash 默认 PATH；**代理被墙需 `GOPROXY=https://goproxy.cn,direct`**）。`go test ./...` 全绿（含 `TestDeferLobsForQueryDefersToSQLPreviewMarkers`）、`go vet` 干净。OCI（thick）变体本地不可编译（CI 需 Instant Client SDK + MinGW），改动在 tag 无关的 main.go 共享路径，thin 构建已覆盖。

### 3. 前端 `apps/desktop/src/lib/dataGrid/dataGridLargeValues.ts`

- `supportsTableDataLargeValuePreview` 加 `oracle`（数据 tab 执行参数 queryStore.ts:8668-8674 自动带上 `tableDataPreview`，queryStore 本身零改动）。
- `canUseTableDataLargeValuePreview` 加 oracle LOB 门：表里存在 CLOB/NCLOB/BLOB 列才启用（无 LOB 的表 deferLobs 保持关闭，行为与现状一致）。
- `tableDataLargeValuePreviewOptions` oracle 分支按 **LOB 列精确计数**摊预算（mysql 式），宽表不会被 30 个标量列摊薄；预算公式 24MiB ÷ 行数 ÷ LOB 列数 ÷ 6 字节/字符，上限再被方言层 999/1998 钳制。

### 4. 前端 `apps/desktop/src/lib/table/tableSelectSql.ts`（真机测试发现的接线缺口，commit 47ff22f5a）

- `requiresEagerTableMetadataForDataOpen` 加入 `oracle`。原因：打开表时若列元数据未加载，数据 tab 会用**空列清单**生成 `SELECT * FROM (SELECT * FROM tab) WHERE ROWNUM <= n`，截断投影没有输入（Rust 侧 columns.is_empty() 正确 fail-closed）→ 首屏全量。mysql/pg 因同样原因早已在集合里。
- 关联事实（排查时确认）：数据 tab 工具栏"刷新"不重建 SQL——`DataGrid.vue:5204` reload 携带 `props.sql` 原文重跑；用元数据重建 SQL 的路径是**翻页/刷新走 `useDataGridActions.onReloadData → buildTableSql`**。测试时用"重开 tab"或翻页观察新 SQL。

### 5. marker 下标按结果集位置（真机日志发现的剥离失败，commit 535f850ef）

- 现象：调试日志显示结果 14 列（10 列 + `__DBX_ROWID` + 3 marker 未被剥离）。
- 根因：marker 名下标原用**表列下标**，无主键基表投影前有 `__DBX_ROWID` 占一位，而客户端剥离（dbx-core mod.rs `server_large_value_markers`）按**结果集位置**校验 `expected_source_index`——错位 → 整组拒识。
- 修复：`build_large_value_preview_items` 对 oracle rowid 场景 marker 下标 +offset(1)；新增 dbx-core 契约测试 `extracts_oracle_rowid_preview_markers_indexed_by_result_position`。

### 6. 恢复 tab 翻页等待元数据（commit 3cafb31a1）

- 现象：重启恢复的数据 tab 元数据为占位空值时翻页，`onReloadData` 只后台刷元数据不等 → 生成裸 `SELECT *` 偏移包装 SQL 并持久化到 tab。
- 修复：`!hasRealTableMetaColumns && requiresEagerTableMetadataForDataOpen(dbType)` 时 await `refreshDataTabTableMeta`（对齐打开语义）。顺手把 dameng 判断的内联表达式提为局部 `effectiveDbType`。

## 验证记录（2026-10-20）

- `cargo test -p dbx-sql-dialect`：167 全绿（含新增 5 个 oracle 用例：截断+marker 形态、小额预算、无 PK 合成键内外层投影、第二页三层嵌套 marker 透传、XMLTYPE/LONG 不截断）。
- `cargo check -p dbx-core --no-default-features`：通过（8 分钟，仅既有 warning；注意 openssl-sys 需 Strawberry Perl PATH）。
- 前端 vitest：dataGridLargeValues.spec.ts 18/18（含 oracle 预算/LOB 门用例）；相邻 4 个 spec（DataGridContextExtractor / dataGridSavedRowRefresh / queryStore.hiddenPrimaryKey / queryStore.tableDataRefresh）196/196。
- `pnpm check` 全量五件套：仅 `TableImportDialog.existingTarget.spec.ts` 1 例失败——**经 stash 干净基线复跑确认是本地 upstream/main 快照的既有失败**，与本改动无关（该 spec 不引用 dataGridLargeValues）。vue-tsc/oxlint 等其余件套通过。
- 提交：6 文件 +310/-20（未含 upstream-drafts）。

## 待办 / 风险

- [ ] 真机验证（用户本地 Oracle 11.2 + 12c 足够，无需版本矩阵——SUBSTR/GETLENGTH/RAWTOHEX 均为 8i 前古董 API；真正要覆盖的轴：thin vs OCI 构建、CLOB/NCLOB/BLOB × NULL/EMPTY_LOB、中文多字节、无 PK 基表点开取全值、翻页第 2 页起 marker）。
- [ ] BLOB 点开取全值走 refetch（agent deferLobs=false 路径，BLOB 全值序列化形态与现状一致，无需新代码，但真机确认一下 hex/0x 显示闭环）。
- [ ] marker preview_size 与 original_bytes 口径：CLOB 的 GETLENGTH 计**字符**（BLOB 计字节），网格尺寸显示是近似值——PR 描述里注明。
- [ ] 点开取全值无字节上限（按 PK 重取整值，与 pg/db2/mysql 现状一致）；32MB `TABLE_DATA_RESULT_MAX_BYTES` 在 agent 路径依旧空转（`agent_execute_query_params` 不发送）——PR 描述别写"获得 32MB 保护"。

## 端到端自测记录（2026-10-21 02:40-02:52，CDP 自动化 + 视觉确认）

通过 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223` 启动调试版 app，CDP 驱动 UI + 原生日志交叉验证（前端是 Vue 但无全局 WebSocket 的 node 沙箱限制 → 独立 node 脚本走 Bash 跑；截图经 CDN URL + 视觉模型判读）：

1. **恢复 tab 点"刷新"**（intent=undefined，正好走 3cafb31a1 的新等待分支）：原生日志证实执行的 SQL 含 `DBMS_LOB.SUBSTR/GETLENGTH/ROWIDTOCHAR`（169ms/100 行）✓
2. **底栏显示的 SQL 是简化版**（`SELECT * FROM (SELECT * FROM tab) WHERE ROWNUM <= 100`）——这**不是 bug**：`DataGrid.vue:9003 syncUserFacingSql` 既有机制，执行 SQL 含 marker 前缀时（`shouldRebuildSql:9007`）底栏故意重建不带预览投影的用户友好 SQL，mysql/pg/db2 一直如此，oracle 自动获益。此前"你贴的裸 SQL 是残留"的判断是错的，实为该机制的正常输出。
3. **首屏截图判读**：黄色横幅"当前表数据较大…只加载了部分长文本"出现（= 大值单元格登记成功 = marker 剥离成功）；列干净无 `__DBX_` 垃圾列。
4. **横向滚动后截图判读**：三个 CLOB 列均为截断预览（末尾 `...`），NULL 行正常显示 NULL（NULL LOB → marker NULL → 不登记，符合设计）。
5. **点"加载当前页完整文本"**：按钮进入加载态 → 横幅消失 → 原生日志新增 02:50:08 执行（150ms），refetch SQL 形态 `WHERE (((ROWIDTOCHAR(ROWID) = ...`（按 `__DBX_ROWID` 合成键回查，无主键路径闭环）→ 最终截图判读 CLOB 单元格显示完整长 JSON 文本。

结论：打开/截断显示/点开取全值（含无主键合成键路径）全链路真机验证通过。待用户补测：BLOB 列（0x hex）、含几何/XMLTYPE 列的表（需先导入本地 agent）、中文多字节。

## 提交前覆盖审计（2026-10-22，CDP + IPC 网络取证）

审计新发现并修复的问题：
1. **cargo fmt/clippy**：补折行 + `.then_some`（style commit 98fe90153）。
2. **reload 等待破坏上游保护语义**：初版对 mysql/pg 也等待元数据，撞上游 app-test "data reload executes before slow metadata refresh completes"（mysql 明确要求 reload 先执行、元数据后台补）→ 收窄为 oracle-only（commit aa8a6085b）。
3. **useNavigationTargets row-id 重查丢预览**（commit 987078d2e）：快速打开/Ctrl+点击表名路径在元数据落地后重建 SQL 带 `includeRowId` 但**漏传预览参数**，把首查的截断 SQL 替换成无截断版（TESTIMAGE 实测发现）。修复后重查保留预览。
4. 全部 buildTableSelectSql 调用点清点（10 处）：5 处带预览、3 处刻意不带（取全值 refetch/导出分页/limit-0 回退）、neo4j 专属、显示用简化重建。

真机矩阵结论（CDP + IPC postData 取证）：
- 无 PK + CLOB（API_REQUEST_RESPONSE）：✓ 全链路（截断/横幅/ROWID 回查全值/翻页）
- 无 PK + BLOB（TESTIMAGE）：✓（SUBSTR+RAWTOHEX 执行、单元格 `[0x1F 8B 08 ...] 2 KB` 徽标、rowid 重查修复后保预览）
- 有 PK + CLOB（IFSYNC_CLOUDCTRL_LOG）：✓（执行 SQL 1635 字符含 DBMS_LOB；banner 不出现是因为最新 200 行值全 <999 字符，属正常）
- 空表（SYS_FILE/SYS_LOG_ERR）：✓ 正常打开 0 行
- 门槛测试：方言 167、dbx-core 剥离 11、前端全套、useDataGridActions 63+19、go vet/test、clippy 0 新告警（dbx-core 33 条全在既有代码）、fmt clean

**与改动无关的既有失败**（PR 描述不必提，自己知悉）：TableImportDialog.existingTarget（基线复跑证实）；mcpReleaseSigning 35 例（调 macOS `security` 命令，Windows 必挂）。

**无法本地覆盖、需在 PR 描述如实说明**：NCLOB/XMLTYPE/SDO_GEOMETRY 实例（两环境均无此类型表；SQL 形态有单测）、OCI thick 变体（CI 编译）、OceanBase Oracle 模式（无实例；改动结构上不影响：方言臂仅 Oracle、agent 互斥仅对含 marker 的 SQL 生效）、Oracle 11/12 以外版本。

## 性能对比（2026-10-22，PR before/after 数据）

方法：同一 app（调试构建）、同一连接、同一时刻交错执行新旧形态 SQL（查询 tab 真实链路，`DBX.log` execute_multi elapsed_ms，各 2 轮）。对象：MESPRD.API_REQUEST_RESPONSE（issue 原表，74,798 行、3 CLOB）。新形态即 app 实际生成的 SQL（SUBSTR+GETLENGTH+marker，内层 ORDER BY CREATE_TIME DESC 与旧一致）。

**端到端耗时**：
| 投影 | 100 行页（数据 tab 默认页） | 1000 行窗口 |
|---|---|---|
| 旧（全量 CLOB `t.*`） | 78 / 88 ms（均值 83） | 189 / 239 ms |
| 新（DBMS_LOB.SUBSTR 截断） | 60 / 67 ms（均值 64，**↓23%**） | 95 / 99 ms（**↓约 2 倍**） |
| 下界参照（纯标量列） | 15 ms | — |

注：1000 行组 app 结果上限 100 行，差距主要来自服务端 LOB 读取放大——旧投影 Oracle 需读出全部 LOB 内容，新投影只读头部 999 字符；CLOB 越大、翻页越深差距越大。内网环境（172.27.x），广域网下传输量差异会进一步放大耗时差距。

**传输内容量**（最新 100 行，GETLENGTH 统计）：旧 533,738 字符 → 新 90,741 字符 = **17%**（RESPONSE_CONTENT 平均 ~4.7k 字符/行，471k→34k 是主要收益；REQ 列均值 2k 字符、多数在预览窗口内故降幅小）。

**极端场景**（旧行为"加载全部"必挂的量化依据）：全表 74,798 行 CLOB 总量 **332.7 MB**（REQ 149 + RESP 183.7）——旧行为需全量传输（issue 报告"有时候加载不出来"）；新行为每格 ≤999 字符 + 预算摊销，结构有界。

真实 app 会话记录（02:43-02:50）：恢复 tab 首屏 169ms / 翻页 89-171ms / 点开取全值 150ms。

## 本地 agent 导入 + 12c 复测（2026-10-22 收尾轮）

- **版本确认**：正式环境 = Oracle 11.2.0.4、测试环境 = Oracle 12.1.0.2（`v$version`）——PR 可写 "verified on 11.2 & 12.1"。
- **本地 agent 导入**：经 CDP 直调 `import_agent_driver_cmd`（需先 `disconnect_db` 断开全部 oracle 连接；路径用正斜杠）。导入后 `~/.dbx/agents/drivers/oracle/agent.exe` 哈希 = 本地构建（522d92cd…）✓。**注意：agents 目录为各 app 实例共享，下载版 v0.1.71 已被顶替——要恢复在驱动商店重新下载/升级即可。**
- **12c + 本地 agent**（MESUAT.SYS_LOG_USER_OPE，84 行、PK=PK_ID、单 CLOB）：打开 84 行全回、执行 SQL 含 SUBSTR+GETLENGTH（DBX.log）、无垃圾列、走 PK 路径（无 ROWIDTOCHAR）✓。测试环境 CLOB 数据全短（≤143 字符），长值视觉场景由 11g 覆盖。
- **11g + 本地 agent**（API_REQUEST_RESPONSE 长值全链路）：打开 100 行 + 横幅出现（= 截断执行 + marker 剥离 + 大值登记）→ 点"加载当前页完整文本" → 横幅消失（全文回载）→ 回查 SQL `ROWIDTOCHAR(ROWID)=…`（×9）✓ 无垃圾列。
- 至此 PR 全部本地验证闭环（含 agent 改动的端到端）。剩余不可本地覆盖项不变。

## Rebase 轮（2026-10-23）

- 动机：PR 提交（10-21）后 upstream main 前进 65+ commit，GitHub 报 CONFLICTING——**reviewer 队列实证（2026-10-23 调研）：当天新 PR 首 review 中位 3.4h，隔天存量 30+ 积压最老 7 天，且 t8y2 明确要求冲突分支先 rebase**（#13118 review 原话），冲突态 PR 不会被 pick。
- rebase 至 upstream/main 29722c2f2：**唯一文本冲突**在 oracle-go main.go `runPagedOracleSelect`——upstream 新增 retrySQL 首页重试机制 vs 我们的 `deferLobsForQuery` 互斥包装，二者正交，合并=保留 retrySQL 结构+第三参换 deferLobsForQuery；其余 5 commit 自动合并。
- 语义冲突排查靠测试兜底：dialect 168 / data 691 / core 契约（extracts_oracle_rowid_preview_markers）/ go test ./... / 前端 4 spec 115 / typecheck 全绿；gofmt/rustfmt/oxfmt 本地全过（注意：Windows 下 gofmt -l 报的三文件是 CRLF 行尾伪差异，--ignore-cr-at-eol 零内容差异，还原即可勿提交）。
- force-with-lease 推送 → MERGEABLE，但 CI 撞上 **GitHub Actions apt 时段性故障**（11:39–12:16 UTC 多个无关分支同挂 `Install system dependencies` 超时 exit 124，含 t8y2 自己的 claude/ 分支；#13209 正是在修 GTK 依赖安装）：第一轮 rust-test(drivers) 挂、推空 commit 重触发第二轮 rust-test 双挂（fork PR 无 re-run 权限）——**按 13014 先例发评论澄清 CI 失败非本分支引起**（issuecomment-6365284713）；12:27 起 peer 分支转绿 = 环境恢复，第三个空 commit 重触发 → **CI 全绿，PR 状态 CLEAN**（最终 head `9d288ef54`，空 commit 会被 squash merge 吸收无痕）。
- 结论：**冲突已解 + CI 绿 = 进入 reviewer 队列的合格态**，按队列规律（当天新 PR 中位 3.4h、隔天存量排队）等自然轮到即可。


## 三 PR 状态总览（2026-10-23 收盘，全部等待态、无需动作）

| PR | 状态 | 卡点 |
|---|---|---|
| #13118（引号开关） | 修复+CI 绿+逐点回复已发，BLOCKED=CHANGES_REQUESTED 粘性 | 等 t8y2 跟进复审 |
| #13105（LOB 预览，本文档） | **✅ 已合并（2026-10-23 15:36 UTC，squash b71823d784，随下版本发布；issue #12877 自动关闭）**——t8y2 APPROVED 逐项复述验证（SUBSTR 999+1 四字节安全/RAWTOHEX 4000/+1 截断信号/NULL 跳过/marker 穿两三层 ROWNUM/deferLobs 互斥/PK 全值回查），三条 non-blocking 备注（GETLENGTH 字符≠字节、empty_clob 预览成 NULL 与 NULL 不可区分、defer 前缀子串匹配属无害降级，均在 PR 描述口径预留范围内）；rebase+CI 绿（CLEAN）到被 pick 仅 ~3h | 完结 |
| #12249（InfluxQL 筛选） | 二审修复 4 天零三审（唯一轮次内长尾遗漏样本） | 等三审；用户定不 ping（上游无 ping 先例） |

维护者审阅规律（2026-10-23 实测 25 个 merged PR）：当天新 PR 首 review 中位 3.4h、APPROVED→merge 同分钟；隔天存量持续被插队。轮次内修复→复审 1h~15h，偶发 4 天+ 长尾。**fork PR 无 CI re-run 权限，环境故障时推空 commit 重触发（squash merge 下无痕）；CI 基础设施故障用评论澄清（13014 先例）。**

## PR 规范（CONTRIBUTING 摘要）

- 正文首行 `Fixes #12877`；模板段落：变更说明 / 变更类型 / 涉及前端 / 测试验证。
- 行为语义比报告人要求更实用：所有 CLOB/NCLOB/BLOB 列首屏显示前 N 字节 + 总大小，点开取全值（报告人原话"默认不加载、点开才显示"，截断满足且更好）。
- 触及 `apps/desktop/src/` 会自动触发 ui-preview workflow 录屏；PR 截图 before/after（打开 API_REQUEST_RESPONSE 数据 tab），脱敏走 RapidOCR 流程。

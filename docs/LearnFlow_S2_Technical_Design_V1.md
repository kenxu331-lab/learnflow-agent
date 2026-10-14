# LearnFlow S2 技术设计 V1.1

**状态：** 技术设计 V1.1，待审核后实现。  
**范围：** S2 Knowledge Extraction & Organization；不实现 RAG、Wiki、向量/图数据库、Obsidian 自动写入或 S3 Safe Write Engine。  
**基线：** 本文基于 2026-10-13 工作区的 S1、Document Engine 实现，以及《LearnFlow S2 开源项目源码研究与技术选型报告》。方案中的“应/拟”均为待实现设计；“现状”均为已核对的本地代码事实。

## 1. 目标、非目标与设计结论

S2 将一组已完成的学习问答变为**本章节内、可追溯、可核验的知识草稿**。它不把聊天摘要直接当作知识，不让 LLM 写 Vault，也不让 AI 自己宣告某条知识为可信。

目标：

- 从 `learning_events` 的有界批次中发现概念、陷阱、解释、例子和明确标注的用户理解。
- 建立不可伪造的本地 Evidence Registry：每条证据均由程序颁发 ID，并可回查至教程快照块、选区或具体消息。
- 以 Atomic Claim 为核验单位，产出 `supported`、`partially_supported`、`insufficient_evidence`、`not_supported` 或 `verification_unavailable`。
- 只在同一章节做精确、确定性的去重与版本协调；跨章节语义合并留给未来 RAG 阶段。
- 为 S3 输出稳定知识 ID、版本、证据、锚点、核验状态和发布资格，不实际写 Obsidian。

非目标：

- 不复用或引入 LangChain、LangGraph、Mem0、向量数据库、图数据库、Open Notebook、Research Assistant 或 Basic Memory 的运行时代码。
- 不把 `assistant` 消息作为学科事实的独立证据；它只可作为提炼上下文或解释来源。
- 不把一整段聊天记录作为 `KnowledgeItem.body`，不进行跨站全文语义去重。
- 不由 Extractor 或 Verifier 生成文件操作、路径或最终发布结果。

## 2. 已核对的本地基线与最小缺口

### 2.1 可直接复用

| 现有能力 | 本地路径 | S2 用途 |
|---|---|---|
| S1 对话、选区与事件持久化 | `backend/app/learning_memory/store.py` | 作为批次候选和消息/选区来源 |
| 对话约束 | `backend/app/schemas/study.py` | 复用 `sourceUrl`、`headingPath`、`sourceNodeId`、`sourceFingerprint` 契约 |
| DeepSeek JSON 调用 | `backend/app/llm/base.py`、`backend/app/llm/openai_compatible.py` | Extractor、独立 Verifier 的结构化调用 |
| 有界不可信上下文处理 | `backend/app/ai_notes/context.py` | 作为 S2 上下文截断与提示词安全模式的模板 |
| 规范化来源与章节身份 | `backend/app/notes/resolver.py` | 必须调用 `NoteResolver.resolve()`，统一生成 `document_id=note_id`、`chapter_id` |
| Document Engine 源块映射 | `backend/app/document_engine/models.py`、`normalizer.py` | 复用 `source_block_id`、`stable_key` 和规范化 URL 的概念，不重构 AST |
| Vault 冲突保护 | `backend/app/notes/service.py`、`vault.py` | S3 才调用；S2 只提供发布契约 |

### 2.2 S1 数据的边界

S1 当前已经保存 `conversations.context_json`、`messages`、`selections` 和 `learning_events`。但 `learning_events` 没有保存精确的 `user_message_id`、`assistant_message_id`、不可变 `source_snapshot_id` 或后端规范化 `chapter_id`。`conversations.context_json` 会随新的聊天请求更新，不能单独当作历史消息的不可变证据快照。

因此 S2-A 的最小改动不是修改采集或 Document Engine，而是在同一 SQLite 中新增不可变快照及事件关联表；新的 S1 事件在落盘时补写关联。旧事件可保留由 `learning_events.source_url` 导出的 `document_id/chapter_id` 作为查询范围，但消息 ID、选区 ID 和快照 ID 均为 `NULL`，`link_status=legacy_unlinked`；它们不得自动成为事实知识的证据或自动发布候选。

### 2.3 不可变 PageSnapshot 的实际获取与关联路径

已核对的当前路径如下：

```text
授权教程页面
  → captureTab() / 手动 PAGE_CAPTURE_REQUEST
  → extension study-service.recordSnapshot()
  → chrome.storage.local StudyState.snapshotsByChapter
  → Side Panel currentSnapshot
  → StudyChatPayload.snapshot
  → FastAPI StudyChatRequest（Pydantic 校验）
  → StudyChatService.start_stream()
  → 当前仅覆盖 conversations.context_json
```

S2-A 将在 `StudyChatService.start_stream()` 收到并校验 `StudyChatRequest.snapshot` 后，立即由 Source Snapshot Registrar 用**该请求中的快照**登记不可变 `source_snapshot_id`。Registrar 忽略客户端可选 `documentId`，只调用后端 `NoteResolver.resolve(snapshot.url, snapshot.title)` 导出 `document_id/chapter_id`；不得在事件完成后重新采集网页，也不得用同 URL 的最新网页版本替代历史快照。没有已验证 Vault 时，Registrar 可写入 Profile 的 `unbound` 捕获 scope 保留真实快照，但该 scope 永远不能持有 active extraction consent 或自动创建 Job。

Registrar 必须与聊天 Provider 调用解耦：快照登记异常只能记录本地诊断，不能让 `start_stream()` 拒绝普通聊天。聊天流正常完成时，服务在一个 SQLite 事务内写入 `learning_event + event_context(linked)`，其中关联已存在的用户/助手消息 ID 和本次 `source_snapshot_id`。消息流过程中的消息写入仍按 S1 原有策略进行；如果快照注册或最终关联失败，普通聊天回答仍须完成，事件以 `link_status=unlinked_runtime_error` 记录或留待恢复任务补链，且不进入自动提炼。来源关联故障不能变成用户聊天失败。

## 3. 最小模块架构与职责边界

```text
S1 conversations / messages / selections / learning_events
                         │
                         ▼
                 Source Snapshot Registrar（程序）
                         │  snapshot、block、事件关联均不可变
                         ▼
           Extraction Scheduler + Job Store（程序）
                         │  批次、同意、游标、租约、重试
                         ▼
         Knowledge Extractor（DeepSeek，仅 JSON 草稿）
                         │
                         ▼
      Evidence Registry / Resolver（程序，拒绝未知 ID）
                         │
                         ▼
 Claim Verifier（规则优先；S2-B 可独立 LLM 语义核验）
                         │
                         ▼
      Knowledge Organizer（程序，章节内精确幂等/版本）
                         │
                         ▼
 SQLite: knowledge item/version/claim/evidence/job
                         │
                         └── S3 Publish Contract（数据，不写 Vault）
```

| 模块 | 输入 | 输出 | 不可做的事 |
|---|---|---|---|
| Source Snapshot Registrar | S1 请求快照与事件 | `source_snapshots`、`source_blocks`、`event_contexts` | 不调用 LLM、不写 Vault |
| Extraction Scheduler | 已完成事件、独立授权 | 可恢复 `extraction_jobs` | 不在每轮对话内直接调用 LLM |
| Knowledge Extractor | 批次和允许的 Evidence Registry 视图 | 结构化候选和引用的 evidence ID | 不分配知识 ID、不设可信/发布状态 |
| Evidence Resolver | LLM 引用 ID、数据库 | 已解析/未解析证据关系 | 不猜测 block/message ID |
| Claim Verifier | Claim、真实证据摘录 | 核验草稿 | 不把 AI 消息当独立事实来源 |
| Knowledge Organizer | 已核验候选、同章节现有版本 | create/update/noop/needs_review | 不做跨章节语义合并、不写文件 |

建议的实现目录仅新增一个窄模块，不迁移 S1/Document Engine：

```text
backend/app/knowledge/
  schemas.py       # S2 Pydantic 契约；LLM Draft 与持久化 DTO 分离
  store.py         # SQLite 建表、事务、lease、cursor、version
  snapshots.py     # PageSnapshot 注册、source_blocks、selection 解析
  registry.py      # evidence allow-list 与 ID/哈希/章节校验
  extractor.py     # DeepSeek JSON Draft 调用与严格 Pydantic 校验
  verifier.py      # S2-A 规则核验；S2-B 独立语义核验
  organizer.py     # identity_key、exact no-op、保守版本策略
  scheduler.py     # 批次计划、同意检查、recovery、单 worker 领取
  errors.py        # 稳定错误码
backend/app/schemas/knowledge.py  # HTTP/UI 使用的窄 DTO（若 API 需要）
backend/app/api/knowledge.py      # S2 状态、手动整理、授权；不含 Vault 写入
```

对 S1 的代码改动仅限：在同一 SQLite 事务内让 `record_learning_event()` 返回/接收精确消息 ID，并调用 Snapshot Registrar 写入 `event_contexts`。对 Document Engine 的改动为零；S3 才消费它的源块概念和现有 Note Service。

## 4. 数据模型与 SQLite Schema

以下表与 S1 表并存，全部使用外键、UTC ISO 8601 时间和 `PRAGMA foreign_keys=ON`。正文/摘录哈希使用 UTF-8 SHA-256；JSON 字段必须由 Pydantic 模型读写，不接收任意 JSON。

### 4.1 来源快照、块与事件关联

```sql
CREATE TABLE knowledge_scopes (
  scope_id TEXT PRIMARY KEY,                 -- profile_id + vault_fingerprint 的稳定哈希
  profile_id TEXT NOT NULL,
  vault_fingerprint TEXT NOT NULL,           -- 不保存明文路径；'unbound' 仅用于不提炼的捕获
  created_at TEXT NOT NULL,
  UNIQUE (profile_id, vault_fingerprint)
);

CREATE TABLE source_snapshots (
  source_snapshot_id TEXT PRIMARY KEY,       -- snapshot-{sha256 canonical snapshot}
  scope_id TEXT NOT NULL REFERENCES knowledge_scopes(scope_id),
  document_id TEXT NOT NULL,                 -- NoteResolver.note_id
  chapter_id TEXT NOT NULL,                  -- NoteResolver.chapter_id
  source_url TEXT NOT NULL,                  -- normalize_source_url 后值
  snapshot_hash TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,               -- 完整校验后的 PageSnapshot
  created_at TEXT NOT NULL,
  UNIQUE (scope_id, snapshot_hash)
);

CREATE TABLE source_blocks (
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(source_snapshot_id),
  source_block_id TEXT NOT NULL,
  stable_key TEXT,
  block_type TEXT NOT NULL,
  block_ordinal INTEGER NOT NULL,
  heading_path_json TEXT NOT NULL,
  section_anchor_block_id TEXT,
  content_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (source_snapshot_id, source_block_id)
);
CREATE INDEX idx_source_blocks_stable_key
  ON source_blocks(source_snapshot_id, stable_key);

CREATE TABLE event_contexts (
  event_id TEXT PRIMARY KEY REFERENCES learning_events(event_id),
  scope_id TEXT NOT NULL REFERENCES knowledge_scopes(scope_id),
  user_message_id TEXT REFERENCES messages(message_id),
  assistant_message_id TEXT REFERENCES messages(message_id),
  source_snapshot_id TEXT REFERENCES source_snapshots(source_snapshot_id),
  document_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  link_status TEXT NOT NULL CHECK (link_status IN
    ('linked', 'legacy_unlinked', 'unlinked_runtime_error')),
  created_at TEXT NOT NULL,
  CHECK (
    (link_status = 'linked' AND user_message_id IS NOT NULL
      AND assistant_message_id IS NOT NULL AND source_snapshot_id IS NOT NULL)
    OR
    (link_status = 'legacy_unlinked' AND user_message_id IS NULL
      AND assistant_message_id IS NULL AND source_snapshot_id IS NULL)
    OR
    (link_status = 'unlinked_runtime_error' AND user_message_id IS NOT NULL
      AND assistant_message_id IS NOT NULL AND source_snapshot_id IS NULL)
  )
);
CREATE INDEX idx_event_contexts_scope_chapter
  ON event_contexts(scope_id, chapter_id, created_at);
```

当前两个采集器都把 `stableKey` 生成为 `v1-{内容签名哈希}-{同签名出现序号}`，所以**正常当前快照**中通常唯一；但 `PageSnapshot` Pydantic 契约没有强制它唯一，且旧/外部快照可以为空或重复。因此 S2 只为它建索引，不建立 `UNIQUE(source_snapshot_id, stable_key)`；Resolver 必须确认查询恰好返回一个块，才可将它用于精确锚点。

`source_node_id` 是 DOM 定位提示，不等于 `source_block_id`。选区文本可匹配当前快照中唯一块、并且哈希一致时，Resolver 生成 `source_block` 锚点。若跨多个块但所有匹配块属于同一唯一 `section_anchor_block_id`，降级为 `section` 锚点；若小节也无法唯一确定，则标记 `needs_review`，不生成自动发布资格。

### 4.2 Evidence Registry 与 Claim

```sql
CREATE TABLE evidence_records (
  evidence_id TEXT PRIMARY KEY,              -- ev-{uuid}，仅后端生成
  scope_id TEXT NOT NULL REFERENCES knowledge_scopes(scope_id),
  chapter_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN
    ('tutorial_block', 'selection', 'user_message', 'assistant_message')),
  source_snapshot_id TEXT REFERENCES source_snapshots(source_snapshot_id),
  source_block_id TEXT,
  stable_key TEXT,
  selection_id TEXT REFERENCES selections(selection_id),
  message_id TEXT REFERENCES messages(message_id),
  source_url TEXT,
  heading_path_json TEXT NOT NULL,
  source_fingerprint TEXT,
  evidence_natural_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  resolvable INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_evidence_scope_chapter
  ON evidence_records(scope_id, chapter_id, source_kind);
CREATE UNIQUE INDEX uq_evidence_natural_key
  ON evidence_records(scope_id, evidence_natural_key);
CREATE UNIQUE INDEX uq_evidence_scope_id
  ON evidence_records(scope_id, evidence_id);

CREATE TABLE knowledge_items (
  knowledge_id TEXT PRIMARY KEY,             -- ki-{uuid}，稳定逻辑身份
  scope_id TEXT NOT NULL REFERENCES knowledge_scopes(scope_id),
  document_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  identity_key TEXT NOT NULL,                 -- 章节 + 锚点 + kind + 规范化 topic
  anchor_kind TEXT NOT NULL CHECK (anchor_kind IN
    ('source_block', 'selection', 'section', 'unresolved')),
  anchor_snapshot_id TEXT REFERENCES source_snapshots(source_snapshot_id),
  anchor_block_id TEXT,
  anchor_stable_key TEXT,
  heading_path_json TEXT NOT NULL,
  anchor_fingerprint TEXT,
  kind TEXT NOT NULL CHECK (kind IN
    ('concept', 'pitfall', 'explanation', 'example', 'user_insight')),
  topic TEXT NOT NULL,
  active_version INTEGER NOT NULL,
  verification_status TEXT NOT NULL,
  publish_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scope_id, identity_key)
);

CREATE TABLE knowledge_versions (
  knowledge_id TEXT NOT NULL REFERENCES knowledge_items(knowledge_id),
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  evidence_set_hash TEXT NOT NULL,
  version_fingerprint TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('source', 'user', 'ai_mixed')),
  extraction_job_id TEXT NOT NULL REFERENCES extraction_jobs(job_id),
  verification_status TEXT NOT NULL,
  evidence_gap_reason TEXT,
  publish_status TEXT NOT NULL,
  supersedes_version INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (knowledge_id, version),
  UNIQUE (knowledge_id, version_fingerprint)
);

CREATE TABLE atomic_claims (
  claim_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES knowledge_scopes(scope_id),
  knowledge_id TEXT NOT NULL,
  knowledge_version INTEGER NOT NULL,
  claim_text TEXT NOT NULL,
  claim_kind TEXT NOT NULL CHECK (claim_kind IN
    ('tutorial_fact', 'technical_explanation', 'user_interpretation')),
  verification_status TEXT NOT NULL,
  verification_reason TEXT,
  FOREIGN KEY (knowledge_id, knowledge_version)
    REFERENCES knowledge_versions(knowledge_id, version),
  UNIQUE (scope_id, claim_id)
);

CREATE TABLE claim_evidence (
  scope_id TEXT NOT NULL REFERENCES knowledge_scopes(scope_id),
  claim_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('supports', 'context_only', 'contradicts')),
  PRIMARY KEY (scope_id, claim_id, evidence_id),
  FOREIGN KEY (scope_id, claim_id) REFERENCES atomic_claims(scope_id, claim_id),
  FOREIGN KEY (scope_id, evidence_id) REFERENCES evidence_records(scope_id, evidence_id)
);
```

`assistant_message` 只能以 `context_only` 关联，不能使 `tutorial_fact` 变为 `supported`。`user_message` 只能对应明确标注为用户理解的 `user_interpretation`；S2-A 只登记为 `evidence_registered`，S2-B 才能将其确认成 `user_attributed`。

### 4.3 Job、游标与审计

```sql
CREATE TABLE extraction_jobs (
  job_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES knowledge_scopes(scope_id),
  chapter_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  batch_fingerprint TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('idle', 'chapter_switch', 'manual', 'recovery')),
  state TEXT NOT NULL,
  event_high_watermark_at TEXT NOT NULL,
  event_high_watermark_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  consent_id TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  output_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scope_id, conversation_id, batch_fingerprint)
);

CREATE TABLE extraction_job_events (
  job_id TEXT NOT NULL REFERENCES extraction_jobs(job_id),
  event_id TEXT NOT NULL REFERENCES learning_events(event_id),
  PRIMARY KEY (job_id, event_id)
);

CREATE TABLE chapter_extraction_cursors (
  scope_id TEXT NOT NULL REFERENCES knowledge_scopes(scope_id),
  chapter_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  last_completed_event_at TEXT,
  last_completed_event_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, chapter_id, conversation_id)
);

CREATE TABLE extraction_consents (
  consent_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES knowledge_scopes(scope_id),
  provider TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose = 'knowledge_extraction'),
  policy_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
  granted_at TEXT NOT NULL,
  revoked_at TEXT
);
```

`knowledge_scopes` 是 Profile + Vault 隔离边界：默认 Profile 为 `local-default`，Vault 指纹来自经 `VaultGuard` 验证的规范化根路径；没有已验证 Vault 时可使用 `vault_fingerprint='unbound'` 保存 S1 的真实来源快照，但不能创建自动提炼 consent 或 Job。所有 Evidence、Knowledge、Job 和 Cursor 查询必须带 `scope_id`，禁止跨 Profile/Vault 复用同一 `identity_key`。

批次指纹为 `extractor_version + scope_id + conversation_id + chapter_id + 排序后的 event_id + 关联 snapshot_hash + 输入 evidence content_hash` 的 SHA-256。游标使用 `(created_at, event_id)` 复合边界，且作用域为 `(scope_id, chapter_id, conversation_id)`；不同会话在同一章节绝不能互相推进或跳过事件。Job 固化 high-watermark；不能仅依赖 UUID 或 SQLite `rowid` 排序。

## 5. Pydantic 契约

LLM 只产生 Draft；数据库服务补充 ID、版本、最终状态。所有模型 `extra='forbid'`，长度受现有 `Settings.llm_max_context_characters` 和新的 S2 上限约束。

```python
class EvidenceRefDraft(BaseModel):
    evidenceIds: list[str]              # 必须来自本批 Registry allow-list
    relation: Literal['supports', 'context_only', 'contradicts']

class AtomicClaimDraft(BaseModel):
    localClaimId: str                    # 批次内 ID，不是数据库 claim_id
    text: str
    kind: Literal['tutorial_fact', 'technical_explanation', 'user_interpretation']
    evidence: list[EvidenceRefDraft]

class KnowledgeCandidateDraft(BaseModel):
    localKnowledgeId: str
    topic: str | None
    kind: Literal['concept', 'pitfall', 'explanation', 'example', 'user_insight'] | None
    body: str | None                     # 简洁、可独立阅读，不复制完整聊天
    anchorEvidenceId: str | None
    claims: list[AtomicClaimDraft]
    worthExtracting: bool
    skipReason: str | None

    # worthExtracting=true: topic/kind/body 非空、claims 至少一条、skipReason=None
    # worthExtracting=false: claims 必须为空、skipReason 非空；其他字段可为空

class ExtractionOutputDraft(BaseModel):
    schemaVersion: Literal[1]
    candidates: list[KnowledgeCandidateDraft]

class ClaimVerificationDraft(BaseModel):
    localClaimId: str
    citedEvidenceIds: list[str]
    semanticVerdict: Literal[
        'supported', 'partially_supported', 'not_supported', 'insufficient_evidence'
    ]
    reason: str
```

服务层对外/跨模块传递的持久化 DTO 与 LLM Draft 分离，最小形态如下：

```python
class EvidenceRecord(BaseModel):
    evidenceId: str
    scopeId: str
    chapterId: str
    sourceKind: Literal['tutorial_block', 'selection', 'user_message', 'assistant_message']
    sourceSnapshotId: str | None
    sourceBlockId: str | None
    stableKey: str | None
    selectionId: str | None
    messageId: str | None
    excerpt: str
    contentHash: str
    resolvable: bool

class AtomicClaimRecord(BaseModel):
    claimId: str
    knowledgeId: str
    knowledgeVersion: int
    text: str
    kind: Literal['tutorial_fact', 'technical_explanation', 'user_interpretation']
    verificationStatus: Literal[
        'evidence_registered', 'supported', 'partially_supported',
        'insufficient_evidence', 'not_supported', 'verification_unavailable',
        'user_attributed'
    ]
    evidenceIds: list[str]

class KnowledgeItemRecord(BaseModel):
    knowledgeId: str
    version: int
    scopeId: str
    documentId: str
    chapterId: str
    anchorBlockId: str | None
    anchorStableKey: str | None
    headingPath: list[str]
    topic: str
    kind: Literal['concept', 'pitfall', 'explanation', 'example', 'user_insight']
    body: str
    bodyHash: str
    verificationStatus: str
    evidenceGapReason: str | None
    publishStatus: Literal[
        'not_eligible', 'eligible', 'eligible_user_insight', 'needs_review'
    ]

class ExtractionJobRecord(BaseModel):
    jobId: str
    scopeId: str
    chapterId: str
    conversationId: str
    eventIds: list[str]
    batchFingerprint: str
    state: Literal[
        'planned', 'blocked_consent', 'queued', 'running', 'completed',
        'skipped', 'retryable_failed', 'needs_review'
    ]
    attemptCount: int
    highWatermark: tuple[str, str]
```

程序校验规则：Draft 的所有 evidence ID 必须在该 Job 的 Registry 中；`worthExtracting=true` 的候选至少有一个 Claim，`worthExtracting=false` 的跳过候选允许且要求 `claims=[]`；`tutorial_fact` 至少引用一个 `tutorial_block` 或已解析 `selection`；`user_insight` 必须带“用户理解”语义；空、重复 local ID、越界锚点或未知引用全部拒绝本次输出。Verifier 的 `semanticVerdict` 还要经过规则合成，不能直接写入最终状态。

## 6. 提炼、注册、核验与组织流程

### 6.1 从多轮对话提炼高价值知识

Scheduler 只对已完成 `learning_events` 组批，输入包含事件问题、回答、精确消息链接、当前章节的 Registry 摘录和选区；不把整段聊天无差别塞入 Prompt。Extractor 提示词要求：

1. 仅提取可复用的章节知识：定义、机制、边界条件、易错点、可验证代码例子、明确的用户理解。
2. 一个 Candidate 只处理一个主题，Claim 可独立核验。
3. 每个事实性 Claim 引用 allow-list 中的教程/选区 evidence ID；AI 回答只能作解释上下文。
4. 只有聊天复述、寒暄、无来源猜测、未解决问题时输出 `worthExtracting=false`。
5. 不生成文件路径、写入指令、最终 `verification_status` 或 `publish_status`。

例如“中间件是什么、对请求/响应做什么、多个中间件的顺序”可形成多个 Claim；“它通常也可做鉴权、限流”的泛化解释若教程未支持，应是 `insufficient_evidence`，而不是教程事实。

### 6.2 Evidence Registry / Resolver

对每个 Job，程序先登记以下证据，再构建 LLM allow-list：

| 来源 | 可支持的结论 | Resolver 条件 |
|---|---|---|
| `tutorial_block` | 教程事实、代码行为 | snapshot + block ID 存在，内容哈希一致 |
| `selection` | 选中原文事实 | selection → user message → event 链完整；唯一映射到块，或跨块唯一映射到同一小节 |
| `user_message` | 用户的主观理解 | message 与 event 精确关联；只能归因给用户 |
| `assistant_message` | 解释上下文 | message 与 event 精确关联；不得单独支持事实 |

注册器拒绝不存在的 `message_id`、`selection_id`、`source_snapshot_id`、`source_block_id` 和跨章节 ID。`heading_path` 只是辅助定位；S3 自动发布至少需要唯一的 `source_block_id`，或由唯一 `section_anchor_block_id` 支持的小节锚点。跨块选区既不能唯一归属块、也不能唯一归属小节时，Candidate 为 `needs_review`，S2-A 不提供人工锚点选择界面。

### 6.3 Claim 级核验

S2-A 先做确定性结构核验：来源存在、scope/章节/会话一致、证据类型允许、摘录哈希一致、Claim 与 `kind` 合法。通过后只产生 `KnowledgeDraft + evidence_registered`，不是 `verified`，也不产生 `eligible PublishCandidate`。S2-A 可独立运行：其验收标准是草稿、证据、跳过与幂等 Job 全部可审计，而不是自动发布。

S2-B 对仍需发布的事实性 Claim 进行独立批量语义核验。Verifier 仅接收 Claim 文本和 Resolver 提供的真实证据摘录，不接收 Extractor 的推理、评分或完整 AI 回答。它可提出语义判断，但最终状态由程序合成：

- 有可解析教程/选区证据且 Verifier `supported`：`supported`。
- 有证据但只覆盖部分限定条件：`partially_supported`，不可自动发布。
- 只有 AI/用户消息、或没有可解析教程证据：`insufficient_evidence`。
- 教程证据与 Claim 相反：`not_supported`。
- Provider 超时/结构无效：`verification_unavailable`，保留草稿、可重试。

Knowledge Version 的总体状态取全部事实性 Claim 的最弱结果计算；任何 `not_supported`、未解析锚点或 `verification_unavailable` 都不能获得 S3 自动发布资格。只有 S2-B 完成必要独立核验且所有事实性 Claim 为 `supported` 时，Organizer 才可将事实型 Knowledge Version 标为 `publish_status=eligible`。

`user_insight` 是单独规则：S2-A 只登记用户消息链并保持 `evidence_registered`，永不标记为 `supported` 技术事实；S2-B 确认消息链完整且用户明确表达个人理解后，才标记 `verification_status=user_attributed + publish_status=eligible_user_insight`，供 S3 仅以“我的理解”Callout 发布，不能与教程事实混写。

## 7. 触发、独立云端授权与 Job 状态机

### 7.1 有界批量触发

每次 S1 成功写入**已链接** `learning_event` 后只更新候选范围，不直接调用 Extractor。满足以下任一条件才计划 Job：同一 `(scope, chapter, conversation)` 累计至少 2 个实质事件、文本量达到阈值、90 秒空闲、切换章节、或用户主动“整理本章学习收获”。实质事件至少包含非空问题、非空助手回答和可解析章节来源；`legacy_unlinked` 与 `unlinked_runtime_error` 事件不自动入批。

Job 以该会话的事件 high-watermark 固化输入，保证之后到达的事件进入下一批。S2-A 采用 FastAPI lifespan 内的单 worker 协作轮询和 SQLite lease；不引入 Celery、Redis 或 Agent 框架。进程启动先执行 recovery scan，再领取到期 Job。当前预算为 Extractor 每批最多 **8,000 输入 Tokens / 3,000 输出 Tokens**；S2-B Verifier 每批最多 **8 个 Claims / 1 次批量核验**。

### 7.2 独立授权

S1 Chat 的 `cloudConsent` 不等于 S2 提炼授权。即使当前 UI 默认允许聊天发往 DeepSeek，S2 仍必须单独展示/记录“将本地对话、选区和章节摘录发送给云端进行知识提炼”的授权。授权固定为 **Profile + Vault** 作用域，默认关闭，写入 `extraction_consents`。

- 无有效 consent：Job 状态为 `blocked_consent`，不构建 Provider 请求。
- 已验证 Vault 前不得创建 active consent；授权绑定 `scope_id`、Provider、用途、政策版本和时间。
- 撤销后：不领取新 Job；运行中 Job 在下个安全检查点停止并回到 `blocked_consent`；本地草稿保留。

### 7.3 状态机

```text
planned → blocked_consent ──(授权)──→ queued → running
                                      │          │
                                      │          ├─ 成功 → completed / skipped / needs_review
                                      │          └─ 可恢复错误 → retryable_failed → queued
                                      │                                  │
                                      └──────────────────(次数耗尽)──────→ needs_review
```

`running` Job 必须有 lease；租约超时后恢复为 `retryable_failed`。`completed`、`skipped`、`needs_review` 是终态。`blocked_consent` 不是失败，不能消耗重试次数。

### 7.4 原子领取、fencing 与游标提交

1. Worker 在短事务 `BEGIN IMMEDIATE` 内，以 `scope_id + job_id + state in (queued, retryable_failed) + next_attempt_at <= now` 原子更新一行到 `running`，写入随机 `lease_token` 和 `lease_expires_at`；受影响行数必须为 1。
2. Provider 调用在事务外进行。Worker 获得 Draft 后先做 Pydantic 和 Registry 校验。
3. 最终持久化在第二个短事务内完成：重新检查 active consent、`state='running'`、未过期 lease 和同一个 `lease_token`；随后写入 Evidence、Draft/Version/Claim、`output_hash`、Job 终态和该会话 Cursor。任一条件不满足即丢弃本 worker 输出，不能覆盖持有新 lease 的 worker。
4. Cursor 只在该 Job 的事件集合已被原子提交到 `completed`、`skipped` 或 `needs_review` 后，推进到该 Job 的 high-watermark；`retryable_failed`、`blocked_consent` 和失去 lease 时绝不推进。
5. 网络错误最多重试 **1 次**；第二次网络失败转为 `needs_review` 并保留错误审计。格式/未知 ID/跨 scope 等确定性错误直接 `needs_review`。
6. recovery scan 仅回收 `lease_expires_at < now` 的 `running` Job，清空旧 token 后转 `retryable_failed`。旧 worker 的 fencing 更新会失败，因此不会产生重复 Draft 或错误推进 Cursor。

## 8. 幂等、合并、版本与恢复

1. **事件幂等：** `UNIQUE(scope_id, conversation_id, batch_fingerprint)` 与 `extraction_job_events` 防止同一会话批次重跑产生第二个 Job；不同会话即使属于同章节也有独立 Cursor。
2. **证据幂等：** `scope_id + source_snapshot_id + source_block_id + content_hash` 和 selection/message 关联组成 Evidence 的自然键；同一证据只登记一次。
3. **知识幂等：** `identity_key = hash(scope_id, chapter_id, anchor, kind, normalized_topic)`。这使相同教程内容在不同 Profile/Vault 内完全隔离。
4. **正文与证据分别版本化：** `body_hash` 相同且 `evidence_set_hash` 相同才是 `noop`。正文不变但证据集合、证据快照或 Claim 核验结果发生可审计变化时，使用 `version_fingerprint` 创建新 Version；不能因正文相同丢失新的来源或核验记录。
5. **保守版本更新：** 同一 identity 下，新 Claim/证据严格补充且锚点不变时可创建 `version + 1`；若出现矛盾证据、锚点变化、主题漂移或无法判断的同义关系，保留并标记 `needs_review`，不做模型相似度合并。
6. **恢复：** Job 在领取、LLM 输出校验、Evidence/Draft 持久化与 Cursor 推进之间使用带 lease token 的短事务；重启时依据 fencing、`output_hash`、`version_fingerprint` 判断已完成/未完成，绝不盲目追加。
7. **失败：** 网络、限流、超时第一次为 `retryable_failed`，最多重试一次；未知 evidence ID、Pydantic 无法修复的输出、跨章节/跨 scope 证据属于确定性失败，记录原因后 `needs_review`。

## 9. 面向 S3 的稳定发布契约

S2-A 不产生 `PublishCandidate`，只产生 `KnowledgeDraft` 与 `evidence_registered` 审计记录。以下契约仅由 S2-B 的 Organizer 在必要核验完成后产生；S2 不调用 `VaultGuard`、`MarkdownNoteService` 或 `DocumentPreviewService.commit()`：

```python
class PublishCandidate(BaseModel):
    knowledgeId: str
    knowledgeVersion: int
    documentId: str
    chapterId: str
    sourceUrl: str
    targetNoteId: str                 # 复用 NoteResolver.note_id
    anchorSnapshotId: str
    anchorBlockId: str | None
    anchorStableKey: str | None
    headingPath: list[str]
    anchorFingerprint: str | None
    body: str
    bodyHash: str
    verificationStatus: Literal['supported', 'user_attributed']
    evidenceIds: list[str]
    publishStatus: Literal['eligible', 'eligible_user_insight']
```

事实型 Candidate 只允许 `verificationStatus=supported + publishStatus=eligible`；`user_attributed + eligible_user_insight` 只能被 S3 渲染为明确标注“我的理解”的 Callout，不能升级或混同为教程事实。S3 还必须自行重新读取文件、通过现有 `NoteResolver`/`VaultGuard` 解析目标、核对 source/anchor、计算当前文件 revision，并创建自己的 `PublishIntent`。S2 的 `eligible*` 仅表示“证据、归因和结构足以交给 S3”，不是已经写入或批准覆盖用户内容。

## 10. S2-A / S2-B 开发边界

| 项目 | S2-A：最小闭环 | S2-B：质量增强 |
|---|---|---|
| 不可变来源 | 本次聊天请求快照、`source_blocks`、`event_contexts(linked)`；旧事件不自动入批 | 迁移审计、旧事件人工修复入口 |
| 提炼 | 单章节、有界批次、严格 JSON Draft | 提示词/阈值调优、候选质量指标 |
| 证据 | Registry、ID/哈希/scope/章节规则校验，状态止于 `evidence_registered` | 独立 LLM Claim 语义核验（每批 8 Claims、1 次） |
| 去重 | 批次与 `body_hash + evidence_set_hash` exact no-op | 保守 version update、needs_review 分流 |
| 任务 | Profile + Vault 独立 consent、lease fencing、网络错误重试 1 次、恢复 | 可观测统计、失败人工重放 |
| 输出 | SQLite `KnowledgeDraft`；`publish_status=not_eligible` | 完整 Claim/Evidence 审计、事实 `eligible` 或用户理解 `eligible_user_insight` |
| 明确不做 | Vault 写入、RAG、跨章节合并 | Vault 写入、RAG、跨章节合并 |

### 10.1 S2-A 独立可运行判定

S2-A 的测试不启动 S2-B Verifier，也不构造 `PublishCandidate`。在一个有效 Profile + Vault consent scope 下，以下断言全部成立即视为 S2-A 独立通过：

1. 同一次聊天请求的 `PageSnapshot` 被登记为不可变快照，最终 `learning_event + event_context(linked)` 原子可回查。
2. Extractor 的已知 evidence ID 只生成 `KnowledgeDraft/evidence_registered/not_eligible`；`worthExtracting=false` 可形成无 Claim 的 `skipped` Job。
3. 编造 ID、跨 scope、跨章节、非唯一锚点均不会生成可发布知识；普通聊天回答不因来源关联失败而失败。
4. 同会话批次重跑为 no-op；同章节不同会话各自 Cursor 不互相跳过；租约过期的旧 worker 不能提交。
5. 无 active consent、无已验证 Vault 或 `unbound` scope 均不发起 Extractor Provider 调用。

因此 S2-A 的唯一云端调用是 Extractor；不存在 S2-B 语义核验调用、S3 文件调用或自动发布资格。

## 11. 实际验收案例

| 场景 | 输入 | 预期结果 |
|---|---|---|
| FastAPI `Annotated[str, Form()]` 多轮讨论（S2-A） | 本次聊天快照代码块 + 选区 + 两轮问答 | 提取一个或多个章节内 `KnowledgeDraft`；每个事实 Claim 指向真实 block；状态最多 `evidence_registered`，没有 PublishCandidate；同批重跑无重复 |
| “中间件”解释包含教程外泛化（S2-B） | 教程块支持请求/响应流程，AI 额外提到鉴权/限流 | 教程流程 Claim 可 `supported`；泛化部分为 `insufficient_evidence` 或拆分为解释草稿 |
| 仅 AI 回答 | 没有教程块或可解析选区 | 不生成可发布事实；可保留 `evidence_registered` 解释草稿并标注 `evidence_gap=assistant_only`，`publish_status=not_eligible` |
| 用户说“我理解为……” | 用户消息链完整但无教程证据 | S2-A 为 `user_insight + evidence_registered`；S2-B 可成为 `user_attributed + eligible_user_insight`，S3 仅以“我的理解”发布 |
| 编造 evidence/message ID | Extractor 输出 `ev-fake` | Resolver 拒绝，Job 进入可审计失败/复核，不落 Knowledge Item |
| 选区跨源块 | 多块属于唯一小节 / 小节不唯一 | 前者降级为 section anchor；后者 `needs_review`，S2-A 不显示人工锚点 UI |
| 跳过输出 | `worthExtracting=false`、无价值闲聊 | `claims=[]`、有 `skipReason`，Job `skipped`，不建 Knowledge Item |
| 同章节不同会话 | 会话 A、B 都有未提炼事件 | 各自 Cursor 和 Job 独立，A 不会推进 B |
| 相同正文但证据更新 | 同 identity/body，新 snapshot 或证据集合 | 新 `evidence_set_hash`/Version，保留审计；完全相同才 `noop` |
| 进程中断 | Job lease 过期 | recovery fenced 回收为 `retryable_failed`；旧 worker 不能提交，Cursor 不前进 |
| 历史 S1 事件 | 只有旧 `learning_events`，无消息/快照 ID | `legacy_unlinked`，不自动入批或取得自动发布资格 |

## 12. 开源项目参考、借鉴与复用声明

| 项目 | 具体源码路径 | 本设计借鉴 | 是否复用代码 |
|---|---|---|---|
| Open Notebook | [`open_notebook/graphs/transformation.py`](https://github.com/lfnovo/open-notebook/blob/main/open_notebook/graphs/transformation.py)、[`open_notebook/domain/notebook.py`](https://github.com/lfnovo/open-notebook/blob/main/open_notebook/domain/notebook.py)、[`api/routers/insights.py`](https://github.com/lfnovo/open-notebook/blob/main/api/routers/insights.py) | Source → Insight → Note 的职责隔离、异步转换 | 否；不引入其 LangChain/LangGraph/SurrealDB 栈 |
| Research Assistant | [`core/registry.py`](https://github.com/jitutarafder/research-assistant/blob/main/core/registry.py)、[`core/assembly.py`](https://github.com/jitutarafder/research-assistant/blob/main/core/assembly.py)、[`core/verification.py`](https://github.com/jitutarafder/research-assistant/blob/main/core/verification.py)、[`schemas.py`](https://github.com/jitutarafder/research-assistant/blob/main/schemas.py) | allow-list 来源 ID、Draft 与最终状态分离、Atomic Claim、独立核验 | 否；不引入其 Web 搜索、Gemini/Tavily、报告流水线 |
| Basic Memory | [`models/knowledge.py`](https://github.com/basicmachines-co/basic-memory/blob/main/src/basic_memory/models/knowledge.py)、[`services/note_preparation.py`](https://github.com/basicmachines-co/basic-memory/blob/main/src/basic_memory/services/note_preparation.py)、[`indexing/note_content_reconciliation.py`](https://github.com/basicmachines-co/basic-memory/blob/main/src/basic_memory/indexing/note_content_reconciliation.py)、[`runtime/note_materialization.py`](https://github.com/basicmachines-co/basic-memory/blob/main/src/basic_memory/runtime/note_materialization.py) | heading/重复标题/代码围栏定位、checksum 与外部编辑协调 | 否；项目为 AGPL-3.0-or-later，仅作设计参考 |

## 13. 已确认产品决策与实施前提

已确认并已反映到本设计：

1. 云端提炼授权以 **Profile + Vault** 为作用域，默认关闭。
2. `user_insight` 可在 S3 以明确标注“我的理解”的形式归档；不得标记为 `supported` 技术事实。
3. S2-B 核验预算为每批最多 1 次、最多 8 个 Claims；网络错误最多重试 1 次；当前 Extractor 预算为 8,000 输入 Tokens、3,000 输出 Tokens。
4. S2-A 不实现人工锚点选择界面；跨块选区仅在唯一小节可确定时降级，否则 `needs_review`。

S2-A 没有阻断实施的问题：它不依赖 S2-B 或 S3，即可在有效 Profile + Vault 独立授权下产出可审计的 `KnowledgeDraft + evidence_registered`。实施前仅需将本设计中的 Snapshot Registrar 与 `event_contexts` 写入纳入 S1 最终事件事务，并为无 Vault/无 consent 场景返回稳定的 `blocked_consent` 状态。


# AGENTS.md

This file defines how Codex should operate in this repository.
本文件定義 Codex 在此專案中的實作規範。

---

## 1. Role / 角色定位

You are an execution engineer working under architectural supervision.
你是一位在架構監督下執行任務的工程師。

You operate under CLAUDE.md governance.
你必須遵守 CLAUDE.md 所定義的架構規範。

You must:

* Follow the phase plan given by Claude
* Work in atomic, reversible steps
* Never modify multiple architectural layers in one commit
* Preserve runtime behavior unless explicitly instructed
* Respect module boundaries and dependency direction

You do NOT redefine architecture.
你不可重新定義架構。

---

## 2. Execution Discipline / 執行紀律

Before coding:

* Ensure branch is not `main`
* If on `main` → create `feature/<task-name>`

During implementation:

* Keep changes minimal
* One logical responsibility per commit
* Avoid cross-layer modifications
* Do not introduce new dependencies without justification

After each logical unit:

1. Run validation / build
2. Only commit if validation passes
3. Write structured commit message

---

## 3. Commit Format / Commit 格式

type(scope): short description

Body:

* What changed
* Why
* Impact

Example:

refactor(selector): extract filter logic

* Moved filtering logic into utils module
* Reduced page-level responsibility
* No runtime behavior change

Allowed types:

* feat
* fix
* refactor
* chore
* docs
* test

---

## 4. Architecture Conflict Protocol / 架構衝突機制

If implementation requires:

* Changing architectural boundaries
* Introducing cross-layer dependency
* Altering module ownership
* Large structural modification

Stop immediately and respond:

"Architecture decision required. Please consult Claude."

Do NOT proceed without architectural approval.

---

## 5. Phase Scope Rule / 階段範圍限制

Only execute the explicitly assigned phase.

* Do NOT anticipate future phases.
* Do NOT implement improvements outside the current phase scope.
* If unclear about phase boundary, stop and ask for clarification.
* Never merge multiple phases into one execution cycle.

---

## 6. TRACE Logging Rule / TRACE 紀錄規則

After completing an assigned phase:

* Append a structured entry to `docs/ai/TRACE.md`
* Include:

  * Phase number
  * Commit references
  * Summary of structural impact
  * Any architectural assumptions made

TRACE updates must be included in the same execution cycle.

---

## 7. Forbidden / 禁止事項

* No force push
* No direct commit to main
* No silent breaking change
* No full-project rewrite
* No unrelated refactor

All changes must be traceable and reversible.

---

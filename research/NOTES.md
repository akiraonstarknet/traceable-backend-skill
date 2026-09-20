# Research notes — prior art for `traceable-backend`

Date: 2026-09-20. Purpose: decide what to borrow, what to avoid, and what the
skill has to invent, before writing `SKILL.md`.

Licence column is "can we copy ideas / copy code?". Ideas are always free; code
is only copied where the licence is permissive (MIT / Apache-2.0 / BSD).
Entries marked **(verify)** could not be confirmed from an authoritative source
in this session (GitHub API returned 403 through the proxy) — confirm before
copying any code.

---

## 1. API / infrastructure catalog derived from code

### Encore (encore.dev) — MPL-2.0 (framework, parser, compiler)

What it does well:

- The **Encore Application Model**: infrastructure is declared *in* application
  code (`api()`, `SQLDatabase()`, `Topic()`), the compiler parses it, and a
  Service Catalog, API docs, architecture diagram and DB explorer are generated
  from that single parse. No second source of truth to keep in sync.
- **Local dev dashboard** (`encore run`) bundles catalog + API explorer +
  distributed traces + DB explorer at one URL. Exactly the "owner opens one
  page" ergonomics we want.
- Tracing is automatic because instrumentation happens at compile time — the
  developer (or the AI) cannot forget to instrument.

What to borrow:

- The **single dev dashboard with grouped nav** covering APIs, data and traces.
- The idea that the catalog is *derived*, so it can never be stale.
- API explorer: let the owner call an endpoint from the UI with prefilled
  params. Cheap to build, huge for a non-coder verifying behaviour.

What to avoid:

- Encore requires adopting Encore's framework, compiler and (for the good
  parts) Encore Cloud. Lock-in is the opposite of what an internal tool owner
  wants. MPL-2.0 file-level copyleft also means we do not want to vendor its
  code.
- Encore has no notion of "data this endpoint must NOT touch", and no enforcement
  layer — the catalog is descriptive, not a contract.

Consequence for us: we cannot derive everything from code (Claude writes the
code, and derived-only means the AI's mistakes are silently documented as
truth). We need a **declared manifest that is checked against runtime facts** —
i.e. Encore's dashboard, but with an adversarial checker instead of a compiler.

### Backstage (backstage.io) — Apache-2.0

What it does well:

- `catalog-info.yaml` with a Kubernetes-inspired envelope:
  `apiVersion` / `kind` / `metadata` / `spec`. Multiple entities per file
  separated by `---`. YAML for humans, JSON over the API.
- `metadata.annotations` as a documented escape hatch for linking to external
  systems (git refs, dashboards, on-call).
- Reserved-meaning fields (`name`, `labels`, `annotations`) vs free-form spec.

What to borrow:

- **The envelope shape verbatim** — `apiVersion: traceable.dev/v1`, `kind: Api |
  Table | Job`, `metadata`, `spec`. It is familiar, versionable, and lets us
  evolve the schema without breaking old manifests.
- One entity kind per file, named after the thing (`apis/tenant-status-update.yaml`).
- `metadata.description` as a required plain-English field, because the owner
  reads it.

What to avoid:

- Backstage's catalog is **entirely self-reported**. Nothing checks that the
  YAML matches reality, so in practice catalogs rot. This is the single failure
  mode our drift checker exists to prevent.
- Backstage's entity graph (System / Domain / Component / Resource / Group /
  User) is far more taxonomy than a small internal app needs. We use three
  kinds, not seven.
- The Backstage *app* is a heavy React/plugin platform. Our UI must be part of
  the app being built, not a separate deployment.

---

## 2. Node / gate runs and run UI

### Apache Burr — Apache-2.0

What it does well:

- Explicit **three-level tracking hierarchy: project → application (≈ a trace)
  → step**. Each step records the state before, the inputs, and the result.
- `LocalTrackingClient` writes everything (including source code of the action)
  to disk, and the Burr UI renders the state machine plus the step timeline.
  Zero infrastructure to see a run.
- Actions are small and declare which state fields they read and write
  (`@action(reads=[...], writes=[...])`). That is a manifest, inline.

What to borrow:

- **`reads` / `writes` declared per node** — same idea as our manifest
  `data_read` / `data_written`, and it proves the pattern works at node level
  too, not just API level.
- The three-level hierarchy maps cleanly onto our `jobs` → `runs` → `run_steps`.
- Persisting the step's own description/source so the UI can explain a step the
  owner has never seen.

What to avoid:

- Python-only. Our default stack is TypeScript.
- Burr's UI shows a *graph*. Graphs are exactly the wrong artefact for a
  non-coder: they invite "trace the arrows" reading. We flatten to a linear
  node → gate → node list, which reads like a receipt.

### LangGraph — MIT

What it does well:

- `add_conditional_edges(source, routing_fn, mapping)`: the routing function
  reads state and **returns a name**, which is then mapped to a node. The
  decision is a value, not a jump — which makes it loggable.
- Checkpointer persists state after every node commit, keyed by `thread_id`, so
  a run resumes rather than restarts.

What to borrow:

- **The routing-function-returns-a-label contract is our Gate, exactly.** This
  is the strongest confirmation that our gate design is a known-good pattern
  and not an invention.
- Persisting state per step (our `run_steps.output_json` doubles as the
  checkpoint).

What to avoid:

- Nothing in LangGraph *stops* a routing function from writing to a database.
  It is convention only. Our differentiator is that the gate signature makes
  side effects unavailable (no db/fetch/llm handle in its context) and the
  validator rejects gates that reach for them.
- The graph/state abstraction is heavy for small internal jobs; we want a
  declared linear pipeline with branches, not a general state machine.

### Temporal — MIT

What it does well:

- Hard **determinism boundary**: workflow code must be deterministic; anything
  touching the outside world must be an Activity; non-deterministic values go
  through `SideEffect`, whose result is recorded in the event history and
  replayed rather than recomputed.
- Event History is the complete, durable, replayable record of a run. The Web UI
  shows running executions, inputs, outputs, and which Activity failed with
  what error.

What to borrow:

- The **"effects live in a named, recorded unit; the coordinating code has no
  effects"** split, which is our node/gate split in miniature.
- "Every run is in the history, including failures" as a non-negotiable.
- Showing the *failing step and its error* as a first-class UI element, not a
  log line to grep.

What to avoid:

- Temporal is a cluster (server, matching, history, worker fleet). Enormous for
  an internal tool that runs a handful of jobs a day. We get durability from a
  Postgres table, not from a distributed scheduler.
- Determinism-by-replay is a tax the AI will get wrong. We record a run
  forward-only and never replay it.

### Inngest (Apache-2.0 core) / Trigger.dev (Apache-2.0)

What they do well:

- `step.run()` checkpoints each step durably; a crash or deploy resumes from
  the last completed step.
- Inngest's dashboard shows **every step's input, output and timing with a
  per-step rerun button**, and the docs explicitly pitch the "a developer who
  didn't write this can open one URL, see the failed step, see the payload,
  fix and rerun" workflow. That is our owner persona, one notch more technical.
- Both ship a local dev UI with no cloud dependency.

What to borrow:

- **Per-step input / output / duration in the UI** as the default run view.
- "Open one URL and understand the failure" as the design target for the Runs
  page.
- Inngest's framing that the run view is for someone who did *not* write the
  code.

What to avoid:

- Both are external platforms your functions run *inside*. That means a second
  vendor, a second place to look, and run history living outside the owner's
  database. Our runs must be rows in the same Postgres the owner's data is in,
  so the Runs page and the Audit page can be joined on `run_id`.
- Replay/rerun implies idempotency guarantees we are not going to be able to
  promise for AI steps. We show runs; we do not offer one-click rerun in v1.

### Langfuse — MIT core (self-hostable)

What it does well:

- Trace → observation tree, where an observation of type `generation` carries
  `model`, input/output, **token counts and computed cost**.
- Cost is computed at ingestion by matching the `model` string against a model
  price table with per-usage-type prices; custom/self-hosted models can be
  added to that table.
- Keeps `usage` even when inferred, so cost is present on every generation.

What to borrow:

- The **generation field set**: `model`, `tokens_in`, `tokens_out`,
  `cost_usd`, plus provider request id. This is precisely rule 5's LLM node
  requirement, and Langfuse is the reference implementation of it.
- A **model price table as data** (a seeded `llm_model_prices` table), so cost
  is computed by the app and the owner can see the price used.

What to avoid:

- Self-hosting Langfuse v3 needs Postgres + ClickHouse + Redis + S3. Absurd for
  an internal tool. We write three columns to Postgres instead.
- Langfuse is LLM-only; it has no notion of API endpoints, tables or grants, so
  it cannot be the single place the owner looks.

### OpenRouter generation stats — (API, not a library)

- The chat completion response carries an `id` (e.g. `gen-...`).
- `GET https://openrouter.ai/api/v1/generation?id={genId}` returns
  `model`, `provider_name`, `tokens_prompt`, `tokens_completion`,
  `native_tokens_prompt`, `native_tokens_completion`, `total_cost`,
  `latency`, `finish_reason`. This is the **authoritative** cost, as billed.
- Stats may lag the completion by a moment; retry once after a short delay.

Borrow: store `provider_generation_id` on every LLM step at write time, and
backfill `cost_usd` / native token counts from that endpoint asynchronously.
That gives the owner a number that matches the invoice, and a link to click.

---

## 3. Audit trail

### Bemi — (verify; ORM packages appear to be LGPL-family, so do not vendor code)

What it does well:

- Captures changes via **CDC off the Postgres WAL** using logical replication,
  so nothing in application code can bypass it — including manual `psql` edits
  and migrations.
- A thin ORM middleware attaches **application context** to the transaction
  (who: user / cron; where: endpoint, method; plus custom fields), and the
  worker stitches that context onto the low-level change.
- Enables time-travel queries and "revert everything from this request".

What to borrow:

- **The context model is exactly ours**: actor + source + request_id/run_id set
  on the transaction, stitched onto each row change. This validates rule 4's
  shape.
- "Group all changes by request" as a UI primitive — our Audit page filters by
  `request_id` / `run_id` and links back to the Runs page.

What to avoid:

- CDC needs logical replication, a replication slot, and a worker process. For
  a small internal app that is a third moving part that can silently fall
  behind — and a lagging audit trail is worse than none, because the owner will
  trust it. Triggers are synchronous: if the audit write fails, the business
  write fails.
- Bemi-the-service is a hosted product; self-hosting is a second deployment.

### supa_audit (Supabase) — Apache-2.0 **(verify)**; the blog post "Postgres Auditing in 150 lines of SQL" is the canonical reference

What it does well:

- One generic `audit.record_version` table, one generic trigger function,
  enabled per table. ~150 lines of SQL total.
- Computes a stable `record_id uuid` from the row's primary key values, so the
  full history of one row is a single indexed lookup rather than a scan.
- Stores old and new record as `jsonb`, plus operation and timestamp.

What to borrow:

- **The whole design.** Generic table + generic trigger + per-table opt-in +
  stable `record_id` from the PK is the right shape, it is permissively
  licensed, and it is small enough that Claude can regenerate it correctly.
- Per-table opt-in matters: our manifests already say which tables exist, so the
  drift checker can assert "every table with a manifest has the audit trigger
  attached" — a check supa_audit itself doesn't offer.

What to avoid:

- Known throughput ceiling: negligible overhead under ~1k writes/s, not
  recommended above ~3k writes/s. Fine for internal tools; document the limit
  honestly in the audit reference so nobody is surprised.
- `supa_audit` has no context columns. We extend the row with
  `actor` / `source` / `request_id` / `run_id`, read inside the trigger from
  transaction-local settings (`current_setting('app.actor', true)`), set by the
  app at the start of each transaction — i.e. supa_audit's storage with Bemi's
  context.

### pgaudit — PostgreSQL licence

What it does well:

- Session and object audit logging at the statement level, from inside the
  server, so it sees everything including ad-hoc SQL.

What to avoid:

- It logs to the **server log files**, not to a table. The owner cannot filter
  it in a UI; it needs a log pipeline to be useful.
- Turning everything on produces enormous volume and will slow the database and
  fill the disk — a documented, common failure.

Verdict: not our audit trail. Worth one sentence in the reference as the
"if you need statement-level DBA auditing, that is a different tool" note.

---

## 4. Spec ↔ code drift

### GitHub Spec Kit — MIT

What it does well:

- Names the failure mode precisely: agents produce plausible code that drifts
  from intent. Specs are treated as **executable sources of truth**, not
  throwaway planning docs.
- A concrete, repeatable command sequence: `/specify` → `/plan` → `/tasks` →
  implement, with each artefact checked into the repo.
- Change flow is "update the spec, regenerate the plan, let the agent redo the
  work" — the spec stays the entry point forever, not just at kickoff.

What to borrow:

- **"Specification is the source of truth" framing and the checked-in artefact
  discipline.** Rule 7 (manifest updated in the same change) is Spec Kit's
  discipline reduced to a single enforceable rule.
- Templates that are prescriptive enough that an agent fills them in
  identically every time.

What to avoid:

- Spec Kit's specs are prose. Prose cannot be diffed against a live route table
  or a `pg_catalog` query. **Our manifests must be machine-checkable YAML with a
  JSON Schema**, and every field must correspond to an observable runtime fact.
  This is the key adaptation: narrow the spec until a script can falsify it.
- The workflow is front-loaded (spec before code). We need the loop to also run
  on every subsequent change, in CI.

### Ecosystem scan (`awesome-spec-driven-development`)

Tools claiming drift detection: **dotdog** (`.dog` specs → `.dag` graphs,
validates completeness and detects drift), **spec-driver** (specs emit deltas
to conform code), **Squelette** (verifies agent changes against declared file
paths, evidence-based task closure), **RailWarden** (records validation
evidence, gates integration), plus **OpenSpec**, **MoAI-ADK**, **Tessl**,
**Kiro**.

Note: `specctl` and `cairn` (named in the brief) do not appear in the curated
list or in search results as spec-drift tools; if they are internal or very
new, they were not findable. Not a blocker.

What to borrow: **evidence-based closure** (Squelette / RailWarden). "Done"
requires a passing machine check, not the agent's assertion. That is rule 7's
teeth.

What to avoid: every tool in this space compares *spec text to code text*,
usually with an LLM. That is fuzzy, slow, non-deterministic, and it re-reads
the code — which is the thing the owner is trying not to have to trust.

**This is the gap `traceable-backend` fills.** We do not diff spec against
code. We diff **manifest against runtime facts**:

| Manifest claim | Runtime fact it is checked against |
|---|---|
| endpoint exists, method, path | the app's live route table |
| endpoint auth: public / secured | the middleware actually mounted on that route |
| table exists, columns, types | `information_schema.columns` |
| table is audited | `pg_trigger` on that table |
| service writes table X | `information_schema.role_table_grants` for that service's role |
| service must NOT touch table Y | absence of any grant to that role on Y |
| job exists, schedule | the registered scheduler entries |
| job's nodes and gates | the node/gate registry the runner loads |

Every row of that table is a deterministic SQL or in-process query. No LLM in
the checker. That is the borrowable-from-nobody part.

---

## 5. Skill authoring

### anthropics/skills, esp. `skill-creator` — (Anthropic, permissive; treat as reference)

Rules that bind our repo layout:

- Three-level **progressive disclosure**: (1) name + description metadata,
  always in context (~100 words); (2) `SKILL.md` body, loaded on trigger,
  **under 500 lines**; (3) `references/`, `scripts/`, `assets/`, loaded only
  when needed.
- `scripts/` for deterministic work, `references/` for docs read into context,
  `assets/` for files used in the output.
- The **description is the trigger**. It must state what the skill does *and*
  the situations that should fire it, and be deliberately "pushy" with keywords,
  because undertriggering is the dominant failure.
- Imperative instructions; explain the *why*, don't just stack MUSTs.
- Table of contents for any reference over ~300 lines.
- If every eval run independently writes the same script, that script belongs
  in `scripts/`.
- Evals: `evals/evals.json` with `{id, prompt, expected_output, files}`; run
  with-skill and baseline **simultaneously**; assertions must be objectively
  verifiable with `text` / `passed` / `evidence`; grade, aggregate, iterate.
- Separate **trigger evals**: ~20 queries, half should-trigger, half
  should-not-trigger, focused on near-misses, with concrete realistic detail.

Applied to us: our skill is unusually lucky — its outputs (a manifest, a
migration, a passing drift check) are objectively verifiable, so assertions can
be real assertions (`scripts/check-drift.ts exits 0`), not vibes.

Community skills reviewed (obra/superpowers' `writing-skills`) agree on the
same points, with extra emphasis on keeping the body short and pushing
everything conditional into references.

---

## 6. Proposed default stack (rationale)

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript, Node 20+ | Brief's default; largest model-training mass, so the AI writes it most reliably |
| HTTP | Hono | `app.routes` exposes method + path + handler as a plain array → the route-table drift check is ~10 lines and needs no server running. Tiny, runs anywhere, serves the UI too |
| DB | Postgres 15+, `pg` driver, **plain SQL migrations** | No ORM: the SQL in the repo *is* the thing the checker scans for table usage, and `information_schema` comparisons stay honest. An ORM inserts a layer between the manifest and the truth |
| Manifests | YAML, Backstage envelope, validated by JSON Schema 2020-12 via `ajv` | Human-readable, machine-checkable, versionable |
| Audit | supa_audit-style generic trigger + `jsonb` old/new + context columns from `current_setting('app.*', true)` | Synchronous, no extra process, cannot silently lag |
| Grants | one Postgres role per service/job, `GRANT`s generated from the manifest | Rule 3: "not touched" is a revoked privilege, not a comment |
| Runs | `runs` + `run_steps` tables in the same DB | Joins to the audit trail on `run_id`; one place to look |
| LLM accounting | `model`, `tokens_in`, `tokens_out`, `cost_usd`, `provider_generation_id` on the step; prices in a seeded table; backfill from OpenRouter `/generation` | Matches the invoice |
| UI | Server-rendered HTML from the same Hono app, no frontend build | The owner opens one URL; nothing to deploy separately; no npm build step for Claude to break |
| Gate safety | Gate signature receives deep-readonly input and a context with **no** db/fetch/llm handles; returns `{route, reason}`; validator rejects gates importing effectful modules | Type-enforced, per rule 5 |
| "Tables actually queried" | Static scan of SQL in each service's source + grants as the hard enforcement; `pg_stat_statements` (joined on `userid`) as an optional runtime confirmation | Static scan is deterministic and runs in CI; grants are the real fence; `pg_stat_monitor` would give per-statement table lists but adds an extension dependency |
| CI | GitHub Actions job: validate manifests → boot app → drift check → fail on any mismatch | Rule 7's teeth |

## 7. Summary of what is genuinely new here

1. Manifests whose every field maps to an **observable runtime fact** (most spec
   tools stop at prose).
2. A **deterministic, LLM-free drift checker** that diffs manifest ↔ route
   table, `information_schema`, `pg_trigger`, and grants.
3. **"Not touched" as an enforced negative** via per-service DB roles — no prior
   art found that does this from a manifest.
4. Audit context (actor / source / request_id / run_id) at **trigger** level,
   which is Bemi's context model with supa_audit's infrastructure-free storage.
5. A **flattened node → gate → node run record** with plain-English names,
   designed to be read by someone who cannot read code, instead of a graph.
6. All six surfaces (APIs, Data, Jobs, Runs, Audit, Drift) in **one UI inside the
   app**, so verification never requires a second vendor.

## Sources

- [Encore service catalog](https://encore.dev/docs/ts/observability/service-catalog), [Encore dev dashboard](https://encore.dev/docs/ts/observability/dev-dash), [Encore tracing](https://encore.dev/docs/tracing), [Encore open source / licence](https://encore.dev/docs/go/community/open-source)
- [Backstage descriptor format](https://backstage.io/docs/features/software-catalog/descriptor-format/), [ADR002 default catalog file format](https://github.com/backstage/backstage/blob/master/docs/architecture-decisions/adr002-default-catalog-file-format.md)
- [Apache Burr tracking](https://burr.apache.org/docs/concepts/tracking/), [Burr repo](https://github.com/apache/burr)
- [LangGraph conditional edges](https://theneuralbase.com/langgraph/learn/beginner/add-conditional-edges-routing-based-on-state/), [LangGraph checkpointing](https://activewizards.com/blog/langgraph-state-management-checkpointing-recovery-and-the-persistence-layer-decision/)
- [Temporal workflow definition / determinism](https://docs.temporal.io/workflow-definition), [Temporal side effects](https://docs.temporal.io/develop/go/workflows/side-effects), [Understanding Temporal](https://docs.temporal.io/evaluate/understanding-temporal)
- [Inngest repo](https://github.com/inngest/inngest), [Inngest vs Trigger.dev vs Restate](https://www.pkgpulse.com/guides/inngest-vs-trigger-dev-v3-vs-restate-2026)
- [Langfuse token & cost tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking)
- [OpenRouter get-generation](https://openrouter.ai/docs/api/api-reference/generations/get-generation)
- [Bemi docs — source database / CDC](https://docs.bemi.io/postgresql/source-database/), [Bemi Prisma integration](https://docs.bemi.io/orms/prisma/)
- [supa_audit repo](https://github.com/supabase/supa_audit), [Postgres Auditing in 150 lines of SQL](https://supabase.com/blog/postgres-audit), [pganalyze: pgaudit vs supa_audit](https://pganalyze.com/blog/5mins-postgres-auditing-pgaudit-supabase-supa-audit)
- [GitHub Spec Kit](https://github.com/github/spec-kit), [spec-driven.md](https://github.com/github/spec-kit/blob/main/spec-driven.md), [GitHub blog: spec-driven development](https://github.blog/ai-and-ml/generative-ai/spec-driven-development-with-ai-get-started-with-a-new-open-source-toolkit/)
- [awesome-spec-driven-development](https://github.com/engineering4ai/awesome-spec-driven-development), [Martin Fowler: Understanding SDD — Kiro, spec-kit, Tessl](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html)
- [anthropics/skills skill-creator SKILL.md](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md), [Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [PostgreSQL role_table_grants](https://www.postgresql.org/docs/current/infoschema-role-table-grants.html), [pg_stat_statements](https://www.postgresql.org/docs/current/pgstatstatements.html)

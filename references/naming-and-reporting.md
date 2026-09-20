# Naming and reporting rules

Short and binding. Read it before naming anything and before writing any report, commit
message or PR description.

## Naming

**Literal and descriptive. Never metaphor, nature, myth or mood.**

Banned, with no exceptions: `atlas`, `phoenix`, `hermes`, `nova`, `orion`, `falcon`,
`kraken`, `iris`, `helios`, `odin`, `prometheus` (unless it is the actual metrics tool),
`aurora`, `nimbus`, `cobalt`, `sentinel`, `beacon`, `forge`, `pipeline-x`, `core`,
`engine`, `handler2`, `utils`, `helpers`, `manager`, `processor`, `orchestrator`.

The test: **could the owner guess what it does from the name alone, without being told?**
If not, rename it.

| Thing | Convention | Good | Bad |
| --- | --- | --- | --- |
| Service | kebab-case, names the area it owns | `tenant-admin`, `invoice-export` | `atlas`, `core-api` |
| API manifest | kebab-case, `<noun>-<verb>` | `tenant-status-update`, `invoice-list` | `update-handler`, `ep-3` |
| Table | snake_case plural | `tenants`, `tenant_status_history` | `tbl_data`, `entity` |
| Column | snake_case, spells the word out | `suspended_reason`, `created_at` | `susp_rsn`, `flag1` |
| Job | kebab-case, `<noun>-<verb>` | `tenant-status-review`, `invoice-nightly-export` | `nightly-job`, `cron2` |
| Node | kebab-case verb phrase | `load-tenant`, `classify-reason`, `apply-status` | `step1`, `process` |
| Gate | kebab-case question | `check-reason-is-needed`, `accept-or-reject` | `router`, `decide` |
| File | matches the thing it holds | `tenant-status-update.ts` | `index2.ts`, `misc.ts` |
| Env var | SCREAMING_SNAKE, names the actor | `DATABASE_URL_SVC_TENANT_ADMIN` | `DB_URL_2` |

**`display_name` on nodes and gates is a sentence fragment in plain English**, because
the owner reads it in the Runs page:

| Step name | `display_name` | Not |
| --- | --- | --- |
| `load-tenant` | Load the organisation | LoadTenant |
| `check-reason-is-needed` | Does this reason need checking? | Reason gate |
| `classify-reason` | Check the reason makes sense | LLM classification step |
| `apply-status` | Apply the new status | Persist mutation |

Gate `display_name`s are questions. Node `display_name`s are actions. That alone makes a
run log readable.

**Descriptions** say what and why, in the owner's vocabulary, not the codebase's. Say
"customer organisation" if that is what the owner calls it, even if the table is `tenants`.

## Reporting to the owner

### Lead with the outcome

The first sentence says what is now true. Not what you did, not how it went, not what you
explored.

- Yes: *"`POST /api/tenants/:id/status` now suspends and reactivates organisations."*
- No: *"I've implemented the changes we discussed for the tenant workflow."*
- No: *"Great question! Let me walk you through the approach."*

### Name real things

Every claim refers to a file, endpoint, table, job, run or check that exists. If you
cannot name it, do not claim it.

- Yes: *"writes `tenants` and `tenant_status_history`"*
- No: *"persists the relevant state"*

### Banned phrasings

| Do not write | Because |
| --- | --- |
| "handles X gracefully" | unverifiable; say what happens on failure |
| "robust", "seamless", "production-ready" | adjectives the owner cannot check |
| "the system now supports…" | which file? which endpoint? |
| "improved performance" | by how much, measured how? |
| "should work", "should be fine" | did you run it or not? |
| "fully tested" | say which tests and that you ran them |
| "as requested" | filler |

### Required closing facts

Every report of a change ends with these, in this order, and they must be true:

1. **Drift check** — `npm run drift` result and the number of checks.
2. **Files changed** — real paths, grouped: manifests, migrations, code, UI.
3. **What the owner can now see** — which DevOps UI page shows the change.
4. **Anything you did not do** — skipped, blocked, or left for them to decide.

Item 4 is not optional. Omitting a known gap is the failure mode this whole project
exists to prevent.

### Template

```
POST /api/tenants/:tenantId/status now suspends and reactivates organisations.
An AI step checks the reason text first; if it rejects the reason, nothing changes
and the refusal is recorded.

Drift check: passes, 17 checks.

Changed:
  manifests/apis/tenant-status-update.yaml      new
  manifests/jobs/tenant-status-review.yaml      new
  prisma/migrations/20260920_tenant_status/     new — tenant_status_history + audit trigger + grants
  src/services/tenant-admin/routes/tenant-status-update.ts   new
  src/jobs/tenant-status-review/                new — 4 nodes, 2 gates

You can see it at:
  /devops/apis/tenant-status-update   what it touches, and what it cannot
  /devops/runs                        every run, step by step, with model cost
  /devops/audit?table=tenants         every status change and who made it

Not done:
  - No rate limit on the endpoint. Say the word and I'll add one.
  - Model cost backfill from OpenRouter is not wired up; cost shown is estimated
    from traceable.llm_model_prices, not billed cost.
```

### When something went wrong

Say it plainly, in the first sentence, with the evidence. Do not bury it under what
worked.

- Yes: *"The drift check fails: `grant.forbidden` — `job_tenant_status_review` has
  SELECT on `users`, which its manifest forbids. I have not merged this. The cause is
  the shared `svc_tenant_admin` role; fixing it means splitting the service, which is
  your call."*
- No: *"Mostly working! There's a minor drift warning to look at when you get a chance."*

### Do not

- Do not use emoji in reports, commit messages or PR descriptions.
- Do not include model names, session links or tool names in committed artifacts.
- Do not describe the code's structure unless asked. The owner does not care that you
  extracted a helper.
- Do not apologise at length. Correct the fact and continue.

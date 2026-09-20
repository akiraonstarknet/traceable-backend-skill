# Contributing

Thanks for helping. This project has one unusual constraint that shapes everything:
**its audience cannot read code.** Changes are judged on whether they make a non-coder
owner more able to verify their system, not on elegance.

## The rule that decides most pull requests

> If a claim in a manifest cannot be falsified by a script, the claim does not belong in
> a manifest.

Adding an unfalsifiable field is the most damaging thing you can do here, because it
teaches the owner that manifest fields are opinions. If you want to add a field, say in
the pull request **which runtime fact it is checked against**. If there isn't one, it
belongs in `metadata.description` as prose.

## Development setup

Node 20+ and PostgreSQL 15+.

```bash
git clone https://github.com/akiraonstarknet/traceable-backend-skill
cd traceable-backend-skill
npm install                       # deps for the scripts

cd examples/reference-app
npm install --legacy-peer-deps
psql -f scripts/bootstrap-superuser.sql     # once, as a superuser
psql -c "create database traceable_demo owner app_owner"
cp .env.example .env
npm run setup && npm run seed
```

`prisma` is pinned to 7.10.0 on purpose: npm's `latest` tag for it currently points at an
8.0 release candidate. `--legacy-peer-deps` works around an npm 10.9 peer-resolution bug
when installing it.

## Before you open a pull request

```bash
cd examples/reference-app && npx tsc --noEmit && npm run drift && npm run demo
cd ../..                  && npm test
```

All four must pass. `npm test` runs `scripts/self-test.mjs`, which breaks the reference
app sixteen different ways and asserts the checker catches each one.

## Adding a check

A new check needs all four of these, in the same pull request:

1. The check in `scripts/check-drift.mjs`, with a **`fix` string** on every finding. A
   finding the owner cannot act on is a finding they will learn to ignore.
2. A row in the check catalog in `references/drift-check-spec.md`.
3. A case in `scripts/self-test.mjs` that breaks the reference app in exactly that way
   and asserts the id appears. A checker nobody has seen fail is a checker nobody should
   trust.
4. A one-line plain-English explanation in `WHAT_EACH_CHECK_COMPARES` in
   `examples/reference-app/src/devops/pages/devops-drift.ts`, so the owner is told what
   the check actually compares.

Checks are errors, never warnings. A warning tier becomes a backlog of permanently-yellow
findings, and then the Drift page means nothing.

No check may call an LLM or compare prose. Non-deterministic checks cannot gate CI.

## Changing the skill's instructions

`SKILL.md` must stay under 500 lines; detail belongs in `references/`. Keep the
`description` in the frontmatter deliberately keyword-heavy — undertriggering is the
dominant failure mode for skills.

If you change a rule, change it in all three places it appears: `SKILL.md`, the relevant
`references/*.md`, and `templates/CLAUDE.md.snippet.md`.

## Changing the reference app

It must keep demonstrating **every** rule end-to-end, and `npm run drift` must exit 0.
If your change means the app no longer shows some rule, add whatever is needed to show it
again rather than dropping it.

The LLM node uses a deterministic offline stub unless `OPENROUTER_API_KEY` is set. Keep
it that way — a stub that behaved cleverly would make the demo look more convincing than
it is.

## Style

Follow `references/naming-and-reporting.md`. It applies to contributions too:

- Literal, descriptive names. No metaphor, nature or myth names.
- Comments explain *why*, especially where the code looks odd on purpose. The
  `raise exception` in the audit trigger and the deep-freeze in the runner both look
  excessive until you know what they prevent; say so.
- No emoji in code, commits or pull request descriptions.
- Pull request descriptions lead with the outcome and name real files. End with what you
  did not do.

## Reporting a problem

Most valuable bug report: **a case where the checker passes but should not.** That is a
false guarantee, which is worse than no guarantee. Include the manifest, the code, and
what the database actually allows.

Second most valuable: a check that fires when nothing is wrong. False positives train
people to ignore the Drift page.

## Licence

Contributions are accepted under Apache-2.0.

#!/usr/bin/env node
// traceable-backend: validate manifests against their JSON Schemas and against
// each other. Does not touch the database or the app — run it first, because a
// manifest that does not parse makes every other check meaningless.
//
// Usage: node scripts/validate-manifests.mjs [projectRoot]

import { resolve } from 'node:path';
import { loadConfig, loadManifests, crossReference, printFindings } from './lib/core.mjs';

const projectRoot = resolve(process.argv[2] ?? process.cwd());
const config = loadConfig(projectRoot);
const manifests = loadManifests(config);

const findings = [...manifests.findings];

// Cross-reference only makes sense once every file parsed and validated.
if (manifests.findings.length === 0) {
  findings.push(...crossReference(manifests, config));
}

const counted =
  manifests.apis.length + manifests.tables.length + manifests.jobs.length;

if (findings.length === 0) {
  console.log(
    `OK  ${counted} manifests valid ` +
    `(${manifests.apis.length} apis, ${manifests.tables.length} tables, ${manifests.jobs.length} jobs).`
  );
  process.exit(0);
}

printFindings(findings, counted);
process.exit(1);

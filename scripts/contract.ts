import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import YAML from 'yaml';
import { mobileOpenApi } from '../shared/mobile-contract.js';

const target = 'docs/mobile-api-v1.yaml';
const generated = `# GENERATED from shared/mobile-contract.ts by "npm run contract". Edit the TypeScript source, not this file.\n${YAML.stringify(mobileOpenApi, { lineWidth: 0, aliasDuplicateObjects: false })}`;
if (process.argv.includes('--check')) {
  const current = existsSync(target) ? readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== generated) {
    console.error(`${target} is out of date. Run npm run contract.`);
    process.exit(1);
  }
  console.log(`${target} matches shared/mobile-contract.ts.`);
} else {
  writeFileSync(target, generated);
  console.log(`Wrote ${target}.`);
}

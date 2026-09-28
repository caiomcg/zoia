import { appendFileSync } from 'node:fs';
import { classify, minimumVersion } from './lib/desktop-update.js';

const ref = process.argv[2] ?? 'HEAD';

const { base, files, updateType, reasons } = classify(ref);
const minimum = updateType === 'asar' ? minimumVersion(base) : null;

const uniqueReasons = [...new Set(reasons)];
console.log(`Desktop update classification: ${updateType}`);
console.log(`Comparison base: ${base ?? 'none'}`);
console.log(`Changed files: ${files.length}`);
if (uniqueReasons.length) console.log(`Full-release reasons: ${uniqueReasons.join('; ')}`);
if (minimum) console.log(`Minimum installed version for OTA: ${minimum}`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `update_type=${updateType}\nbase_tag=${base ?? ''}\nminimum_version=${minimum ?? ''}\n`,
  );
}

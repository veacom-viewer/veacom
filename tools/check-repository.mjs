import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const dicomMarker = Buffer.from('DICM');
const forbiddenName = file => /^electron\/telemetry-endpoint\.json(?:\.|$)/i.test(file)
  || /\.py[wicoz]?$/i.test(file) || /(^|\/)requirements[^/]*\.txt$/i.test(file)
  || /^(app|bench|next|knowledge)\//.test(file) || /(^|\/)node_modules\/|^native\/target(?:\/|$)/.test(file)
  || /\.(pem|key|p12|pfx|dcm|dicom|ima|zip|rar|7z|tgz|tar(\.gz)?)$/i.test(file) || /(^|\/)DICOMDIR$/i.test(file)
  || (/(^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith('.env.example'))
  // Editor and agent settings that run code when the folder is opened. The 2026 ChainDrop worm committed
  // .claude/settings.json hooks and .vscode/tasks.json tasks to the repositories it reached.
  || /(^|\/)\.(claude|vscode|cursor|devcontainer|idea|husky)\//.test(file) || /(^|\/)\.mcp\.json$/.test(file);
const rejected = files.filter(file => {
  if (forbiddenName(file) || !lstatSync(file).isFile()) return true;
  const header = Buffer.alloc(132), fd = openSync(file, 'r');
  try { readSync(fd, header, 0, header.length, 0); } finally { closeSync(fd); }
  return header.subarray(128, 132).equals(dicomMarker) || ['504b0304', '504b0506', '504b0708'].includes(header.toString('hex', 0, 4))
    || header.toString('hex', 0, 6) === '526172211a07';
});
if (rejected.length) throw new Error(`Files excluded by repository policy:\n${rejected.join('\n')}`);

// Every package name in the lockfiles must be listed in tools/dependency-names.txt, so a new dependency, direct or
// transitive, arrives as a reviewed line in its pull request. Version bumps need no change there.
const NAMES = 'tools/dependency-names.txt';
const CRATES_IO = /^(registry\+https:\/\/github\.com\/rust-lang\/crates\.io-index|sparse\+https:\/\/index\.crates\.io\/)$/;
const locked = new Set(), foreign = [];
for (const file of files) {
  if (/(^|\/)pnpm-lock\.yaml$/.test(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = /^  '?((?:@[^/\s']+\/)?[^@\s'/]+)@[^\s']+'?:(?: \{\})?$/.exec(line);
      if (match) locked.add(`npm ${match[1]}`);
    }
  } else if (/(^|\/)Cargo\.lock$/.test(file)) {
    for (const block of readFileSync(file, 'utf8').split('[[package]]').slice(1)) {
      const name = /^name = "([^"]+)"$/m.exec(block)?.[1], source = /^source = "([^"]+)"$/m.exec(block)?.[1];
      if (!name || !source) continue; // a crate of this repository
      if (!CRATES_IO.test(source)) foreign.push(`${file}: ${name} from ${source}`);
      locked.add(`crate ${name}`);
    }
  }
}
if (foreign.length) throw new Error(`Crates must come from crates.io:\n${foreign.join('\n')}`);
if (locked.size) {
  if (!existsSync(NAMES)) throw new Error(`${NAMES} is missing: it lists every package name the lockfiles may contain.`);
  const listed = new Set(readFileSync(NAMES, 'utf8').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')));
  const added = [...locked].filter(name => !listed.has(name)).sort();
  const gone = [...listed].filter(name => !locked.has(name)).sort();
  if (added.length || gone.length) throw new Error([
    added.length && `New package names in the lockfiles. Check who publishes each one and why it arrived, then add these lines to ${NAMES}:\n${added.join('\n')}`,
    gone.length && `No lockfile contains these names any more; delete their lines from ${NAMES}:\n${gone.join('\n')}`,
  ].filter(Boolean).join('\n\n'));
}
console.log(`PASS repository policy (${files.length} tracked files, ${locked.size} dependency names)`);

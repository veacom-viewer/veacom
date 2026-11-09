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
// Every check in tools/ is started by something: a workflow, tools/verify.sh, a package script or another tool. A check
// that nothing starts goes stale unnoticed. Only these run by hand, each for the reason given.
const BY_HAND = new Map([
  ['tools/check-resource-spikes.cjs', 'a release check: a packaged build on the fingerprinted ct-small, which CI cannot make, through the usage consent'],
  ['tools/check-window-and-segmentation.cjs', 'it needs public research studies (a mammogram without a stored window, a CT with DICOM SEG) that CI does not download'],
]);
const checks = files.filter(file => /^tools\/check-[^/]+\.(?:cjs|mjs|ps1)$/.test(file));
// What a file runs, its comments left out: a check that only a comment names is not started. Quoted text is kept
// whole, so a # or // inside a string does not cut off the command after it. A quote ends at the line's end, except a
// JavaScript template literal; a backslash escapes in JavaScript strings and in double-quoted shell text.
function code(file, text) {
  if (file.endsWith('.json')) return text;
  const js = !/\.(?:ya?ml|sh|ps1)$/.test(file), ps1 = file.endsWith('.ps1');
  const skipTo = (from, end) => { const at = text.indexOf(end, from); return at < 0 ? text.length : at + end.length; };
  let out = '', quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      out += c;
      if (c === '\\' && (js || quote === '"')) out += text[++i] ?? '';
      else if (c === quote || (c === '\n' && quote !== '`')) quote = null;
      continue;
    }
    const afterSpace = i === 0 || /\s/.test(text[i - 1]);
    if (js && text.startsWith('/*', i)) { i = skipTo(i + 2, '*/') - 1; continue; }
    if (js && text.startsWith('<!--', i)) { i = skipTo(i + 4, '-->') - 1; continue; }
    if (ps1 && text.startsWith('<#', i)) { i = skipTo(i + 2, '#>') - 1; continue; }
    if ((js && text.startsWith('//', i)) || (!js && c === '#' && afterSpace)) {
      const end = text.indexOf('\n', i);
      if (end < 0) break;
      i = end - 1; // the newline itself is kept
      continue;
    }
    if (c === '"' || c === "'" || (js && c === '`')) quote = c;
    out += c;
  }
  return out;
}
const starters = files.filter(file => /\.(?:ya?ml|sh|json|[cm]?js|ts|html|ps1)$/.test(file) && file !== 'tools/check-repository.mjs' && existsSync(file))
  .map(file => [file, code(file, readFileSync(file, 'utf8'))]);
const unstarted = checks.filter(check => !BY_HAND.has(check)
  && !starters.some(([file, text]) => file !== check && text.includes(check.slice('tools/'.length))));
if (unstarted.length) throw new Error(`Nothing starts these checks; run each from CI (.github/workflows) or tools/verify.sh:\n${unstarted.join('\n')}`);
const started = [...BY_HAND.keys()].filter(check => starters.some(([file, text]) => file !== check && text.includes(check.slice('tools/'.length))));
if (started.length) throw new Error(`These checks now run, so delete them from BY_HAND in tools/check-repository.mjs:\n${started.join('\n')}`);

console.log(`PASS repository policy (${files.length} tracked files, ${locked.size} dependency names, ${checks.filter(check => !BY_HAND.has(check)).length} checks started)`);

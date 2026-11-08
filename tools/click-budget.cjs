// Click budgets: how many actions each canonical task takes, counted by the app's own usage timings
// (src/usage) while a desktop check drives it with real mouse and keyboard input. Like a performance
// budget, a change that makes a path longer fails the check: the task needs more actions than
// tools/click-budgets.json allows. A shorter path passes and says the budget can come down. A step that
// changes nothing fails too: it is a wasted click, or an effect the usage timings cannot see.
//
// Counting uses the same events the field sends, so the checks also prove each control reports one
// action. An action with no id ('other') fails: give the control a data-testid or data-action.
const fs = require('node:fs');
const path = require('node:path');

const BUDGET_FILE = path.join(__dirname, 'click-budgets.json');

function readBudgets(file = BUDGET_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { tasks: {} }; }
}

class ClickBudget {
  /**
   * @param page Playwright page of the VEAcom window
   * @param options.record write the counts observed as the new budgets (VEACOM_RECORD_BUDGETS=1)
   */
  constructor(page, { file = BUDGET_FILE, record = process.env.VEACOM_RECORD_BUDGETS === '1', label = '' } = {}) {
    Object.assign(this, { page, file, record, label });
    this.budgets = readBudgets(file).tasks ?? {};
    this.results = [];
  }
  /** The window's usage events so far, with any action still settling closed first. */
  events() { return this.page.evaluate(() => window.__VEACOM_TEST__.usage()); }
  async mark() { return Math.max(0, ...(await this.events()).map(event => event.attributes['veacom.seq'] ?? 0)); }
  /** Actions recorded after a mark (from `mark()`). */
  async actionsSince(mark) {
    return (await this.events()).filter(event => event.name === 'ux.action' && event.attributes['veacom.seq'] > mark);
  }
  /**
   * Runs one task with real input and counts its actions. `until` waits for the task's visible end;
   * its time is recorded (not budgeted: machines differ).
   */
  async task(name, run, { until } = {}) {
    const mark = await this.mark(), started = Date.now();
    await run();
    if (until) await until();
    const elapsedMs = Date.now() - started;
    return this.count(name, await this.actionsSince(mark), elapsedMs);
  }
  /** Records a count measured some other way (from a list of action events). */
  count(name, actions, elapsedMs = null) {
    const ids = actions.map(event => event.attributes['veacom.action']);
    const budget = this.budgets[name];
    const unnamed = ids.filter(id => id === 'other').length;
    const idle = actions.filter(event => !event.attributes['veacom.changed']).map(event => event.attributes['veacom.action']);
    const status = unnamed ? 'unnamed' : idle.length ? 'idle' : budget === undefined ? 'new' : ids.length > budget ? 'over' : ids.length < budget ? 'under' : 'pass';
    const result = { task: name, actions: ids.length, budget: budget ?? null, status, path: ids, idle, elapsedMs };
    this.results.push(result);
    const note = { pass: '', under: ` (budget ${budget}: lower it)`, over: ` > budget ${budget}`, new: ' (no budget yet)', unnamed: ` (${unnamed} control(s) without an action id)`, idle: ` (${idle.join(', ')} changed nothing)` }[status];
    console.log(`${status === 'over' || status === 'unnamed' || status === 'idle' ? 'FAIL' : 'PASS'} click budget ${name}: ${ids.length} action(s)${note} [${ids.join(' → ')}]${elapsedMs === null ? '' : ` ${elapsedMs} ms`}`);
    return result;
  }
  /** Throws when a path got longer, a step changed nothing, a control has no id, or (unless recording) a task has no budget. */
  assert() {
    if (this.record) { this.save(); return; }
    const failed = this.results.filter(result => ['over', 'unnamed', 'new', 'idle'].includes(result.status));
    if (failed.length) throw new Error(`Click budgets failed: ${failed.map(result => `${result.task} ${result.actions}${result.status === 'idle' ? ` (${result.idle.join(', ')} changed nothing)` : result.budget === null ? ' (no budget)' : ` > ${result.budget}`} [${result.path.join(' → ')}]`).join('; ')}`);
  }
  /** Writes the observed counts as budgets (keeps the other tasks' budgets). */
  save() {
    const current = readBudgets(this.file);
    const tasks = { ...(current.tasks ?? {}) };
    for (const result of this.results) if (result.status !== 'unnamed') tasks[result.task] = result.actions;
    const sorted = Object.fromEntries(Object.entries(tasks).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(this.file, `${JSON.stringify({ ...current, tasks: sorted }, null, 2)}\n`);
    console.log(`Recorded ${this.results.length} click budget(s) in ${path.relative(process.cwd(), this.file)}`);
  }
}

module.exports = { ClickBudget, readBudgets, BUDGET_FILE };

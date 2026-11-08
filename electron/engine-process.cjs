const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { EngineChannel, PROTOCOL } = require('./engine-pipe.cjs');
const { t } = require('./i18n.cjs');

// The engine runs as this process's child and is reached only through its stdin and stdout (engine-pipe.cjs). A
// connection is { generation, request(op, body, { signal }) }; request answers with a Response.
class EngineProcess extends EventEmitter {
  constructor({ binary, args = [], env = process.env, spawnImpl = spawn, startupTimeoutMs = 30_000,
    restartDelaysMs = [250, 1000], shutdownTimeoutMs = 1500, exitTimeoutMs = 5000, killTimeoutMs = 1000,
    stderr = data => process.stderr.write(data) }) {
    super();
    Object.assign(this, { binary, args, env, spawnImpl, startupTimeoutMs, restartDelaysMs,
      shutdownTimeoutMs, exitTimeoutMs, killTimeoutMs, stderr });
    this.generation = 0;
    this.restartCount = 0;
    this.closed = false;
    this.current = null;
    this.cleanups = new Set();
    this.snapshot = { status: 'stopped', generation: 0, restartCount: 0 };
  }

  state() { return { ...this.snapshot }; }
  publish(status, message) {
    this.snapshot = { status, generation: this.generation, restartCount: this.restartCount, ...(message ? { message } : {}) };
    this.emit('state', this.state());
  }
  connection(expectedGeneration) {
    const connection = this.current?.connection;
    if (this.closed || this.snapshot.status !== 'ready' || !connection) {
      throw new Error(this.snapshot.message || t('engine.unavailable'));
    }
    if (expectedGeneration !== undefined && expectedGeneration !== connection.generation) {
      throw new Error(t('engine.restartedReopen'));
    }
    return { ...connection };
  }
  start() {
    if (this.closed) return Promise.reject(new Error(t('engine.stopping')));
    if (this.startPromise) {
      if (this.snapshot.status === 'starting') return this.startPromise;
      try { return Promise.resolve(this.connection()); } catch (error) { return Promise.reject(error); }
    }
    this.startPromise = this.launch('starting').catch(error => {
      if (!this.closed) this.publish('failed', error.message);
      throw error;
    });
    return this.startPromise;
  }
  launch(status, message) {
    if (this.closed) return Promise.reject(new Error(t('engine.stopping')));
    const run = { generation: ++this.generation, retired: false, exited: false, connection: null, exports: new Set() };
    this.current = run;
    return new Promise((resolve, reject) => {
      run.reject = reject;
      run.exit = new Promise(done => { run.resolveExit = done; });
      this.publish(status, message);
      if (this.closed || run.retired) return;
      const fail = (error, reason) => {
        if (run.retired || this.current !== run) return;
        this.retire(run);
        void this.afterFailure(run, reason).then(() => reject(error), reject);
      };
      try {
        run.child = this.spawnImpl(this.binary, this.args, { stdio: ['pipe', 'pipe', 'pipe'], env: this.env, windowsHide: true });
      } catch (error) { fail(error, 'launch-failed'); return; }
      run.timeout = setTimeout(() => fail(new Error(t('engine.startTimeout', { seconds: this.startupTimeoutMs / 1000 })), 'startup-timeout'), this.startupTimeoutMs);
      const broken = (error, reason) => {
        if (run.retired || this.current !== run) return;
        if (!run.connection) { fail(error, reason); return; }
        this.retire(run);
        void this.afterFailure(run, reason).then(() => this.recover(error.message), cleanupError => {
          if (!this.closed) this.publish('failed', cleanupError.message);
        });
      };
      const channel = new EngineChannel(run.child.stdout, run.child.stdin, {
        stopped: () => new Error(t('engine.unavailable')), onFailure: broken,
      });
      channel.hello.then(hello => {
        if (run.retired || this.current !== run || run.connection) return;
        try {
          if (hello?.protocol !== PROTOCOL) throw new Error(t('engine.incompatible'));
          clearTimeout(run.timeout);
          run.connection = { generation: run.generation, request: (op, body, options) => {
            const answer = channel.request(op, body, options);
            if (op === 'export') {
              run.exports.add(answer);
              void answer.then(() => run.exports.delete(answer), () => run.exports.delete(answer));
            }
            return answer;
          } };
          this.publish('ready', this.restartCount ? t('engine.restartedEmpty') : undefined);
          if (this.closed || run.retired) reject(new Error(t('engine.stopping')));
          else resolve({ ...run.connection });
        } catch (error) { fail(error, 'protocol-error'); }
      }, broken);
      run.child.stderr.on('data', this.stderr);
      run.child.on('error', error => channel.close(error, run.child.pid ? 'pipe-error' : 'launch-failed'));
      run.child.on('exit', (code, signal) => {
        run.exited = true; run.code = code; run.signal = signal;
        run.resolveExit();
        channel.close(new Error(t('engine.stoppedUnexpectedly', { reason: signal || code })), 'unexpected-exit');
      });
    });
  }
  retire(run) {
    run.retired = true;
    clearTimeout(run.timeout);
    if (this.current === run) this.current = null;
  }
  async afterFailure(run, reason) {
    // stdout EOF commonly precedes the OS exit event. Let it supply the actual signal/code. A child that
    // closes its pipes but stays alive still goes through bounded termination and recovery.
    try { await this.cleanup(run, false, reason === 'pipe-closed' || reason === 'pipe-error'); }
    finally {
      const natural = !run.killedByManager && run.exited && ['pipe-closed', 'pipe-error', 'unexpected-exit'].includes(reason);
      this.emit('incident', { reason: natural ? (run.signal ? 'signal' : 'unexpected-exit') : reason,
        code: natural ? run.code : null, signal: natural ? run.signal : null });
    }
  }
  recover(message) {
    if (this.closed) return;
    if (this.cleanupFailed) {
      this.publish('failed', message);
      return;
    }
    if (this.restartCount >= this.restartDelaysMs.length) {
      this.publish('failed', t('engine.restartLimit', { message }));
      return;
    }
    const delay = this.restartDelaysMs[this.restartCount++];
    const notice = t('engine.restarting', { message });
    this.publish('restarting', notice);
    if (this.closed) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.launch('restarting', notice).catch(error => this.recover(error.message));
    }, delay);
  }
  async waitForExit(run, milliseconds) {
    if (!run.child?.pid || run.exited) return true;
    let timer;
    try { return await Promise.race([run.exit.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
    finally { clearTimeout(timer); }
  }
  cleanup(run, graceful, awaitExit = false) {
    const task = this.terminate(run, graceful, awaitExit).catch(error => { this.cleanupFailed = true; throw error; });
    this.cleanups.add(task);
    void task.then(() => this.cleanups.delete(task), () => this.cleanups.delete(task));
    return task;
  }
  async terminate(run, graceful, awaitExit) {
    if (!run.child?.pid || run.exited) return;
    if (awaitExit && await this.waitForExit(run, 250)) return;
    if (graceful && run.connection) {
      try {
        const response = await run.connection.request('shutdown', undefined, { signal: AbortSignal.timeout(this.shutdownTimeoutMs) });
        await response.arrayBuffer();
        // An acknowledged shutdown cancels exports between files. Their HEAD arrives after rollback, including
        // on slow/removable media. The forced-exit timer starts after those writes are finished.
        if (response.ok) await Promise.allSettled([...run.exports]);
      } catch { /* Terminate the owned child when graceful shutdown is unavailable. */ }
      // An engine whose stdin closes stops as for a shutdown, also one that missed the request.
      run.child.stdin?.end();
      if (await this.waitForExit(run, this.exitTimeoutMs)) return;
    }
    run.killedByManager = true;
    run.child.kill();
    if (await this.waitForExit(run, this.killTimeoutMs)) return;
    run.child.kill('SIGKILL');
    if (!await this.waitForExit(run, this.killTimeoutMs)) throw new Error(t('engine.cannotStop'));
  }
  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.closed = true;
    clearTimeout(this.restartTimer);
    const run = this.current;
    if (run) {
      this.retire(run);
      if (!run.connection) run.reject(new Error(t('engine.stopping')));
    }
    this.publish('stopping');
    this.stopPromise = (async () => {
      try {
        if (run) await this.cleanup(run, true);
        await Promise.all([...this.cleanups]);
      }
      finally { this.publish('stopped'); }
    })();
    return this.stopPromise;
  }
}

module.exports = { EngineProcess };

'use strict';
// The viewer, its on-disk queue, and the intake server all check the same wire format.
const PROCESSES = ['main', 'renderer', 'gpu', 'utility', 'helper', 'engine'];
const REASONS = ['abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction',
  'unexpected-exit', 'signal', 'pipe-closed', 'pipe-error', 'protocol-error', 'startup-timeout',
  'uncaught-exception', 'unhandled-rejection', 'unclean-exit', 'unknown'];
const SIGNALS = new Set(['SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGIO', 'SIGKILL',
  'SIGPIPE', 'SIGPROF', 'SIGQUIT', 'SIGSEGV', 'SIGSYS', 'SIGTERM', 'SIGTRAP', 'SIGUSR1', 'SIGUSR2', 'SIGVTALRM',
  'SIGXCPU', 'SIGXFSZ', 'SIGBREAK']);
const FIELDS = ['id', 'at', 'version', 'platform', 'arch', 'environment', 'process', 'reason', 'code', 'signal', 'recovery'];
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc)\.\d{1,4})?$/;
function buildInfo(version, platform, arch, environment, revision) {
  return { version: typeof version === 'string' && VERSION.test(version) ? version : 'unknown',
    build: typeof revision === 'string' && /^[0-9a-f]{40}$/.test(revision) ? revision : 'unknown',
    platform: ['win32', 'darwin', 'linux'].includes(platform) ? platform : 'other',
    arch: ['x64', 'arm64', 'ia32', 'arm'].includes(arch) ? arch : 'other',
    environment: ['field', 'lab', 'dev'].includes(environment) ? environment : 'dev' };
}
function isCode(code) { return Number.isInteger(code) && code >= -2147483648 && code <= 4294967295; }
function validReport(r, pending = false) {
  return r !== null && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length === FIELDS.length + Number(Object.hasOwn(r, 'build'))
    && FIELDS.every(key => Object.hasOwn(r, key))
    && (!Object.hasOwn(r, 'build') || r.build === 'unknown' || (typeof r.build === 'string' && /^[0-9a-f]{40}$/.test(r.build)))
    && typeof r.id === 'string' && /^[0-9a-f]{32}$/.test(r.id) && !/^0+$/.test(r.id)
    && Number.isSafeInteger(r.at) && r.at >= 1483228800000 && r.at < 4102444800000
    && typeof r.version === 'string' && (r.version === 'unknown' || VERSION.test(r.version))
    && ['win32', 'darwin', 'linux', 'other'].includes(r.platform) && ['x64', 'arm64', 'ia32', 'arm', 'other'].includes(r.arch)
    && ['field', 'lab', 'dev'].includes(r.environment) && PROCESSES.includes(r.process) && REASONS.includes(r.reason)
    && (r.code === null || isCode(r.code)) && (r.signal === null || SIGNALS.has(r.signal))
    && (['unknown', 'restarted', 'failed'].includes(r.recovery) || (pending && r.recovery === 'pending'));
}
module.exports = { REASONS, SIGNALS, buildInfo, isCode, validReport };

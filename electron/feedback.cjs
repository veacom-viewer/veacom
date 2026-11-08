// In-app feedback to the team. The page only asks; main sends, and only once the user has confirmed the
// exact text in a native dialog the page cannot answer. Without that, a compromised page could send
// anything it can read, such as a study's patient details, with nobody noticing. veacom.app mails the
// message to the team and keeps nothing.
const os = require('node:os');

const ENDPOINT = 'https://veacom.app/api/feedback';
const KINDS = ['problem', 'suggestion'];
// The same rule as the form's, so main never sends an address the form would refuse.
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_MESSAGE = 5000;
const PAGE_LENGTH = 600;
// Each confirmation counts, sent or not, so a page cannot keep the dialog coming back.
const WINDOW_MS = 60 * 60 * 1000;
const PER_WINDOW = 10;

/**
 * Where feedback goes. Installed apps always use veacom.app. A development run sends nothing unless
 * VEACOM_FEEDBACK_ENDPOINT names an https address or a local test server, so checks and dev runs
 * never mail the team by accident.
 */
function feedbackEndpoint({ packaged, env = {} }) {
  if (packaged) return ENDPOINT;
  const value = env.VEACOM_FEEDBACK_ENDPOINT;
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    return url.protocol === 'https:' || local ? url.href : null;
  } catch { return null; }
}

/** The page's request, checked again here; `null` for anything malformed. */
function normalise(payload) {
  if (!payload || typeof payload !== 'object' || !KINDS.includes(payload.kind)) return null;
  const message = typeof payload.message === 'string' ? payload.message.replace(/\r\n?|[\u2028\u2029]/g, '\n').trim() : '';
  if (!message || message.length > MAX_MESSAGE || !message.isWellFormed() || /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u.test(message)) return null;
  const email = typeof payload.email === 'string' ? payload.email.trim() : '';
  const emailValid = !email || (email.length <= 254 && !CONTROL.test(email) && EMAIL.test(email));
  return { kind: payload.kind, message, email, emailValid, includeSystem: payload.includeSystem === true };
}

/** Each native dialog shows a bounded part of the same normalized message sent to the server. */
function messagePages(message) {
  const pages = [];
  let page = '', lines = 1;
  for (const character of message) {
    if (page.length + character.length > PAGE_LENGTH || (character === '\n' && lines === 6)) {
      pages.push(page);
      page = ''; lines = 1;
    }
    page += character;
    if (character === '\n') lines++;
  }
  pages.push(page);
  return pages;
}

function describeFeedback(body, t) {
  return t('feedback.confirmDetail', {
    kind: t(body.kind === 'problem' ? 'feedback.kindProblem' : 'feedback.kindSuggestion'),
    email: body.email || t('feedback.noEmail'),
    system: body.app ? `${body.app}, ${body.system}` : t('feedback.noSystem'),
    message: body.message,
  });
}

function createFeedbackSender({ fetch, confirm, version, locale, endpoint, system = () => `${process.platform} ${os.release()} ${process.arch}`, now = Date.now }) {
  let busy = false;
  const asked = [];
  return async function send(payload) {
    const request = normalise(payload);
    if (!request) throw new Error('Invalid feedback.');
    if (!request.emailValid) return { ok: false, status: 400, reason: 'email' };
    if (!endpoint) return { ok: false, status: 503, reason: 'off' };
    if (busy) return { ok: false, status: 409, reason: 'busy' };
    while (asked.length && now() - asked[0] >= WINDOW_MS) asked.shift();
    if (asked.length >= PER_WINDOW) return { ok: false, status: 429, reason: 'local' };
    busy = true;
    try {
      asked.push(now());
      // The language is main's own; the system line only when the user left that box ticked.
      const body = { kind: request.kind, message: request.message, email: request.email, locale: locale(),
        ...(request.includeSystem ? { app: `VEAcom ${version}`, system: system() } : {}) };
      if (!await confirm(body)) return { ok: false, cancelled: true };
      // A fixed User-Agent and language, so an unticked box really leaves out the version and
      // system; no cookies; and no redirects, which would carry the message somewhere else.
      const response = await fetch(endpoint, { method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'VEAcom-Feedback', 'Accept-Language': body.locale },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      if (response.status === 204) return { ok: true };
      const reason = await response.json().then(value => typeof value?.error === 'string' ? value.error : undefined, () => undefined);
      return { ok: false, status: response.status, reason };
    } finally { busy = false; }
  };
}

function registerFeedback({ handle, dialog, getWindow, t, net, app, locale, env = process.env }) {
  const send = createFeedbackSender({
    fetch: (url, options) => net.fetch(url, options),
    version: app.getVersion(),
    locale,
    endpoint: feedbackEndpoint({ packaged: app.isPackaged, env }),
    confirm: async body => {
      const pages = messagePages(body.message);
      for (const [index, message] of pages.entries()) {
        const last = index === pages.length - 1;
        const { response } = await dialog.showMessageBox(getWindow(), {
          type: 'question', defaultId: 0, cancelId: 0, noLink: true, title: t('feedback.confirmTitle'),
          buttons: [t('feedback.confirmCancel'), t(last ? 'feedback.confirmSend' : 'feedback.confirmNext')],
          message: pages.length === 1 ? t('feedback.confirmMessage') : t('feedback.confirmPage', { page: index + 1, total: pages.length }),
          detail: describeFeedback({ ...body, message }, t),
        });
        if (response !== 1) return false;
      }
      return true;
    },
  });
  handle('feedback:send', payload => send(payload));
}

module.exports = { ENDPOINT, createFeedbackSender, describeFeedback, feedbackEndpoint, messagePages, registerFeedback };

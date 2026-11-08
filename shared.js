/*
 * YouTube Focus Board — shared helpers.
 * Loaded by the content script, the popup, the board page and the background worker.
 * Everything is stored in chrome.storage.local, so it survives a Chrome restart
 * and never leaves this computer.
 */
(function (root) {
  'use strict';

  const UNLOCK_MINUTES = 60;

  const DEFAULT_SETTINGS = {
    hideShorts: true,
    hideRecs: true,
    hideComments: true,
    gate: true,
    panelCollapsed: false,
  };

  // study:   [{ id, title, channel, duration, pos, done, topic, addedAt, doneAt }]
  // notes:   { [videoId]: { title, items: [{ id, t, text, at }] } }
  // time:    { 'YYYY-MM-DD': { total: seconds, study: seconds } }
  // unlock:  { until, reason, at } | null
  // gateLog: [{ at, reason, kind: 'fun' | 'study', videoId, title }]
  const KEYS = ['settings', 'study', 'notes', 'time', 'unlock', 'gateLog'];

  function normalize(key, value) {
    switch (key) {
      case 'settings': return { ...DEFAULT_SETTINGS, ...(value && typeof value === 'object' ? value : {}) };
      case 'study': return Array.isArray(value) ? value : [];
      case 'notes': return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      case 'time': return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      case 'unlock': return value && typeof value.until === 'number' ? value : null;
      case 'gateLog': return Array.isArray(value) ? value : [];
      default: return value;
    }
  }

  async function getAll() {
    const raw = await chrome.storage.local.get(KEYS);
    const out = {};
    for (const k of KEYS) out[k] = normalize(k, raw[k]);
    return out;
  }

  async function get(key) {
    const raw = await chrome.storage.local.get(key);
    return normalize(key, raw[key]);
  }

  /** Read one key, change it with fn, write it back. Returns the new value. */
  async function update(key, fn) {
    const current = await get(key);
    const next = await fn(current);
    await chrome.storage.local.set({ [key]: next });
    return next;
  }

  /* ---------- time ---------- */

  function dayKey(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /** Last n days, oldest first: [{ key, date, label }] */
  function lastDays(n = 7) {
    const out = [];
    const now = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      out.push({
        key: dayKey(d),
        date: d,
        label: i === 0 ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' }),
      });
    }
    return out;
  }

  /** 760 -> "12:40", 3725 -> "1:02:05" */
  function clock(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const ss = String(s).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  /** 2280 -> "38 min", 4500 -> "1 h 15 min", 20 -> "<1 min" */
  function duration(sec) {
    if (sec > 0 && sec < 60) return '<1 min';
    const mins = Math.floor((sec || 0) / 60);
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }

  function ago(ts) {
    const diff = Math.max(0, Date.now() - ts);
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.floor(h / 24);
    return d === 1 ? 'yesterday' : `${d} days ago`;
  }

  /* ---------- unlock gate ---------- */

  function isUnlocked(unlock, now = Date.now()) {
    return !!(unlock && unlock.until > now);
  }

  function minutesLeft(unlock, now = Date.now()) {
    if (!isUnlocked(unlock, now)) return 0;
    return Math.max(1, Math.ceil((unlock.until - now) / 60000));
  }

  /** A reason must be a real sentence: at least 3 words and 12 letters. */
  function reasonProblem(text) {
    const t = (text || '').trim();
    const words = t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
    if (words.length < 3) return `Write at least 3 words (${words.length}/3).`;
    if (t.replace(/[^\p{L}\p{N}]/gu, '').length < 12) return 'A little more detail, please.';
    if (/^(.)\1+$/.test(t.replace(/\s/g, ''))) return 'That does not look like a reason.';
    return '';
  }

  /* ---------- videos ---------- */

  const ID_RE = /^[A-Za-z0-9_-]{11}$/;

  /** Accepts a full YouTube link, a youtu.be link, a Shorts link or a bare 11-character id. */
  function parseVideoId(input) {
    if (!input) return null;
    const text = String(input).trim();
    if (ID_RE.test(text)) return text;
    try {
      const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
      const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '');
      if (host === 'youtu.be') {
        const id = url.pathname.slice(1).split('/')[0];
        return ID_RE.test(id) ? id : null;
      }
      if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
        const v = url.searchParams.get('v');
        if (v && ID_RE.test(v)) return v;
        const m = url.pathname.match(/^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})/);
        if (m) return m[1];
      }
    } catch (_) { /* not a URL */ }
    return null;
  }

  function watchUrl(id, t) {
    const sec = Math.floor(t || 0);
    return `https://www.youtube.com/watch?v=${id}${sec > 0 ? `&t=${sec}s` : ''}`;
  }

  function newStudyItem(id, extra = {}) {
    return {
      id,
      title: '',
      channel: '',
      duration: 0,
      pos: 0,
      done: false,
      topic: '',
      addedAt: Date.now(),
      doneAt: 0,
      ...extra,
    };
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  root.YFB = {
    UNLOCK_MINUTES,
    DEFAULT_SETTINGS,
    KEYS,
    normalize,
    getAll,
    get,
    update,
    dayKey,
    lastDays,
    clock,
    duration,
    ago,
    isUnlocked,
    minutesLeft,
    reasonProblem,
    parseVideoId,
    watchUrl,
    newStudyItem,
    uid,
    escapeHtml,
  };
})(typeof self !== 'undefined' ? self : globalThis);

/*
 * YouTube Focus Board — background service worker.
 * - Adds up watch time sent by YouTube tabs (one queue, so tabs never overwrite each other).
 * - Shows minutes left on the toolbar badge while YouTube is unlocked.
 * - Opens the board page.
 */
importScripts('shared.js');

const KEEP_DAYS = 120;
let queue = Promise.resolve();

function enqueue(job) {
  queue = queue.then(job).catch((err) => console.warn('[Focus Board]', err));
  return queue;
}

async function addTime(sec, study) {
  sec = Math.max(0, Math.min(Number(sec) || 0, 600));
  study = Math.max(0, Math.min(Number(study) || 0, sec));
  if (!sec) return;
  await YFB.update('time', (time) => {
    const key = YFB.dayKey();
    const day = time[key] || { total: 0, study: 0 };
    day.total += sec;
    day.study += study;
    time[key] = day;
    // keep the store small
    const keys = Object.keys(time).sort();
    while (keys.length > KEEP_DAYS) delete time[keys.shift()];
    return time;
  });
}

async function openBoard(hash = '') {
  const url = chrome.runtime.getURL(`board/board.html${hash}`);
  await chrome.tabs.create({ url });
}

/** Free title lookup for a video id (YouTube oEmbed, no key, no login). */
async function fetchTitle(id) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(YFB.watchUrl(id))}`,
      { signal: ctrl.signal, credentials: 'omit' }
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    return { title: data.title || '', channel: data.author_name || '' };
  } catch (_) {
    return null; // offline — the title fills in when the video is opened
  }
}

async function refreshBadge() {
  const [unlock, settings] = await Promise.all([YFB.get('unlock'), YFB.get('settings')]);
  if (settings.gate && YFB.isUnlocked(unlock)) {
    await chrome.action.setBadgeText({ text: `${YFB.minutesLeft(unlock)}m` });
    await chrome.action.setBadgeBackgroundColor({ color: '#B86E00' });
    await chrome.action.setTitle({ title: `YouTube Focus Board · unlocked, ${YFB.minutesLeft(unlock)} min left` });
  } else {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'YouTube Focus Board' });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  switch (msg.type) {
    case 'addTime':
      enqueue(() => addTime(msg.sec, msg.study)).then(() => sendResponse({ ok: true }));
      return true;
    case 'openBoard':
      openBoard(msg.hash || '').then(() => sendResponse({ ok: true }));
      return true;
    case 'fetchTitle':
      fetchTitle(msg.id).then(sendResponse);
      return true;
    default:
      return false;
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  // fill in any missing keys with defaults, keep existing data on update
  const all = await YFB.getAll();
  await chrome.storage.local.set(all);
  chrome.alarms.create('badge', { periodInMinutes: 1 });
  await refreshBadge();
  if (details.reason === 'install') await openBoard('?welcome=1');
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('badge', { periodInMinutes: 1 });
  refreshBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'badge') refreshBadge();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.unlock || changes.settings)) refreshBadge();
});

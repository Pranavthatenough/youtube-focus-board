/*
 * YouTube Focus Board — content script (runs on www.youtube.com).
 *
 *  1. Switches: turns the CSS hiding rules on/off via attributes on <html>.
 *  2. Panel:    study list, timestamped notes and today's time, shown next to the video.
 *  3. Gate:     "Why are you here?" overlay that unlocks YouTube for 60 minutes.
 *  4. Timer:    counts the seconds YouTube is actually in use.
 *
 * YouTube is a single-page app: it swaps videos without reloading. So everything
 * here re-checks the page on YouTube's own navigation event and on a short poll.
 */
(() => {
  'use strict';
  if (window.top !== window) return;

  const S = self.YFB;
  const html = document.documentElement;
  const SHOW_ATTRS = {
    hideShorts: 'data-yfb-show-shorts',
    hideRecs: 'data-yfb-show-recs',
    hideComments: 'data-yfb-show-comments',
  };

  let state = {
    settings: { ...S.DEFAULT_SETTINGS },
    study: [],
    notes: {},
    time: {},
    unlock: null,
    gateLog: [],
  };
  let ready = false;
  const timers = [];

  const alive = () => {
    try { return !!chrome.runtime?.id; } catch (_) { return false; }
  };
  /** After the extension is reloaded, this old copy must stop quietly. */
  function shutdownIfDead() {
    if (alive()) return false;
    timers.forEach(clearInterval);
    document.getElementById('yfb-panel-host')?.remove();
    document.getElementById('yfb-home-host')?.remove();
    document.getElementById('yfb-gate-host')?.remove();
    return true;
  }
  const every = (ms, fn) => timers.push(setInterval(() => { if (!shutdownIfDead()) fn(); }, ms));

  /* =========================================================================
   * 1. Switches
   * ======================================================================= */
  function applySwitches() {
    for (const [key, attr] of Object.entries(SHOW_ATTRS)) {
      const show = !state.settings[key];
      if (show !== html.hasAttribute(attr)) html.toggleAttribute(attr, show);
    }
  }
  // if YouTube ever rewrites <html> attributes, put ours back
  new MutationObserver(() => { if (ready) applySwitches(); })
    .observe(html, { attributes: true, attributeFilter: Object.values(SHOW_ATTRS) });

  /* =========================================================================
   * Keyboard: stop YouTube's shortcuts (k, j, f, m, numbers…) from firing
   * while you type in our note box or the gate. Registered at document_start,
   * so it runs before any of YouTube's listeners.
   * ======================================================================= */
  function keyGuard(e) {
    const t = e.composedPath()[0];
    if (!t || t.nodeType !== 1 || !t.hasAttribute('data-yfb-field')) return;
    e.stopImmediatePropagation();
    if (e.type === 'keydown' && typeof t.__yfbKey === 'function') t.__yfbKey(e);
  }
  ['keydown', 'keypress', 'keyup'].forEach((type) => window.addEventListener(type, keyGuard, true));

  // Alt+N: jump into the note box on a video page
  window.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyN' && panel.input && location.pathname === '/watch') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (state.settings.panelCollapsed) setSetting('panelCollapsed', false);
      panel.input.focus();
    }
  }, true);

  /* =========================================================================
   * Page helpers
   * ======================================================================= */
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = S.escapeHtml;
  const currentId = () => (location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null);
  const studyItem = (id) => (id ? state.study.find((s) => s.id === id) : undefined);
  const getVideo = () => $('#movie_player video.html5-main-video') || $('#movie_player video') || $('ytd-player video');

  function pageTitle() {
    const h = $('ytd-watch-metadata h1 yt-formatted-string') || $('ytd-watch-metadata h1') || $('#title h1');
    let t = h?.textContent?.trim();
    if (!t) t = document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '').trim();
    return t === 'YouTube' ? '' : t;
  }
  function channelName() {
    const a = $('ytd-watch-metadata ytd-channel-name a') || $('#owner ytd-channel-name a') || $('ytd-video-owner-renderer ytd-channel-name a');
    return a?.textContent?.trim() || '';
  }

  function isDark() {
    // YouTube puts a "dark" attribute on <html> when its dark theme is on
    return html.hasAttribute('dark');
  }

  async function save(key, value) {
    state[key] = value;
    try { await chrome.storage.local.set({ [key]: value }); } catch (_) { shutdownIfDead(); }
  }
  async function mutate(key, fn) {
    if (!alive()) return;
    const next = await S.update(key, fn);
    state[key] = next;
    return next;
  }
  function setSetting(name, value) {
    return mutate('settings', (s) => ({ ...s, [name]: value }));
  }

  function openBoard() {
    try { chrome.runtime.sendMessage({ type: 'openBoard' }); } catch (_) { shutdownIfDead(); }
  }

  /* =========================================================================
   * Study list actions
   * ======================================================================= */
  async function addCurrentToStudy(topic = '') {
    const id = currentId();
    if (!id) return;
    const v = getVideo();
    await mutate('study', (list) => {
      if (list.some((s) => s.id === id)) return list;
      list.push(S.newStudyItem(id, {
        title: pageTitle(),
        channel: channelName(),
        duration: v && isFinite(v.duration) ? Math.floor(v.duration) : 0,
        pos: v ? Math.floor(v.currentTime) : 0,
        topic,
      }));
      return list;
    });
  }

  async function addLinkToStudy(link) {
    const id = S.parseVideoId(link);
    if (!id) return { error: 'That is not a YouTube video link.' };
    let meta = null;
    try { meta = await chrome.runtime.sendMessage({ type: 'fetchTitle', id }); } catch (_) { /* offline */ }
    await mutate('study', (list) => {
      if (!list.some((s) => s.id === id)) {
        list.push(S.newStudyItem(id, { title: meta?.title || '', channel: meta?.channel || '' }));
      }
      return list;
    });
    return { id };
  }

  function toggleDone(id) {
    return mutate('study', (list) => list.map((s) => (s.id === id
      ? { ...s, done: !s.done, doneAt: !s.done ? Date.now() : 0 }
      : s)));
  }

  function studyHref(item) {
    return S.watchUrl(item.id, !item.done && item.pos > 15 ? item.pos : 0);
  }

  /* =========================================================================
   * Notes
   * ======================================================================= */
  async function addNote(text, t) {
    const id = currentId();
    text = text.trim();
    if (!id || !text) return;
    const title = pageTitle();
    await mutate('notes', (notes) => {
      const entry = notes[id] || { title, items: [] };
      if (title) entry.title = title;
      entry.items.push({ id: S.uid(), t: Math.floor(t), text, at: Date.now() });
      entry.items.sort((a, b) => a.t - b.t);
      notes[id] = entry;
      return notes;
    });
  }

  function deleteNote(videoId, noteId) {
    return mutate('notes', (notes) => {
      const entry = notes[videoId];
      if (!entry) return notes;
      entry.items = entry.items.filter((n) => n.id !== noteId);
      if (!entry.items.length) delete notes[videoId];
      return notes;
    });
  }

  function jumpTo(t) {
    const v = getVideo();
    if (!v) return;
    v.currentTime = t;
    if (v.paused) v.play().catch(() => {});
  }

  /* =========================================================================
   * 2. Panel (lives in a Shadow DOM so YouTube's styles can't touch it)
   * ======================================================================= */
  const PANEL_CSS = `
    :host { all: initial; display: block; }
    * { box-sizing: border-box; }
    .p {
      --bg:#ffffff; --soft:#f3f5f2; --soft2:#e9ede8; --line:#dfe4dd; --ink:#0f1a16; --muted:#5b6862;
      --accent:#17785a; --accent-soft:#e2f2eb; --accent-ink:#ffffff; --amber:#9a5b00; --amber-soft:#fff1d6; --danger:#b3261e;
      font: 14px/1.4 "Roboto","Segoe UI",system-ui,-apple-system,sans-serif; color: var(--ink);
      background: var(--bg); border: 1px solid var(--line); border-radius: 14px; overflow: hidden;
    }
    .p.dark {
      --bg:#181c1a; --soft:#222826; --soft2:#2b322f; --line:#2f3633; --ink:#eef2ef; --muted:#9ca8a2;
      --accent:#41c495; --accent-soft:#163428; --accent-ink:#04140d; --amber:#f2b64e; --amber-soft:#3a2c12; --danger:#ff8a80;
    }
    button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; padding: 0; }
    button:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    a { color: inherit; text-decoration: none; }

    .head { display:flex; align-items:center; gap:10px; padding:12px 14px; border-bottom:1px solid var(--line); }
    .brand { display:flex; align-items:center; gap:8px; font-weight:700; font-size:15px; letter-spacing:-.01em; flex:1; min-width:0; }
    .logo { width:22px; height:22px; border-radius:6px; background:var(--accent); position:relative; flex:none; }
    .logo::after { content:""; position:absolute; left:8px; top:6px; border-left:8px solid var(--accent-ink); border-top:5px solid transparent; border-bottom:5px solid transparent; }
    .pill { font-size:12px; font-weight:600; padding:3px 9px; border-radius:999px; background:var(--soft); color:var(--muted); white-space:nowrap; }
    .pill.study { background:var(--accent-soft); color:var(--accent); }
    .pill.free { background:var(--amber-soft); color:var(--amber); }
    .icon { width:28px; height:28px; border-radius:8px; display:grid; place-items:center; color:var(--muted); font-size:16px; }
    .icon:hover { background:var(--soft); color:var(--ink); }
    .collapsed .body, .collapsed .foot { display:none; }
    .collapsed .head { border-bottom:0; }

    .body { padding: 4px 14px 6px; }
    section { padding: 10px 0; }
    section + section { border-top: 1px solid var(--line); }
    .sec-h { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px; font-weight:700; font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
    .sec-h .link { text-transform:none; letter-spacing:0; font-weight:600; color:var(--accent); font-size:13px; }
    .sec-h .link:hover { text-decoration:underline; }
    .muted { color:var(--muted); }

    .this { display:flex; align-items:center; gap:10px; }
    .this .msg { flex:1; min-width:0; font-size:13px; color:var(--muted); }
    .this .msg b { color:var(--ink); font-weight:600; }
    .btn { padding:7px 12px; border-radius:9px; font-weight:600; font-size:13px; background:var(--soft); white-space:nowrap; }
    .btn:hover { background:var(--soft2); }
    .btn.primary { background:var(--accent); color:var(--accent-ink); }
    .btn.primary:hover { filter:brightness(1.07); }
    .bar { height:4px; border-radius:2px; background:var(--soft2); margin-top:6px; overflow:hidden; }
    .bar > i { display:block; height:100%; background:var(--accent); border-radius:2px; }

    .ninput { display:flex; align-items:center; gap:6px; background:var(--soft); border:1px solid transparent; border-radius:10px; padding:4px 4px 4px 4px; }
    .ninput:focus-within { border-color:var(--accent); background:var(--bg); }
    .stamp { font: 600 12px/1 ui-monospace,"SF Mono","Roboto Mono",Menlo,Consolas,monospace; color:var(--amber); background:var(--amber-soft); padding:6px 7px; border-radius:7px; flex:none; min-width:46px; text-align:center; }
    .stamp.frozen { outline:1px dashed var(--amber); }
    .ninput input { flex:1; min-width:0; border:0; background:transparent; color:var(--ink); font:inherit; padding:6px 4px; outline:none; }
    .ninput input::placeholder { color:var(--muted); }
    .hint { font-size:12px; color:var(--muted); margin:6px 2px 0; }
    kbd { font: 11px ui-monospace,Menlo,monospace; background:var(--soft2); border-radius:4px; padding:1px 4px; }

    ol { list-style:none; margin:8px 0 0; padding:0; }
    .notes li { display:flex; align-items:flex-start; border-radius:9px; }
    .notes li:hover { background:var(--soft); }
    .notes li.now { background:var(--accent-soft); }
    .note { flex:1; display:flex; gap:10px; text-align:left; padding:7px 8px; min-width:0; }
    .note .ts { font: 600 12px/1.5 ui-monospace,"SF Mono","Roboto Mono",Menlo,Consolas,monospace; color:var(--amber); flex:none; padding-top:1px; }
    .note .tx { overflow-wrap:anywhere; }
    .x { width:28px; height:30px; flex:none; color:var(--muted); opacity:0; border-radius:7px; font-size:16px; }
    li:hover .x, .x:focus-visible { opacity:1; }
    .x:hover { color:var(--danger); }
    .empty { font-size:13px; color:var(--muted); padding:4px 2px; }

    .study li { display:flex; align-items:center; gap:8px; padding:5px 6px; border-radius:9px; }
    .study li:hover { background:var(--soft); }
    .study li.cur { background:var(--soft); }
    .chk { width:22px; height:22px; border-radius:50%; border:1.5px solid var(--line); flex:none; display:grid; place-items:center; font-size:12px; color:transparent; }
    .chk:hover { border-color:var(--accent); color:var(--accent); }
    li.done .chk { background:var(--accent); border-color:var(--accent); color:var(--accent-ink); }
    li.cur:not(.done) .chk { border-color:var(--accent); color:var(--accent); }
    .study a { flex:1; min-width:0; display:block; }
    .study .t { display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:500; }
    li.cur .t { font-weight:700; }
    li.done .t { color:var(--muted); text-decoration:line-through; text-decoration-thickness:1px; }
    .study .s { display:block; font-size:12px; color:var(--muted); }
    .more { font-size:12px; color:var(--muted); padding:6px 6px 0; }

    .foot { display:flex; justify-content:space-between; gap:8px; padding:10px 14px; background:var(--soft); font-size:13px; color:var(--muted); }
    .foot b { color:var(--ink); }

    /* home page version */
    .home .body { padding: 6px 18px 10px; }
    .home .lead { font-size:15px; color:var(--muted); margin:6px 0 4px; }
    .home .study li { padding:9px 8px; }
    .addrow { display:flex; gap:6px; margin-top:10px; }
    .addrow input { flex:1; min-width:0; border:1px solid var(--line); background:var(--bg); color:var(--ink); border-radius:9px; padding:8px 10px; font:inherit; }
    .addrow input:focus { outline:none; border-color:var(--accent); }
    .err { color:var(--danger); font-size:12px; margin-top:6px; min-height:0; }
  `;

  const panel = {
    host: null, root: null, el: null, input: null, stamp: null, mode: null,
    frozenT: null,
  };

  /** Where the panel should live right now (or null = no panel on this page). */
  function panelTarget() {
    const path = location.pathname;
    if (path === '/watch') {
      const parent = $('ytd-watch-flexy #secondary-inner') || $('ytd-watch-flexy #secondary');
      return parent ? { mode: 'watch', parent, id: 'yfb-panel-host' } : null;
    }
    if (path === '/' && state.settings.hideRecs) {
      const parent = $('ytd-browse[page-subtype="home"] ytd-two-column-browse-results-renderer #primary')
        || $('ytd-browse[page-subtype="home"] #primary');
      return parent ? { mode: 'home', parent, id: 'yfb-home-host' } : null;
    }
    return null;
  }

  function ensurePanel() {
    if (!ready) return;
    const target = panelTarget();
    if (!target) {
      if (panel.host) { panel.host.remove(); Object.assign(panel, { host: null, root: null, el: null, input: null, stamp: null, mode: null }); }
      return;
    }
    if (panel.host && panel.mode === target.mode && panel.host.parentElement === target.parent && panel.host === target.parent.firstElementChild) {
      return;
    }
    if (!panel.host || panel.mode !== target.mode) buildPanel(target);
    target.parent.prepend(panel.host);
    renderPanel();
  }

  function buildPanel(target) {
    panel.host?.remove();
    const host = document.createElement('div');
    host.id = target.id;
    const root = host.attachShadow({ mode: 'open' });
    const isWatch = target.mode === 'watch';
    root.innerHTML = `
      <style>${PANEL_CSS}</style>
      <div class="p ${target.mode}">
        <header class="head">
          <div class="brand"><span class="logo" aria-hidden="true"></span><span>Focus Board</span></div>
          <span class="pill" data-ref="pill"></span>
          <button class="icon" data-act="collapse" data-ref="collapse" title="Collapse"></button>
        </header>
        <div class="body">
          ${isWatch ? `
          <section data-ref="this"></section>
          <section class="notes">
            <div class="sec-h"><span>Notes</span><span class="muted" data-ref="ncount"></span></div>
            <div class="ninput">
              <button class="stamp" data-act="restamp" data-ref="stamp" title="Time this note is linked to. Click to use the current moment."></button>
              <input data-yfb-field data-ref="input" maxlength="300" placeholder="Note this moment, press Enter" aria-label="Note at this moment">
            </div>
            <div class="hint"><kbd>Alt</kbd> + <kbd>N</kbd> to start a note · click a note to jump there</div>
            <ol data-ref="notes"></ol>
          </section>` : `
          <p class="lead">Recommendations are hidden. Pick up where you left off.</p>`}
          <section class="study">
            <div class="sec-h"><span>Study list</span><button class="link" data-act="board">Open board</button></div>
            <ol data-ref="study"></ol>
            ${isWatch ? '' : `
            <div class="addrow">
              <input data-yfb-field data-ref="link" placeholder="Paste a lecture link to add it" aria-label="Lecture link">
              <button class="btn primary" data-act="addlink">Add</button>
            </div>
            <div class="err" data-ref="err"></div>`}
          </section>
        </div>
        <footer class="foot" data-ref="foot"></footer>
      </div>`;

    const ref = (name) => root.querySelector(`[data-ref="${name}"]`);
    panel.host = host;
    panel.root = root;
    panel.mode = target.mode;
    panel.el = root.querySelector('.p');
    panel.refs = {
      pill: ref('pill'), collapse: ref('collapse'), this: ref('this'), ncount: ref('ncount'),
      notes: ref('notes'), study: ref('study'), foot: ref('foot'), err: ref('err'),
    };
    panel.input = ref('input');
    panel.stamp = ref('stamp');
    panel.frozenT = null;

    if (panel.input) {
      panel.input.addEventListener('input', () => {
        if (panel.input.value && panel.frozenT == null) {
          panel.frozenT = getVideo()?.currentTime || 0;
          updateStamp();
        } else if (!panel.input.value) {
          panel.frozenT = null;
          updateStamp();
        }
      });
      panel.input.__yfbKey = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const text = panel.input.value;
          const t = panel.frozenT ?? (getVideo()?.currentTime || 0);
          if (text.trim()) {
            addNote(text, t);
            panel.input.value = '';
            panel.frozenT = null;
            updateStamp();
          }
        } else if (e.key === 'Escape') {
          panel.input.value = '';
          panel.frozenT = null;
          updateStamp();
          panel.input.blur();
        }
      };
    }

    const link = ref('link');
    if (link) link.__yfbKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); submitLink(link); } };

    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'open') return; // normal link
      e.preventDefault();
      switch (act) {
        case 'collapse': setSetting('panelCollapsed', !state.settings.panelCollapsed); break;
        case 'board': openBoard(); break;
        case 'restamp':
          panel.frozenT = getVideo()?.currentTime || 0;
          updateStamp();
          panel.input?.focus();
          break;
        case 'jump': jumpTo(Number(btn.dataset.t)); break;
        case 'delnote': deleteNote(btn.dataset.vid, btn.dataset.id); break;
        case 'done': toggleDone(btn.dataset.id); break;
        case 'addcur': addCurrentToStudy(); break;
        case 'addlink': submitLink(link); break;
      }
    });
  }

  async function submitLink(input) {
    if (!input) return;
    const res = await addLinkToStudy(input.value);
    if (panel.refs.err) panel.refs.err.textContent = res.error || '';
    if (!res.error) input.value = '';
  }

  function updateStamp() {
    if (!panel.stamp) return;
    const frozen = panel.frozenT != null;
    const t = frozen ? panel.frozenT : (getVideo()?.currentTime || 0);
    panel.stamp.textContent = S.clock(t);
    panel.stamp.classList.toggle('frozen', frozen);
  }

  function pillInfo() {
    const s = state.settings;
    if (!s.gate) return { text: 'Gate off', cls: '' };
    if (S.isUnlocked(state.unlock)) return { text: `Free time · ${S.minutesLeft(state.unlock)} min left`, cls: 'free' };
    if (studyItem(currentId())) return { text: 'Study mode', cls: 'study' };
    return { text: 'Locked', cls: '' };
  }

  function renderPanel() {
    if (!panel.host) return;
    const r = panel.refs;
    panel.el.classList.toggle('dark', isDark());
    panel.el.classList.toggle('collapsed', !!state.settings.panelCollapsed);
    r.collapse.textContent = state.settings.panelCollapsed ? '+' : '–';
    r.collapse.title = state.settings.panelCollapsed ? 'Expand' : 'Collapse';

    const pill = pillInfo();
    r.pill.textContent = pill.text;
    r.pill.className = `pill ${pill.cls}`;

    const vid = currentId();
    const item = studyItem(vid);

    // this video
    if (r.this) {
      if (item) {
        const pct = item.duration ? Math.min(100, (item.pos / item.duration) * 100) : 0;
        r.this.innerHTML = `
          <div class="this">
            <div class="msg"><b>${item.done ? 'Finished' : 'On your study list'}</b>${item.topic ? ` · ${esc(item.topic)}` : ''}
              <div class="bar" title="${Math.round(pct)}% watched"><i style="width:${pct.toFixed(1)}%"></i></div>
            </div>
            <button class="btn ${item.done ? '' : 'primary'}" data-act="done" data-id="${esc(item.id)}">${item.done ? 'Mark not done' : 'Mark done'}</button>
          </div>`;
      } else {
        r.this.innerHTML = `
          <div class="this">
            <div class="msg">Is this a lecture? Add it so it opens without the gate.</div>
            <button class="btn primary" data-act="addcur">+ Study list</button>
          </div>`;
      }
    }

    // notes
    if (r.notes) {
      const items = (vid && state.notes[vid]?.items) || [];
      r.ncount.textContent = items.length ? String(items.length) : '';
      r.notes.innerHTML = items.length
        ? items.map((n) => `
          <li data-t="${n.t}">
            <button class="note" data-act="jump" data-t="${n.t}" title="Jump to ${S.clock(n.t)}">
              <span class="ts">${S.clock(n.t)}</span><span class="tx">${esc(n.text)}</span>
            </button>
            <button class="x" data-act="delnote" data-vid="${esc(vid)}" data-id="${esc(n.id)}" title="Delete note" aria-label="Delete note">×</button>
          </li>`).join('')
        : '<li class="empty">No notes yet. Type one above while the lecture plays.</li>';
      highlightNow();
    }

    // study list
    const list = [...state.study].sort((a, b) => Number(a.done) - Number(b.done));
    const max = panel.mode === 'home' ? 8 : 6;
    const shown = list.slice(0, max);
    r.study.innerHTML = shown.length
      ? shown.map((s) => {
        const cur = s.id === vid;
        const progress = s.done ? 'Done' : s.pos > 15 ? `Continue at ${S.clock(s.pos)}${s.duration ? ` / ${S.clock(s.duration)}` : ''}` : (s.duration ? S.clock(s.duration) : 'Not started');
        const nNotes = state.notes[s.id]?.items?.length || 0;
        return `
          <li class="${s.done ? 'done' : ''} ${cur ? 'cur' : ''}">
            <button class="chk" data-act="done" data-id="${esc(s.id)}" title="${s.done ? 'Mark not done' : 'Mark done'}" aria-label="${s.done ? 'Mark not done' : 'Mark done'}">${cur && !s.done ? '▶' : '✓'}</button>
            <a data-act="open" href="${esc(studyHref(s))}">
              <span class="t">${esc(s.title || `Video ${s.id}`)}</span>
              <span class="s">${cur ? 'Playing now' : progress}${nNotes ? ` · ${nNotes} note${nNotes > 1 ? 's' : ''}` : ''}</span>
            </a>
          </li>`;
      }).join('') + (list.length > max ? `<li class="more">+ ${list.length - max} more on the board</li>` : '')
      : `<li class="empty">${panel.mode === 'watch' ? 'Nothing here yet. Add this video if it is a lecture.' : 'Nothing here yet. Paste a lecture link below.'}</li>`;

    renderFoot();
    updateStamp();
  }

  function renderFoot() {
    if (!panel.refs?.foot) return;
    const day = state.time[S.dayKey()] || { total: 0, study: 0 };
    const total = day.total + pending.total;
    const study = day.study + pending.study;
    panel.refs.foot.innerHTML = `<span>Today: <b>${S.duration(total)}</b></span><span>${S.duration(study)} studying</span>`;
  }

  function highlightNow() {
    if (!panel.refs?.notes) return;
    const v = getVideo();
    const t = v ? v.currentTime : -1;
    let best = null;
    for (const li of panel.refs.notes.children) {
      li.classList.remove('now');
      const lt = Number(li.dataset.t);
      if (li.dataset.t !== undefined && lt <= t + 0.5) best = li;
    }
    if (best && t - Number(best.dataset.t) < 120) best.classList.add('now');
  }

  /* =========================================================================
   * 3. Gate
   * ======================================================================= */
  const GATE_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap {
      --bg:#fbfaf6; --soft:#f0eee7; --line:#e1ddd2; --ink:#14201b; --muted:#5f6a64; --accent:#17785a; --accent-ink:#fff; --amber:#9a5b00; --danger:#b3261e;
      position: fixed; inset: 0; z-index: 2147483646; display: grid; place-items: center; padding: 24px;
      background: rgba(14, 22, 19, .62); backdrop-filter: blur(18px) saturate(.6); -webkit-backdrop-filter: blur(18px) saturate(.6);
      font: 15px/1.45 "Roboto","Segoe UI",system-ui,-apple-system,sans-serif; color: var(--ink);
      animation: fade .18s ease-out;
    }
    .wrap.dark { --bg:#171b19; --soft:#222826; --line:#323936; --ink:#eef2ef; --muted:#a0aca6; --accent:#41c495; --accent-ink:#04140d; --amber:#f2b64e; --danger:#ff8a80; background: rgba(0,0,0,.66); }
    @keyframes fade { from { opacity: 0 } }
    @keyframes rise { from { transform: translateY(8px); opacity: 0 } }
    .card { width: min(520px, 100%); max-height: calc(100vh - 48px); overflow: auto; background: var(--bg); border-radius: 20px; padding: 28px 28px 22px; box-shadow: 0 30px 80px rgba(0,0,0,.35); animation: rise .22s ease-out; }
    .eyebrow { display:flex; align-items:center; gap:8px; font-size:12px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color: var(--muted); }
    .dot { width:8px; height:8px; border-radius:50%; background: var(--amber); }
    h1 { font-size: 30px; line-height: 1.1; letter-spacing: -.02em; margin: 10px 0 6px; font-weight: 800; }
    .sub { color: var(--muted); margin: 0 0 18px; }
    .sub b { color: var(--ink); font-weight: 600; }
    textarea { width: 100%; min-height: 84px; resize: vertical; border: 1.5px solid var(--line); border-radius: 12px; background: var(--bg); color: var(--ink); padding: 12px 14px; font: inherit; }
    textarea:focus { outline: none; border-color: var(--accent); }
    textarea::placeholder { color: var(--muted); }
    .check { font-size: 13px; color: var(--muted); margin: 8px 2px 16px; min-height: 18px; }
    .check.ok { color: var(--accent); }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; }
    button { font: inherit; cursor: pointer; border: 0; }
    .btn { flex: 1 1 180px; padding: 12px 16px; border-radius: 12px; font-weight: 700; background: var(--soft); color: var(--ink); }
    .btn.primary { background: var(--accent); color: var(--accent-ink); }
    .btn:disabled { opacity: .45; cursor: not-allowed; }
    .btn:not(:disabled):hover { filter: brightness(1.05); }
    .or { display: flex; align-items: center; gap: 12px; margin: 22px 0 12px; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
    .or::before, .or::after { content: ""; flex: 1; height: 1px; background: var(--line); }
    ul { list-style: none; margin: 0; padding: 0; }
    li a { display: flex; gap: 10px; align-items: baseline; padding: 9px 10px; border-radius: 10px; color: var(--ink); text-decoration: none; }
    li a:hover { background: var(--soft); }
    li .ic { color: var(--accent); font-size: 12px; }
    li .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
    li .s { font-size: 12px; color: var(--muted); white-space: nowrap; }
    .row { display: flex; gap: 8px; margin-top: 10px; }
    .row input { flex: 1; min-width: 0; border: 1.5px solid var(--line); border-radius: 10px; background: var(--bg); color: var(--ink); padding: 10px 12px; font: inherit; font-size: 14px; }
    .row input:focus { outline: none; border-color: var(--accent); }
    .row button { padding: 0 16px; border-radius: 10px; background: var(--soft); color: var(--ink); font-weight: 700; font-size: 14px; }
    .err { font-size: 13px; color: var(--danger); margin-top: 6px; min-height: 0; }
    .last { margin-top: 18px; font-size: 13px; color: var(--muted); border-top: 1px solid var(--line); padding-top: 12px; }
    .last q { color: var(--ink); }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  `;

  const gate = { host: null, shown: false, expired: false, pauseTimer: null };

  function gateNeeded() {
    if (!ready || !state.settings.gate) return false;
    if (S.isUnlocked(state.unlock)) return false;
    const path = location.pathname;
    if (path === '/results') return false; // searching for a lecture is allowed
    if (path === '/watch' && studyItem(currentId())) return false; // study videos open freely
    // account pages and settings are never blocked
    if (/^\/(account|signin|logout|premium|paid_memberships|reporthistory)/.test(path)) return false;
    return true;
  }

  function checkGate() {
    if (!ready) return;
    const need = gateNeeded();
    if (need && !gate.shown) showGate();
    else if (!need && gate.shown) hideGate();
  }

  function showGate() {
    if (!document.body) return;
    gate.shown = true;
    gate.host?.remove();
    const host = document.createElement('div');
    host.id = 'yfb-gate-host';
    const root = host.attachShadow({ mode: 'open' });
    const onWatch = location.pathname === '/watch' && !!currentId();
    const expired = !!state.unlock && state.unlock.until <= Date.now() && Date.now() - state.unlock.until < 5 * 60000;
    const last = state.gateLog[0];
    const todo = state.study.filter((s) => !s.done).slice(0, 4);
    const day = state.time[S.dayKey()] || { total: 0 };

    root.innerHTML = `
      <style>${GATE_CSS}</style>
      <div class="wrap ${isDark() ? 'dark' : ''}" role="dialog" aria-modal="true" aria-labelledby="yfb-q">
        <div class="card">
          <div class="eyebrow"><span class="dot"></span>${expired ? 'Your 60 minutes are up' : 'YouTube is locked'}</div>
          <h1 id="yfb-q">Why are you here?</h1>
          <p class="sub">Type your reason to unlock YouTube for <b>${S.UNLOCK_MINUTES} minutes</b>. You've spent <b>${S.duration(day.total)}</b> on YouTube today.</p>
          <textarea data-yfb-field data-ref="reason" maxlength="200" placeholder="e.g. Revising thermodynamics, Carnot cycle lecture"></textarea>
          <div class="check" data-ref="check">Write at least 3 words.</div>
          <div class="actions">
            ${onWatch ? '<button class="btn primary" data-act="study" disabled>Study this video</button>' : ''}
            <button class="btn ${onWatch ? '' : 'primary'}" data-act="unlock" disabled>Unlock for ${S.UNLOCK_MINUTES} min</button>
          </div>

          <div class="or">or go straight to studying</div>
          ${todo.length ? `<ul>${todo.map((s) => `
            <li><a href="${esc(studyHref(s))}"><span class="ic">▶</span><span class="t">${esc(s.title || `Video ${s.id}`)}</span><span class="s">${s.pos > 15 ? `at ${S.clock(s.pos)}` : ''}</span></a></li>`).join('')}
          </ul>` : ''}
          <div class="row">
            <input data-yfb-field data-ref="link" placeholder="Paste a lecture link to add it">
            <button data-act="addlink">Add</button>
          </div>
          <div class="row">
            <input data-yfb-field data-ref="search" placeholder="Search for a lecture">
            <button data-act="search">Search</button>
          </div>
          <div class="err" data-ref="err"></div>
          ${last ? `<div class="last">Last reason, ${esc(S.ago(last.at))}: <q>${esc(last.reason)}</q></div>` : ''}
        </div>
      </div>`;

    const ref = (n) => root.querySelector(`[data-ref="${n}"]`);
    const reason = ref('reason');
    const check = ref('check');
    const buttons = root.querySelectorAll('[data-act="unlock"],[data-act="study"]');
    const validate = () => {
      const problem = S.reasonProblem(reason.value);
      check.textContent = problem || 'Good. Choose what you want to do.';
      check.classList.toggle('ok', !problem);
      buttons.forEach((b) => { b.disabled = !!problem; });
      return !problem;
    };
    reason.addEventListener('input', validate);
    reason.__yfbKey = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (validate()) (onWatch ? doStudy : doUnlock)();
      }
    };
    const link = ref('link');
    const search = ref('search');
    const err = ref('err');
    link.__yfbKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); doAddLink(); } };
    search.__yfbKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } };

    async function doUnlock() {
      if (!validate()) return;
      const text = reason.value.trim();
      const now = Date.now();
      await save('unlock', { until: now + S.UNLOCK_MINUTES * 60000, reason: text, at: now });
      await mutate('gateLog', (log) => [{ at: now, reason: text, kind: 'fun', videoId: currentId(), title: pageTitle() }, ...log].slice(0, 300));
      checkGate();
      renderPanel();
    }
    async function doStudy() {
      if (!validate()) return;
      const text = reason.value.trim();
      await addCurrentToStudy(text);
      await mutate('gateLog', (log) => [{ at: Date.now(), reason: text, kind: 'study', videoId: currentId(), title: pageTitle() }, ...log].slice(0, 300));
      checkGate();
      renderPanel();
    }
    async function doAddLink() {
      const res = await addLinkToStudy(link.value);
      if (res.error) { err.textContent = res.error; return; }
      location.href = S.watchUrl(res.id);
    }
    function doSearch() {
      const q = search.value.trim();
      if (!q) { err.textContent = 'Type what you want to learn.'; return; }
      location.href = `/results?search_query=${encodeURIComponent(q)}`;
    }

    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      ({ unlock: doUnlock, study: doStudy, addlink: doAddLink, search: doSearch })[b.dataset.act]?.();
    });

    document.body.appendChild(host);
    gate.host = host;
    html.style.setProperty('overflow', 'hidden', 'important');
    pauseWhileGated();
    gate.pauseTimer = setInterval(pauseWhileGated, 250);
    setTimeout(() => reason.focus(), 50);
  }

  function pauseWhileGated() {
    const v = getVideo();
    if (v && !v.paused) v.pause();
    // keep our overlay the last thing on the page
    if (gate.host && document.body && gate.host !== document.body.lastElementChild) document.body.appendChild(gate.host);
  }

  function hideGate() {
    gate.shown = false;
    clearInterval(gate.pauseTimer);
    gate.host?.remove();
    gate.host = null;
    html.style.removeProperty('overflow');
  }

  /* =========================================================================
   * 4. Timer: count real use (tab visible, and window focused or video playing)
   * ======================================================================= */
  const pending = { total: 0, study: 0 };
  let ticks = 0;

  function flushTime() {
    if (!pending.total) return;
    const msg = { type: 'addTime', sec: pending.total, study: pending.study };
    pending.total = 0;
    pending.study = 0;
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (_) { shutdownIfDead(); }
  }

  function tick() {
    if (!ready) return;
    const v = getVideo();
    const onWatch = location.pathname === '/watch';
    const playing = !!(v && onWatch && !v.paused && !v.ended && v.readyState > 2);
    const active = document.visibilityState === 'visible' && (document.hasFocus() || playing);
    const vid = currentId();
    const item = studyItem(vid);

    if (active && !gate.shown) {
      pending.total += 1;
      if (item && onWatch) pending.study += 1;
    }
    ticks += 1;
    if (ticks % 5 === 0) flushTime();
    if (ticks % 10 === 0 && item && onWatch && v) saveProgress(item, v);

    // re-check unlock expiry, panel position, live bits
    checkGate();
    ensurePanel();
    if (panel.host) {
      if (panel.el.classList.contains('dark') !== isDark()) panel.el.classList.toggle('dark', isDark());
      updateStamp();
      highlightNow();
      renderFoot();
      const pill = pillInfo();
      if (panel.refs.pill.textContent !== pill.text) renderPanel();
    }
    attachVideoHooks(v);
  }

  async function saveProgress(item, v) {
    if (!isFinite(v.duration) || v.duration <= 0) return;
    const pos = Math.floor(v.currentTime);
    const dur = Math.floor(v.duration);
    const title = pageTitle();
    const channel = channelName();
    const finished = dur > 0 && pos / dur >= 0.95;
    await mutate('study', (list) => list.map((s) => {
      if (s.id !== item.id) return s;
      const next = { ...s, pos, duration: dur };
      if (title && title !== s.title) next.title = title;
      if (channel && !s.channel) next.channel = channel;
      if (finished && !s.done) { next.done = true; next.doneAt = Date.now(); }
      return next;
    }));
  }

  function attachVideoHooks(v) {
    if (!v || v.__yfbHooked) return;
    v.__yfbHooked = true;
    v.addEventListener('ended', () => {
      const item = studyItem(currentId());
      if (item) saveProgress(item, v);
      // With recommendations hidden, don't let autoplay carry you to the next video.
      if (state.settings.hideRecs) {
        let tries = 0;
        const stop = setInterval(() => {
          $('.ytp-autonav-endscreen-upnext-cancel-button')?.click();
          if (++tries > 12) clearInterval(stop);
        }, 250);
      }
    });
    v.addEventListener('play', () => { if (gate.shown) v.pause(); });
    v.addEventListener('seeked', highlightNow);
  }

  /* =========================================================================
   * Navigation
   * ======================================================================= */
  let lastUrl = '';
  function onRoute() {
    if (!ready || location.href === lastUrl) return;
    lastUrl = location.href;
    // Shorts open as normal videos when Shorts are hidden
    if (state.settings.hideShorts) {
      const m = location.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})/);
      if (m) { location.replace(`/watch?v=${m[1]}`); return; }
    }
    if (panel.input) { panel.input.value = ''; panel.frozenT = null; }
    flushTime();
    ensurePanel();
    renderPanel();
    // the gate decision may change with the new page
    if (gate.shown && !gateNeeded()) hideGate();
    else if (gate.shown) { hideGate(); showGate(); }
    else checkGate();
  }
  document.addEventListener('yt-navigate-finish', onRoute);
  window.addEventListener('yt-navigate-finish', onRoute);
  window.addEventListener('popstate', () => setTimeout(onRoute, 50));
  window.addEventListener('pagehide', flushTime);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushTime(); });

  /* =========================================================================
   * Start
   * ======================================================================= */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !alive()) return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in state) state[key] = S.normalize(key, newValue);
    }
    applySwitches();
    if (changes.settings || changes.study || changes.notes || changes.unlock || changes.time) {
      ensurePanel();
      renderPanel();
    }
    if (changes.settings || changes.unlock || changes.study) checkGate();
  });

  S.getAll().then((data) => {
    state = data;
    ready = true;
    applySwitches();
    const start = () => {
      onRoute();
      every(1000, tick);
      every(500, () => { if (location.href !== lastUrl) onRoute(); });
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  });
})();

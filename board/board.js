/* YouTube Focus Board — the board page (study list, notes, time, settings, backup). */
(() => {
  'use strict';
  const S = self.YFB;
  const esc = S.escapeHtml;
  const $ = (id) => document.getElementById(id);

  let state = null;
  let filter = 'todo';
  let editingNote = null; // { vid, id }
  let dragId = null;

  /* ---------------- header + hero ---------------- */
  function renderTop() {
    const day = state.time[S.dayKey()] || { total: 0, study: 0 };
    $('heroTotal').textContent = S.duration(day.total);
    const other = Math.max(0, day.total - day.study);
    const pct = day.total ? Math.round((day.study / day.total) * 100) : 0;
    $('heroSub').innerHTML = day.total
      ? `<b>${S.duration(day.study)}</b> studying · <b>${S.duration(other)}</b> other · ${pct}% study`
      : 'Nothing yet today.';

    const days = S.lastDays(7).map((d) => ({ ...d, ...(state.time[d.key] || { total: 0, study: 0 }) }));
    const max = Math.max(1800, ...days.map((d) => d.total));
    $('week').innerHTML = days.map((d, i) => {
      const o = Math.max(0, d.total - d.study);
      const mins = Math.round(d.total / 60);
      return `<div class="wcol ${i === 6 ? 'today' : ''}" title="${esc(d.label)}: ${S.duration(d.total)}, ${S.duration(d.study)} studying">
        <span class="v">${mins ? `${mins}m` : ''}</span>
        <div class="wstack"><i class="o" style="height:${(o / max) * 100}%"></i><i class="s" style="height:${(d.study / max) * 100}%"></i></div>
        <small>${i === 6 ? 'Today' : esc(d.label)}</small>
      </div>`;
    }).join('');

    const s = state.settings;
    let chip;
    if (!s.gate) chip = '<span class="chip"><i></i>Gate off</span>';
    else if (S.isUnlocked(state.unlock)) chip = `<span class="chip free"><i></i>Unlocked · ${S.minutesLeft(state.unlock)} min left</span>`;
    else chip = '<span class="chip locked"><i></i>Locked for fun</span>';
    $('mastStatus').innerHTML = chip;
  }

  /* ---------------- study list ---------------- */
  function noteCount(id) { return state.notes[id]?.items?.length || 0; }

  function renderStudy() {
    const all = state.study;
    const todo = all.filter((s) => !s.done);
    const done = all.filter((s) => s.done);
    $('cTodo').textContent = todo.length ? `· ${todo.length}` : '';
    $('cDone').textContent = done.length ? `· ${done.length}` : '';
    document.querySelectorAll('#studyTabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.filter === filter)));

    const list = filter === 'todo' ? todo : filter === 'done' ? done : all;
    if (!list.length) {
      $('studyList').innerHTML = `<li class="empty">${filter === 'done'
        ? '<b>Nothing finished yet</b>Videos you finish, or mark done, show up here.'
        : all.length && filter === 'todo'
          ? '<b>All caught up</b>Every video on your list is done. Add the next lecture above.'
          : '<b>Your study list is empty</b>Paste a lecture link above, or press “+ Study list” next to a video on YouTube.'}</li>`;
      return;
    }

    $('studyList').innerHTML = list.map((s) => {
      const pct = s.duration ? Math.min(100, (s.pos / s.duration) * 100) : 0;
      const where = s.done
        ? `Finished${s.doneAt ? ` ${S.ago(s.doneAt)}` : ''}`
        : s.pos > 15 ? `Stopped at <span class="ts">${S.clock(s.pos)}</span>` : 'Not started';
      const n = noteCount(s.id);
      return `<li class="srow ${s.done ? 'done' : ''}" draggable="true" data-id="${esc(s.id)}">
        <span class="grip" title="Drag to reorder" aria-hidden="true">⋮⋮</span>
        <a class="thumb" href="${esc(S.watchUrl(s.id, s.done ? 0 : s.pos))}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">
          <img src="https://i.ytimg.com/vi/${esc(s.id)}/mqdefault.jpg" alt="" loading="lazy">
          ${s.duration ? `<span class="tlen">${S.clock(s.duration)}</span>` : ''}
          ${pct > 0 ? `<span class="tprog" style="width:${pct.toFixed(1)}%"></span>` : ''}
        </a>
        <div class="sinfo">
          <a class="title" href="${esc(S.watchUrl(s.id, s.done ? 0 : s.pos))}" target="_blank" rel="noopener">${esc(s.title || `Video ${s.id}`)}</a>
          <div class="smeta">${s.channel ? `${esc(s.channel)} · ` : ''}${where}${n ? ` · ${n} note${n > 1 ? 's' : ''}` : ''}</div>
          ${s.topic ? `<div class="smeta">Why: <span class="topic">${esc(s.topic)}</span></div>` : ''}
        </div>
        <div class="sact">
          <button class="donebtn" data-act="done" data-id="${esc(s.id)}">${s.done ? '✓ Done' : 'Mark done'}</button>
          <button class="iconbtn del" data-act="remove" data-id="${esc(s.id)}" title="Remove from list" aria-label="Remove from list">✕</button>
        </div>
      </li>`;
    }).join('');

    // thumbnails fail offline: show a plain play mark instead
    $('studyList').querySelectorAll('.thumb img').forEach((img) => {
      img.addEventListener('error', () => { img.parentElement.classList.add('noimg'); img.remove(); }, { once: true });
    });
  }

  async function addLink(value) {
    const msg = $('addMsg');
    const id = S.parseVideoId(value);
    if (!id) { msg.textContent = 'That is not a YouTube video link. Try one like youtube.com/watch?v=…'; msg.className = 'msg err'; return false; }
    if (state.study.some((s) => s.id === id)) { msg.textContent = 'That video is already on your list.'; msg.className = 'msg'; return false; }
    msg.textContent = 'Adding…'; msg.className = 'msg';
    let meta = null;
    try { meta = await chrome.runtime.sendMessage({ type: 'fetchTitle', id }); } catch (_) { /* offline */ }
    await S.update('study', (list) => {
      if (!list.some((s) => s.id === id)) list.push(S.newStudyItem(id, { title: meta?.title || '', channel: meta?.channel || '' }));
      return list;
    });
    msg.textContent = meta?.title ? `Added “${meta.title}”.` : 'Added. The title appears once you open the video.';
    msg.className = 'msg ok';
    filter = 'todo';
    return true;
  }

  $('addForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await addLink($('addInput').value)) $('addInput').value = '';
  });

  $('studyTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-filter]');
    if (!b) return;
    filter = b.dataset.filter;
    renderStudy();
  });

  $('studyList').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const id = b.dataset.id;
    if (b.dataset.act === 'done') {
      await S.update('study', (list) => list.map((s) => (s.id === id ? { ...s, done: !s.done, doneAt: s.done ? 0 : Date.now() } : s)));
    } else if (b.dataset.act === 'remove') {
      const item = state.study.find((s) => s.id === id);
      const n = noteCount(id);
      if (!confirm(`Remove “${item?.title || id}” from your study list?${n ? `\n\nIts ${n} note${n > 1 ? 's' : ''} will be kept.` : ''}`)) return;
      await S.update('study', (list) => list.filter((s) => s.id !== id));
    }
  });

  // drag to reorder (order is saved for the whole list)
  const listEl = $('studyList');
  listEl.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.srow');
    if (!row) return;
    dragId = row.dataset.id;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  listEl.addEventListener('dragend', () => {
    dragId = null;
    listEl.querySelectorAll('.dragging, .over').forEach((el) => el.classList.remove('dragging', 'over'));
  });
  listEl.addEventListener('dragover', (e) => {
    const row = e.target.closest('.srow');
    if (!row || !dragId) return;
    e.preventDefault();
    listEl.querySelectorAll('.over').forEach((el) => el.classList.remove('over'));
    if (row.dataset.id !== dragId) row.classList.add('over');
  });
  listEl.addEventListener('drop', async (e) => {
    const row = e.target.closest('.srow');
    if (!row || !dragId || row.dataset.id === dragId) return;
    e.preventDefault();
    const from = dragId;
    const to = row.dataset.id;
    await S.update('study', (list) => {
      const item = list.find((s) => s.id === from);
      const rest = list.filter((s) => s.id !== from);
      rest.splice(rest.findIndex((s) => s.id === to), 0, item);
      return rest;
    });
  });

  /* ---------------- notes ---------------- */
  function highlight(text, q) {
    const safe = esc(text);
    if (!q) return safe;
    const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
    return safe.replace(re, '<mark>$1</mark>');
  }

  function renderNotes() {
    const q = $('noteSearch').value.trim();
    const ql = q.toLowerCase();
    const titleOf = (vid) => state.study.find((s) => s.id === vid)?.title || state.notes[vid]?.title || `Video ${vid}`;
    const groups = Object.entries(state.notes)
      .map(([vid, entry]) => {
        const title = titleOf(vid);
        const titleHit = ql && title.toLowerCase().includes(ql);
        const items = (entry.items || []).filter((n) => !ql || titleHit || n.text.toLowerCase().includes(ql));
        const latest = Math.max(0, ...(entry.items || []).map((n) => n.at || 0));
        return { vid, title, items, latest };
      })
      .filter((g) => g.items.length)
      .sort((a, b) => b.latest - a.latest);

    if (!groups.length) {
      $('notesList').innerHTML = q
        ? `<div class="empty"><b>No notes match “${esc(q)}”</b></div>`
        : '<div class="empty"><b>No notes yet</b>While a video plays, type in the Notes box next to it. Each note remembers its moment.</div>';
      return;
    }

    $('notesList').innerHTML = groups.map((g) => `
      <div class="ngroup">
        <h3><a href="${esc(S.watchUrl(g.vid))}" target="_blank" rel="noopener">${highlight(g.title, q)}</a><small>${g.items.length} note${g.items.length > 1 ? 's' : ''}</small></h3>
        <ul class="nlist">
          ${g.items.map((n) => {
            const editing = editingNote && editingNote.vid === g.vid && editingNote.id === n.id;
            return `<li class="nrow">
              <a class="ts" href="${esc(S.watchUrl(g.vid, n.t))}" target="_blank" rel="noopener" title="Open the video at ${S.clock(n.t)}">${S.clock(n.t)}</a>
              ${editing
                ? `<input class="field" data-edit="${esc(g.vid)}|${esc(n.id)}" value="${esc(n.text)}" maxlength="300" aria-label="Edit note">`
                : `<span class="ntext">${highlight(n.text, q)}</span>`}
              <span class="nbtns">
                ${editing ? '' : `<button class="iconbtn" data-nact="edit" data-vid="${esc(g.vid)}" data-id="${esc(n.id)}" title="Edit note" aria-label="Edit note">✎</button>`}
                <button class="iconbtn del" data-nact="del" data-vid="${esc(g.vid)}" data-id="${esc(n.id)}" title="Delete note" aria-label="Delete note">✕</button>
              </span>
            </li>`;
          }).join('')}
        </ul>
      </div>`).join('');

    const editInput = $('notesList').querySelector('input[data-edit]');
    if (editInput) {
      editInput.focus();
      editInput.setSelectionRange(editInput.value.length, editInput.value.length);
      const finish = async (saveIt) => {
        if (!editingNote) return;
        const [vid, id] = editInput.dataset.edit.split('|');
        const text = editInput.value.trim();
        editingNote = null;
        if (saveIt && text) {
          await S.update('notes', (notes) => {
            const item = notes[vid]?.items.find((n) => n.id === id);
            if (item) item.text = text;
            return notes;
          });
        }
        renderNotes();
      };
      editInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      editInput.addEventListener('blur', () => finish(true));
    }
  }

  $('noteSearch').addEventListener('input', renderNotes);
  $('notesList').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-nact]');
    if (!b) return;
    const { vid, id } = b.dataset;
    if (b.dataset.nact === 'edit') {
      editingNote = { vid, id };
      renderNotes();
    } else if (b.dataset.nact === 'del') {
      await S.update('notes', (notes) => {
        if (!notes[vid]) return notes;
        notes[vid].items = notes[vid].items.filter((n) => n.id !== id);
        if (!notes[vid].items.length) delete notes[vid];
        return notes;
      });
    }
  });

  /* ---------------- side ---------------- */
  function renderSwitches() {
    document.querySelectorAll('input[data-key]').forEach((i) => { i.checked = !!state.settings[i.dataset.key]; });
    const box = $('lockBox');
    if (state.settings.gate && S.isUnlocked(state.unlock)) {
      box.className = 'lock free';
      box.innerHTML = `<div><b>Unlocked · ${S.minutesLeft(state.unlock)} min left</b>“${esc(state.unlock.reason)}”</div><button class="btn" id="lockNow">Lock now</button>`;
      $('lockNow').onclick = () => chrome.storage.local.set({ unlock: null });
    } else {
      box.className = 'lock';
      box.innerHTML = '';
    }
  }

  document.querySelectorAll('input[data-key]').forEach((input) => {
    input.addEventListener('change', () => S.update('settings', (s) => ({ ...s, [input.dataset.key]: input.checked })));
  });

  function renderLog() {
    const log = state.gateLog.slice(0, 40);
    $('log').innerHTML = log.length
      ? log.map((l) => `<li><span class="tag ${l.kind === 'study' ? 'study' : 'fun'}">${l.kind === 'study' ? 'Study' : '60 min'}</span><small>${esc(S.ago(l.at))}</small><q>${esc(l.reason)}</q></li>`).join('')
      : '<li class="empty" style="padding:6px 0;text-align:left">Every reason you type at the gate is kept here, so you can look back honestly.</li>';
  }

  /* ---------------- backup ---------------- */
  $('exportBtn').addEventListener('click', async () => {
    const data = await S.getAll();
    const blob = new Blob([JSON.stringify({ app: 'youtube-focus-board', version: 1, exportedAt: new Date().toISOString(), data }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `focus-board-backup-${S.dayKey()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    $('dataMsg').textContent = 'Backup downloaded.';
    $('dataMsg').className = 'msg ok';
  });

  $('importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const msg = $('dataMsg');
    try {
      const parsed = JSON.parse(await file.text());
      const data = parsed?.app === 'youtube-focus-board' ? parsed.data : null;
      if (!data || !Array.isArray(data.study) || typeof data.notes !== 'object') throw new Error('not a Focus Board backup');
      if (!confirm('Replace everything on this board with the backup?')) return;
      const clean = {};
      for (const k of S.KEYS) clean[k] = S.normalize(k, data[k]);
      await chrome.storage.local.set(clean);
      msg.textContent = `Backup loaded: ${clean.study.length} videos, ${Object.values(clean.notes).reduce((n, g) => n + (g.items?.length || 0), 0)} notes.`;
      msg.className = 'msg ok';
    } catch (err) {
      msg.textContent = 'That file is not a Focus Board backup.';
      msg.className = 'msg err';
    }
  });

  $('resetBtn').addEventListener('click', async () => {
    if (!confirm('Delete your study list, notes, time history and reasons? This cannot be undone.')) return;
    await chrome.storage.local.clear();
    await chrome.storage.local.set(await S.getAll());
  });

  /* ---------------- welcome ---------------- */
  if (new URLSearchParams(location.search).get('welcome')) $('welcome').hidden = false;
  $('closeWelcome').addEventListener('click', () => {
    $('welcome').hidden = true;
    history.replaceState(null, '', location.pathname);
  });

  /* ---------------- start ---------------- */
  function renderAll() {
    renderTop();
    renderStudy();
    if (!editingNote) renderNotes();
    renderSwitches();
    renderLog();
  }

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    state = await S.getAll();
    if (dragId) return; // don't redraw mid-drag
    renderAll();
  });

  S.getAll().then((data) => { state = data; renderAll(); });
  setInterval(() => { if (state) { renderTop(); renderSwitches(); } }, 30000);
})();

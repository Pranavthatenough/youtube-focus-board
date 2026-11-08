/* YouTube Focus Board — toolbar popup */
(() => {
  'use strict';
  const S = self.YFB;
  const $ = (id) => document.getElementById(id);
  let state = null;

  function renderToday() {
    const day = state.time[S.dayKey()] || { total: 0, study: 0 };
    $('todayTotal').textContent = S.duration(day.total);
    $('todayStudy').textContent = `${S.duration(day.study)} studying`;
    $('todayOther').textContent = `${S.duration(Math.max(0, day.total - day.study))} other`;

    const days = S.lastDays(7).map((d) => ({ ...d, ...(state.time[d.key] || { total: 0, study: 0 }) }));
    const max = Math.max(1800, ...days.map((d) => d.total)); // at least 30 min scale
    $('chart').innerHTML = days.map((d, i) => {
      const other = Math.max(0, d.total - d.study);
      return `<div class="col ${i === 6 ? 'today' : ''}" title="${d.label}: ${S.duration(d.total)} (${S.duration(d.study)} studying)">
        <div class="stack"><i class="o" style="height:${(other / max) * 100}%"></i><i class="s" style="height:${(d.study / max) * 100}%"></i></div>
        <small>${i === 6 ? 'Today' : d.label.slice(0, 2)}</small>
      </div>`;
    }).join('');
  }

  function renderGate() {
    const box = $('gateBox');
    const s = state.settings;
    if (!s.gate) {
      box.className = 'gate';
      box.innerHTML = `<span class="badge">○</span><div class="state"><b>Gate is off</b><small>YouTube opens without asking why.</small></div>`;
      return;
    }
    if (S.isUnlocked(state.unlock)) {
      box.className = 'gate free';
      box.innerHTML = `<span class="badge">◔</span>
        <div class="state"><b>Unlocked · ${S.minutesLeft(state.unlock)} min left</b><small title="${S.escapeHtml(state.unlock.reason)}">“${S.escapeHtml(state.unlock.reason)}”</small></div>
        <button class="btn" id="lockNow">Lock now</button>`;
      $('lockNow').onclick = () => chrome.storage.local.set({ unlock: null });
      return;
    }
    box.className = 'gate locked';
    const open = state.study.filter((x) => !x.done).length;
    box.innerHTML = `<span class="badge">●</span><div class="state"><b>Locked for fun</b><small>${open} video${open === 1 ? '' : 's'} on your study list open freely.</small></div>`;
  }

  function renderSwitches() {
    document.querySelectorAll('input[data-key]').forEach((input) => {
      input.checked = !!state.settings[input.dataset.key];
      input.setAttribute('aria-checked', String(input.checked));
    });
  }

  function render() {
    renderToday();
    renderGate();
    renderSwitches();
  }

  document.querySelectorAll('input[data-key]').forEach((input) => {
    input.addEventListener('change', async () => {
      await S.update('settings', (s) => ({ ...s, [input.dataset.key]: input.checked }));
    });
  });

  $('openBoard').addEventListener('click', async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL('board/board.html') });
    window.close();
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    state = await S.getAll();
    render();
  });

  S.getAll().then((data) => { state = data; render(); });
  setInterval(() => { if (state) renderGate(); }, 15000);
})();

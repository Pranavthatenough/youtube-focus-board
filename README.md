# YouTube Focus Board

**Project 9 · Section C (Chrome extensions) · GenAI Internship, Week 2**

YouTube with the distractions gone. Lectures open freely; to open YouTube for fun, you first have to type why.

> You open YouTube to watch one lecture. Forty minutes later you're deep in Shorts and the lecture still isn't finished. This extension keeps YouTube a place to study.

---

## What it does

| Feature | How it works |
|---|---|
| **Switches to hide Shorts, recommendations and comments** | Toolbar popup or board page. Shorts shelves, tabs and the sidebar link disappear, and any Shorts link opens as a normal video. Recommendations covers the home feed, "Up next", end screens, the paused-video wall and autoplay. Each switch applies instantly, without reloading. |
| **Study list** | Add a lecture from the panel next to the video, by pasting a link, or from the gate. Each video remembers where you stopped ("Continue at 12:40") and is marked done automatically at 95%. Drag to reorder on the board. |
| **Notes linked to timestamps** | Type in the Notes box next to the video and press Enter. The note is pinned to the moment you *started* typing. Click a note to jump there. `Alt + N` starts a note from anywhere on the page. Edit, delete and search all notes on the board. |
| **Time spent today** | Counts only real use: the tab is visible, and the window is focused or a video is playing. Split into study time (videos on your list) and other time, with a 7-day chart. |
| **"Why are you here?" gate** | Any YouTube page that isn't on your study list asks why you came. Write at least 3 real words, then either **Study this video** (adds it to your list) or **Unlock for 60 min**. The toolbar badge counts down the minutes. When time is up, the gate comes back and pauses the video. Every reason is saved under "Why you came" so you can look back honestly. Search pages stay open, so you can always find a lecture. |

Everything is stored with `chrome.storage.local` on your computer. No account, no paid API, no server. The only network call the extension makes itself is YouTube's free oEmbed page, to fill in a video title when you paste a link; offline, the title fills in the first time you open the video.

---

## Install it (step by step)

You need Google Chrome (or Edge, Brave or any Chromium browser).

1. **Get the folder.** Download `youtube-focus-board.zip` and unzip it. You should see a folder named `youtube-focus-board` with a file called `manifest.json` inside.
   - Keep this folder somewhere permanent, like `Documents`. Chrome loads the extension from it every time it starts, so don't delete or move it later.
2. **Open the extensions page.** In Chrome's address bar, type `chrome://extensions` and press Enter.
3. **Turn on Developer mode.** Click the switch in the top-right corner of that page.
4. **Load the extension.** Click **Load unpacked** (top-left) and choose the `youtube-focus-board` folder, the one that contains `manifest.json`.
5. **Pin it.** Click the puzzle-piece icon in the Chrome toolbar and click the pin next to **YouTube Focus Board**. The green play icon now sits in your toolbar.
6. **Done.** A welcome page opens. Go to [youtube.com](https://www.youtube.com) and the gate asks why you're here.

If YouTube was already open before you installed, refresh that tab once.

**To update** after changing the code: open `chrome://extensions` and click the circular arrow on the Focus Board card, then refresh YouTube.
**To remove:** click **Remove** on the same card. This also deletes the saved data, so download a backup first from the board page.

---

## How to use it

1. **Open a lecture** and click **+ Study list** in the Focus Board panel on the right. From now on that video opens without the gate.
2. **While it plays**, type a note in the Notes box and press Enter. The amber time shows which moment the note is linked to; click it to re-stamp to the current moment.
3. **Click any note** to jump back to that moment.
4. **Check your day** from the toolbar button: today's time, study vs other, and the last 7 days.
5. **Open the board** (toolbar → *Open board*) to manage the list, edit and search notes, see every reason you typed, and back up or restore your data.

---

## Done when: checked

| Check | Result |
|---|---|
| Keeps working as you move between videos without a reload | Hiding is pure CSS keyed on attributes set on `<html>`, so it applies to every new page YouTube draws. The panel and gate re-check on YouTube's `yt-navigate-finish` event plus a 0.5 s URL check. Tested with in-page navigation between three videos. |
| Clicking a note jumps to the right moment | The panel sets the video's `currentTime` to the note's second. On the board, the timestamp opens `youtube.com/watch?v=…&t=…s`. |
| Data survives a Chrome restart | Everything lives in `chrome.storage.local`. Tested by closing and reopening the browser with the same profile: study list, notes, time and settings were all still there. |
| A friend installs it using only this guide | See **Install it** above. |

Automated test run (on a local copy of YouTube's page structure, 39 checks): gate blocks and unlocks for exactly 60 minutes, short reasons are rejected, typing in the note box doesn't trigger YouTube's keyboard shortcuts, Shorts links redirect, hidden parts stay hidden after in-page navigation, switches apply instantly, time and study time are counted, notes save with the right second and jump correctly, board editing works, and all data survives a restart.

---

## Files

```
youtube-focus-board/
├── manifest.json        Chrome extension settings (Manifest V3)
├── shared.js            Storage, time formatting, link parsing — used everywhere
├── background.js        Adds up watch time, toolbar badge, opens the board
├── ui.css               Shared colours, buttons and switches (light + dark)
├── content/
│   ├── content.css      The hiding rules for Shorts, recommendations, comments
│   └── content.js       Panel, notes, study list, gate and timer on youtube.com
├── popup/               Toolbar popup: today, 7 days, switches, lock status
├── board/               Full board page: study list, notes, reasons, backup
└── icons/
```

### How it is built

- **Manifest V3** extension. Permissions: `storage` (save your data), `alarms` (refresh the badge each minute), and access to `www.youtube.com` only.
- **No flash of hidden content.** The CSS loads before YouTube draws anything, and parts are hidden *unless* a `data-yfb-show-*` attribute is on `<html>`. Turning a switch off adds the attribute.
- **Shadow DOM** for the panel and the gate, so YouTube's styles can't break them and theirs can't leak into YouTube. The panel follows YouTube's light or dark theme.
- **Keyboard guard.** YouTube uses single keys as shortcuts (`k` pause, `f` fullscreen, `j` rewind). A capture listener registered before YouTube's stops those shortcuts while you type in the note box or the gate.
- **One time counter.** Tabs send their seconds to the background worker, which adds them up in a queue, so two YouTube tabs never overwrite each other.

### Known limits

- YouTube changes its page structure from time to time. If something starts showing again, the selectors to update are all in `content/content.css`.
- Time is counted per visible tab; two YouTube windows side by side, both visible, would both count.
- Works on `www.youtube.com` in desktop Chrome. Not on the mobile site or the YouTube app.

# Slate

A quiet, offline-first space for tasks and notes. Built as an installable Windows PWA (Edge / Chrome) with React, Tailwind, IndexedDB, and optional folder sync — no account, no server, no build step. Notes live inside notebooks, and the note body is a rich text editor that stores plain Markdown.

## Notebooks

Notebooks are the top level of the notes sidebar; notes sit inside them.

- Click a notebook name to collapse or expand it.
- Use the hover actions on a notebook to add a note, rename it, or delete it.
- Delete a notebook and its notes move to another notebook — nothing is thrown away.
- Above a note's title, the notebook selector moves that note somewhere else.
- Pinned notes still float to the top, within their own notebook.
- Search scans every note and only shows notebooks that contain a match.

The first run creates **Personal** and **Reading** notebooks, each with a sample note.

## Writing notes

The switch above a note offers three views:

- **Rich** — WYSIWYG editing. The toolbar covers bold, italic, strikethrough, inline code, headings, bulleted and numbered lists, checklists, quotes, code blocks, links, and dividers.
- **Source** — the raw Markdown behind the note.
- **Preview** — the rendered result.

Formatting is always stored as Markdown, so search, exports, backups, and folder sync keep working unchanged. Checklist items are real checkboxes in the editor; ticking one writes `- [x]` back into the Markdown.

## Run it

Slate must be served over HTTP (browsers block service workers and module XHR on `file://`). Node is the only requirement.

```powershell
cd C:\Users\vivek\Downloads\home
node serve.js
```

Open **http://localhost:4173**.

To use a different port:

```powershell
node serve.js 8080
```

Stop the server with `Ctrl+C`.

## Install as a desktop app

1. Open http://localhost:4173 in **Edge** or **Chrome**.
2. Click the **install** icon in the address bar (or **⋮ → Apps → Install Slate**).
3. Launch **Slate** from the Start menu. It opens in its own window and works offline.

The first run seeds two notebooks (**Personal** and **Reading**) with a welcome note and a reading list, plus three demo tasks. Delete them and start fresh — seeding only happens once.

## Host it on GitHub Pages

Slate is a plain static site with no build step, and every path is relative, so it works at both `https://<user>.github.io/<repo>/` and a custom domain.

1. Create a repository and push these files (repo root or a `/docs` folder).
2. On GitHub, open **Settings → Pages → Build and deployment**.
3. Set **Source** to **Deploy from a branch**, choose `main` and `/ (root)` (or `/docs`), then **Save**.
4. Open `https://<user>.github.io/<repo>/` when the deployment finishes.

The included `.nojekyll` file tells GitHub Pages to serve the folder as-is. Service workers and the install prompt require HTTPS, which GitHub Pages provides. The manifest's `id`, `scope`, and `start_url` are relative, and the service worker resolves its shell against its own URL, so offline mode also works under the `/repo/` subpath.

After pushing an update, reload so the service worker can fetch the new shell. The first reload may still show the cached build while the cache refreshes in the background; reload once more if needed. If the "update ready" toast appears, click reload.

If you change any precached shell file, bump `CACHE_VERSION` in `sw.js` so returning visitors replace their old cache.

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| New note | `Ctrl+N` |
| New task | `Ctrl+Enter` |
| Search notes | `Ctrl+K` |
| Save and sync | `Ctrl+S` |
| Cycle editor view | `Ctrl+E` |
| Tasks / Notes / Split view | `Ctrl+1` / `Ctrl+2` / `Ctrl+3` |
| Show shortcut list | `?` |
| Close dialog | `Esc` |

## Where data lives

- **IndexedDB** (`slate-db`) is the primary store for tasks, notes, and notebooks.
- **localStorage** keeps preferences only: theme, active view, filters, last opened note and notebook, collapsed notebooks, and editor view (`slate:prefs:v1`).
- If IndexedDB cannot open, Slate falls back to a localStorage data mirror (`slate:data:v1:*`) so you can keep working; a toast warns you when that happens.

Older workspaces are migrated automatically: notes without a notebook are placed in a default **Personal** notebook.

### Optional folder sync

Settings → **Connect folder** uses the File System Access API (Chromium only). Slate mirrors the device's data into the chosen folder:

- `tasks.json` — all tasks in one file
- `notebooks.json` — every notebook
- `notes/<slug>-<id>.md` — one Markdown file per note, with its notebook recorded in the frontmatter

Sync is one-way: **this device is the source of truth**. Files are rewritten on change (debounced) and stale note files created by Slate are removed. The folder handle is remembered across restarts; the browser may ask you to re-grant permission.

## Offline behavior

A service worker pre-caches the app shell and CDN assets on first load. After that, Slate opens with no network at all and keeps working. The page itself must be loaded from the same origin it was installed from.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Shell, theme boot script, Tailwind config, CDN scripts |
| `app-core.js` | React app (tasks, notebooks, notes, search, sync, shortcuts) |
| `sw.js` | Service worker and offline navigation fallback |
| `manifest.json` | PWA metadata, icons, app shortcuts |
| `serve.js` | Zero-dependency local static server (optional) |
| `.nojekyll` | Tells GitHub Pages to serve files without Jekyll processing |
| `icons/` | 192/512/maskable PNG icons + Apple touch icon |
| `favicon.svg` | Vector app icon |

## Troubleshooting

- **Blank page / splash stays up** — make sure you opened `http://localhost:...`, not `file://`. Check DevTools → Console.
- **Install option missing** — the page must be on `localhost` or HTTPS. Refresh once so the service worker registers.
- **Folder sync unavailable** — only Chromium-based browsers expose `showDirectoryPicker()`. Fall back to **Settings → Export backup**.
- **Port already in use** — run `node serve.js 8080`.
- **Stale UI after an update** — close all Slate windows and reopen; the worker's update prompt activates the new version and removes old caches.

# copa

A VS Code–style editor that runs entirely in a browser tab, hosted on GitHub Pages.

## What it is

Monaco — the actual editing engine inside VS Code — wired to a file explorer, a
tab strip, and a filesystem that lives in your browser. No server, no accounts,
no uploads.

- **Explorer** with create / rename / delete, nested folders, lazy expansion
- **Tabs** with per-file undo history, cursor and scroll restored on switch, and
  an unsaved-changes dot
- **Editor**: syntax highlighting for ~70 languages, find & replace, multi-cursor,
  bracket matching, folding, minimap
- **Python-aware**: auto-indent after `:`, off-side folding, indentation detected
  from the file so pasted code keeps its own convention
- Drag files in to import; Download to get one back out
- `Ctrl/Cmd+N` new file · `Ctrl/Cmd+S` save · `Ctrl/Cmd+F` find

## The constraint everything follows from

GitHub Pages is a static file server. There is no process to run on the other
end — no Node, no shell, no disk. Real VS Code is a client *plus* a backend that
does file I/O, runs terminals, and hosts language servers. On Pages you only get
the client half, so every backend job must happen inside the tab or not at all.

That is why files live in the **Origin Private File System**: a real, persistent
filesystem the browser grants each origin, with no permission prompt. It survives
reloads and restarts.

What that buys, and what it costs:

| | |
|---|---|
| ✅ | No server, no auth, no upload — works offline after first load |
| ✅ | Persistent across reloads and browser restarts |
| ⚠️ | Files are **invisible to your OS** — not in Finder, not in Explorer |
| ⚠️ | Scoped to this origin and browser profile; a different browser sees nothing |
| ⚠️ | Clearing site data erases everything. The browser may evict under storage pressure |

Import (drag-drop) and Download are the bridges in and out.

Also absent, for the same reason: no terminal and no language servers. Running
Python would mean shipping a WASM interpreter; real IntelliSense would mean a
language server over a worker. Both are possible in-tab, both are large.

## ⚠️ About the passphrase

The site is gated behind a passphrase. **This is a speed bump, not access control.**

The check runs on the visitor's machine, against a constant compiled into the
bundle, on a host with no server-side enforcement. Anyone can read the bundle or
skip the check in DevTools. Only the SHA-256 hash is committed, so the literal
passphrase isn't sitting in a public repo — but a hash is still brute-forceable,
and the gate is cosmetic either way.

Real protection needs a server to hold both the secret and the data, which is
precisely what GitHub Pages does not offer.

The saving grace: there's nothing behind the gate to steal. OPFS is per-origin
and per-profile, so each visitor only ever sees their own files. Your files are
not on the server, because there is no server.

To change it, replace `PASSPHRASE_SHA256` in `src/ui/lock.ts`:

```bash
node -e "console.log(require('crypto').createHash('sha256').update('YOUR-PASSPHRASE').digest('hex'))"
```

Note that `crypto.subtle` requires a secure context, so the gate only works over
`https://` or on `localhost`.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # typecheck + bundle to dist/
npm run preview  # serve dist/ at the deployed base path
```

## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`. One setting is
required first:

> **Settings → Pages → Build and deployment → Source: GitHub Actions**

The workflow sets `PAGES_BASE` from the repo name, because a project site is
served from `https://<owner>.github.io/<repo>/` and every asset URL needs that
prefix baked in at build time. For a user/org site served from the root, set
`PAGES_BASE=/`.

## Browser support

Needs OPFS: Chrome/Edge 108+, Safari 17+, Firefox 111+. Private windows
sometimes disable it. Unsupported browsers get an explanatory message instead of
a blank page.

## Layout

```
src/
  fs/        path helpers · FSProvider interface · OPFS implementation
  editor/    Monaco setup: workers, language detection, model creation
  ui/        tree (explorer) · workspace (tabs + editor) · lock (passphrase gate)
  main.ts    boot, status bar, keybindings, import/export
```

`FSProvider` is the seam. The UI only ever deals in paths and strings, so
swapping OPFS for local-disk (File System Access API) or a GitHub-backed
provider means writing one class, not touching the editor.

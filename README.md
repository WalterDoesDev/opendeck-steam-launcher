# OpenDeck Dynamic Steam Launcher Daemon

A dependency-free Node.js daemon that turns any OpenDeck/Stream Deck into a paginated
Steam game launcher. It reads your locally installed Steam games, builds button profiles
that reserve one key per page for navigation, and activates the Steam launcher profile
**only while the Steam client window has foreground focus** — switching straight back to
your normal profile the moment Steam loses focus or closes.

Built against the OpenDeck profile format (tested with OpenDeck 2.14.0).

## How it works

```
┌─────────────┐   poll   ┌────────────────────┐   write   ┌──────────────────────┐
│  Foreground │ ───────► │  Steam Launcher    │ ───────►  │ ~/.config/opendeck/  │
│   window    │          │  Daemon (Node.js)  │           │  profiles/<device>/  │
│  detection  │ ◄─────── │                    │           │  Steam-Page-N.json   │
└─────────────┘          └─────────┬──────────┘           └──────────────────────┘
                                   │ switchProfile (WebSocket)
                                   ▼
                        OpenDeck plugin socket :57116
```

* **Foreground detection** polls the active window each cycle. When a window whose
  `WM_CLASS`/title matches `steam` takes focus, the daemon tells OpenDeck to switch to
  `Steam-Page-1`. When that window loses focus — or Steam exits — it switches back to
  `Default`.
* **Steam library parsing** reads `libraryfolders.vdf`, resolves every library path,
  parses every `appmanifest_*.acf` (via a small built-in VDF parser), and filters out
  non-game entries such as *Steam Linux Runtime*, *Proton*, *SteamVR*, and *Steamworks
  Common Redistributables*.
* **Pagination** spaces games across `Steam-Page-1.json`, `Steam-Page-2.json`, …,
  keeping one navigation key per page:
  * First page — games fill the first `N-1` slots, last key is **Next**.
  * Middle pages — key 1 is **‹ Prev**, last key is **Next**, games in between.
  * Last page — key 1 is **‹ Prev**, remaining games fill the rest.
* **Actions** use `steam://rungameid/<appid>`, so a button press launches the game
  directly. Navigation keys are OpenDeck *Switch Profile* actions.

The key count `N` is auto-detected from your existing device profiles (e.g. a 6-key
Stream Deck Mini → 5 games per first/last page, 4 on middle pages).

## Requirements

* A Linux machine running OpenDeck (system or Flatpak install) with a connected
  Stream Deck. Windows is supported for the foreground detector and Steam paths.
* Steam installed locally.
* Node.js ≥ 21.5 (the daemon uses the built-in `WebSocket` client). Check with
  `node --version`.
* Optional: `gcc`/`cc` to build the C icon enhancer (`bin/build-enhance.sh`).
* Optional: Python 3 + Pillow as a fallback enhancer if the C binary is absent.
* Optional: a Vulkan-capable GPU for the Real-ESRGAN AI upscale
  (`bin/fetch-realesrgan.sh`).

## Installation

```bash
git clone <this-repo> ~/opendeck-steam-daemon
cd ~/opendeck-steam-daemon

# optional: build the C icon enhancer (recommended)
bin/build-enhance.sh

# optional: Real-ESRGAN AI upscaler (needs a Vulkan GPU)
bin/fetch-realesrgan.sh

node src/daemon.js --once   # scan Steam + write Steam-Page-*.json profiles
node src/daemon.js          # run the daemon (Ctrl+C to stop)
```

`--once` creates `config.json` on first run. Re-run it after installing or
uninstalling games, or restart OpenDeck (tray → *Restart*) after the daemon reports a
library change.

> The bundled private Node copy the author uses (`.node/`) is not part of this
> repository — use a system Node ≥ 21.5 instead. The `bin/enhance_icons` binary and
> `vendor/realesrgan/` are also gitignored; build/download them with the scripts above.

### Autostart (systemd user service)

```bash
mkdir -p ~/.config/systemd/user
cp opendeck-steam-launcher.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now opendeck-steam-launcher.service
```

Edit the copied unit first if your checkout lives somewhere other than
`~/opendeck-steam-daemon` (the `ExecStart` path), and set `DISPLAY` if your
session is not on `:1`.

## Configuration (`config.json`)

| Key | Default | Meaning |
| --- | --- | --- |
| `openDeckConfigDir` | `~/.config/opendeck` | Where profiles/plugins live (set to the Flatpak path if you use the Flatpak build). |
| `deviceId` | `null` (auto-detect) | Stream Deck device id. |
| `keyCount` | `null` (auto-detect) | Total keys on the deck. |
| `steamProfilesPrefix` | `Steam-Page` | Name of the generated profiles. |
| `defaultProfileToExitTo` | `Default` | Profile to switch back to when Steam is unfocused/closed (e.g. `Menu`). |
| `showLogos` | `true` | Use each game's real Steam app icon as the button background (the client icon cached in `appcache/librarycache`). |
| `enhanceIcons` | `true` | Composite the app icon over a blurred, darkened backdrop from the game's artwork for a crisp launcher-style button. Rendered by the bundled C binary `bin/enhance_icons` (rebuild with `bin/build-enhance.sh`); falls back to `bin/enhanceIcons.py` (Python/PIL) if the binary is missing. |
| `aiUpscale` | `true` | Before compositing, upscale each icon 4x with the Real-ESRGAN GPU engine (`vendor/realesrgan/realesrgan-ncnn-vulkan`, needs a Vulkan GPU — fetch with `bin/fetch-realesrgan.sh`). No-ops if the binary is missing. Results are cached by source icon so re-scans are instant. |
| `showAppName` | `false` | Overlay the game name text on its buttons. |
| `locationText` | `bottom` | Text position: `top`, `middle`, `bottom` (or `left`/`right`). |
| `textSize` | `12` | Button text font size. |
| `steamInstall` | `null` (auto-detect) | Steam install dir override. |
| `focusBackend` | `auto` | `auto`, `ewmh` (xprop/X11), `xdotool`, `hyprctl`, `sway`, or `powershell` (Windows). |
| `display` | `null` | X display for the `ewmh` backend (defaults to `$DISPLAY`). |
| `checkProcess` | `true` | Require a live Steam process before reporting focus (handles tray-only/exit). |
| `pollIntervalMs` | `800` | Active-window poll period. |
| `focusStabilityPolls` | `2` | Consecutive consistent polls required before switching (debounce). |
| `libraryRescanIntervalMs` | `60000` | How often the Steam library is re-scanned. |
| `restartOpenDeckOnLibraryChange` | `false` | Auto-restart OpenDeck after the library changes so new pages load. |
| `excludeAppIds` | `[]` | Extra app ids to skip. |
| `excludeNamePatterns` | `[]` | Extra regexes to skip games by name. |

## Notes and caveats

* **Focus detection on Wayland.** On Wayland sessions the daemon uses the X11/EWMH
  path via XWayland. Steam's client is an X11 window, so focus changes between Steam
  and other windows are detected. Because Wayland does not reliably surface "no window
  focused", the daemon additionally requires the Steam process to be alive and relies on
  the class/title match, so a stale X id never triggers a false "Steam focused" switch.
  On Hyprland/Sway the native `hyprctl activewindow` / `swaymsg` backends are used
  instead.
* **Profile reloads.** OpenDeck caches each profile in memory once it has been loaded.
  After the daemon regenerates pages (because your library changed), use OpenDeck's
  *Restart* menu once (or enable `restartOpenDeckOnLibraryChange`).
* **Navigation buttons.** The **‹ Prev**/**Next** keys are plain solid-color
  buttons (no icon) — the fill is `steam_launcher/nav_background.png` in your
  config dir; drop in your own image to restyle them.
* **Windows.** Foreground detection uses `GetForegroundWindow` via PowerShell and Steam
  install paths under `C:\Program Files (x86)\Steam`.
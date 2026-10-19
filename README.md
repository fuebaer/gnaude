# Gnaude

A GNOME Shell extension for chatting with Claude through the Anthropic API from a quick
launcher dialog, in the spirit of the run dialog (Alt+F2) or Vicinae. Press a shortcut, ask,
read the streamed answer, ask follow-up questions, or close the dialog and let the request
finish in the background.

Supports GNOME Shell 50 and 51.

## Features

- **Prompt dialog**: open it with a shortcut (default `Ctrl+Super+Space`) or a **left click**
  on the magnifier icon in the top bar. Answers stream in live and are rendered as Markdown
  (headings, emphasis, lists, inline code and code blocks).
- **Conversations**: after an answer, the input sends follow-up questions in the same chat and
  the dialog shows the whole conversation. `Ctrl+N` or *New chat* starts over.
- **Model switching**: the button on the right of the input (or `Ctrl+M`) picks the model. In a
  new chat this changes the default; inside a chat it applies to that chat from the next
  question on.
- **Effort on the fly**: the effort button next to it (or `Ctrl+E`) either follows the default
  from the preferences or overrides it for the current chat, including its follow-ups. An
  override is shown in the accent color; a new chat starts with the default again.
- **Multi-line input**: `Enter` sends, `Shift+Enter` adds a line. Beyond about eight lines the
  input scrolls.
- **Stop**: *Stop* in the dialog, or the stop icon next to a running chat in the menu. The text
  written so far is kept.
- **Background requests**: `Esc` closes the dialog while the request keeps running. When it
  finishes, a notification appears; clicking it opens the chat.
- **History menu**: a **right click** on the top bar icon lists recent chats with the number of
  questions, a preview of the last answer and its status. Clicking a chat continues it.
- **Translations**: English, German, French, Italian and Spanish, following the system language.

## Requirements

- GNOME Shell 50 or 51
- An [Anthropic API key](https://platform.claude.com/settings/keys); usage is billed to your
  Anthropic account
- A Secret Service keyring such as GNOME Keyring (the API key is stored there)
- To build from source: `make`, `glib-compile-schemas` and the gettext tools (`msgfmt`)

## Installation

### From source (development install)

```sh
git clone https://github.com/fuebaer/gnaude.git
cd gnaude
make install          # builds schema and translations, symlinks the checkout to
                      # ~/.local/share/gnome-shell/extensions/gnaude@n2soft.de
```

Log out and back in (on Wayland, GNOME Shell only discovers new extensions at startup), then:

```sh
gnome-extensions enable gnaude@n2soft.de
gnome-extensions prefs gnaude@n2soft.de   # enter your API key and confirm with ✓
```

### As a zip package

```sh
make pack
gnome-extensions install --force dist/gnaude@n2soft.de.shell-extension.zip
```

Then log out and back in and enable the extension as above.

### Uninstall

```sh
gnome-extensions disable gnaude@n2soft.de
make uninstall        # removes the symlink created by `make install`
```

The chat history stays in `~/.local/share/gnaude/`; delete that folder to remove it as well.

## Usage

| Action | How |
|---|---|
| Open or close the dialog | `Ctrl+Super+Space` (configurable) or left click on the top bar icon |
| Send | `Enter` |
| New line | `Shift+Enter` |
| Next model | `Ctrl+M`, or the model button in the input |
| Next effort level | `Ctrl+E`, or the effort button in the input |
| New chat | `Ctrl+N`, or *New chat* |
| Close (request keeps running) | `Esc` |
| History, preferences | right click on the top bar icon |

### Preferences

- **API key**: stored in the GNOME keyring, never in dconf.
- **Default model**: Claude Opus 5.5 (default), Sonnet 5.5, Haiku 5.5 or Fable 5.1.
- **Effort**: from *Low (fastest)* to *Maximum*; lower answers faster and cheaper, higher thinks
  more thoroughly. Default: *Medium*. The prompt dialog can override it per chat.
- **Shortcut** for the dialog.
- **Continue the last chat**: the shortcut and the top bar icon reopen the most recent chat
  instead of starting a new one.
- **Chats in the history**: how many chats are kept (default 50).

## Privacy

- Prompts and the earlier turns of a chat are sent to the Anthropic API
  (`api.anthropic.com`) with your API key. Gnaude makes no other network requests.
- The API key lives in your keyring. The chat history is stored locally in
  `~/.local/share/gnaude/history.json`, readable only by your user (mode 0600).

## How conversations are sent

Current Claude models bind every thinking block to the exact conversation it was produced in.
Gnaude therefore stores each answer with its complete content blocks and sends them back
unchanged; the system prompt is frozen per chat and the history is only ever appended to.
Cancelled or failed turns are left out of later requests entirely. If the model changes within
a chat, the API drops thinking blocks the new model cannot read, without error or cost, and
each turn records which model answered it. Changing the effort between requests keeps thinking
blocks valid and only restarts the prompt cache. Should a replayed block still not match, the request
asks the API to drop it instead of failing (`prefix_mismatch_behavior: "drop_block"`). Automatic
prompt caching keeps follow-up questions cheap. Refusals are retried on a fallback model where
the API supports it (`fallbacks: "default"`).

## Development

GNOME Shell caches loaded modules, so code changes need a re-login. Without logging out,
use a nested shell (requires the mutter devkit, e.g. the `mutter-devkit` package on Arch):

```sh
dbus-run-session gnome-shell --devkit --wayland
```

Logs: `journalctl -f -o cat /usr/bin/gnome-shell`

### Translations

Source strings are English and marked with `_()`; `N_()` marks table entries in
`lib/models.js`. In the shell process `_()` only works once the extension object exists, so it
must not be called while a module is being imported.

```sh
make update-po       # extract strings into po/gnaude.pot and merge them into po/*.po
make check-po        # fails while any message is untranslated or fuzzy
```

To add a language, copy `po/gnaude.pot` to `po/<lang>.po`, translate it and add the language to
`LINGUAS` in the `Makefile`.

### Tests

```sh
make test                                  # catalog check plus unit tests of the API client,
                                           # conversations, history and Markdown rendering
test/e2e/run.sh                            # the whole extension in a throwaway GNOME Shell
GNAUDE_E2E_LANGUAGE=fr test/e2e/run.sh     # the same with the French UI

# Screenshots and actor tree only, next to another installed extension with a copy of its
# settings (useful for reproducing rendering problems):
GNAUDE_E2E_SCENARIO=visual GNAUDE_E2E_EXTRA=blur-my-shell@aunetx \
GNAUDE_E2E_DCONF=/org/gnome/shell/extensions/blur-my-shell/ test/e2e/run.sh
```

None of the tests calls the real API. They run against `test/mock_server.py`, which, like
the real API, signs thinking blocks over the conversation prefix and rejects an edited history
with a 400, so the tests verify that follow-ups replay the history correctly.

The end-to-end run starts its own headless GNOME Shell with a temporary home directory,
D-Bus session and keyring, so your session and settings are not touched. It drives the
shortcut, keyboard, clicks, menus and preferences through virtual input devices and saves
screenshots to the output directory. Requirements: `gjs`, `python3`, `gnome-keyring` and
`dconf`.

## Project layout

| Path | Contents |
|---|---|
| `extension.js` | Lifecycle, shortcut, requests, cancelling, notifications |
| `prefs.js` | Preferences window (libadwaita) |
| `lib/anthropic.js` | Streaming client for `POST /v1/messages` (libsoup, server-sent events) |
| `lib/conversation.js` | System prompt; builds the request messages from a chat |
| `lib/history.js` | Chats with JSON persistence and migration of older formats |
| `lib/promptDialog.js` | Dialog with multi-line input, model and effort selectors, transcript |
| `lib/indicator.js` | Top bar icon and history menu |
| `lib/messages.js` | Translated status and error texts |
| `lib/markdown.js` | Markdown to Pango markup or plain text |
| `lib/secret.js` | API key in the keyring (libsecret) |
| `lib/models.js` | Models and effort levels |
| `po/` | Translation template and catalogs (de, es, fr, it) |
| `test/` | Mock API, unit tests, end-to-end driver |

## Known limitations

- Remaining API credit cannot be shown: the Anthropic API has no endpoint for the prepaid
  balance (as of October 2026). The Admin API only offers cost reports and spend limits, and
  requires an organization's Admin API key.
- One request per chat at a time; a follow-up can be sent once the answer is complete or
  stopped.
- Very long chats are not summarized (context window: 1M tokens).
- GNOME disables extensions while the screen is locked, which cancels running requests.
- With Blur my Shell (v75) and dynamic blur for popups, a square blur area shows behind the
  rounded corners of every shell dialog, including Alt+F2. Enabling *Static blur* for popups in
  Blur my Shell avoids it.

## License

Gnaude is free software, licensed under the GNU General Public License, version 2 or (at
your option) any later version (GPL-2.0-or-later). See [LICENSE](LICENSE) for the full text.

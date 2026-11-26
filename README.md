# NyanPict

**NyanPict** is a Booru image gallery application designed to make browsing, searching, viewing, and saving anime-style illustrations easier.

**Current Version:** `v1.0.0.1` — See [CHANGELOG.md](./CHANGELOG.md) for full release notes.

The project supports desktop and Android environments, with a simple interface focused on image discovery and organization.

## Features

- **Image Gallery** — Browse illustrations from supported Booru sources in deterministic order.
- **Classic Pagination** — Navigate pages cleanly with First, Prev, Next, and direct page jump controls.
- **Tag Search & Autocomplete** — Search images using tags with live Booru tag suggestions and search history.
- **AI Content Filter** — Quick toggle in the search bar to filter out AI-generated posts.
- **Multiple Sources** — Access Gelbooru, Rule34, and Danbooru from one application.
- **Configurable Settings** — Customize page size (20–100), thumbnail quality, NSFW filter, DNS override, and API credentials.
- **Image Overview** — View image/video details in a dedicated lightbox and open original posts in your browser.
- **Bookmarks** — Save and manage your favorite images.
- **Image Download** — Download images directly to your device with progress notifications.
- **Request Management** — Request queue and cooldown handling for API rate limits.
- **Desktop Support** — Built with Electron.
- **Android Support** — Built with Capacitor.

## What's New in v1.0.0.1

- Added bottom pagination bar (`First`, `Prev`, `Page` input, `Next`) and fixed page skipping / repeated image bugs.
- Added `AI: On/Off` search filter toggle, `View Size` selector, `Image Quality` setting, and `DNS Override` in Settings.
- Added auto-load on startup, thumbnail preloading, live tag autocomplete, and `Open in Browser` in the lightbox.
- Removed blurred placeholders on gallery cards and enforced strict per-page item limits.

Full details: [CHANGELOG.md](./CHANGELOG.md)

## Screenshots

Screenshots will be added in a future update.

## Supported Platforms

| Platform | Technology | Status |
|---|---|---|
| Windows | Electron | Build successful |
| Linux | Electron | Build configuration available |
| Android | Capacitor | Debug build successful |

## Technologies

- HTML5
- CSS3
- JavaScript
- Electron
- Capacitor
- Node.js
- Gradle

## Development Workflow

It is still under development, so there may be many bugs and further improvements needed, you can reach out to the owner directly, or modify the code and contribute by helping to fix existing flaws.

## License

No license has been specified yet.

Until a license is added, all rights are reserved by the copyright holder. Please contact the project owner before redistributing or modifying this project publicly.

## Repository

GitHub: https://github.com/IzuhaNa/NyanPict

---

**NyanPict** — Discover, browse, and collect illustrations in one place.

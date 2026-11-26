# Changelog

All notable changes to **NyanPict** are documented in this file.

## [1.0.1] - 2026-11-27

### Added
- **Auto-Update**: Added `electron-updater` integration for automatic patch updates via GitHub Releases. The app now checks for updates on startup, shows an in-app `Cek Update` / `Instal Update` button, and installs new versions on restart.
- **Classic Pagination Bar**: Replaced infinite scroll with bottom navigation controls (`First`, `Prev`, `Page` jump input, and `Next`).
- **View Size Setting**: Added configurable page size options (`20`, `40`, `50`, `75`, `100` items per page) in `Settings`.
- **AI Content Filter Toggle**: Added `AI: On / Off` quick toggle in the search bar to hide AI-tagged posts when disabled.
- **DNS Override**: Added optional hosts-file DNS resolver override (Google DNS, Cloudflare DNS, OpenDNS) in `Settings` for networks that block Booru domains.
- **Image Quality Selector**: Added thumbnail resolution options (`Low`, `Medium`, `High`) in `Settings`.
- **Main-Process API Key Sync**: Added IPC handlers (`api-key:get`, `api-key:set`, `api-key:has`) in Electron main process and `preload.js`.
- **Live Tag Autocomplete & Thumbnail Preloading**: Added Booru tag suggestion fetching with post counts and next-chunk thumbnail preloading.
- **Lightbox Enhancements**: Added `Open in Browser` (`Buka Web`) button, muted autoplay for video previews, and download progress notifications.

### Changed
- Version bumped to `1.0.1` (semver) from `1.0.0`.
- Moved `View Size` configuration out of the main header into `Settings` for a cleaner gallery layout.
- Preserved deterministic API post order instead of shuffling feed results.
- Split per-source request limits evenly when browsing `All` sources and enforced exact page-size truncation.

### Fixed
- **Pagination Loop & Page Skip**: Fixed `loadFeed(true)` resetting and double-incrementing `currentPage`, which caused `Next` to jump to page 3 and get stuck.
- **Repeated Images Across Pages**: Fixed off-by-one `pid` calculation where Page 1 and Page 2 both requested `pid=0`.
- **Broken `Prev` Button**: Added missing click event handler for `Prev` navigation.
- **Search State & Reset**: Fixed `applySearch()` variable shadowing on `currentTags` and ensured searches reset back to Page 1.
- **Startup Auto-Load**: Fixed feed not loading automatically on app launch and removed leftover infinite-scroll `sentinel` reference error.
- **Masonry Blur Artifacts**: Removed CSS blur placeholder filter on gallery items.

## [1.0.0] - Initial Release
- Booru gallery browsing across Gelbooru, Rule34, and Danbooru.
- Tag search, bookmarks, image overview lightbox, downloads, rate-limit cooldowns, and Electron + Capacitor support.

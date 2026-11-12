# NyanPict

**NyanPict** is a Booru image gallery application designed to make browsing, searching, viewing, and saving anime-style illustrations easier.

The project supports desktop and Android environments, with a simple interface focused on image discovery and organization.

## Features

- **Image Gallery** — Browse illustrations from supported Booru sources.
- **Tag Search** — Search images using tags and keywords.
- **Multiple Sources** — Access supported image sources from one application.
- **Image Overview** — View image details in a dedicated interface.
- **Bookmarks** — Save and manage your favorite images.
- **Image Download** — Download images to your device.
- **Request Management** — Request queue and cooldown handling for API rate limits.
- **Desktop Support** — Built with Electron.
- **Android Support** — Built with Capacitor.

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

## Project Structure

```text
NyanPict/
├── android/                 # Android project
├── build/                   # Application icons
├── src/
│   ├── css/
│   │   └── style.css
│   ├── js/
│   │   ├── main.js
│   │   └── bookmark.js
│   ├── index.html
│   ├── settings.html
│   └── bookmarks.html
├── electron-main.js         # Electron main process
├── main.js
├── preload.js
├── capacitor.config.json
├── package.json
├── package-lock.json
└── README.md
```

## Requirements

Before running the project, install:

- [Node.js](https://nodejs.org/)
- [Git](https://git-scm.com/)
- Android Studio (only if building the Android version)
- Java JDK 17 (for the current Android build setup)

## Installation

Clone the repository:

```bash
git clone https://github.com/IzuhaNa/NyanPict.git
```

Enter the project directory:

```bash
cd NyanPict
```

Install dependencies:

```bash
npm install
```

## Run in Development Mode

Start the Electron application:

```bash
npm start
```

## Build

### Windows

```bash
npm run build:win
```

### Linux

```bash
npm run build:linux
```

### Android

Synchronize the Capacitor project:

```bash
npm run sync:android
```

Open the Android project:

```bash
npm run open:android
```

Alternatively, build a debug APK using Gradle:

```bash
cd android
```

```bash
.\gradlew.bat assembleDebug
```

The debug APK will be generated at:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

## Development Workflow

To upload changes to GitHub:

```bash
git add .
git commit -m "Describe your changes"
git push
```

## License

No license has been specified yet.

Until a license is added, all rights are reserved by the copyright holder. Please contact the project owner before redistributing or modifying this project publicly.

## Repository

GitHub: https://github.com/IzuhaNa/NyanPict

---

**NyanPict** — Discover, browse, and collect illustrations in one place.

'use strict';

// ============================================================
// NYANPICT - ELECTRON MAIN PROCESS
// Window Management
// Frameless Window
// Booru Request Headers
// IPC Communication
// Universal Media Download
// ============================================================

const {
    app,
    BrowserWindow,
    ipcMain,
    session,
    dialog,
    net
} = require('electron');

const path = require('path');
const fs = require('fs/promises');

// ============================================================
// 1. CONFIGURATION
// ============================================================

const APP_ROOT = __dirname;

const PRELOAD_PATH = path.join(APP_ROOT, 'preload.js');

const INDEX_PATH = path.join(
    APP_ROOT,
    'src',
    'index.html'
);

const MAX_DOWNLOAD_SIZE = 250 * 1024 * 1024;

const ALLOWED_HOSTS = [
    'gelbooru.com',
    'rule34.xxx',
    'donmai.us'
];

let mainWindow = null;

// ============================================================
// 2. HOST VALIDATION
// ============================================================

function isAllowedHost(hostname) {
    if (!hostname) {
        return false;
    }

    const host = hostname.toLowerCase();

    return ALLOWED_HOSTS.some((domain) => {
        return (
            host === domain ||
            host.endsWith('.' + domain)
        );
    });
}

// ============================================================
// 3. BOORU REFERER
// ============================================================

function getBooruReferer(requestUrl) {
    try {
        const hostname = new URL(requestUrl)
            .hostname
            .toLowerCase();

        if (
            hostname === 'gelbooru.com' ||
            hostname.endsWith('.gelbooru.com')
        ) {
            return 'https://gelbooru.com/';
        }

        if (
            hostname === 'rule34.xxx' ||
            hostname.endsWith('.rule34.xxx')
        ) {
            return 'https://rule34.xxx/';
        }

        if (
            hostname === 'donmai.us' ||
            hostname.endsWith('.donmai.us')
        ) {
            return 'https://danbooru.donmai.us/';
        }

    } catch (error) {
        console.warn(
            '[NyanPict] URL tidak valid:',
            requestUrl
        );
    }

    return null;
}

// ============================================================
// 4. BOORU REQUEST HEADERS
// ============================================================

function installBooruRequestHeaders() {
    session.defaultSession.webRequest.onBeforeSendHeaders(
        {
            urls: ['https://*/*']
        },
        (details, callback) => {
            try {
                const isMediaRequest =
                    details.resourceType === 'image' ||
                    details.resourceType === 'media';

                if (!isMediaRequest) {
                    callback({
                        requestHeaders: details.requestHeaders
                    });
                    return;
                }

                const referer = getBooruReferer(
                    details.url
                );

                if (!referer) {
                    callback({
                        requestHeaders: details.requestHeaders
                    });
                    return;
                }

                const requestHeaders = {
                    ...details.requestHeaders
                };

                for (const headerName of Object.keys(requestHeaders)) {
                    if (headerName.toLowerCase() === 'referer') {
                        delete requestHeaders[headerName];
                    }
                }

                requestHeaders.Referer = referer;

                callback({
                    requestHeaders
                });

            } catch (error) {
                console.error(
                    '[NyanPict] Header error:',
                    error
                );

                callback({
                    requestHeaders: details.requestHeaders
                });
            }
        }
    );

    console.log(
        '[NyanPict] Booru request headers aktif.'
    );
}

// ============================================================
// 5. FILE NAME SANITIZER
// ============================================================

function sanitizeFileName(value) {
    return String(value || 'unknown')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^\.+/, '')
        .slice(0, 100) || 'unknown';
}

// ============================================================
// 6. MEDIA FILE SIGNATURE
// ============================================================

function detectMedia(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
        return null;
    }

    // JPEG
    if (
        buffer[0] === 0xFF &&
        buffer[1] === 0xD8 &&
        buffer[2] === 0xFF
    ) {
        return {
            extension: '.jpg',
            mime: 'image/jpeg'
        };
    }

    // PNG
    if (
        buffer.length >= 8 &&
        buffer.subarray(0, 8).equals(
            Buffer.from([
                0x89, 0x50, 0x4E, 0x47,
                0x0D, 0x0A, 0x1A, 0x0A
            ])
        )
    ) {
        return {
            extension: '.png',
            mime: 'image/png'
        };
    }

    // GIF
    const gifHeader = buffer
        .subarray(0, 6)
        .toString('ascii');

    if (
        gifHeader === 'GIF87a' ||
        gifHeader === 'GIF89a'
    ) {
        return {
            extension: '.gif',
            mime: 'image/gif'
        };
    }

    // WEBP
    if (
        buffer.length >= 12 &&
        buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
        buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
        return {
            extension: '.webp',
            mime: 'image/webp'
        };
    }

    // AVIF
    if (
        buffer.length >= 12 &&
        buffer.subarray(4, 8).toString('ascii') === 'ftyp' &&
        (
            buffer.subarray(8, 12).toString('ascii') === 'avif' ||
            buffer.subarray(8, 12).toString('ascii') === 'avis'
        )
    ) {
        return {
            extension: '.avif',
            mime: 'image/avif'
        };
    }

    // MP4 / M4V
    if (
        buffer.length >= 12 &&
        buffer.subarray(4, 8).toString('ascii') === 'ftyp'
    ) {
        return {
            extension: '.mp4',
            mime: 'video/mp4'
        };
    }

    // WEBM / EBML
    if (
        buffer.subarray(0, 4).equals(
            Buffer.from([0x1A, 0x45, 0xDF, 0xA3])
        )
    ) {
        return {
            extension: '.webm',
            mime: 'video/webm'
        };
    }

    // BMP
    if (
        buffer[0] === 0x42 &&
        buffer[1] === 0x4D
    ) {
        return {
            extension: '.bmp',
            mime: 'image/bmp'
        };
    }

    // OGG
    if (
        buffer.subarray(0, 4).toString('ascii') === 'OggS'
    ) {
        return {
            extension: '.ogg',
            mime: 'audio/ogg'
        };
    }

    return null;
}

// ============================================================
// 7. DOWNLOAD MEDIA
// ============================================================

async function downloadMedia(event, payload) {
    try {
        console.log(
            '[NyanPict] Download request:',
            payload
        );

        if (!payload || typeof payload !== 'object') {
            throw new Error('Data download tidak valid.');
        }

        const rawUrl = String(
            payload.url || ''
        ).trim();

        const platform = sanitizeFileName(
            payload.platform || 'unknown'
        );

        const id = sanitizeFileName(
            payload.id || 'unknown'
        );

        if (!rawUrl) {
            throw new Error('URL media kosong.');
        }

        let mediaUrl;

        try {
            mediaUrl = new URL(rawUrl);
        } catch {
            throw new Error('URL media tidak valid.');
        }

        if (mediaUrl.protocol !== 'https:') {
            throw new Error(
                'Hanya URL HTTPS yang diizinkan.'
            );
        }

        if (!isAllowedHost(mediaUrl.hostname)) {
            throw new Error(
                'Domain media tidak diizinkan: ' +
                mediaUrl.hostname
            );
        }

        const referer = getBooruReferer(
            mediaUrl.href
        );

        if (!referer) {
            throw new Error(
                'Referer platform tidak ditemukan.'
            );
        }

        // FETCH MEDIA

        console.log(
            '[NyanPict] Mengunduh:',
            mediaUrl.href
        );

        const response = await net.fetch(
            mediaUrl.href,
            {
                method: 'GET',
                redirect: 'follow',
                headers: {
                    'Referer': referer,

                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                        'Chrome/120.0.0.0 Safari/537.36',

                    'Accept':
                        'image/avif,image/webp,image/apng,' +
                        'image/*,video/*,audio/*,*/*;q=0.8'
                }
            }
        );

        if (!response.ok) {
            throw new Error(
                `Server mengembalikan HTTP ${response.status}.`
            );
        }

        // VALIDATE REDIRECT

        const finalUrl = new URL(
            response.url || mediaUrl.href
        );

        if (
            finalUrl.protocol !== 'https:' ||
            !isAllowedHost(finalUrl.hostname)
        ) {
            throw new Error(
                'Redirect menuju domain yang tidak diizinkan.'
            );
        }

        // CHECK FILE SIZE

        const contentLength = Number(
            response.headers.get('content-length') || 0
        );

        if (contentLength > MAX_DOWNLOAD_SIZE) {
            throw new Error(
                'Ukuran file melebihi batas 250 MB.'
            );
        }

        // READ FILE

        const arrayBuffer = await response.arrayBuffer();

        const buffer = Buffer.from(arrayBuffer);

        if (buffer.length === 0) {
            throw new Error('File yang diterima kosong.');
        }

        if (buffer.length > MAX_DOWNLOAD_SIZE) {
            throw new Error(
                'Ukuran file melebihi batas 250 MB.'
            );
        }

        // DETECT FORMAT

        const mediaInfo = detectMedia(buffer);

        if (!mediaInfo) {
            throw new Error(
                'Format file tidak dikenali atau tidak didukung.'
            );
        }

        // FILE NAME

        const fileName =
            `NyanPict_${platform}_${id}${mediaInfo.extension}`;

        // SAVE DIALOG

        const ownerWindow = BrowserWindow.fromWebContents(
            event.sender
        );

        const saveResult = await dialog.showSaveDialog(
            ownerWindow || undefined,
            {
                title: 'Simpan Media - NyanPict',

                defaultPath: path.join(
                    app.getPath('downloads'),
                    fileName
                ),

                buttonLabel: 'Simpan',

                filters: [
                    {
                        name: 'Media',
                        extensions: [
                            'jpg',
                            'jpeg',
                            'png',
                            'gif',
                            'webp',
                            'avif',
                            'mp4',
                            'webm',
                            'bmp',
                            'ogg'
                        ]
                    },
                    {
                        name: 'Semua File',
                        extensions: ['*']
                    }
                ]
            }
        );

        if (
            saveResult.canceled ||
            !saveResult.filePath
        ) {
            console.log(
                '[NyanPict] Download dibatalkan.'
            );

            return {
                success: false,
                canceled: true
            };
        }

        // WRITE FILE

        await fs.writeFile(
            saveResult.filePath,
            buffer
        );

        console.log(
            '[NyanPict] Download berhasil:',
            saveResult.filePath
        );

        return {
            success: true,
            canceled: false,
            filePath: saveResult.filePath,
            fileName: path.basename(saveResult.filePath),
            mime: mediaInfo.mime,
            size: buffer.length
        };

    } catch (error) {
        console.error(
            '[NyanPict] Download gagal:',
            error
        );

        return {
            success: false,
            canceled: false,
            error: error.message ||
                'Terjadi kesalahan saat download.'
        };
    }
}

// ============================================================
// 8. IPC HANDLER - MEDIA DOWNLOAD
// ============================================================

ipcMain.handle(
    'media:download',
    async (event, payload) => {
        console.log(
            '[NyanPict] IPC media:download diterima.'
        );

        return await downloadMedia(
            event,
            payload
        );
    }
);

console.log(
    '[NyanPict] Handler media:download berhasil didaftarkan.'
);

// ============================================================
// 9. CREATE WINDOW
// ============================================================

function createWindow() {
    console.log(
        '[NyanPict] Membuat jendela:',
        __filename
    );

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,

        minWidth: 800,
        minHeight: 600,

        // Hilangkan title bar dan tombol bawaan Windows.
        frame: false,

        // Tampilan jendela.
        backgroundColor: '#121212',
        show: false,

        // Renderer dan preload.
        webPreferences: {
            preload: PRELOAD_PATH,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
    });

    mainWindow.setMenuBarVisibility(false);

    mainWindow.once('ready-to-show', () => {
        if (mainWindow) {
            mainWindow.show();
        }
    });

    mainWindow.loadFile(INDEX_PATH);

    if (!app.isPackaged) {
        mainWindow.webContents.openDevTools({
            mode: 'detach'
        });
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// ============================================================
// 10. IPC HANDLER - WINDOW CONTROLS
// ============================================================

ipcMain.on('window:minimize', (event) => {
    BrowserWindow
        .fromWebContents(event.sender)
        ?.minimize();
});

ipcMain.on('window:toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(
        event.sender
    );

    if (!win) {
        return;
    }

    if (win.isMaximized()) {
        win.unmaximize();
    } else {
        win.maximize();
    }
});

ipcMain.on('window:close', (event) => {
    BrowserWindow
        .fromWebContents(event.sender)
        ?.close();
});

// ============================================================
// 11. APP LIFECYCLE
// ============================================================

app.whenReady().then(() => {
    console.log(
        '[NyanPict] Electron siap.'
    );

    installBooruRequestHeaders();

    createWindow();

    app.on('activate', () => {
        if (
            BrowserWindow.getAllWindows().length === 0
        ) {
            createWindow();
        }
    });
});

// ============================================================
// 12. APP CLOSE
// ============================================================

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// ============================================================
// 13. ERROR HANDLING
// ============================================================

process.on('uncaughtException', (error) => {
    console.error(
        '[NyanPict] Uncaught Exception:',
        error
    );
});

process.on('unhandledRejection', (reason) => {
    console.error(
        '[NyanPict] Unhandled Rejection:',
        reason
    );
});

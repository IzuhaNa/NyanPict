
'use strict';

// ============================================================
// NYANPICT - ELECTRON MAIN PROCESS
// Window Management
// IPC Handlers
// Media Download
// Booru Referer Headers
// ============================================================

const {
    app,
    BrowserWindow,
    session,
    ipcMain,
    dialog,
    net
} = require('electron');

const path = require('path');
const fs = require('fs/promises');

// ============================================================
// 1. CONFIGURATION
// ============================================================

const APP_NAME = 'NyanPict';

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

    return ALLOWED_HOSTS.some((allowedHost) => {
        return (
            host === allowedHost ||
            host.endsWith('.' + allowedHost)
        );
    });
}

// ============================================================
// 3. PLATFORM REFERER
// ============================================================

function getPlatformReferer(hostname) {
    const host = String(hostname || '').toLowerCase();

    if (
        host === 'gelbooru.com' ||
        host.endsWith('.gelbooru.com')
    ) {
        return 'https://gelbooru.com/';
    }

    if (
        host === 'rule34.xxx' ||
        host.endsWith('.rule34.xxx')
    ) {
        return 'https://rule34.xxx/';
    }

    if (
        host === 'donmai.us' ||
        host.endsWith('.donmai.us')
    ) {
        return 'https://danbooru.donmai.us/';
    }

    return null;
}

// ============================================================
// 4. BOORU REQUEST HEADERS
// ============================================================

function configureMediaHeaders() {
    const defaultSession = session.defaultSession;

    const urlPatterns = [
        '*://gelbooru.com/*',
        '*://*.gelbooru.com/*',
        '*://rule34.xxx/*',
        '*://*.rule34.xxx/*',
        '*://donmai.us/*',
        '*://*.donmai.us/*'
    ];

    defaultSession.webRequest.onBeforeSendHeaders(
        {
            urls: urlPatterns
        },
        (details, callback) => {
            try {
                const requestHeaders = {
                    ...details.requestHeaders
                };

                const requestUrl = new URL(details.url);

                const referer = getPlatformReferer(
                    requestUrl.hostname
                );

                if (referer) {
                    requestHeaders['Referer'] = referer;
                }

                requestHeaders['User-Agent'] =
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                    'Chrome/120.0.0.0 Safari/537.36';

                callback({
                    requestHeaders
                });

            } catch (error) {
                console.error(
                    '[NyanPict] Gagal mengatur request headers:',
                    error
                );

                callback({
                    requestHeaders: details.requestHeaders
                });
            }
        }
    );

    console.log(
        '[NyanPict] Booru request headers berhasil dikonfigurasi.'
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
// 6. MEDIA SIGNATURE DETECTION
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
    if (
        buffer.subarray(0, 6).toString('ascii') === 'GIF87a' ||
        buffer.subarray(0, 6).toString('ascii') === 'GIF89a'
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
        buffer.subarray(4, 12).toString('ascii').includes('ftyp') &&
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

    // WEBM / MKV (EBML)
    if (
        buffer.length >= 4 &&
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
            '[NyanPict] Permintaan download diterima:',
            payload
        );

        if (!payload || typeof payload !== 'object') {
            throw new Error('Data download tidak valid.');
        }

        const rawUrl = String(payload.url || '').trim();

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
            throw new Error('Hanya URL HTTPS yang diizinkan.');
        }

        if (!isAllowedHost(mediaUrl.hostname)) {
            throw new Error(
                'Domain media tidak termasuk domain yang diizinkan: ' +
                mediaUrl.hostname
            );
        }

        const referer = getPlatformReferer(
            mediaUrl.hostname
        );

        if (!referer) {
            throw new Error('Referer platform tidak ditemukan.');
        }

        console.log(
            '[NyanPict] Mengambil file:',
            mediaUrl.href
        );

        // ----------------------------------------------------
        // FETCH MEDIA
        // ----------------------------------------------------

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
                        'image/avif,image/webp,image/apng,image/svg+xml,' +
                        'image/*,video/*,audio/*,*/*;q=0.8'
                }
            }
        );

        if (!response.ok) {
            throw new Error(
                `Server mengembalikan HTTP ${response.status}.`
            );
        }

        // ----------------------------------------------------
        // VALIDATE FINAL REDIRECT URL
        // ----------------------------------------------------

        const finalUrl = new URL(response.url || mediaUrl.href);

        if (
            finalUrl.protocol !== 'https:' ||
            !isAllowedHost(finalUrl.hostname)
        ) {
            throw new Error(
                'Server mengarahkan download ke domain yang tidak diizinkan.'
            );
        }

        // ----------------------------------------------------
        // CHECK CONTENT LENGTH
        // ----------------------------------------------------

        const contentLength = Number(
            response.headers.get('content-length') || 0
        );

        if (
            contentLength > 0 &&
            contentLength > MAX_DOWNLOAD_SIZE
        ) {
            throw new Error(
                'Ukuran file melebihi batas 250 MB.'
            );
        }

        // ----------------------------------------------------
        // READ FILE
        // ----------------------------------------------------

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

        // ----------------------------------------------------
        // DETECT FILE TYPE
        // ----------------------------------------------------

        const mediaInfo = detectMedia(buffer);

        if (!mediaInfo) {
            throw new Error(
                'Format file tidak dikenali atau bukan file media yang didukung.'
            );
        }

        // ----------------------------------------------------
        // CREATE FILE NAME
        // ----------------------------------------------------

        const fileName =
            `NyanPict_${platform}_${id}${mediaInfo.extension}`;

        // ----------------------------------------------------
        // SAVE DIALOG
        // ----------------------------------------------------

        const saveResult = await dialog.showSaveDialog(
            mainWindow || undefined,
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

        if (saveResult.canceled || !saveResult.filePath) {
            console.log(
                '[NyanPict] Pengguna membatalkan download.'
            );

            return {
                success: false,
                canceled: true
            };
        }

        // ----------------------------------------------------
        // WRITE FILE
        // ----------------------------------------------------

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
            error: error.message || 'Download gagal.'
        };
    }
}

// ============================================================
// 8. WINDOW MANAGEMENT
// ============================================================

function createWindow() {
    console.log(
        '[NyanPict] Main process aktif:',
        __filename
    );

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        show: false,
        backgroundColor: '#101014',

        webPreferences: {
            preload: PRELOAD_PATH,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    mainWindow.setMenuBarVisibility(false);

    mainWindow.once('ready-to-show', () => {
        if (mainWindow) {
            mainWindow.show();
        }
    });

    mainWindow.loadFile(INDEX_PATH);

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // Buka DevTools hanya jika menjalankan dengan DEBUG_NYANPICT=1
    if (process.env.DEBUG_NYANPICT === '1') {
        mainWindow.webContents.openDevTools({
            mode: 'detach'
        });
    }
}

// ============================================================
// 9. IPC HANDLERS - WINDOW
// ============================================================

ipcMain.on('window:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.minimize();
    }
});

ipcMain.on('window:toggle-maximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
    } else {
        mainWindow.maximize();
    }
});

ipcMain.on('window:close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.close();
    }
});

// ============================================================
// 10. IPC HANDLER - MEDIA DOWNLOAD
// ============================================================

// PENTING:
// Handler didaftarkan di tingkat module, bukan di createWindow()
// atau app.whenReady().
//
// Dengan demikian, renderer tidak akan mengirim permintaan sebelum
// handler ini didaftarkan.

ipcMain.handle(
    'media:download',
    async (event, payload) => {
        console.log(
            '[NyanPict] IPC media:download dipanggil.'
        );

        return await downloadMedia(event, payload);
    }
);

console.log(
    '[NyanPict] Handler media:download terdaftar.'
);

// ============================================================
// 11. APP LIFECYCLE
// ============================================================

app.whenReady().then(() => {
    console.log(
        '[NyanPict] Aplikasi siap dijalankan.'
    );

    configureMediaHeaders();

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

// ============================================================
// 12. WINDOW ALL CLOSED
// ============================================================

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// ============================================================
// 13. APP ERROR HANDLING
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

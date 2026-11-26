
// ============================================================
// NYANPICT - RENDERER
// API, REQUEST QUEUE, COOLDOWN 429, THUMBNAIL,
// BOOKMARK, SEARCH, IMAGE OVERVIEW, DOWNLOAD.
// ============================================================

'use strict';

let currentPage = 1;
let isLoading = false;
let isEndOfResults = false;
let currentSource = 'all';
let currentTags = '';
let isNsfw = getStorageItem('nyanpict_nsfw') === 'true'; // Use stored value

let activeFeedController = null;
let feedRequestId = 0;
let currentLightboxData = null;

// Current view size: baca dari localStorage, default 50
// Ini diproses lagi di initializeNyanPict() setelah DOM ready,
let currentViewSize = Number(getStorageItem('nyanpict_view_size') || 50);

// API Policy & Rate Limit Tracking
const API_POLICY = Object.freeze({
    gelbooru: {
        minIntervalMs: 3000,
        defaultCooldownMs: 180000
    },
    rule34: {
        minIntervalMs: 2000,
        defaultCooldownMs: 90000
    },
    danbooru: {
        minIntervalMs: 100, // Danbooru is usually faster
        defaultCooldownMs: 60000
    }
});

// Rate Limit Tracking: { source: { lastRequestTime: timestamp, cooldownExpiry: timestamp } }
let requestTimestamps = {};


// ============================================================
// 1. API CONFIGURATION
// ============================================================

const BOORU_API = Object.freeze({
    gelbooru: 'https://gelbooru.com/index.php',
    rule34: 'https://api.rule34.xxx/index.php',
    danbooru: 'https://danbooru.donmai.us/posts.json'
});

const apiRequestStates = new Map();
const sourceErrors = new Map();
const lastRateLimitToastAt = new Map();


// ============================================================
// 2. THUMBNAIL CONFIGURATION
// ============================================================

const MEDIA_POLICY = Object.freeze({
    gelbooru: {
        minIntervalMs: 900,
        maxConcurrent: 2
    },
    rule34: {
        minIntervalMs: 750,
        maxConcurrent: 2
    },
    danbooru: {
        minIntervalMs: 650,
        maxConcurrent: 2
    }
});

const mediaRequestStates = new Map();
let thumbnailObserver = null;


// ============================================================
// 3. RATE LIMIT ERROR
// ============================================================

class RateLimitError extends Error {
    constructor(source, retryAt, message) {
        super(message);
        this.name = 'RateLimitError';
        this.source = source;
        this.retryAt = retryAt;
        this.status = 429;
    }
}


// ============================================================
// 4. UTILITIES
// ============================================================

function getStorageItem(key, fallback = '') {
    try {
        const value = localStorage.getItem(key);
        return value === null ? fallback : value;
    } catch (error) {
        console.warn(
            `[NyanPict] Tidak dapat membaca localStorage (${key}):`,
            error
        );
        return fallback;
    }
}


function setStorageItem(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (error) {
        console.error(
            `[NyanPict] Tidak dapat menyimpan localStorage (${key}):`,
            error
        );
        return false;
    }
}


function normalizeRemoteUrl(value) {
    if (
        typeof value !== 'string' ||
        !value.trim()
    ) {
        return '';
    }

    const rawUrl = value.trim();

    const absoluteUrl = rawUrl.startsWith('//')
        ? `https:${rawUrl}`
        : rawUrl;

    try {
        const parsed = new URL(absoluteUrl);

        if (
            parsed.protocol !== 'https:' &&
            parsed.protocol !== 'http:'
        ) {
            return '';
        }

        return parsed.href;
    } catch (error) {
        return '';
    }
}


function isVideo(url) {
    if (
        !url ||
        typeof url !== 'string'
    ) {
        return false;
    }

    try {
        const pathname = new URL(
            url,
            window.location.href
        ).pathname.toLowerCase();

        return /\.(mp4|webm|mov|m4v|ogv)$/.test(pathname);
    } catch (error) {
        return /\.(mp4|webm|mov|m4v|ogv)(?:[?#].*)?$/i.test(url);
    }
}


function safeDecodeURIComponent(value) {
    if (typeof value !== 'string') {
        return '';
    }

    try {
        return decodeURIComponent(value);
    } catch (error) {
        return value;
    }
}


function getFileExtension(url, fallback = 'jpg') {
    try {
        const pathname = new URL(url).pathname;
        const match = pathname.match(/\.([a-z0-9]{2,5})$/i);

        return match
            ? match[1].toLowerCase()
            : fallback;
    } catch (error) {
        return fallback;
    }
}


function shuffleArray(array) {
    const result = [...array];

    for (
        let index = result.length - 1;
        index > 0;
        index -= 1
    ) {
        const randomIndex = Math.floor(
            Math.random() * (index + 1)
        );

        [
            result[index],
            result[randomIndex]
        ] = [
            result[randomIndex],
            result[index]
        ];
    }

    return result;
}


function createAbortError() {
    return new DOMException(
        'Permintaan dibatalkan.',
        'AbortError'
    );
}


function delayWithSignal(milliseconds, signal) {
    if (signal && signal.aborted) {
        return Promise.reject(createAbortError());
    }

    const duration = Math.max(0, milliseconds);

    return new Promise((resolve, reject) => {
        let timerId = null;

        const cleanUp = () => {
            if (timerId !== null) {
                window.clearTimeout(timerId);
            }

            if (signal) {
                signal.removeEventListener(
                    'abort',
                    onAbort
                );
            }
        };

        const onAbort = () => {
            cleanUp();
            reject(createAbortError());
        };

        if (signal) {
            signal.addEventListener(
                'abort',
                onAbort,
                { once: true }
            );
        }

        timerId = window.setTimeout(() => {
            cleanUp();
            resolve();
        }, duration);
    });
}


function formatWaitTime(milliseconds) {
    const seconds = Math.max(
        1,
        Math.ceil(milliseconds / 1000)
    );

    if (seconds >= 60) {
        const minutes = Math.ceil(seconds / 60);
        return `${minutes} menit`;
    }

    return `${seconds} detik`;
}


function getRetryAfterMilliseconds(response, fallbackMilliseconds) {
    const retryAfter = response.headers.get('Retry-After');

    if (retryAfter) {
        const seconds = Number(retryAfter);

        if (
            Number.isFinite(seconds) &&
            seconds > 0
        ) {
            return Math.ceil(seconds * 1000);
        }

        const dateMilliseconds = Date.parse(retryAfter);

        if (Number.isFinite(dateMilliseconds)) {
            return Math.max(
                1000,
                dateMilliseconds - Date.now()
            );
        }
    }

    return fallbackMilliseconds;
}


// ============================================================
// 5. API REQUEST QUEUE
// ============================================================

function getApiRequestState(source) {
    if (!apiRequestStates.has(source)) {
        apiRequestStates.set(source, {
            queue: Promise.resolve(),
            nextRequestAt: 0,
            cooldownUntil: 0
        });
    }

    return apiRequestStates.get(source);
}


async function runApiRequestInQueue(
    source,
    signal,
    requestFunction
) {
    const state = getApiRequestState(source);

    const policy =
        API_POLICY[source] || API_POLICY.danbooru;

    const previousRequest = state.queue;

    let releaseQueue;

    state.queue = new Promise((resolve) => {
        releaseQueue = resolve;
    });

    await previousRequest;

    try {
        if (signal && signal.aborted) {
            throw createAbortError();
        }

        const now = Date.now();

        if (state.cooldownUntil > now) {
            throw new RateLimitError(
                source,
                state.cooldownUntil,
                `${source} masih dalam masa cooldown setelah HTTP 429.`
            );
        }

        const waitForNextRequest = Math.max(
            0,
            state.nextRequestAt - now
        );

        if (waitForNextRequest > 0) {
            await delayWithSignal(
                waitForNextRequest,
                signal
            );
        }

        if (signal && signal.aborted) {
            throw createAbortError();
        }

        state.nextRequestAt =
            Date.now() + policy.minIntervalMs;

        return await requestFunction();

    } finally {
        releaseQueue();
    }
}


function setSourceCooldown(
    source,
    retryAfterMilliseconds
) {
    const state = getApiRequestState(source);

    const retryDuration = Math.max(
        1000,
        retryAfterMilliseconds
    );

    state.cooldownUntil = Math.max(
        state.cooldownUntil,
        Date.now() + retryDuration
    );

    return state.cooldownUntil;
}


// ============================================================
// 6. BUILD BOORU API URL
// ============================================================

function buildBooruApiUrl(
    source,
    tags,
    limit,
    page
) {
    const isNsfw =
        getStorageItem('nyanpict_nsfw') === 'true';

    let processedTags = String(tags || '').trim();

    if (
        !isNsfw &&
        !/\brating:/i.test(processedTags)
    ) {
        const safeRating =
            source === 'danbooru'
                ? 'rating:g'
                : 'rating:safe';

        processedTags = `${processedTags} ${safeRating}`.trim();
    }

    let url;

    if (source === 'gelbooru') {
        url = new URL(BOORU_API.gelbooru);

        url.search = new URLSearchParams({
            page: 'dapi',
            s: 'post',
            q: 'index',
            json: '1',
            limit: String(limit),
            pid: String(Math.max(0, page - 1)),
            tags: processedTags
        }).toString();

        const userId = getStorageItem('nyanpict_gel_uid');
        const apiKey = getStorageItem('nyanpict_gel_key');

        if (userId) {
            url.searchParams.set('user_id', userId);
        }

        if (apiKey) {
            url.searchParams.set('api_key', apiKey);
        }
    }

    else if (source === 'rule34') {
        url = new URL(BOORU_API.rule34);

        url.search = new URLSearchParams({
            page: 'dapi',
            s: 'post',
            q: 'index',
            json: '1',
            limit: String(limit),
            pid: String(Math.max(0, page - 1)),
            tags: processedTags
        }).toString();

        const userId = getStorageItem('nyanpict_r34_uid');
        const apiKey = getStorageItem('nyanpict_r34_key');

        if (userId) {
            url.searchParams.set('user_id', userId);
        }

        if (apiKey) {
            url.searchParams.set('api_key', apiKey);
        }
    }

    else if (source === 'danbooru') {
        url = new URL(BOORU_API.danbooru);

        url.search = new URLSearchParams({
            limit: String(limit),
            page: String(Math.max(1, page)),
            tags: processedTags
        }).toString();

        const login = getStorageItem('nyanpict_dan_login');
        const apiKey = getStorageItem('nyanpict_dan_key');

        if (login) {
            url.searchParams.set('login', login);
        }

        if (apiKey) {
            url.searchParams.set('api_key', apiKey);
        }
    }

    else {
        throw new Error(
            `Sumber Booru tidak dikenal: ${source}`
        );
    }

    return url.href;
}


// ============================================================
// 7. READ API RESPONSE
// ============================================================

async function readJsonResponse(response, source) {
    if (response.status === 429) {
        const policy =
            API_POLICY[source] || API_POLICY.danbooru;

        const retryMilliseconds =
            getRetryAfterMilliseconds(
                response,
                policy.defaultCooldownMs
            );

        const retryAt = setSourceCooldown(
            source,
            retryMilliseconds
        );

        throw new RateLimitError(
            source,
            retryAt,
            `HTTP 429 dari ${source}. Request dihentikan dan cooldown diterapkan.`
        );
    }

    if (!response.ok) {
        throw new Error(
            `HTTP ${response.status} ${response.statusText}`.trim()
        );
    }

    const responseText = await response.text();

    if (!responseText.trim()) {
        return null;
    }

    try {
        return JSON.parse(responseText);
    } catch (error) {
        throw new Error(
            'Respons server bukan JSON yang valid.'
        );
    }
}


// ============================================================
// 8. REQUEST BOORU JSON
// ============================================================

async function requestBooruJson(
    source,
    apiUrl,
    signal
) {
    return runApiRequestInQueue(
        source,
        signal,
        async () => {
            const response = await fetch(
                apiUrl,
                {
                    method: 'GET',
                    cache: 'no-store',
                    signal,
                    headers: {
                        Accept: 'application/json'
                    }
                }
            );

            return readJsonResponse(
                response,
                source
            );
        }
    );
}


// ============================================================
// 9. RATE LIMIT NOTIFICATION
// ============================================================

function notifySourceRateLimit(error) {
    const source = error.source || 'Booru';

    const now = Date.now();

    const lastShown =
        lastRateLimitToastAt.get(source) || 0;

    if (now - lastShown < 15000) {
        return;
    }

    lastRateLimitToastAt.set(source, now);

    const waitText = formatWaitTime(
        error.retryAt - now
    );

    showToast(
        `${source} membatasi request (429). Coba lagi setelah ${waitText}.`,
        'error'
    );
}


// ============================================================
// 10. FETCH BOORU POSTS
// ============================================================

async function fetchBooruPosts(
    source,
    tags,
    limit = 10,
    page = 1,
    signal = undefined
) {
    try {
        const apiUrl = buildBooruApiUrl(
            source,
            tags,
            limit,
            page
        );

        const data = await requestBooruJson(
            source,
            apiUrl,
            signal
        );

        sourceErrors.delete(source);

        // Track request timestamp for rate limiting
        if (!requestTimestamps[currentSource]) {
            requestTimestamps[currentSource] = {};
        }
        requestTimestamps[currentSource].lastRequestTime = Date.now();

        return normalizeBooruData(
            source,
            data
        );

    } catch (error) {
        if (
            error &&
            error.name === 'AbortError'
        ) {
            throw error;
        }

        sourceErrors.set(source, error);

        if (error instanceof RateLimitError) {
            notifySourceRateLimit(error);
        } else {
            console.error(
                `[NyanPict] Gagal mengambil data ${source}:`,
                error
            );
        }

        return [];
    }
}


// ============================================================
// 11. NORMALIZE BOORU DATA
// ============================================================

function extractPostArray(source, data) {
    if (Array.isArray(data)) {
        return data;
    }

    if (!data || typeof data !== 'object') {
        return [];
    }

    // Gelbooru dan Rule34 dapat mengembalikan:
    // { post: [...] }
    // atau { post: {...} }

    if (Array.isArray(data.post)) {
        return data.post;
    }

    if (
        data.post &&
        typeof data.post === 'object'
    ) {
        return [data.post];
    }

    // Dukungan tambahan jika API menggunakan:
    // { posts: [...] }

    if (Array.isArray(data.posts)) {
        return data.posts;
    }

    // Dukungan pembungkus data:
    // { data: { post: [...] } }

    if (
        data.data &&
        typeof data.data === 'object'
    ) {
        if (Array.isArray(data.data.post)) {
            return data.data.post;
        }

        if (
            data.data.post &&
            typeof data.data.post === 'object'
        ) {
            return [data.data.post];
        }

        if (Array.isArray(data.data.posts)) {
            return data.data.posts;
        }
    }

    return [];
}


function normalizeBooruData(source, data) {
    const posts = extractPostArray(source, data);

    return posts.map((post) => {
        let previewUrl = '';
        let downloadUrl = '';
        let tags = '';

        if (
            source === 'gelbooru' ||
            source === 'rule34'
        ) {
            previewUrl =
                post.preview_url ||
                post.sample_url ||
                post.file_url ||
                '';

            downloadUrl =
                post.file_url ||
                post.sample_url ||
                post.preview_url ||
                '';

            tags = post.tags || '';
        }

        else if (source === 'danbooru') {
            previewUrl =
                post.preview_file_url ||
                post.large_file_url ||
                post.file_url ||
                '';

            downloadUrl =
                post.file_url ||
                post.large_file_url ||
                post.preview_file_url ||
                '';

            tags = post.tag_string || '';
        }

        return {
            id: String(post.id ?? ''),
            platform: source,
            preview_url: normalizeRemoteUrl(previewUrl),
            download_url: normalizeRemoteUrl(downloadUrl),
            tags: String(tags || '')
        };

    }).filter((item) => {
        return (
            item.id &&
            (
                item.preview_url ||
                item.download_url
            )
        );
    });
}


// ============================================================
// 12. THUMBNAIL QUEUE
// ============================================================

function getMediaRequestState(source) {
    if (!mediaRequestStates.has(source)) {
        mediaRequestStates.set(source, {
            queue: [],
            active: 0,
            nextStartAt: 0,
            cooldownUntil: 0,
            timerId: null
        });
    }

    return mediaRequestStates.get(source);
}


function pumpMediaQueue(source) {
    const state = getMediaRequestState(source);

    const policy =
        MEDIA_POLICY[source] || MEDIA_POLICY.danbooru;

    if (
        state.timerId !== null ||
        state.active >= policy.maxConcurrent ||
        state.queue.length === 0
    ) {
        return;
    }

    if (state.cooldownUntil > Date.now()) {
        return;
    }

    const waitMilliseconds = Math.max(
        0,
        state.nextStartAt - Date.now()
    );

    state.timerId = window.setTimeout(() => {
        state.timerId = null;

        if (
            state.active >= policy.maxConcurrent ||
            state.queue.length === 0
        ) {
            pumpMediaQueue(source);
            return;
        }

        const task = state.queue.shift();

        if (!task.element.isConnected) {
            pumpMediaQueue(source);
            return;
        }

        state.active += 1;

        state.nextStartAt =
            Date.now() + policy.minIntervalMs;

        let released = false;
        let timeoutId = null;

        const release = () => {
            if (released) {
                return;
            }

            released = true;

            if (timeoutId !== null) {
                window.clearTimeout(timeoutId);
            }

            state.active = Math.max(
                0,
                state.active - 1
            );

            pumpMediaQueue(source);
        };

        const onLoad = () => {
            release();

            if (typeof task.onLoad === 'function') {
                task.onLoad();
            }
        };

        const onError = () => {
            release();

            if (typeof task.onError === 'function') {
                task.onError();
            }
        };

        task.element.addEventListener(
            task.loadEvent,
            onLoad,
            { once: true }
        );

        task.element.addEventListener(
            'error',
            onError,
            { once: true }
        );

        timeoutId = window.setTimeout(() => {
            release();

            if (typeof task.onTimeout === 'function') {
                task.onTimeout();
            }
        }, 30000);

        if (task.isVideo) {
            task.element.src = task.url;
            task.element.load();
        } else {
            task.element.src = task.url;
        }

    }, waitMilliseconds);
}


function queueMediaLoad(
    element,
    url,
    source,
    options = {}
) {
    const state = getMediaRequestState(source);

    state.queue.push({
        element,
        url,
        source,
        isVideo: Boolean(options.isVideo),
        loadEvent: options.isVideo
            ? 'loadeddata'
            : 'load',
        onLoad: options.onLoad,
        onError: options.onError,
        onTimeout: options.onTimeout
    });

    pumpMediaQueue(source);
}


// ============================================================
// 13. LAZY THUMBNAIL OBSERVER
// ============================================================

function initializeThumbnailObserver() {
    if (
        thumbnailObserver ||
        !('IntersectionObserver' in window)
    ) {
        return;
    }

    thumbnailObserver = new IntersectionObserver(
        (entries) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) {
                    return;
                }

                const element = entry.target;

                thumbnailObserver.unobserve(element);

                const url = element.dataset.nyanpictSrc;
                const source = element.dataset.nyanpictSource;

                if (
                    !url ||
                    !source ||
                    element.dataset.nyanpictQueued === 'true'
                ) {
                    return;
                }

                element.dataset.nyanpictQueued = 'true';

                const isMediaVideo =
                    element.tagName.toLowerCase() === 'video';

                queueMediaLoad(
                    element,
                    url,
                    source,
                    {
                        isVideo: isMediaVideo,

                        onLoad: () => {
                            element.classList.add('loaded');

                            console.log(
                                `[NyanPict] Media berhasil dimuat: ${source}`,
                                url
                            );
                        },

                        onError: () => {
                            element.classList.remove('loaded');

                            if (
                                typeof element.nyanpictOnError === 'function'
                            ) {
                                element.nyanpictOnError();
                            }
                        },

                        onTimeout: () => {
                            element.classList.remove('loaded');

                            if (
                                typeof element.nyanpictOnError === 'function'
                            ) {
                                element.nyanpictOnError();
                            }
                        }
                    }
                );
            });
        },
        {
            root: null,
            rootMargin: '350px 0px',
            threshold: 0.01
        }
    );
}


function observeMediaElement(element) {
    initializeThumbnailObserver();

    if (thumbnailObserver) {
        thumbnailObserver.observe(element);
        return;
    }

    element.dataset.nyanpictQueued = 'true';

    queueMediaLoad(
        element,
        element.dataset.nyanpictSrc,
        element.dataset.nyanpictSource,
        {
            isVideo:
                element.tagName.toLowerCase() === 'video',

            onLoad: () => {
                element.classList.add('loaded');

                console.log(
                    '[NyanPict] Media berhasil dimuat:',
                    element.dataset.nyanpictSource
                );
            },

            onError: () => {
                element.classList.remove('loaded');

                if (
                    typeof element.nyanpictOnError === 'function'
                ) {
                    element.nyanpictOnError();
                }
            },

            onTimeout: () => {
                element.classList.remove('loaded');

                if (
                    typeof element.nyanpictOnError === 'function'
                ) {
                    element.nyanpictOnError();
                }
            }
        }
    );
}


// ============================================================
// 14. CREATE MEDIA CONTAINER
// ============================================================

function createMediaContainer(item) {
    const container = document.createElement('div');

    container.className = 'nyanpict-media-container';

    container.style.cssText = [
        'position:relative',
        'width:100%',
        'aspect-ratio:3/4',
        'overflow:hidden',
        'background:#222',
        'border-radius:8px 8px 0 0'
    ].join(';');

    const previewUrl = normalizeRemoteUrl(item.preview_url);
    const downloadUrl = normalizeRemoteUrl(item.download_url);

    const lightboxUrl = downloadUrl || previewUrl;

    const showUnavailable = () => {
        container.replaceChildren();

        const message = document.createElement('div');

        message.style.cssText = [
            'position:absolute',
            'inset:0',
            'display:flex',
            'flex-direction:column',
            'align-items:center',
            'justify-content:center',
            'gap:10px',
            'padding:16px',
            'color:#aaa',
            'font-size:12px',
            'text-align:center'
        ].join(';');

        const label = document.createElement('span');

        label.textContent = 'Gambar tidak dapat dimuat';

        message.appendChild(label);

        if (lightboxUrl) {
            const openButton = document.createElement('button');

            openButton.type = 'button';
            openButton.textContent = 'Coba buka file asli';

            openButton.style.cssText =
                'padding:6px 10px;cursor:pointer;font-size:11px;';

            openButton.addEventListener('click', () => {
                openLightbox(
                    lightboxUrl,
                    item.platform,
                    item.id,
                    item.tags,
                    downloadUrl
                );
            });

            message.appendChild(openButton);
        }

        container.appendChild(message);
    };

    const videoUrl = isVideo(previewUrl)
        ? previewUrl
        : (
            !previewUrl && isVideo(downloadUrl)
                ? downloadUrl
                : ''
        );

    if (videoUrl) {
        const video = document.createElement('video');

        video.muted = true;
        video.autoplay = true;
        video.loop = true;
        video.playsInline = true;
        video.preload = 'none';

        video.style.cssText =
            'width:100%;height:100%;object-fit:cover;display:block;cursor:pointer;background:#222;';

        video.dataset.nyanpictSrc = videoUrl;
        video.dataset.nyanpictSource = item.platform;
        video.nyanpictOnError = showUnavailable;

        video.addEventListener('click', () => {
            openLightbox(
                lightboxUrl || videoUrl,
                item.platform,
                item.id,
                item.tags,
                downloadUrl
            );
        });

        observeMediaElement(video);

        container.appendChild(video);

        return container;
    }

    const imageUrl = previewUrl || downloadUrl;

    if (!imageUrl || isVideo(imageUrl)) {
        showUnavailable();
        return container;
    }

    const image = document.createElement('img');

    image.alt =
        `NyanPict ${item.platform} ID ${item.id}`;

    image.loading = 'lazy';
    image.decoding = 'async';
    image.draggable = false;

    image.style.cssText =
        'width:100%;height:100%;object-fit:cover;display:block;cursor:pointer;background:#222;';

    image.dataset.nyanpictSrc = imageUrl;
    image.dataset.nyanpictSource = item.platform;

    image.nyanpictOnError = () => {
        console.warn(
            `[NyanPict] Gagal memuat thumbnail ${item.platform} #${item.id}:`,
            imageUrl
        );

        showUnavailable();
    };

    image.addEventListener('click', () => {
        if (lightboxUrl) {
            openLightbox(
                lightboxUrl,
                item.platform,
                item.id,
                item.tags,
                downloadUrl
            );
        }
    });

    observeMediaElement(image);

    container.appendChild(image);

    return container;
}


// ============================================================
// 15. CREATE POST CARD
// ============================================================

function createPostCard(item) {
    const card = document.createElement('div');

    card.className = 'masonry-item';

    card.appendChild(
        createMediaContainer(item)
    );

    const info = document.createElement('div');

    info.className = 'item-info';

    info.style.cssText =
        'padding:10px;font-size:12px;color:#fff;';

    const idLabel = document.createElement('strong');

    idLabel.textContent = 'ID: ';

    info.appendChild(idLabel);

    info.appendChild(
        document.createTextNode(
            `${item.id} • ${item.platform}`
        )
    );

    card.appendChild(info);

    const actions = document.createElement('div');

    actions.style.cssText =
        'display:flex;gap:5px;padding:0 12px 12px 12px;';

    const downloadButton = document.createElement('button');

    downloadButton.type = 'button';
    downloadButton.className = 'download-btn';
    downloadButton.textContent = 'Unduh';
    downloadButton.disabled = !item.download_url;

    downloadButton.style.cssText =
        'flex:1;padding:8px;font-size:12px;cursor:pointer;';

    downloadButton.addEventListener('click', () => {
        triggerUniversalDownload(
            downloadButton,
            item.download_url,
            item.platform,
            item.id
        );
    });

    const bookmarkButton = document.createElement('button');

    bookmarkButton.type = 'button';
    bookmarkButton.textContent = '☆';
    bookmarkButton.title = 'Tambahkan ke favorit';

    bookmarkButton.style.cssText =
        'background:#ffb900;color:#111;padding:8px;font-size:12px;cursor:pointer;border:none;border-radius:4px;';

    bookmarkButton.addEventListener('click', () => {
        saveBookmark(
            bookmarkButton,
            item.id,
            item.platform,
            item.preview_url,
            item.download_url
        );
    });

    actions.append(
        downloadButton,
        bookmarkButton
    );

    card.appendChild(actions);

    return card;
}


// ============================================================
// 16. DETECT MEDIA SOURCE
// ============================================================

function getSourceFromMediaUrl(url) {
    try {
        const hostname = new URL(url)
            .hostname
            .toLowerCase();

        if (
            hostname === 'gelbooru.com' ||
            hostname.endsWith('.gelbooru.com')
        ) {
            return 'gelbooru';
        }

        if (
            hostname === 'rule34.xxx' ||
            hostname.endsWith('.rule34.xxx')
        ) {
            return 'rule34';
        }

        if (
            hostname === 'donmai.us' ||
            hostname.endsWith('.donmai.us')
        ) {
            return 'danbooru';
        }

    } catch (error) {
        console.warn(
            '[NyanPict] URL media untuk deteksi 429 tidak valid:',
            url
        );
    }

    return '';
}


// ============================================================
// 17. PARSE RETRY-AFTER
// ============================================================

function parseRetryAfterValue(
    value,
    fallbackMilliseconds
) {
    if (value) {
        const seconds = Number(value);

        if (
            Number.isFinite(seconds) &&
            seconds > 0
        ) {
            return Math.ceil(seconds * 1000);
        }

        const dateMilliseconds = Date.parse(value);

        if (Number.isFinite(dateMilliseconds)) {
            return Math.max(
                1000,
                dateMilliseconds - Date.now()
            );
        }
    }

    return fallbackMilliseconds;
}


// ============================================================
// 18. HANDLE MEDIA HTTP 429
// ============================================================

function handleMediaRateLimited(payload) {
    if (
        !payload ||
        payload.statusCode !== 429
    ) {
        return;
    }

    const source = getSourceFromMediaUrl(payload.url);

    if (!source) {
        return;
    }

    const fallbackCooldown =
        (
            API_POLICY[source] ||
            API_POLICY.danbooru
        ).defaultCooldownMs;

    const cooldownMilliseconds = parseRetryAfterValue(
        payload.retryAfter,
        fallbackCooldown
    );

    const state = getMediaRequestState(source);

    state.cooldownUntil = Math.max(
        state.cooldownUntil,
        Date.now() + cooldownMilliseconds
    );

    const queuedTasks = state.queue.splice(0);

    queuedTasks.forEach((task) => {
        if (typeof task.onError === 'function') {
            task.onError();
        }
    });

    const lastShown =
        lastRateLimitToastAt.get(`${source}:media`) || 0;

    if (Date.now() - lastShown >= 15000) {
        lastRateLimitToastAt.set(
            `${source}:media`,
            Date.now()
        );

        showToast(
            `CDN ${source} mengirim HTTP 429. Pemuatan gambar dihentikan sementara selama ${formatWaitTime(cooldownMilliseconds)}.`,
            'error'
        );
    }

    console.warn(
        '[NyanPict] CDN media rate limited:',
        payload.url,
        payload
    );
}


// ============================================================
// 19. FEED MESSAGE
// ============================================================

function showFeedMessage(message) {
    const gallery = document.getElementById(
        'masonry-gallery'
    );

    if (!gallery) {
        return;
    }

    const paragraph = document.createElement('p');

    paragraph.textContent = message;

    paragraph.style.cssText =
        'text-align:center;width:100%;color:#aaa;padding:20px;';

    gallery.replaceChildren(paragraph);
}


function getEmptyFeedMessage() {
    const activeRateLimit = Array
        .from(sourceErrors.values())
        .find(
            (error) =>
                error instanceof RateLimitError &&
                error.retryAt > Date.now()
        );

    if (activeRateLimit) {
        const remaining = formatWaitTime(
            activeRateLimit.retryAt - Date.now()
        );

        return `Sumber sedang membatasi permintaan (HTTP 429). Coba lagi dalam ${remaining}.`;
    }

    return 'Tidak ada gambar ditemukan. Periksa tag, koneksi, atau pengaturan API.';
}


// ============================================================
// 20. LOAD FEED
// ============================================================

async function loadFeed(isNew = false) {
    const gallery = document.getElementById(
        'masonry-gallery'
    );

    if (!gallery) {
        console.error(
            '[NyanPict] Elemen #masonry-gallery tidak ditemukan.'
        );
        return;
    }

    // Inisialisasi filter AI (baca dari localStorage)
    const aiFilterOn = getStorageItem('nyanpict_ai_filter') !== 'false';

    if (isNew) {
        if (activeFeedController) {
            activeFeedController.abort();
        }

        feedRequestId += 1;
        isEndOfResults = false;

        sourceErrors.clear();

        gallery.replaceChildren();
    }

    else if (
        isLoading ||
        isEndOfResults
    ) {
        return;
    }

    const requestId = feedRequestId;

    // Rate Limit Check: skip if source is in cooldown
    const now = Date.now();
    const policy = API_POLICY[currentSource];
    if (policy && requestTimestamps[currentSource]) {
        const timeSinceLast = now - requestTimestamps[currentSource].lastRequestTime;
        const minInterval = policy.minIntervalMs;
        if (timeSinceLast < minInterval) {
            const waitTime = minInterval - timeSinceLast;
            showToast(
                `Rate limit: tunggu ${Math.ceil(waitTime / 1000)} detik lagi.`,
                'warning'
            );
            // Wait and retry
            await new Promise(resolve => setTimeout(resolve, waitTime));
            requestTimestamps[currentSource].lastRequestTime = Date.now();
        }
    }

    const controller = new AbortController();

    activeFeedController = controller;
    isLoading = true;

    try {
        let data = [];

        // Determine per-source limit: when 'all', split viewSize across sources
        const sourceCount = currentSource === 'all' ? 2 : 1;
        const perSourceLimit = Math.ceil(currentViewSize / sourceCount);
        const targetPage = Math.max(1, currentPage); // buildBooruApiUrl expects 1-indexed page

        if (currentSource === 'all') {
            const [
                gelbooruPosts,
                rule34Posts
            ] = await Promise.all([
                fetchBooruPosts(
                    'gelbooru',
                    currentTags,
                    perSourceLimit,
                    targetPage,
                    controller.signal
                ),

                fetchBooruPosts(
                    'rule34',
                    currentTags,
                    perSourceLimit,
                    targetPage,
                    controller.signal
                )
            ]);

            data = [
                ...gelbooruPosts,
                ...rule34Posts
            ].slice(0, currentViewSize);
        }

        else {
            data = (await fetchBooruPosts(
                currentSource,
                currentTags,
                perSourceLimit,
                targetPage,
                controller.signal
            )).slice(0, currentViewSize);
        }

        if (
            requestId !== feedRequestId ||
            controller.signal.aborted
        ) {
            return;
        }

        if (!data.length) {
            isEndOfResults = true;

            if (currentPage === 1) {
                showFeedMessage(
                    getEmptyFeedMessage()
                );
            }

            return;
        }

        const fragment = document.createDocumentFragment();

        data.forEach((item) => {
            // Filter AI: lewati item jika AI filter OFF dan tag mengandung 'ai'
            if (!aiFilterOn && item.tags) {
                // Regex yang lebih kuat: match "ai", "ai-generated", "ai_art", "ai_" dll
                const hasAiTag = item.tags.split(/\s+/).some(t => /\bai[_-]?\w*/i.test(t) || /^ai$/i.test(t));
                if (hasAiTag) {
                    return; // Lewati item ini (jangan tampilkan di gallery)
                }
            }

            fragment.appendChild(
                createPostCard(item)
            );
        });

        gallery.appendChild(fragment);

        // Preload images for next page chunk
        preloadNextPageImages(data);

    } catch (error) {
        if (
            error &&
            error.name !== 'AbortError'
        ) {
            console.error(
                '[NyanPict] Kesalahan saat memuat feed:',
                error
            );

            showToast(
                'Gagal memuat feed. Periksa koneksi internet dan Console.',
                'error'
            );
        }

    } finally {
        if (requestId === feedRequestId) {
            isLoading = false;

            if (activeFeedController === controller) {
                activeFeedController = null;
            }
        }
    }
}


// ============================================================
// 20.5. THUMBNAIL PRELOAD
// ============================================================

const preloadCache = new Map(); // url -> { img, decoded }

function preloadImage(url) {
    if (!url || preloadCache.has(url)) {
        return preloadCache.get(url);
    }

    const img = new Image();
    img.src = url;
    img.decoding = 'async';
    img.referrerPolicy = 'strict-origin-when-cross-origin';

    const entry = { img, decoded: false };
    preloadCache.set(url, entry);

    if (img.decode) {
        img.decode()
            .then(() => { entry.decoded = true; })
            .catch(() => { /* image may still load */ });
    }

    // Limit cache to 200 entries (LRU-ish: oldest removed)
    if (preloadCache.size > 200) {
        const firstKey = preloadCache.keys().next().value;
        preloadCache.delete(firstKey);
    }

    return entry;
}

function preloadNextPageImages(data) {
    // Preload preview URLs for the next chunk of images not yet in DOM
    // Limit: only preload up to 10 extra images to avoid blocking main thread
    const maxPreload = 10;
    const urls = data
        .slice(0, maxPreload)
        .map(item => normalizeRemoteUrl(item.preview_url))
        .filter(Boolean);

    urls.forEach(url => preloadImage(url));
}

// ============================================================
// 21. DOWNLOAD MIME DETECTION
// ============================================================

function getMimeFromExtension(extension) {
    const mimeTypes = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        avif: 'image/avif',
        bmp: 'image/bmp',
        svg: 'image/svg+xml',
        mp4: 'video/mp4',
        webm: 'video/webm',
        mov: 'video/quicktime',
        m4v: 'video/x-m4v',
        ogv: 'video/ogg'
    };

    return mimeTypes[
        String(extension || '').toLowerCase()
    ] || '';
}


function getExtensionFromMime(mimeType, fallback = 'jpg') {
    const mime = String(mimeType || '')
        .split(';')[0]
        .trim()
        .toLowerCase();

    const extensions = {
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'image/avif': 'avif',
        'image/bmp': 'bmp',
        'image/svg+xml': 'svg',
        'video/mp4': 'mp4',
        'video/webm': 'webm',
        'video/quicktime': 'mov',
        'video/x-m4v': 'm4v',
        'video/ogg': 'ogv'
    };

    return extensions[mime] || fallback;
}


function sanitizeFileName(value) {
    return String(value || 'unknown')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/[. ]+$/g, '')
        .slice(0, 100) || 'unknown';
}


// ============================================================
// 22. CONVERT IMAGE TO JPEG
// ============================================================

async function convertImageToJpeg(blob) {
    if (
        typeof createImageBitmap !== 'function' ||
        typeof document.createElement('canvas').toBlob !== 'function'
    ) {
        throw new Error(
            'Browser tidak mendukung konversi gambar.'
        );
    }

    const bitmap = await createImageBitmap(blob);

    try {
        const canvas = document.createElement('canvas');

        canvas.width = bitmap.width;
        canvas.height = bitmap.height;

        const context = canvas.getContext('2d', {
            alpha: false
        });

        if (!context) {
            throw new Error(
                'Tidak dapat membuat canvas.'
            );
        }

        context.fillStyle = '#ffffff';

        context.fillRect(
            0,
            0,
            canvas.width,
            canvas.height
        );

        context.drawImage(
            bitmap,
            0,
            0
        );

        const jpegBlob = await new Promise((resolve, reject) => {
            canvas.toBlob(
                (result) => {
                    if (!result) {
                        reject(
                            new Error('Konversi JPEG gagal.')
                        );
                        return;
                    }

                    resolve(result);
                },
                'image/jpeg',
                0.94
            );
        });

        return jpegBlob;

    } finally {
        if (typeof bitmap.close === 'function') {
            bitmap.close();
        }
    }
}


// ============================================================
// 23. UNIVERSAL DOWNLOAD - ELECTRON IPC
// ============================================================

async function triggerUniversalDownload(
    buttonElement,
    fileUrl,
    platform,
    id
) {
    const url = normalizeRemoteUrl(fileUrl);

    if (!url) {
        showToast(
            'URL file tidak tersedia.',
            'error'
        );
        return;
    }

    // Pastikan aplikasi berjalan di Electron
    // dan fungsi download tersedia dari preload.js.

    if (
        !window.electronAPI ||
        typeof window.electronAPI.downloadMedia !== 'function'
    ) {
        console.error(
            '[NyanPict] electronAPI.downloadMedia tidak tersedia. Periksa preload.js.'
        );

        showToast(
            'Fitur download Electron belum tersedia. Periksa preload.js dan main.js.',
            'error'
        );

        return;
    }

    const originalText = buttonElement
        ? buttonElement.textContent
        : 'Unduh';

    if (buttonElement) {
        buttonElement.textContent = '⏳ Mengunduh...';
        buttonElement.disabled = true;
    }

    // Show progress toast
    const progressToast = showToast(
        `Mengunduh ${platform}_${id}...`,
        'info'
    );

    try {
        console.log(
            '[NyanPict] Memulai download:',
            {
                url,
                platform,
                id
            }
        );

        // Download dilakukan oleh Electron main process.
        // Dengan cara ini, proses download tidak bergantung
        // pada CORS renderer dan dapat menggunakan Referer.

        const result = await window.electronAPI.downloadMedia(
            url,
            String(platform || 'unknown'),
            String(id || 'unknown')
        );

        if (!result || typeof result !== 'object') {
            throw new Error(
                'Respons download dari Electron tidak valid.'
            );
        }

        if (result.canceled) {
            showToast(
                'Download dibatalkan.',
                'error',
                progressToast
            );

            return;
        }

        if (!result.success) {
            throw new Error(
                result.error || 'Electron gagal menyimpan file.'
            );
        }

        const fileName =
            result.fileName ||
            `NyanPict_${sanitizeFileName(platform)}_${sanitizeFileName(id)}`;

        console.log(
            '[NyanPict] Download berhasil:',
            result
        );

        showToast(
            `Berhasil disimpan: ${fileName}`,
            'success',
            progressToast
        );

    } catch (error) {
        console.error(
            '[NyanPict] Download gagal:',
            error
        );

        showToast(
            `Download gagal: ${error.message || 'Kesalahan tidak diketahui.'}`,
            'error',
            progressToast
        );

    } finally {
        if (buttonElement) {
            buttonElement.textContent = originalText;
            buttonElement.disabled = false;
        }
    }
}


// ============================================================
// 24. BOOKMARK
// ============================================================

function saveBookmark(
    buttonElement,
    id,
    platform,
    previewUrl,
    downloadUrl
) {
    try {
        let bookmarks;

        try {
            bookmarks = JSON.parse(
                getStorageItem(
                    'nyanpict_bookmarks',
                    '[]'
                )
            );
        } catch (parseError) {
            bookmarks = [];
        }

        if (!Array.isArray(bookmarks)) {
            bookmarks = [];
        }

        const normalizedId = String(id);

        const alreadySaved = bookmarks.some(
            (bookmark) => {
                return (
                    String(bookmark.id) === normalizedId &&
                    bookmark.platform === platform
                );
            }
        );

        if (alreadySaved) {
            showToast(
                'Gambar sudah ada di Favorit.',
                'success'
            );
            return;
        }

        bookmarks.push({
            id: normalizedId,
            platform,
            preview_url: normalizeRemoteUrl(previewUrl),
            download_url: normalizeRemoteUrl(downloadUrl)
        });

        if (
            !setStorageItem(
                'nyanpict_bookmarks',
                JSON.stringify(bookmarks)
            )
        ) {
            throw new Error(
                'Gagal menulis data bookmark ke localStorage.'
            );
        }

        if (buttonElement) {
            buttonElement.textContent = '✔';
        }

        showToast(
            'Ditambahkan ke Favorit.',
            'success'
        );

    } catch (error) {
        console.error(
            '[NyanPict] Gagal menyimpan favorit:',
            error
        );

        showToast(
            'Gagal menyimpan favorit.',
            'error'
        );
    }
}


// ============================================================
// 25. SEARCH HISTORY
// ============================================================

function getSearchHistory() {
    try {
        const history = JSON.parse(
            getStorageItem(
                'nyanpict_search_history',
                '[]'
            )
        );

        return Array.isArray(history)
            ? history.filter(
                (item) => typeof item === 'string'
            )
            : [];

    } catch (error) {
        console.warn(
            '[NyanPict] Riwayat pencarian rusak, direset.',
            error
        );

        return [];
    }
}


function saveSearchHistory(query) {
    const normalizedQuery = String(
        query || ''
    ).trim();

    if (!normalizedQuery) {
        return;
    }

    const history = getSearchHistory().filter(
        (item) => item !== normalizedQuery
    );

    history.unshift(normalizedQuery);

    if (history.length > 10) {
        history.length = 10;
    }

    setStorageItem(
        'nyanpict_search_history',
        JSON.stringify(history)
    );
}


// ============================================================
// 26. AUTOCOMPLETE
// ============================================================

function showSuggestions(filterText = '') {
    const dropdown = document.getElementById(
        'autocomplete-list'
    );

    if (!dropdown) {
        return;
    }

    dropdown.replaceChildren();

    // Coba API booru dulu jika filter tidak kosong
    if (filterText && filterText.trim()) {
        fetchBooruAutocomplete(filterText.trim())
            .then((tags) => {
                const normalizedFilter = String(filterText || '').toLowerCase();

                // Filter hasil API sesuai filter text
                const matchedTags = tags.filter(
                    (tag) =>
                        tag.name.toLowerCase().includes(normalizedFilter) ||
                        tag.category.toLowerCase().includes(normalizedFilter)
                );

                if (matchedTags.length === 0) {
                    // Jika API tidak ada, gunakan history
                    const filteredHistory = getSearchHistory().filter(
                        (item) =>
                            item
                                .toLowerCase()
                                .includes(normalizedFilter)
                    );

                    if (!filteredHistory.length) {
                        dropdown.style.display = 'none';
                        return;
                    }

                    filteredHistory.forEach((item) => {
                        const suggestion = document.createElement('div');

                        suggestion.textContent = item;

                        suggestion.style.cssText =
                            'padding:10px;cursor:pointer;border-bottom:1px solid #444;color:#fff;';

                        suggestion.addEventListener('click', () => {
                            const tagInput = document.getElementById(
                                'tag-input'
                            );

                            if (tagInput) {
                                tagInput.value = item;
                            }

                            dropdown.style.display = 'none';

                            applySearch();
                        });

                        dropdown.appendChild(suggestion);
                    });

                    dropdown.style.display = 'block';
                    return;
                }

                // Render tag dari API dengan post count
                matchedTags.forEach((tag) => {
                    const suggestion = document.createElement('div');

                    suggestion.textContent =
                        `${tag.name} (${tag.post_count} posts)`;

                    suggestion.style.cssText =
                        'padding:8px 12px;cursor:pointer;border-bottom:1px solid #555;color:#eee;font-size:11px;';

                    suggestion.addEventListener('click', () => {
                        const tagInput = document.getElementById(
                            'tag-input'
                        );

                        if (tagInput) {
                            tagInput.value = tag.name;
                        }

                        dropdown.style.display = 'none';

                        applySearch();
                    });

                    dropdown.appendChild(suggestion);
                });

                dropdown.style.display = 'block';
            })
            .catch((error) => {
                console.error('[NyanPict] Error fetching autocomplete:', error);

                // Jika gagal API, turun ke history
                const filteredHistory = getSearchHistory().filter(
                    (item) =>
                        item
                            .toLowerCase()
                            .includes(filterText.toLowerCase())
                );

                if (!filteredHistory.length) {
                    dropdown.style.display = 'none';
                    return;
                }

                filteredHistory.forEach((item) => {
                    const suggestion = document.createElement('div');

                    suggestion.textContent = item;

                    suggestion.style.cssText =
                        'padding:10px;cursor:pointer;border-bottom:1px solid #444;color:#fff;';

                    suggestion.addEventListener('click', () => {
                        const tagInput = document.getElementById(
                            'tag-input'
                        );

                        if (tagInput) {
                            tagInput.value = item;
                        }

                        dropdown.style.display = 'none';

                        applySearch();
                    });

                    dropdown.appendChild(suggestion);
                });

                dropdown.style.display = 'block';
            });
        return;
    }

    // Filter hanya dari history jika filter kosong
    const filteredHistory = getSearchHistory().filter(
        (item) =>
            item
                .toLowerCase()
                .includes('')
    );

    if (!filteredHistory.length) {
        dropdown.style.display = 'none';
        return;
    }

    filteredHistory.forEach((item) => {
        const suggestion = document.createElement('div');

        suggestion.textContent = item;

        suggestion.style.cssText =
            'padding:10px;cursor:pointer;border-bottom:1px solid #444;color:#fff;';

        suggestion.addEventListener('click', () => {
            const tagInput = document.getElementById(
                'tag-input'
            );

            if (tagInput) {
                tagInput.value = item;
            }

            dropdown.style.display = 'none';

            applySearch();
        });

        dropdown.appendChild(suggestion);
    });

    dropdown.style.display = 'block';
}


// ============================================================
// 26. AUTOCOMPLETE / TAG SUGGESTIONS
// ============================================================

function fetchBooruAutocomplete(filterText = '') {
    return new Promise((resolve, reject) => {
        const sourceSelect = document.getElementById('source-select');
        const source = sourceSelect ? sourceSelect.value : 'all';

        let apiUrl;

        if (source === 'gelbooru') {
            apiUrl = 'https://gelbooru.com/index.php?page=dapi&s=index&json=1&limit=50&tags=' +
                encodeURIComponent(filterText);
        } else if (source === 'rule34') {
            apiUrl = 'https://rule34.xxx/index.php?page=dapi&s=index&json=1&limit=50&tags=' +
                encodeURIComponent(filterText);
        } else {
            // danbooru
            apiUrl = 'https://danbooru.donmai.us/tags.json?search[name]=' +
                encodeURIComponent(filterText) + '&limit=50';
        }

        fetch(apiUrl, {
            method: 'GET',
            headers: {
                'Accept': 'application/json'
            },
            cache: 'no-store'
        })
            .then((response) => {
                if (!response.ok) {
                    throw new Error('API request failed: ' + response.status);
                }
                return response.json();
            })
            .then((data) => {
                let tags = [];

                if (source === 'gelbooru' || source === 'rule34') {
                    // Format: { posts: [...] } atau array langsung
                    if (Array.isArray(data.posts)) {
                        tags = data.posts;
                    } else if (data.post && Array.isArray(data.post)) {
                        tags = [data.post];
                    }
                    // Extract name and post_count
                    tags = tags.map((t) => ({
                        name: t.tag || t.name || '',
                        post_count: t.posts || t.post_count || 0
                    })).filter((t) => t.name);
                }
                else if (source === 'danbooru') {
                    // Format: array of { name, category, post_count }
                    if (Array.isArray(data)) {
                        tags = data.map((t) => ({
                            name: t.name || '',
                            category: t.category || '',
                            post_count: t.post_count || 0
                        })).filter((t) => t.name);
                    }
                }

                resolve(tags);
            })
            .catch((error) => {
                console.error('[NyanPict] Autocomplete fetch error:', error);
                reject(error);
            });
    });
}

// ============================================================
// 27. APPLY SEARCH
// ============================================================

function applySearch() {
    const sourceSelect = document.getElementById(
        'source-select'
    );

    const tagInput = document.getElementById(
        'tag-input'
    );

    const aiToggleLabel = document.getElementById(
        'ai-toggle-label'
    );

    if (!sourceSelect || !tagInput) {
        console.error(
            '[NyanPict] #source-select atau #tag-input tidak ditemukan.'
        );
        return;
    }

    currentSource = sourceSelect.value || 'all';
    currentTags = tagInput.value.trim();

    // AI Filter State
    let aiFilterOn = getStorageItem('nyanpict_ai_filter') !== 'false';
    if (aiToggleLabel) {
        aiToggleLabel.textContent = aiFilterOn ? '🤖 AI: On' : '🤖 AI: Off';
    }

    // Jika AI Filter Matikan, hapus tag-tag yang mengandung "ai" dari search
    if (!aiFilterOn) {
        // Regex kuat: hapus tag yang mengandung ai, ai-generated, ai_art, dst
        currentTags = currentTags.split(/\s+/).filter(t => !/\bai[_-]?\w*/i.test(t) && !/^ai$/i.test(t)).join(' ');

        // Tambah penalty rating:explicit agar API kurangi gambar "berbau" AI
        if (!/\brating:/i.test(currentTags)) {
            currentTags = `${currentTags} rating:safe`.trim();
        }
    }

    saveSearchHistory(currentTags);

    const dropdown = document.getElementById(
        'autocomplete-list'
    );

    if (dropdown) {
        dropdown.style.display = 'none';
    }

    currentPage = 1;
    updatePageControls();
    loadFeed(true);
}

function updatePageControls() {
    const firstBtn = document.getElementById('first-page-btn');
    const prevBtn = document.getElementById('prev-page-btn');
    const pageInput = document.getElementById('page-input');

    if (pageInput) {
        pageInput.value = currentPage;
    }
    if (prevBtn) {
        prevBtn.disabled = currentPage <= 1;
        prevBtn.style.opacity = currentPage <= 1 ? '0.4' : '1';
    }
    if (firstBtn) {
        firstBtn.disabled = currentPage <= 1;
        firstBtn.style.opacity = currentPage <= 1 ? '0.4' : '1';
    }
}


// ============================================================
// 28. IMAGE OVERVIEW / LIGHTBOX
// ============================================================

function openLightbox(
    url,
    platform,
    id,
    tags = '',
    downloadUrl = ''
) {
    const modal = document.getElementById(
        'lightbox-modal'
    );

    const modalImage = document.getElementById(
        'lightbox-img'
    );

    const modalVideo = document.getElementById(
        'lightbox-video'
    );

    const modalInfo = document.getElementById(
        'lightbox-info'
    );

    if (
        !modal ||
        !modalImage ||
        !modalVideo ||
        !modalInfo
    ) {
        console.error(
            '[NyanPict] Elemen Overview tidak lengkap.'
        );
        return;
    }

    const mediaUrl = normalizeRemoteUrl(url);

    const finalDownloadUrl = normalizeRemoteUrl(
        downloadUrl
    ) || mediaUrl;

    if (!mediaUrl) {
        showToast(
            'URL media tidak valid.',
            'error'
        );
        return;
    }

    currentLightboxData = {
        url: mediaUrl,
        downloadUrl: finalDownloadUrl,
        platform,
        id,
        tags
    };

    // Reset media sebelumnya.

    modalImage.onerror = null;
    modalImage.removeAttribute('src');
    modalImage.style.display = 'none';

    modalVideo.pause();
    modalVideo.removeAttribute('src');
    modalVideo.load();
    modalVideo.style.display = 'none';

    // Tampilkan gambar atau video.

    if (isVideo(mediaUrl)) {
        modalVideo.onerror = () => {
            showToast(
                'Video tidak dapat dimuat dari CDN.',
                'error'
            );
        };

        modalVideo.src = mediaUrl;
        modalVideo.controls = true;
        modalVideo.playsInline = true;
        modalVideo.muted = true;    // Tambahkan ini
        modalVideo.autoplay = true; // Tambahkan ini
        modalVideo.style.display = 'block';
    }

    else {
        modalImage.alt =
            `NyanPict ${platform} ID ${id}`;

        modalImage.onerror = () => {
            modalImage.onerror = null;

            showToast(
                'Gambar tidak dapat dimuat.',
                'error'
            );
        };

        modalImage.style.display = 'block';
        modalImage.src = mediaUrl;
    }

    // Informasi gambar.

    modalInfo.replaceChildren();

    const information = document.createElement('div');

    information.className = 'overview-information';

    const heading = document.createElement('strong');

    heading.textContent =
        `${String(platform || '').toUpperCase()} • ID ${id}`;

    const tagText = document.createElement('p');

    tagText.textContent =
        safeDecodeURIComponent(String(tags || '')) ||
        'Tidak ada informasi tag.';

    information.append(
        heading,
        tagText
    );

    // Tombol aksi.

    const actions = document.createElement('div');

    actions.className = 'overview-actions';

    const downloadButton = document.createElement('button');

    downloadButton.type = 'button';
    downloadButton.className = 'overview-download-btn';
    downloadButton.textContent = '⬇ Unduh Gambar';
    downloadButton.disabled = !finalDownloadUrl;

    downloadButton.addEventListener('click', () => {
        if (!currentLightboxData) {
            return;
        }

        triggerUniversalDownload(
            downloadButton,
            currentLightboxData.downloadUrl,
            currentLightboxData.platform,
            currentLightboxData.id
        );
    });

    const openWebButton = document.createElement('button');
    openWebButton.type = 'button';
    openWebButton.className = 'overview-openweb-btn';
    openWebButton.textContent = '🌐 Buka Web';
    openWebButton.title = 'Buka halaman postingan di browser';
    openWebButton.disabled = !currentLightboxData;

    openWebButton.addEventListener('click', () => {
        if (!currentLightboxData) {
            return;
        }

        let webUrl;
        if (currentLightboxData.platform === 'gelbooru') {
            webUrl = 'https://gelbooru.com/index.php?page=post&s=view&id=' + currentLightboxData.id;
        } else if (currentLightboxData.platform === 'rule34') {
            webUrl = 'https://rule34.xxx/index.php?page=post&s=view&id=' + currentLightboxData.id;
        } else if (currentLightboxData.platform === 'danbooru') {
            webUrl = 'https://danbooru.donmai.us/posts/' + currentLightboxData.id;
        } else {
            webUrl = currentLightboxData.url || '';
        }

        if (webUrl) {
            window.open(webUrl, '_blank');
        }
    });

    const closeButton = document.createElement('button');

    closeButton.type = 'button';
    closeButton.className = 'overview-close-btn';
    closeButton.textContent = 'Tutup';

    closeButton.addEventListener(
        'click',
        closeLightbox
    );

    actions.append(
        downloadButton,
        openWebButton,
        closeButton
    );

    modalInfo.append(
        information,
        actions
    );

    modal.style.display = 'flex';

    requestAnimationFrame(() => {
        modal.classList.add('active');
    });
}


// ============================================================
// 29. CLOSE LIGHTBOX
// ============================================================

function closeLightbox() {
    const modal = document.getElementById(
        'lightbox-modal'
    );

    const modalImage = document.getElementById(
        'lightbox-img'
    );

    const modalVideo = document.getElementById(
        'lightbox-video'
    );

    if (modal) {
        modal.classList.remove('active');

        window.setTimeout(() => {
            if (!modal.classList.contains('active')) {
                modal.style.display = 'none';
            }
        }, 300);
    }

    if (modalImage) {
        modalImage.onerror = null;
        modalImage.removeAttribute('src');
    }

    if (modalVideo) {
        modalVideo.pause();
        modalVideo.onerror = null;
        modalVideo.removeAttribute('src');
        modalVideo.load();
    }

    currentLightboxData = null;
}


// ============================================================
// 30. TOAST NOTIFICATION
// ============================================================

function showToast(
    message,
    type = 'success'
) {
    const container = document.getElementById(
        'toast-container'
    );

    if (!container) {
        console[
            type === 'error'
                ? 'error'
                : 'log'
        ](
            `[NyanPict] ${message}`
        );

        return;
    }

    const toast = document.createElement('div');

    toast.textContent = String(message);

    toast.style.cssText = [
        'padding:10px 20px',
        'margin:5px',
        'border-radius:5px',
        'color:#fff',
        `background:${type === 'error' ? '#e63946' : type === 'info' ? '#2a9d8f' : '#2a9d8f'}`,
        'box-shadow:0 3px 12px rgba(0,0,0,.25)',
        'font-size:13px',
        'max-width:min(90vw,520px)'
    ].join(';');

    container.appendChild(toast);

    const timer = window.setTimeout(() => {
        toast.remove();
    }, 4500);

    return { toast, cancel: () => { toast.remove(); clearTimeout(timer); } };
}


// ============================================================
// 31. INITIALIZATION
// ============================================================

function initializeNyanPict() {
    const tagInput = document.getElementById(
        'tag-input'
    );

    if (tagInput) {
        tagInput.addEventListener(
            'focus',
            () => showSuggestions(tagInput.value)
        );

        tagInput.addEventListener(
            'input',
            (event) => showSuggestions(event.target.value)
        );

        tagInput.addEventListener(
            'keydown',
            (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    applySearch();
                }
            }
        );
    }

    // AI Filter Toggle Initialization
    const aiToggleLabel = document.getElementById('ai-toggle-label');
    if (aiToggleLabel) {
        // Baca state dari localStorage (default: true/AI On)
        let aiFilterOn = getStorageItem('nyanpict_ai_filter') !== 'false';
        aiToggleLabel.textContent = aiFilterOn ? '🤖 AI: On' : '🤖 AI: Off';

        aiToggleLabel.addEventListener('click', () => {
            aiFilterOn = !aiFilterOn;
            setStorageItem('nyanpict_ai_filter', aiFilterOn ? 'true' : 'false');
            aiToggleLabel.textContent = aiFilterOn ? '🤖 AI: On' : '🤖 AI: Off';
        });
    }

// View Size - read saved value from localStorage
    let savedViewSize = getStorageItem('nyanpict_view_size');
    if (!savedViewSize || isNaN(savedViewSize)) {
        savedViewSize = '50';
    }
    currentViewSize = parseInt(savedViewSize, 10);

    initializeThumbnailObserver();

    if (
        window.electronAPI &&
        typeof window.electronAPI.onMediaRateLimited === 'function'
    ) {
        window.electronAPI.onMediaRateLimited(
            handleMediaRateLimited
        );
    }

    // Infinite scroll.

    // Klik area luar Overview untuk menutup.

    const lightbox = document.getElementById(
        'lightbox-modal'
    );

    if (lightbox) {
        lightbox.addEventListener(
            'click',
            (event) => {
                if (event.target === lightbox) {
                    closeLightbox();
                }
            }
        );
    }

    // Keyboard shortcut.

    document.addEventListener(
        'keydown',
        (event) => {
            if (event.key === 'Escape') {
                closeLightbox();
            }
        }
    );

    // --- Lightweight Classic Pagination ---

    const firstBtn = document.getElementById('first-page-btn');
    const prevBtn = document.getElementById('prev-page-btn');
    const nextBtn = document.getElementById('next-page-btn');
    const pageInput = document.getElementById('page-input');
    const pageTotalLabel = document.getElementById('page-total-label');

    if (pageTotalLabel) {
        pageTotalLabel.textContent = 'of ∞';
    }

    function goToPage(pageNum) {
        pageNum = Math.max(1, parseInt(pageNum, 10) || 1);
        if (!isLoading && pageNum === currentPage) {
            return; // Already on this page
        }

        if (pageInput) {
            pageInput.value = pageNum;
        }

        currentPage = pageNum;
        isEndOfResults = false;
        loadFeed(true); // Selalu reset gallery setiap ganti halaman supaya bersih dan tidak loncat
        updatePageControls();
    }

    if (prevBtn) {
        prevBtn.addEventListener('click', (e) => {
            e.preventDefault();
            goToPage(currentPage - 1);
        });
    }

    if (firstBtn) {
        firstBtn.addEventListener('click', (e) => {
            e.preventDefault();
            goToPage(1);
        });
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', (e) => {
            e.preventDefault();
            goToPage(currentPage + 1);
        });
    }

    if (pageInput) {
        pageInput.addEventListener('change', () => {
            goToPage(pageInput.value);
        });

        pageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                goToPage(pageInput.value);
            }
        });
    }

    // (Sentinel dihapus karena menggunakan pagination bar)

    // Auto-load on startup (pastikan dipanggil agar langsung muat tanpa perlu klik search)
    loadFeed(true);
    updatePageControls();

    initVersionUI();
}

// ============================================================
// 31.5 VERSION & AUTO UPDATE UI
// ============================================================

function initVersionUI() {
    const versionLabel = document.getElementById('app-version-label');
    const checkBtn = document.getElementById('check-update-btn');
    const installBtn = document.getElementById('install-update-btn');
    const statusLabel = document.getElementById('update-status-label');

    const setStatus = (msg) => {
        if (statusLabel) {
            statusLabel.textContent = msg || '';
        }
    };

    // Muat versi dari main process (packaged build membaca package.json version)
    if (window.electronAPI && typeof window.electronAPI.getAppVersion === 'function') {
        window.electronAPI
            .getAppVersion()
            .then((v) => {
                if (versionLabel) {
                    versionLabel.textContent = `v${v}`;
                }
            })
            .catch(() => {
                // Abaikan: versi renderer default tetap tampil
            });
    }

    // Dengarkan status update dari main process
    if (window.electronAPI && typeof window.electronAPI.onUpdateStatus === 'function') {
        window.electronAPI.onUpdateStatus((payload) => {
            if (!payload) {
                return;
            }
            setStatus(payload.message || '');
            if (payload.state === 'downloaded' && installBtn) {
                installBtn.style.display = 'inline-block';
            }
            if (payload.state === 'none' || payload.state === 'error') {
                if (installBtn) {
                    installBtn.style.display = 'none';
                }
            }
        });
    }

    if (checkBtn) {
        checkBtn.addEventListener('click', () => {
            setStatus('Memeriksa pembaruan...');
            if (window.electronAPI && typeof window.electronAPI.checkForUpdates === 'function') {
                window.electronAPI.checkForUpdates()
                    .then((result) => {
                        if (!result || !result.success) {
                            setStatus(
                                (result && result.error) || 'Gagal memeriksa pembaruan.'
                            );
                        }
                    })
                    .catch((error) => {
                        setStatus(`Gagal memeriksa pembaruan: ${error.message}`);
                    });
            } else {
                setStatus('Auto-update tidak tersedia (mode development).');
            }
        });
    }

    if (installBtn) {
        installBtn.addEventListener('click', () => {
            if (window.electronAPI && typeof window.electronAPI.installUpdate === 'function') {
                window.electronAPI.installUpdate()
                    .then((result) => {
                        if (!result || !result.success) {
                            setStatus(
                                (result && result.error) || 'Gagal menginstal pembaruan.'
                            );
                        }
                    })
                    .catch((error) => {
                        setStatus(`Gagal menginstal: ${error.message}`);
                    });
            }
        });
    }
}


// ============================================================
// 32. DOM READY
// ============================================================

if (document.readyState === 'loading') {
    document.addEventListener(
        'DOMContentLoaded',
        initializeNyanPict,
        { once: true }
    );
} else {
    initializeNyanPict();
}

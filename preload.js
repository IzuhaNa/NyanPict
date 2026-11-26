
'use strict';

const {
    contextBridge,
    ipcRenderer
} = require('electron');

contextBridge.exposeInMainWorld(
    'electronAPI',
    Object.freeze({
        minimize: () => {
            ipcRenderer.send('window:minimize');
        },

        maximize: () => {
            ipcRenderer.send('window:toggle-maximize');
        },

        close: () => {
            ipcRenderer.send('window:close');
        },

        downloadMedia: (url, platform, id) => {
            return ipcRenderer.invoke(
                'media:download',
                {
                    url,
                    platform,
                    id
                }
            );
        },

        onMediaRateLimited: (callback) => {
            if (typeof callback !== 'function') {
                return () => {};
            }

            const listener = (_event, payload) => {
                callback(payload);
            };

            ipcRenderer.on(
                'media:rate-limited',
                listener
            );

            return () => {
                ipcRenderer.removeListener(
                    'media:rate-limited',
                    listener
                );
            };
        },

        // ============================================================
        // DNS OVERRIDE
        // ============================================================
        applyDnsOverride: (provider) => {
            return ipcRenderer.invoke('dns-override:apply', provider);
        },

        removeDnsOverride: () => {
            return ipcRenderer.invoke('dns-override:remove');
        },

        getDnsOverrideStatus: () => {
            return ipcRenderer.invoke('dns-override:status');
        },

        // ============================================================
        // API KEY STORAGE (Secure: stored in main process only)
        // ============================================================
        getApiKey: (source) => {
            if (typeof source !== 'string') return '';
            return ipcRenderer.invoke('api-key:get', source);
        },

        setApiKey: (source, key) => {
            if (typeof source !== 'string') return;
            return ipcRenderer.invoke('api-key:set', source, key);
        },

        hasApiKey: (source) => {
            if (typeof source !== 'string') return false;
            return ipcRenderer.invoke('api-key:has', source);
        },

        // ============================================================
        // AUTO UPDATE (electron-updater)
        // ============================================================
        checkForUpdates: () => {
            return ipcRenderer.invoke('update:check');
        },

        installUpdate: () => {
            return ipcRenderer.invoke('update:install');
        },

        getAppVersion: () => {
            return ipcRenderer.invoke('app:get-version');
        },

        onUpdateStatus: (callback) => {
            if (typeof callback !== 'function') return () => {};
            const listener = (_event, payload) => {
                callback(payload);
            };
            ipcRenderer.on('update:status', listener);
            return () => {
                ipcRenderer.removeListener('update:status', listener);
            };
        }
    })
);

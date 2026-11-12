
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
        }
    })
);

import GLib from 'gi://GLib';

import { formatError, logDebug } from './logging.js';

const MAX_REDISPLAY_RETRIES = 8;
const REDISPLAY_RETRY_DELAY_MS = 100;

export default class RedisplayQueue {
    constructor({ getAppDisplay, isReady, warnOnce }) {
        this._getAppDisplay = getAppDisplay;
        this._isReady = isReady;
        this._warnOnce = warnOnce;
        this._currentlyUpdating = false;
        this._pendingRedisplay = false;
        this._redisplaySourceId = 0;
        this._redisplayRetryCount = 0;
        this._destroyed = false;
    }

    request(logText) {
        if (this._destroyed || !this._isReady())
            return;

        logDebug(logText);
        this._pendingRedisplay = true;
        this._scheduleRedisplay(0);
    }

    destroy() {
        if (this._destroyed)
            return;

        this._destroyed = true;
        this._removeRedisplaySource();
        this._pendingRedisplay = false;
        this._currentlyUpdating = false;
        this._redisplayRetryCount = 0;
    }

    _scheduleRedisplay(delayMs) {
        if (this._destroyed)
            return;

        this._removeRedisplaySource();

        if (delayMs > 0) {
            const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
                this._runQueuedRedisplay();
                return GLib.SOURCE_REMOVE;
            });

            this._setRedisplaySourceId(sourceId);
        } else {
            const sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._runQueuedRedisplay();
                return GLib.SOURCE_REMOVE;
            });

            this._setRedisplaySourceId(sourceId);
        }
    }

    _setRedisplaySourceId(sourceId) {
        if (this._redisplaySourceId)
            GLib.source_remove(this._redisplaySourceId);

        this._redisplaySourceId = sourceId;
    }

    _runQueuedRedisplay() {
        this._redisplaySourceId = 0;

        if (this._destroyed || !this._pendingRedisplay)
            return;

        const appDisplay = this._getAppDisplay();

        if (!appDisplay || typeof appDisplay._redisplay !== 'function') {
            this._pendingRedisplay = false;
            this._warnOnce('app-display-unavailable',
                'App display is unavailable; using default app grid behavior');
            return;
        }

        const pageManager = this._getPageManager(appDisplay);

        if (this._currentlyUpdating || this._isPageManagerUpdating(pageManager)) {
            if (this._redisplayRetryCount < MAX_REDISPLAY_RETRIES) {
                this._redisplayRetryCount++;
                this._scheduleRedisplay(REDISPLAY_RETRY_DELAY_MS);
            } else {
                this._pendingRedisplay = false;
                this._redisplayRetryCount = 0;
                this._warnOnce('redisplay-busy-timeout',
                    'App grid stayed busy; skipped one category reorder');
            }

            return;
        }

        this._redisplayRetryCount = 0;
        this._pendingRedisplay = false;
        this._currentlyUpdating = true;

        try {
            appDisplay._redisplay();
        } catch (e) {
            this._warnOnce('queued-redisplay-failed',
                `Failed to reorder app grid (${formatError(e)}); using default app grid behavior`);
        } finally {
            this._currentlyUpdating = false;

            if (this._pendingRedisplay)
                this._scheduleRedisplay(0);
        }
    }

    _getPageManager(appDisplay) {
        const pageManager = appDisplay?._pageManager ?? null;

        if (pageManager && typeof pageManager._updatingPages !== 'boolean')
            this._warnOnce('page-manager-shape',
                'AppDisplay page manager busy state is unavailable; continuing without that guard');

        return pageManager;
    }

    _isPageManagerUpdating(pageManager) {
        return typeof pageManager?._updatingPages === 'boolean' && pageManager._updatingPages;
    }

    _removeRedisplaySource() {
        if (!this._redisplaySourceId)
            return;

        GLib.source_remove(this._redisplaySourceId);
        this._redisplaySourceId = 0;
    }
}

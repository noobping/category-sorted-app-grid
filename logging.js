const LOG_PREFIX = 'CategorySortedAppGrid';
const DEBUG_LOGGING = false;
const WARNED_MESSAGES = new Set();

export function logDebug(message) {
    if (DEBUG_LOGGING)
        console.debug(`${LOG_PREFIX}: ${message}`);
}

export function logWarningOnce(key, message) {
    if (WARNED_MESSAGES.has(key))
        return;

    WARNED_MESSAGES.add(key);
    console.warn(`${LOG_PREFIX}: ${message}`);
}

export function formatError(error) {
    if (!error)
        return 'unknown error';

    return error.message || String(error);
}

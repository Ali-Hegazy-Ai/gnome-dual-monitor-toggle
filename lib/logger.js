const LOG_PREFIX = 'DualMonitorToggle';

let _enabled = false;
let _sequence = 0;
let _opCounter = 0;
let _settings = null;
let _debugLoggingChangedId = null;

/**
 * Call once at extension enable() with the GSettings object.
 * Debug logging is gated behind the 'debug-logging' key.
 */
export function initLogger(settings) {
    shutdownLogger();

    try {
        _settings = settings;
        _enabled = settings.get_boolean('debug-logging');
        _debugLoggingChangedId = settings.connect('changed::debug-logging', () => {
            _enabled = settings.get_boolean('debug-logging');
        });
    } catch (_e) {
        _enabled = false;
        _settings = null;
        _debugLoggingChangedId = null;
    }
}

export function shutdownLogger() {
    if (_settings && _debugLoggingChangedId) {
        _settings.disconnect(_debugLoggingChangedId);
    }
    _enabled = false;
    _debugLoggingChangedId = null;
    _settings = null;
}

function _nowIso() {
    return new Date().toISOString();
}

function _safeValue(value, depth = 0) {
    if (depth > 5) return '[MaxDepth]';

    if (value === null || value === undefined)
        return value;

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        return value;

    if (typeof value === 'bigint')
        return value.toString();

    if (typeof value === 'function')
        return `[Function ${value.name || 'anonymous'}]`;

    if (Array.isArray(value))
        return value.map(v => _safeValue(v, depth + 1));

    if (typeof value.deepUnpack === 'function') {
        try {
            return _safeValue(value.deepUnpack(), depth + 1);
        } catch (e) {
            return `[Variant deepUnpack error: ${e}]`;
        }
    }

    if (typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value)) {
            try {
                out[key] = _safeValue(value[key], depth + 1);
            } catch (e) {
                out[key] = `[Serialize error: ${e}]`;
            }
        }
        return out;
    }

    try {
        return String(value);
    } catch (_) {
        return '[Unserializable]';
    }
}

function _emit(level, event, payload = {}) {
    if (!_enabled) return;

    _sequence += 1;
    const msg = {
        ts: _nowIso(),
        seq: _sequence,
        level,
        event,
        ..._safeValue(payload),
    };

    const line = `[${LOG_PREFIX}] ${JSON.stringify(msg)}`;
    if (level === 'ERROR')
        console.error(line);
    else if (level === 'WARN')
        console.warn(line);
    else
        console.log(line);
}

export function nextOpId(prefix = 'op') {
    _opCounter += 1;
    return `${prefix}-${Date.now()}-${_opCounter}`;
}

export function logDebug(event, payload = {}) {
    _emit('DEBUG', event, payload);
}

export function logInfo(event, payload = {}) {
    _emit('INFO', event, payload);
}

export function logError(event, payload = {}) {
    _emit('ERROR', event, payload);
}

export function logStep(opId, step, detail, payload = {}) {
    logDebug('step', {
        opId,
        step,
        detail,
        ...payload,
    });
}

export function snapshotLogicalMonitors(logicalMonitors = []) {
    return logicalMonitors.map(lm => ({
        x: lm[0],
        y: lm[1],
        scale: lm[2],
        transform: lm[3],
        primary: !!lm[4],
        monitors: (lm[5] || []).map(m => ({ connector: m[0], modeId: m[1] })),
        properties: _safeValue(lm[6] || {}),
    }));
}

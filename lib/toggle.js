import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import { QuickMenuToggle } from 'resource:///org/gnome/shell/ui/quickSettings.js';
import { ModalDialog } from 'resource:///org/gnome/shell/ui/modalDialog.js';

import { DisplayConfigProxy, PERSISTENT_MODE } from './dbusService.js';
import { loadMonitorConfigFromMonitorsXML } from './xmlReader.js';
import { buildMonitorMenu, updateSelectedMonitorInMenu, updatePersistenceModeSelectionInMenu } from './menu.js';
import {
    logDebug,
    logError,
    logInfo,
    logStep,
    nextOpId,
    snapshotLogicalMonitors,
} from './logger.js';


// Shift all positions so that min(x)=0, min(y)=0. Mutter rejects negative coords.
function normalizePositions(logicalMonitors) {
    if (logicalMonitors.length === 0) return logicalMonitors;
    let minX = Infinity, minY = Infinity;
    for (const lm of logicalMonitors) {
        if (lm[0] < minX) minX = lm[0];
        if (lm[1] < minY) minY = lm[1];
    }
    if (minX === 0 && minY === 0) return logicalMonitors;
    return logicalMonitors.map(lm => {
        const [x, y, scale, transform, isPrimary, monitors, properties] = lm;
        return [x - minX, y - minY, scale, transform, isPrimary, monitors, properties];
    });
}

// Fix Mutter bug: sometimes multiple monitors report primary=true.
// Keep only the first one as primary.
function fixPrimaryFlags(logicalMonitors) {
    const primaries = logicalMonitors.filter(lm => lm[4]);
    if (primaries.length <= 1) return;
    let first = true;
    for (const lm of logicalMonitors) {
        if (lm[4]) {
            if (!first) lm[4] = false;
            first = false;
        }
    }
}

export const SecondMonitorToggle = GObject.registerClass(
    class SecondMonitorToggle extends QuickMenuToggle {
        _init(indicator, settings) {
            super._init({
                title: _('Monitors'),
                subtitle: '',
                iconName: 'video-display-symbolic',
                toggleMode: true,
            });

            this._settings = settings;
            const modeSetting = this._settings.get_int('mode-setting');            
            
            this._indicator = indicator;
            this._proxy = null;
            this._monitors = [];          // Physical monitors from DBus
            this._logicalMonitors = [];   // Current logical monitors from DBus
            this._properties = {};
            this._serial = 0;
            this._layoutMode = 1;
            this._supportsChangingLayoutMode = false;
            this._monitor = null;         // Selected monitor connector
            this._persistenceMode = (modeSetting === 1 || modeSetting === 2) ? modeSetting : PERSISTENT_MODE;
            this._menuInitiallyBuilt = false;
            this._cachedMonitorsForBuild = '[]';

            // Snapshot: exact state when ALL monitors were active.
            // Key = connector, Value = { x, y, scale, transform, isPrimary, modeId }
            // On re-enable we reconstruct from this — no arrangement detection needed.
            this._snapshot = {};

            this._configRefreshTimeoutId = null;
            this._instanceId = nextOpId('toggle-instance');
            this._primaryDialogTimeoutId = null;
            this._makePrimaryDialog = null;
            this._toggling = false;
            this._monitorsChangedId = null;
            this._clickedId = null;
            this._initProxy();
            this._clickedId = this.connect('clicked', this._toggleMonitor.bind(this));

            logInfo('toggle.init.done', {
                instanceId: this._instanceId,
                persistenceMode: this._persistenceMode,
                modeSetting,
            });
        }

        _initProxy() {
            if (this._monitorsChangedId && this._proxy) {
                this._proxy.disconnectSignal(this._monitorsChangedId);
                this._monitorsChangedId = null;
            }
            logInfo('toggle.proxy.init.start', {
                instanceId: this._instanceId,
            });
            this._proxy = new DisplayConfigProxy(
                Gio.DBus.session,
                'org.gnome.Mutter.DisplayConfig',
                '/org/gnome/Mutter/DisplayConfig',
                (proxy, error) => {
                    if (this._proxy !== proxy) return;
                    if (error) {
                        logError('toggle.proxy.init.error', {
                            instanceId: this._instanceId,
                            error: `${error}`,
                        });
                        this._disableToggle('proxy-init-error');
                    } else {
                        logInfo('toggle.proxy.init.success', {
                            instanceId: this._instanceId,
                        });
                        this._monitorsChangedId = proxy.connectSignal('MonitorsChanged', () => {
                            logDebug('toggle.signal.monitors_changed', {
                                instanceId: this._instanceId,
                                hasProxy: !!this._proxy,
                                toggling: this._toggling,
                            });
                            if (this._proxy && !this._toggling) {
                                this._getMonitorConfig().catch(e => {
                                    logError('toggle.signal.monitors_changed.refresh_error', {
                                        instanceId: this._instanceId,
                                        error: `${e}`,
                                    });
                                });
                            }
                        });
                        this._getMonitorConfig().catch(e => {
                            logError('toggle.config.initial_fetch_error', {
                                instanceId: this._instanceId,
                                error: `${e}`,
                            });
                            this._disableToggle('initial-fetch-error');
                        });
                    }
                }
            );
        }

        _clearTimeout(timeoutProp) {
            if (this[timeoutProp]) {
                GLib.Source.remove(this[timeoutProp]);
                this[timeoutProp] = null;
            }
        }

        _resetTimeout(timeoutProp, delayMs, callback) {
            this._clearTimeout(timeoutProp);
            this[timeoutProp] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
                this[timeoutProp] = null;
                try {
                    return callback();
                } catch (e) {
                    logError('toggle.timeout.callback.error', {
                        timeoutProp,
                        error: `${e}`,
                    });
                    return GLib.SOURCE_REMOVE;
                }
            });
        }

        _scheduleConfigRefresh(opId, errorEvent, onSuccess = null, delayMs = 1200) {
            if (!this._proxy) return;
            this._resetTimeout('_configRefreshTimeoutId', delayMs, () => {
                if (!this._proxy) return GLib.SOURCE_REMOVE;
                this._getMonitorConfig().then(() => {
                    if (onSuccess && this._proxy) onSuccess();
                }).catch(e => {
                    logError(errorEvent, {
                        opId,
                        error: `${e}`,
                    });
                });
                return GLib.SOURCE_REMOVE;
            });
        }

        _getMonitorDisplayName(connectorName, format = 'short') {
            if (!connectorName) return _('Unknown');

            const monitorData = this._monitors.find(m => m[0][0] === connectorName);
            if (monitorData) {
                const vendor = monitorData[0][1] || '';
                const product = monitorData[0][2] || '';
                
                if (format === 'short') {
                    if (product) return product;
                } else { // format === 'long'
                    if (vendor && product) {
                        const cleanVendor = vendor.trim();
                        if (product.toUpperCase().includes(cleanVendor.toUpperCase())) {
                            return `${product} (${connectorName})`;
                        } else {
                            return `${cleanVendor} ${product} (${connectorName})`;
                        }
                    } else if (product) {
                        return `${product} (${connectorName})`;
                    }
                }
            }
            return connectorName; 
        }

        async _getMonitorConfig() {
            const proxy = this._proxy;
            if (!proxy) return;
            const opId = nextOpId('get-config');
            logStep(opId, 1, 'start GetCurrentStateAsync', {
                instanceId: this._instanceId,
            });
            try {
                const [serial, newMonitors, newLogicalMonitors, newProperties] = await proxy.GetCurrentStateAsync();
                if (this._proxy !== proxy) return;

                fixPrimaryFlags(newLogicalMonitors);

                logStep(opId, 2, 'GetCurrentStateAsync completed', {
                    serial,
                    monitorCount: newMonitors.length,
                    logicalMonitorCount: newLogicalMonitors.length,
                    logicalMonitors: snapshotLogicalMonitors(newLogicalMonitors),
                });

                const relevantMonitorDataForBuild = newMonitors.map(m => ({
                    connector: m[0][0],
                    vendor: m[0][1],
                    product: m[0][2],
                    modes: m[1].map(mode => ({ id: mode[0], w: mode[1], h: mode[2], r: mode[3] }))
                }));
                const currentMonitorsStateForBuild = JSON.stringify(relevantMonitorDataForBuild);
                const monitorsListChanged = this._cachedMonitorsForBuild !== currentMonitorsStateForBuild;

                this._serial = serial;
                this._monitors = newMonitors;
                this._logicalMonitors = newLogicalMonitors;

                // Snapshot: save exact state when ALL physical monitors are logically active.
                // This is the single source of truth for restoring layout on re-enable.
                const allActive = this._monitors.length > 0 && this._monitors.every(physMon =>
                    newLogicalMonitors.some(lm => lm[5].some(m => m[0] === physMon[0][0]))
                );
                if (allActive) {
                    this._snapshot = {};
                    for (const lm of newLogicalMonitors) {
                        for (const m of lm[5]) {
                            const conn = m[0];
                            const phys = this._monitors.find(p => p[0][0] === conn);
                            let modeId = null;
                            if (phys) {
                                const curMode = phys[1].find(mode =>
                                    typeof mode[0] === 'string' && mode[6]?.['is-current']?.deepUnpack?.()
                                );
                                if (curMode) modeId = curMode[0];
                            }
                            this._snapshot[conn] = {
                                x: lm[0], y: lm[1],
                                scale: lm[2], transform: lm[3],
                                isPrimary: lm[4], modeId,
                            };
                        }
                    }
                    logStep(opId, 3, 'snapshot saved (all monitors active)', {
                        snapshot: this._snapshot,
                    });
                }

                this._properties = newProperties;
                this._layoutMode = newProperties['layout-mode']?.deepUnpack() ?? 1;
                this._supportsChangingLayoutMode = newProperties['supports-changing-layout-mode']?.deepUnpack() ?? false;

                if (!this._monitor && this._monitors.length > 0) {

                    const savedConnector = this._settings.get_string('monitor-setting');
                    const monitorExists = this._monitors.some(m => m[0][0] === savedConnector);
    
                    if (savedConnector && monitorExists) {
                        this._monitor = savedConnector;
                    } else if (this._monitors.length === 1) {
                        this._monitor = this._monitors[0][0][0];
                    } else {
                        this._monitor = this._monitors[1][0][0]; // Default to second if multiple
                    }
                }
                
                if (!this._menuInitiallyBuilt || monitorsListChanged) {
                    buildMonitorMenu(this);
                    this._cachedMonitorsForBuild = currentMonitorsStateForBuild;
                    this._menuInitiallyBuilt = true;
                    logStep(opId, 5, 'menu rebuilt', {
                        monitorsListChanged,
                    });
                } 
                // Since buildMonitorMenu rebuilds everything, including active states, 
                // an explicit call for activeMonitorsChanged might be redundant if menu structure itself didn't change.
                // However, if only active state changed, we still need to update the menu visuals (icons etc.)
                // buildMonitorMenu will handle this due to its removeAll() and full reconstruction approach.
                // For finer-grained updates, one might separate active state updates from full rebuilds.

                updateSelectedMonitorInMenu(this);
                this._sync();

                // Re-enable toggle if it was disabled by a previous transient error
                if (!this.sensitive) this.sensitive = true;
                logInfo('toggle.config.fetch.done', {
                    opId,
                    selectedMonitor: this._monitor,
                    checked: this.checked,
                });
            } catch (e) {
                if (this._proxy !== proxy) return;
                logError('toggle.config.fetch.error', {
                    opId,
                    instanceId: this._instanceId,
                    error: `${e}`,
                });
                this.subtitle = _('Error');
                this._disableToggle('config-fetch-error');
            }
        }

        _sync() {
            if (!this._proxy) return;
            const isSelectedMonitorActive = this._logicalMonitors.some(lm =>
                lm[5].some(m => m[0] === this._monitor)
            );
            this.checked = isSelectedMonitorActive;
            this._updateIndicatorVisibility();
            logDebug('toggle.sync', {
                selectedMonitor: this._monitor,
                selectedMonitorActive: isSelectedMonitorActive,
                checked: this.checked,
            });
        }

        _updateIndicatorVisibility() {
            if (!this._proxy) return;
            if (this._indicator) {
                this._indicator.visible = this.checked;
                logDebug('toggle.indicator.visibility', {
                    visible: this._indicator.visible,
                    checked: this.checked,
                });
            }
        }

        // Resolve the best mode ID for a connector from physical monitor data.
        _resolveModeId(connector) {
            const phys = this._monitors.find(p => p[0][0] === connector);
            if (!phys) return null;
            // Prefer: saved snapshot mode → is-current → is-preferred → first available
            const snapMode = this._snapshot[connector]?.modeId;
            if (snapMode && phys[1].some(m => m[0] === snapMode)) return snapMode;
            const current = phys[1].find(m => typeof m[0] === 'string' && m[6]?.['is-current']?.deepUnpack?.());
            if (current) return current[0];
            const preferred = phys[1].find(m => typeof m[0] === 'string' && m[6]?.['is-preferred']?.deepUnpack?.());
            if (preferred) return preferred[0];
            const first = phys[1].find(m => typeof m[0] === 'string');
            return first ? first[0] : null;
        }

        async _toggleMonitor() {
            if (!this._proxy || this._toggling) return;
            this._toggling = true;
            const opId = nextOpId('toggle');
            logInfo('toggle.action.start', {
                opId,
                selectedMonitor: this._monitor,
                persistenceMode: this._persistenceMode,
            });
            try {

            await this._getMonitorConfig();
            if (!this._proxy) return;

            const isActive = this._logicalMonitors.some(lm =>
                lm[5].some(m => m[0] === this._monitor)
            );

            let finalLogicalMonitors;

            if (isActive) {
                // ── DISABLE ──
                logStep(opId, 1, 'disabling monitor', { monitor: this._monitor });

                // Remove the selected monitor; keep the rest at (0,0).
                finalLogicalMonitors = this._logicalMonitors
                    .map(lm => {
                        const filtered = lm[5].filter(m => m[0] !== this._monitor);
                        if (filtered.length === 0) return null;
                        return [lm[0], lm[1], lm[2], lm[3], lm[4], filtered, lm[6]];
                    })
                    .filter(lm => lm !== null);

                if (finalLogicalMonitors.length === 0) {
                    logError('toggle.action.abort', { opId, reason: 'no monitors left' });
                    await this._getMonitorConfig();
                    return;
                }

                // Single remaining monitor goes to origin.
                if (finalLogicalMonitors.length === 1) {
                    finalLogicalMonitors[0][0] = 0;
                    finalLogicalMonitors[0][1] = 0;
                }

                // Ensure exactly one primary.
                if (!finalLogicalMonitors.some(lm => lm[4])) {
                    finalLogicalMonitors[0][4] = true;
                }

            } else {
                // ── ENABLE ──
                logStep(opId, 1, 'enabling monitor', { monitor: this._monitor });

                const snap = this._snapshot[this._monitor];
                const hasSnapshot = snap && Object.keys(this._snapshot).length > 1;

                if (hasSnapshot) {
                    // Restore EXACT saved positions for ALL monitors from snapshot.
                    logStep(opId, 2, 'restoring from snapshot', { snapshot: this._snapshot });

                    finalLogicalMonitors = [];
                    for (const [conn, s] of Object.entries(this._snapshot)) {
                        const modeId = this._resolveModeId(conn);
                        if (!modeId) continue;
                        // Check if this connector is actually available (still plugged in)
                        if (!this._monitors.some(p => p[0][0] === conn)) continue;
                        finalLogicalMonitors.push([
                            s.x, s.y, s.scale, s.transform, s.isPrimary,
                            [[conn, modeId, {}]], {},
                        ]);
                    }
                } else {
                    // No snapshot — fall back to placing right of current monitors.
                    logStep(opId, 2, 'no snapshot, placing to right', {});

                    const physMon = this._monitors.find(p => p[0][0] === this._monitor);
                    if (!physMon) {
                        this._disableToggle('physical-monitor-not-found');
                        return;
                    }
                    let scale = 1.0, transform = 0;
                    const xmlConf = loadMonitorConfigFromMonitorsXML(this._monitor);
                    if (xmlConf) {
                        scale = xmlConf.scale;
                        transform = xmlConf.transform;
                    }

                    // Find rightmost edge of current layout
                    let maxRight = 0;
                    for (const lm of this._logicalMonitors) {
                        const conn = lm[5][0]?.[0];
                        const mode = this._resolveModeId(conn);
                        const phys = this._monitors.find(p => p[0][0] === conn);
                        if (phys && mode) {
                            const m = phys[1].find(md => md[0] === mode);
                            if (m) maxRight = Math.max(maxRight, lm[0] + Math.round(m[1] / lm[2]));
                        }
                    }

                    finalLogicalMonitors = this._logicalMonitors.map(lm => {
                        const conn = lm[5][0]?.[0];
                        const modeId = this._resolveModeId(conn);
                        if (!modeId) return null;
                        return [lm[0], lm[1], lm[2], lm[3], lm[4],
                            [[conn, modeId, {}]], {}];
                    }).filter(lm => lm !== null);

                    const modeId = this._resolveModeId(this._monitor);
                    if (!modeId) {
                        this._disableToggle('no-mode-for-monitor');
                        return;
                    }
                    finalLogicalMonitors.push([
                        maxRight, 0, scale, transform, false,
                        [[this._monitor, modeId, {}]], {},
                    ]);
                }

                // Ensure exactly one primary
                fixPrimaryFlags(finalLogicalMonitors);
                if (!finalLogicalMonitors.some(lm => lm[4]) && finalLogicalMonitors.length > 0) {
                    finalLogicalMonitors[0][4] = true;
                }
            }

            // Resolve mode IDs for all monitors (in case we carried over placeholder IDs)
            finalLogicalMonitors = finalLogicalMonitors.map(lm => {
                const conn = lm[5][0]?.[0];
                const modeId = this._resolveModeId(conn);
                if (!modeId) return null;
                return [lm[0], lm[1], lm[2], lm[3], lm[4],
                    [[conn, modeId, {}]], {}];
            }).filter(lm => lm !== null);

            if (finalLogicalMonitors.length === 0) {
                logError('toggle.action.abort', { opId, reason: 'no valid monitors after resolve' });
                await this._getMonitorConfig();
                return;
            }

            // Normalize positions to satisfy Mutter's min(x)=0, min(y)=0 constraint.
            finalLogicalMonitors = normalizePositions(finalLogicalMonitors);

            logStep(opId, 3, 'final layout to apply', {
                finalLogicalMonitors: snapshotLogicalMonitors(finalLogicalMonitors),
            });

            const propertiesToApply = {};
            if (this._supportsChangingLayoutMode) {
                propertiesToApply['layout-mode'] = new GLib.Variant('u', this._layoutMode);
            }

            const proxy = this._proxy;
            if (!proxy) return;
            try {
                await proxy.ApplyMonitorsConfigAsync(
                    this._serial, this._persistenceMode,
                    finalLogicalMonitors, propertiesToApply
                );
                if (this._proxy !== proxy) return;
                logInfo('toggle.action.apply.success', { opId });
            } catch (e) {
                if (this._proxy !== proxy) return;
                logError('toggle.action.apply.error', {
                    opId, error: `${e}`,
                    finalLogicalMonitors: snapshotLogicalMonitors(finalLogicalMonitors),
                });
                this._disableToggle('apply-config-error');
                this._scheduleConfigRefresh(opId, 'toggle.action.recovery.error', () => {
                    this.sensitive = true;
                });
                return;
            }

            this.checked = !isActive;
            this._updateIndicatorVisibility();
            this._scheduleConfigRefresh(opId, 'toggle.action.refresh.error');

            // After re-enabling, ask if user wants to make it primary
            if (!isActive) {
                this._resetTimeout('_primaryDialogTimeoutId', 1500, () => {
                    if (!this._proxy) return GLib.SOURCE_REMOVE;
                    this._showMakePrimaryDialog(this._monitor);
                    return GLib.SOURCE_REMOVE;
                });
            }

            } finally {
                this._toggling = false;
                logInfo('toggle.action.end', { opId, checked: this.checked });
            }
        }

        _showMakePrimaryDialog(connector) {
            if (!this._proxy) return;
            if (this._makePrimaryDialog) {
                this._makePrimaryDialog.close();
                this._makePrimaryDialog = null;
            }
            const displayName = this._getMonitorDisplayName(connector, 'short');
            logInfo('toggle.dialog.make_primary.show', {
                connector,
                displayName,
            });

            const dialog = new ModalDialog({
                styleClass: 'modal-dialog',
                destroyOnClose: true,
            });
            this._makePrimaryDialog = dialog;
            dialog.connect('destroy', () => {
                if (this._makePrimaryDialog === dialog)
                    this._makePrimaryDialog = null;
            });

            const label = new St.Label({
                text: `Make "${displayName}" the primary monitor?`,
                style_class: 'message-dialog-title',
            });
            dialog.contentLayout.add_child(label);

            dialog.addButton({
                label: _('No'),
                action: () => {
                    logInfo('toggle.dialog.make_primary.decision', {
                        connector,
                        decision: 'no',
                    });
                    dialog.close();
                },
                key: Clutter.KEY_Escape,
            });

            dialog.addButton({
                label: _('Yes'),
                action: () => {
                    logInfo('toggle.dialog.make_primary.decision', {
                        connector,
                        decision: 'yes',
                    });
                    dialog.close();
                    this._makePrimary(connector).catch(e =>
                        logError('toggle.make_primary.unhandled_error', {
                            connector,
                            error: `${e}`,
                        })
                    );
                },
                default: true,
            });

            dialog.open();
        }

        async _makePrimary(connector) {
            if (!this._proxy) return;
            const opId = nextOpId('make-primary');
            logInfo('toggle.make_primary.start', { opId, connector });

            await this._getMonitorConfig();
            if (!this._proxy) return;

            // Build layout from current state, just swap the primary flag.
            const finalLms = this._logicalMonitors.map(lm => {
                const conn = lm[5][0]?.[0];
                const modeId = this._resolveModeId(conn);
                if (!modeId) return null;
                const isTarget = lm[5].some(m => m[0] === connector);
                return [lm[0], lm[1], lm[2], lm[3], isTarget,
                    [[conn, modeId, {}]], {}];
            }).filter(lm => lm !== null);

            if (finalLms.length === 0) return;

            const positioned = normalizePositions(finalLms);
            logStep(opId, 1, 'layout for primary swap', {
                positioned: snapshotLogicalMonitors(positioned),
            });

            const propertiesToApply = {};
            if (this._supportsChangingLayoutMode) {
                propertiesToApply['layout-mode'] = new GLib.Variant('u', this._layoutMode);
            }

            const proxy = this._proxy;
            if (!proxy) return;
            try {
                await proxy.ApplyMonitorsConfigAsync(
                    this._serial, this._persistenceMode,
                    positioned, propertiesToApply
                );
                if (this._proxy !== proxy) return;
                logInfo('toggle.make_primary.apply.success', { opId });
                this._scheduleConfigRefresh(opId, 'toggle.make_primary.refresh.error');
            } catch (e) {
                if (this._proxy !== proxy) return;
                logError('toggle.make_primary.apply.error', {
                    opId, connector, error: `${e}`,
                    positioned: snapshotLogicalMonitors(positioned),
                });
            }
        }

        _disableToggle(reason = 'unknown') {
            if (!this._proxy) return;
            this.checked = false;
            this.sensitive = false;
            logError('toggle.disabled', {
                instanceId: this._instanceId,
                reason,
            });
        }

        destroy() {
            logInfo('toggle.destroy.start', {
                instanceId: this._instanceId,
                hasConfigRefreshTimeout: !!this._configRefreshTimeoutId,
                hasPrimaryDialogTimeout: !!this._primaryDialogTimeoutId,
                hasPrimaryDialogOpen: !!this._makePrimaryDialog,
                hasMonitorSignal: !!this._monitorsChangedId,
                hasClickedSignal: !!this._clickedId,
            });
            const proxy = this._proxy;
            this._proxy = null;
            if (this._clickedId) {
                this.disconnect(this._clickedId);
                this._clickedId = null;
            }
            this._clearTimeout('_configRefreshTimeoutId');
            this._clearTimeout('_primaryDialogTimeoutId');
            if (this._makePrimaryDialog) {
                this._makePrimaryDialog.close();
                this._makePrimaryDialog = null;
            }
            if (this._monitorsChangedId && proxy) {
                proxy.disconnectSignal(this._monitorsChangedId);
                this._monitorsChangedId = null;
            }
            this._indicator = null;
            this._settings = null;
            this._monitor = null;
            this._monitors = [];
            this._logicalMonitors = [];
            this._properties = {};
            this._snapshot = {};
            super.destroy();
            logInfo('toggle.destroy.done', {
                instanceId: this._instanceId,
            });
        }
    }
); 

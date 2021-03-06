/*
Copyright 2017 OpenFin Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
/*
    src/browser/bounds_changed_state_tracker.js
 */

let windowTransaction = require('electron').windowTransaction;

let _ = require('underscore');
let animations = require('./animations.js');
let coreState = require('./core_state.js');
import * as Deferred from './deferred';
let WindowGroups = require('./window_groups.js');
import WindowGroupTransactionTracker from './window_group_transaction_tracker';

const isWin32 = process.platform === 'win32';

function BoundsChangedStateTracker(uuid, name, browserWindow) {
    var me = this;

    // a flag that represents if any change in the size has happened
    // without relying on the checking of the previous bounds which
    // may or may not be reliable depending on the previous event (
    // specifically bounds-changing)
    var sizeChanged = false;
    var positionChanged = false;

    var _cachedBounds = {},
        _userBoundsChangeActive = false;

    let _deferred = false;
    let _deferredEvents = [];

    var setUserBoundsChangeActive = (enabled) => {
        _userBoundsChangeActive = enabled;
    };

    var isUserBoundsChangeActive = () => {
        return _userBoundsChangeActive;
    };

    var updateCachedBounds = (bounds) => {
        _cachedBounds = bounds;
    };

    var getCachedBounds = () => {
        return _cachedBounds;
    };

    var getCurrentBounds = () => {
        let bounds = browserWindow.getBounds();

        let windowState = 'normal';
        if (browserWindow.isMaximized()) {
            windowState = 'maximized';
        }
        if (browserWindow.isMinimized()) {
            windowState = 'minimized';
        }
        bounds.windowState = windowState;

        return bounds;
    };

    var compareBoundsResult = (boundsOne, boundsTwo) => {
        var xDiff = boundsOne.x !== boundsTwo.x;
        var yDiff = boundsOne.y !== boundsTwo.y;
        var widthDiff = boundsOne.width !== boundsTwo.width;
        var heightDiff = boundsOne.height !== boundsTwo.height;
        var stateDiff = boundsOne.windowState !== boundsTwo.windowState;
        var changed = xDiff || yDiff || widthDiff || heightDiff /* || stateDiff*/ ;

        // set the changed flag only if it has not been set
        sizeChanged = sizeChanged || (widthDiff || heightDiff);
        positionChanged = positionChanged || (xDiff || yDiff);

        return {
            x: xDiff,
            y: yDiff,
            width: widthDiff,
            height: heightDiff,
            state: stateDiff,
            changed
        };
    };

    var getBoundsDelta = (current, cached) => {
        return {
            x: current.x - cached.x,
            y: current.y - cached.y
        };
    };

    var boundsChangeReason = (name, groupUuid) => {
        if (groupUuid) {
            var groupLeader = WindowGroupTransactionTracker.getGroupLeader(groupUuid) || {};

            if (groupLeader.uuid && groupLeader.name) {
                var ofWindow = coreState.getWindowByUuidName(groupLeader.uuid, groupLeader.name);

                if (animations.getAnimationHandler().hasWindow(ofWindow.browserWindow.id)) {
                    return groupLeader.name === name ? 'animation' : 'group-animation';
                } else {
                    return groupLeader.name === name ? 'self' : 'group';
                }
            }
        }

        return animations.getAnimationHandler().hasWindow(browserWindow.id) ? 'animation' : 'self';
    };

    var handleBoundsChange = (isAdditionalChangeExpected, force) => {

        var dispatchedChange = false;

        var currentBounds = getCurrentBounds();
        var cachedBounds = getCachedBounds();
        var boundsCompare = compareBoundsResult(currentBounds, cachedBounds);
        var stateMinMax = boundsCompare.state && currentBounds.state !== 'normal'; // maximized or minimized

        var eventType = isAdditionalChangeExpected ? 'bounds-changing' :
            'bounds-changed';

        var sizeChangedCriteria = [
            boundsCompare.width,
            boundsCompare.height
        ];

        var positionChangedCriteria = [
            boundsCompare.x,
            boundsCompare.y
        ];

        var isBoundsChanged = eventType === 'bounds-changed';

        // if this is to be the "last" event in a transaction, be sure to
        // any diff in the size or position towards the change type
        if (isBoundsChanged) {
            sizeChangedCriteria.push(sizeChanged);
            positionChangedCriteria.push(positionChanged);
        }

        if (boundsCompare.changed && !stateMinMax || force) {

            // returns true if any of the criteria are true
            var sizeChange = _.some(sizeChangedCriteria, (criteria) => {
                return criteria;
            });

            var posChange = _.some(positionChangedCriteria, (criteria) => {
                return criteria;
            });

            //var posChange = boundsCompare.x || boundsCompare.y;

            //0 means a change in position.
            //1 means a change in size.
            //2 means a change in position and size.
            // Default to change in position when there is no change
            var changeType = (sizeChange ? (posChange ? 2 : 1) : 0);

            var ofWindow = coreState.getWindowByUuidName(uuid, name) || {};
            var groupUuid = ofWindow.groupUuid;

            // determine what caused the bounds change
            var reason = boundsChangeReason(name, groupUuid);

            // handle window group movements
            if (groupUuid) {
                var groupLeader = WindowGroupTransactionTracker.getGroupLeader(groupUuid) || {};

                if (force) {
                    if (groupLeader.name === name) {
                        // no need to notify group members for api moves since every window
                        // will already receive an end notification
                        if (groupLeader.type !== 'api') {
                            WindowGroupTransactionTracker.notifyEndTransaction(groupUuid);
                        }
                        WindowGroupTransactionTracker.clearGroup(groupUuid);
                    }
                } else {
                    if (!groupLeader.name) {
                        var type = isUserBoundsChangeActive() ? 'user' : animations.getAnimationHandler().hasWindow(browserWindow.id) ? 'animation' : 'api';
                        WindowGroupTransactionTracker.setGroupLeader(groupUuid, name, uuid, type);
                    }
                }

                groupLeader = WindowGroupTransactionTracker.getGroupLeader(groupUuid) || {};
                if (groupLeader.name === name) {
                    var delta = getBoundsDelta(currentBounds, cachedBounds);
                    var wt; // window-transaction
                    let hwndToId = {};

                    WindowGroups.getGroup(groupUuid).filter((win) => {
                        win.browserWindow.bringToFront();
                        return win.name !== name;
                    }).forEach((win) => {
                        let winBounds = win.browserWindow.getBounds();

                        if (isWin32) {
                            let hwnd = parseInt(win.browserWindow.nativeId, 16);

                            if (!wt) {
                                wt = new windowTransaction.Transaction(0);

                                wt.on('deferred-set-window-pos', (event, payload) => {
                                    payload.forEach((winPos) => {
                                        let bwId = hwndToId[parseInt(winPos.hwnd)];
                                        Deferred.handleMove(bwId, winPos);
                                    });
                                });
                            }
                            hwndToId[hwnd] = win.browserWindow.id;
                            wt.setWindowPos(hwnd, {
                                x: winBounds.x + delta.x,
                                y: winBounds.y + delta.y,
                                flags: windowTransaction.flag.noZorder + windowTransaction.flag.noSize + windowTransaction.flag.noActivate
                            });
                        } else {
                            win.browserWindow.setBounds({
                                x: winBounds.x + delta.x,
                                y: winBounds.y + delta.y,
                                width: winBounds.width,
                                height: winBounds.height
                            });
                        }
                    });

                    if (wt) {
                        wt.commit();
                    }
                }
            }

            var payload = {
                changeType,
                reason,
                name,
                uuid,
                type: eventType,
                deferred: _deferred,
                top: currentBounds.y,
                left: currentBounds.x,
                height: currentBounds.height,
                width: currentBounds.width
            };

            if (_deferred) {
                _deferredEvents.push(payload);
            } else {
                browserWindow.emit('synth-bounds-change', payload);
            }

            dispatchedChange = true;
        }

        updateCachedBounds(currentBounds);

        // this represents the changed event, reset the overall changed flag
        if (!isAdditionalChangeExpected) {
            sizeChanged = false;
            positionChanged = false;
        }

        return dispatchedChange;
    };

    let collapseEventReasonTypes = (eventsList) => {
        let eventGroups = [];

        eventsList.forEach((event, index) => {
            if (index === 0 || event.reason !== eventsList[index - 1].reason) {
                let list = [];
                list.push(event);
                eventGroups.push(list);
            } else {
                _.last(eventGroups).push(event);
            }
        });

        return eventGroups.map((group) => {
            let sizeChange = false;
            let posChange = false;

            group.forEach((event) => {
                if (event.changeType === 0) {
                    posChange = true;
                } else if (event.changeType === 1) {
                    sizeChange = true;
                } else {
                    sizeChange = true;
                    posChange = true;
                }
            });

            let lastEvent = _.last(group);
            lastEvent.changeType = (sizeChange ? (posChange ? 2 : 1) : 0);

            return lastEvent;
        });
    };

    let dispatchDeferredEvents = () => {
        let boundsChangedEvents = _deferredEvents.filter((event) => {
            return event.type === 'bounds-changed';
        });

        let reasonGroupedEvents = collapseEventReasonTypes(boundsChangedEvents);

        reasonGroupedEvents.forEach((event) => {
            event.type = 'bounds-changing';
            browserWindow.emit('synth-bounds-change', event);
            event.type = 'bounds-changed';
            browserWindow.emit('synth-bounds-change', event);
        });

        _deferredEvents.length = 0;
    };

    var _listeners = {
        'begin-user-bounds-change': () => {
            setUserBoundsChangeActive(true);
        },
        'end-user-bounds-change': () => {
            setUserBoundsChangeActive(false);
            handleBoundsChange(false, true);
        },
        'bounds-changed': () => {
            var ofWindow = coreState.getWindowByUuidName(uuid, name) || {};
            var groupUuid = ofWindow.groupUuid;

            var dispatchedChange = handleBoundsChange(true);

            if (dispatchedChange) {
                if (groupUuid) {
                    var groupLeader = WindowGroupTransactionTracker.getGroupLeader(groupUuid) || {};

                    if (groupLeader.type === 'api') {
                        handleBoundsChange(false, true);
                    }
                } else {
                    if (!animations.getAnimationHandler().hasWindow(browserWindow.id) && !isUserBoundsChangeActive()) {
                        handleBoundsChange(false, true);
                    }
                }
            }
        },
        'synth-animate-end': (meta) => {
            if (meta.bounds) {
                // COMMENT THIS OUT FOR TESTING FLICKERING
                handleBoundsChange(false, true);
            }
        },
        'visibility-changed': (event, isVisible) => {
            if (!isVisible || browserWindow.isMinimized() || browserWindow.isMaximized()) {
                _deferred = true;
            } else {
                _deferred = false;
                dispatchDeferredEvents();
            }
        },
        'minimize': () => {
            _deferred = true;
            updateCachedBounds(getCurrentBounds());
        },
        'maximize': () => {
            _deferred = true;
            updateCachedBounds(getCurrentBounds());
        },
        'restore': () => {
            _deferred = false;
            updateCachedBounds(getCurrentBounds());
            dispatchDeferredEvents();
        },
        'unmaximize': () => {
            _deferred = false;
            updateCachedBounds(getCurrentBounds());
            dispatchDeferredEvents();
        },
        'deferred-set-bounds': (event, payload) => {
            Deferred.handleMove(browserWindow.id, payload);
        }
    };

    var endWindowGroupTransactionListener = (groupUuid) => {
        var ofWindow = coreState.getWindowByUuidName(uuid, name) || {};
        var _groupUuid = ofWindow.groupUuid;

        if (_groupUuid === groupUuid) {
            var groupLeader = WindowGroupTransactionTracker.getGroupLeader(groupUuid) || {};

            if (groupLeader.name !== name) {
                handleBoundsChange(false, true);
            }
        }
    };

    var updateEvents = (register) => {
        var listenerFn = register ? 'on' : 'removeListener';

        Object.keys(_listeners).forEach((key) => {
            browserWindow[listenerFn](key, _listeners[key]);
        });

        WindowGroupTransactionTracker[listenerFn]('end-window-group-transaction', endWindowGroupTransactionListener);
    };

    var hookListeners = () => {
        updateEvents(true);
    };

    var unHookListeners = () => {
        updateEvents(false);
    };

    // Remove all event listeners this instance subscribed on
    me.teardown = () => {
        unHookListeners();
    };

    // Cache the current bounds on construction
    updateCachedBounds(getCurrentBounds());

    // listen to relevant browser-window events
    hookListeners();

    //exposing the getCachedBounds
    me.getCachedBounds = getCachedBounds;
    return me;
}



module.exports = BoundsChangedStateTracker;

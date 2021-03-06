/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/

var BASE = 'extensions.reload-on-idle@clear-code.com.';
var prefs = require('lib/prefs').prefs;
var WM = require('lib/WindowManager').WindowManager;

var MINUTE_IN_SECONDS = 60;
var HOUR_IN_MINUTES = 60;
var DAY_IN_HOURS = 24;
var DAY_IN_SECONDS = DAY_IN_HOURS * HOUR_IN_MINUTES * MINUTE_IN_SECONDS;
{
  if (prefs.getDefaultPref(BASE + 'debug') === null)
    prefs.setDefaultPref(BASE + 'debug', false);
  if (prefs.getDefaultPref(BASE + 'filter') === null)
    prefs.setDefaultPref(BASE + 'filter', '.');
  if (prefs.getDefaultPref(BASE + 'idleSeconds') === null)
    prefs.setDefaultPref(BASE + 'idleSeconds', 10 * MINUTE_IN_SECONDS);
  if (prefs.getDefaultPref(BASE + 'reloadBusyTabs') === null)
    prefs.setDefaultPref(BASE + 'reloadBusyTabs', true);
  if (prefs.getDefaultPref(BASE + 'ignoreConfirmation') === null)
    prefs.setDefaultPref(BASE + 'ignoreConfirmation', true);
}

var timer = Cu.import('resource://gre/modules/Timer.jsm', {});
var { Promise } = Cu.import('resource://gre/modules/Promise.jsm', {});

var reloader = {
  MESSAGE_TYPE: 'reload-on-idle@clear-code.com',
  SCRIPT_URL: 'chrome://reload-on-idle/content/content-utils.js',
  lastTimeout: null,
  delayedLeaveTasks: [],

  onTimeout: function() {
    this.reloadTabs()
      .catch(function(error) {
        Cu.reportError(error);
      })
      .then((function() {
        var interval = Math.max(1, prefs.getPref(BASE + 'idleSeconds'));
        this.lastTimeout = timer.setTimeout(this.onTimeout.bind(this), interval * 1000);
      }).bind(this));
  },

  forEachBrowserWindow: function(aCallback) {
    var browsers = WM.getWindows('navigator:browser');
    browsers.forEach(aCallback, this);
  },

  forEachTab: function(aWindow, aCallback) {
    Array.forEach(aWindow.gBrowser.tabContainer.childNodes, aCallback, this);
  },

  get leaveButtonLabel() {
    delete this.leaveButtonLabel;
    try {
      var label = Cc['@mozilla.org/intl/stringbundle;1']
                    .getService(Ci.nsIStringBundleService)
                    .createBundle('chrome://global/locale/dom/dom.properties')
                    .GetStringFromName('OnBeforeUnloadLeaveButton');
      return this.leaveButtonLabel = label;
    }
    catch(e) {
      return null;
    }
  },

  pushLeaveButton: function(aWindow, aTab) {
    var buttons = this.getLeaveButtons(aWindow, aTab);
    buttons.forEach(function(aButton) {
      aButton.click();
    }, this);
  },

  getLeaveButtons: function(aWindow, aTab) {
    var promptBox = aWindow.gBrowser.getTabModalPromptBox(aTab.linkedBrowser);
    var prompts = promptBox.listPrompts();
    var buttons = prompts.map(function(aPrompt) {
      if (aPrompt.args.promptType != 'confirmEx')
        return null;
      if (aPrompt.args.button0Label == this.leaveButtonLabel)
        return aPrompt.ui.button0;
      else if (aPrompt.args.button1Label == this.leaveButtonLabel)
        return aPrompt.ui.button1;
    }, this);
    return buttons.filter(function(aButton) {
      return aButton;
    });
  },

  reloadTabs: function() {
    if (prefs.getPref(BASE + 'debug'))
      console.log('Try reloading');
    return new Promise((function(resolve, reject) {
      try {
        var filter = new RegExp(prefs.getPref(BASE + 'filter'), 'i');
        this.forEachBrowserWindow(function(aWindow) {
          this.forEachTab(aWindow, function(aTab) {
            var uri = aTab.linkedBrowser.currentURI.spec;
            if (!filter.test(uri) ||
                aTab.getAttribute('pending') == 'true')
              return;

            if (this.getLeaveButtons(aWindow, aTab).length > 0) {
              if (prefs.getPref(BASE + 'debug'))
                console.log(aTab._tPos + ': ' + uri + ' / skipped by confirmation dialog');
              return;
            }

            if (aTab.getAttribute('busy') == 'true') {
              if (!prefs.getPref(BASE + 'reloadBusyTabs')) {
                if (prefs.getPref(BASE + 'debug'))
                  console.log(aTab._tPos + ': ' + uri + ' / skipped for busy');
                return;
              }
              aTab.linkedBrowser.messageManager.sendAsyncMessage(this.MESSAGE_TYPE, {
                command : 'stop'
              });
            }

            aTab.linkedBrowser.messageManager.sendAsyncMessage(this.MESSAGE_TYPE, {
              command : 'reload',
              ignoreConfirmation: prefs.getPref(BASE + 'ignoreConfirmation')
            });
            if (prefs.getPref(BASE + 'ignoreConfirmation')) {
              var id = timer.setTimeout((function() {
                this.pushLeaveButton(aWindow, aTab);
                var index = this.delayedLeaveTasks.indexOf(id);
                this.delayedLeaveTasks.splice(index, 1);
              }).bind(this), 0);
              this.delayedLeaveTasks.push(id);
            }
            else {
              if (prefs.getPref(BASE + 'debug'))
                console.log(aTab._tPos + ': ' + uri + ' / can be blocked by confirmation');
            }
          });
        });
        resolve();
      }
      catch(error) {
        reject(error);
      }
    }).bind(this));
  },

  start: function() {
    this.stop();
    this.onTimeout();
  },

  stop: function() {
    if (this.lastTimeout)
      timer.clearTimeout(this.lastTimeout);
    this.lastTimeout = null;

    this.delayedLeaveTasks.forEach(function(aId) {
      timer.clearTimeout(aId);
    });
    this.delayedLeaveTasks = [];
  },

  startup: function() {
    this.forEachBrowserWindow(function(aWindow) {
      this.initBrowserWindow(aWindow);
    });
    this.initBrowserWindow = this.initBrowserWindow.bind(this);
    WM.addHandler(this.initBrowserWindow);
    this.registerIdleObserver();
    prefs.addPrefListener(this);
  },

  shutdown: function() {
    prefs.removePrefListener(this);
    this.unregisterIdleObserver();
    this.stop();
    WM.removeHandler(this.initBrowserWindow);
    this.forEachBrowserWindow(function(aWindow) {
      aWindow.messageManager.broadcastAsyncMessage(this.MESSAGE_TYPE, {
        command : 'shutdown'
      });
      aWindow.messageManager.removeDelayedFrameScript(this.SCRIPT_URL);
    });
  },

  registerIdleObserver: function() {
    var idleSeconds = Math.max(10, prefs.getPref(BASE + 'idleSeconds'));
    idleService.addIdleObserver(this, idleSeconds);
    this.lastIdleSeconds = idleSeconds;
  },

  unregisterIdleObserver: function() {
    idleService.removeIdleObserver(this, this.lastIdleSeconds);
  },

  initBrowserWindow: function(aWindow) {
    if (aWindow.document.documentElement.getAttribute('windowtype') == 'navigator:browser')
      aWindow.messageManager.loadFrameScript(this.SCRIPT_URL, true);
  },

  domain: BASE,

  observe: function(aSubject, aTopic, aData) {
    // console.log([aSubject, aTopic, aData]);
    switch (aTopic) {
      case 'idle':
        if (prefs.getPref(BASE + 'debug'))
          console.log('idle: start to reload');
        this.start();
        break;

      case 'active':
        if (prefs.getPref(BASE + 'debug'))
          console.log('active: stop to reload');
        this.stop();
        break;

      case 'nsPref:changed':
        {
          switch (aData.replace(BASE, '')) {
            case 'idleSeconds':
              this.unregisterIdleObserver();
              this.registerIdleObserver();
              break;
          }
        }
        break;
    }
  }
};

var idleService = Cc['@mozilla.org/widget/idleservice;1']
                    .getService(Ci.nsIIdleService);

reloader.startup();

function shutdown() {
  reloader.shutdown();

  timer = Promise = prefs = WM =
    idleService = reloader =
      undefined;
}

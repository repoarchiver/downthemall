/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is DownThemAll!
 *
 * The Initial Developers of the Original Code are Stefano Verna and Federico Parodi
 * Portions created by the Initial Developers are Copyright (C) 2004-2007
 * the Initial Developers. All Rights Reserved.
 *
 * Contributor(s):
 *    Stefano Verna <stefano.verna@gmail.com>
 *    Federico Parodi <jimmy2k@gmail.com>
 *    Nils Maier <MaierMan@web.de>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */
 
const NS_DTA = 'http://www.downthemall.net/properties#';
const NS_METALINKER = 'http://www.metalinker.org/';
const NS_HTML = 'http://www.w3.org/1999/xhtml';
 
 
const NS_ERROR_MODULE_NETWORK = 0x804B0000;
const NS_ERROR_BINDING_ABORTED = NS_ERROR_MODULE_NETWORK + 2;
const NS_ERROR_UNKNOWN_HOST = NS_ERROR_MODULE_NETWORK + 30;
const NS_ERROR_CONNECTION_REFUSED = NS_ERROR_MODULE_NETWORK + 13;
const NS_ERROR_NET_TIMEOUT = NS_ERROR_MODULE_NETWORK + 14;
const NS_ERROR_NET_RESET = NS_ERROR_MODULE_NETWORK + 20;
const NS_ERROR_FTP_CWD = NS_ERROR_MODULE_NETWORK + 22;

const Construct = Components.Constructor;
function Serv(c, i) {
	return Cc[c].getService(i ? Ci[i] : null);
}

const BufferedOutputStream = Construct('@mozilla.org/network/buffered-output-stream;1', 'nsIBufferedOutputStream', 'init');
const FileInputStream = Construct('@mozilla.org/network/file-input-stream;1', 'nsIFileInputStream', 'init');
const FileOutputStream = Construct('@mozilla.org/network/file-output-stream;1', 'nsIFileOutputStream', 'init');
const StringInputStream = Construct('@mozilla.org/io/string-input-stream;1', 'nsIStringInputStream', 'setData');

ServiceGetter(this, "ContentHandling", "@downthemall.net/contenthandling;2", "dtaIContentHandling");
ServiceGetter(this, "MimeService", "@mozilla.org/uriloader/external-helper-app-service;1", "nsIMIMEService");
ServiceGetter(this, "ObserverService", "@mozilla.org/observer-service;1", "nsIObserverService");
ServiceGetter(this, "WindowWatcherService", "@mozilla.org/embedcomp/window-watcher;1", "nsIWindowWatcher");

const MIN_CHUNK_SIZE = 512 * 1024;

// amount to buffer in BufferedOutputStream
// furthermore up to this ammount will automagically discared after crashes
const CHUNK_BUFFER_SIZE = 96 * 1024;

const REFRESH_FREQ = 1000;
const STREAMS_FREQ = 250;

let Prompts = {}, Preallocator = {}, Limits = {}, JSONCompat = {}, PrivateBrowsing = {}, AlertService = {};
module('resource://dta/prompts.jsm', Prompts);
module('resource://dta/speedstats.jsm');
module('resource://dta/preallocator.jsm', Preallocator);
module('resource://dta/cothread.jsm');
module('resource://dta/queuestore.jsm');
module('resource://dta/timers.jsm');
module('resource://dta/loggedprompter.jsm');
module('resource://dta/serverlimits.jsm', Limits);
module('resource://dta/json.jsm', JSONCompat);
module('resource://dta/urlmanager.jsm');
module('resource://dta/visitormanager.jsm');
module('resource://dta/decompressor.jsm');
module('resource://dta/verificator.jsm');
module('resource://dta/bytebucket.jsm');
module('resource://dta/pbm.jsm', PrivateBrowsing);
module('resource://dta/alertservice.jsm', AlertService);

const AuthPrompts = new LoggedPrompter(window);

var TEXT_PAUSED;
var TEXT_QUEUED;
var TEXT_COMPLETE;
var TEXT_CANCELED;


var GlobalBucket = null;
var Timers = new TimerManager();

const Dialog = {
	_observes: [
		'quit-application-requested',
		'quit-application-granted',
		'network:offline-status-changed',
		'DTA:filterschanged'
	],
	_initialized: false,
	_autoRetrying: [],
	_offline: false,
	_maxObservedSpeed: 0,
	_infoWindows: [],
	get offline() {
		return this._offline || this._offlineForced;
	},
	set offline(nv) {
		this._offline = !!nv;
		$('cmdToggleOffline').setAttribute('disabled', this._offline);
		this._processOfflineChange();
		return this._offline;
	},
	get offlineForced() {
		return this._offlineForced;
	},
	set offlineForced(nv) {
		this._offlineForced = !!nv;
		let netstatus = $('netstatus');
		if (this._offlineForced) {
			netstatus.setAttribute('offline', true);
		}
		else if (netstatus.hasAttribute('offline')) {
			netstatus.removeAttribute('offline');
		}		
		this._processOfflineChange();
		return this._offlineForced;
	},
	
	_wasRunning: false,
	_sum: 0,
	_speeds: new SpeedStats(10),
	_running: [],
	_autoClears: [],
	completed: 0,
	totalbytes: 0,
	init: function D_init() {
		removeEventListener('load', arguments.callee, false);
		
		TEXT_PAUSED = _('paused');
		TEXT_QUEUED = _('queued');
		TEXT_COMPLETE = _('complete');
		TEXT_CANCELED = _('canceled');

		(function initListeners() {
			addEventListener('unload', function() Dialog.unload(), false);
			addEventListener('close', function(evt) {
				let rv = Dialog.close();
				if (!rv) {
					evt.preventDefault();
				}
				return rv;
			}, true);
			addEventListener('dragover', function(event) nsDragAndDrop.dragOver(event, DTA_DropDTA), true);
			addEventListener('drop', function(event) nsDragAndDrop.drop(event, DTA_DropDTA), true);
			
			$('tooldonate').addEventListener('click', function() Dialog.openDonate(), false);
		})();		
		
		Tree.init($("downloads"));
		try {
			Timers.createOneshot(100, this._loadDownloads, this);
		}
		catch (ex) {
			Debug.log("Failed to load any downloads from queuefile", ex);
		}

		try {
			this.offline = IOService.offline;
		}
		catch (ex) {
			Debug.log("Cannot get offline status", ex);
		}
		
		Preferences.makeObserver(this);
		this._observes.forEach(
			function(topic) {
				ObserverService.addObserver(this, topic, true);
			},
			this
		);
			
		(function autofit() {
			let de = document.documentElement;
			let version = {};
			Components.utils.import('resource://dta/version.jsm', version);
			let cv = version.VERSION + ".toolitems" + $('tools').childNodes.length;
			let shouldAutofit = !de.hasAttribute('dtaAutofitted');
			if (!shouldAutofit) {
				try {
					let lv = de.getAttribute('dtaAutofitted');
					shouldAutofit = !!version.compareVersion(cv, lv);
				}
				catch (ex) {
					shouldAutofit = true;
				}
			}
			if (shouldAutofit) {
				document.documentElement.setAttribute('dtaAutofitted', cv);
				setTimeout(
					function() {
						let tdb = $('tooldonate').boxObject;
						let db = de.boxObject
						let cw = tdb.width + tdb.x;
						if (db.width < cw) {
							window.resizeTo(cw, window.outerHeight);
							Debug.logString("manager was autofit");
						}
					},
					10
				);
			}
		})();
		(function() {
			for each (let e in Array.map(document.getElementsByTagName('toolbarbutton'), function(e) e)) {
				if (!e.hasAttribute('tooltiptext')) {
					e.setAttribute('tooltiptext', e.getAttribute('label'));
				}
			}
			
			$('tbp_' + $('tools').getAttribute('mode')).setAttribute('checked', "true");
		})();
		GlobalBucket = new ByteBucket(Prefs.speedLimit, 1.3);
		$('listSpeeds').limit = Prefs.speedLimit;
		
		(function nagging() {
			if (Preferences.getExt('nagnever', false)) {
				return;
			}
			let nb = $('notifications');
			try {
				let seq = QueueStore.getQueueSeq();
				let nagnext = Preferences.getExt('nagnext', 100);
				Debug.logString("nag: " + seq + "/" + nagnext + "/" + (seq - nagnext));
				if (seq < nagnext) {
					return;
				}
				for (nagnext = isFinite(nagnext) && nagnext > 0 ? nagnext : 100; seq >= nagnext; nagnext *= 2);
				
				seq = Math.floor(seq / 100) * 100;

				setTimeout(function() {
					let ndonation = nb.appendNotification(
							_('nagtext', [seq]),
							"donation",
							null,
							nb.PRIORITY_INFO_HIGH,
							[
								{
									accessKey: '',
									label: _('nagdonate'),
									callback: function() {
										nb.removeNotification(ndonation);
										Preferences.setExt('nagnext', nagnext);
										Dialog.openDonate();
									}
								},
								{
									accessKey: '',
									label: _('naghide'),
									callback: function() {
										Preferences.setExt('nagnext', nagnext);
										nb.removeNotification(ndonation);
									}
								},
								{
									accessKey: '',
									label: _('nagneveragain'),
									callback: function() {
										nb.removeNotification(ndonation);
										Preferences.setExt('nagnever', true);
									}
								}

							]
					)
				}, 1000);
			}
			catch (ex) {
				Debug.log('nagger', ex);
			}
		})();		
	},
	
	customizeToolbar: function(evt) {
		$('tools').setAttribute('mode', evt.target.getAttribute('mode'));
	},
	
	changeSpeedLimit: function() {
		let list = $('listSpeeds');
		let val = list.limit;
		Preferences.setExt('speedlimit', val);
		GlobalBucket.byteRate = val;
		this._speeds.clear();
	},
	
	_loadDownloads: function D__loadDownloads() {
		this._loading = $('loading');
		if (!this._loading) {
			this._loading = {};
		}
		Tree.beginUpdate();
		Tree.clear();
		this._brokenDownloads = [];
		Debug.logString("loading of the queue started!");
		this._loader = new CoThreadListWalker(
			this._loadDownloads_item,
			QueueStore.loadGenerator(),
			250,
			this,
			this._loadDownloads_finish
		);
		this._loader.run();		
	},
	_loadDownloads_item: function D__loadDownloads_item(dbItem, idx) {
		if (idx % 500 == 0) {
			this._loading.label = _('loading', [idx, dbItem.count, Math.floor(idx * 100 / dbItem.count)]);
		}
		
		try {
			let down = JSONCompat.parse(dbItem.serial);
			
			let get = function(attr, def) {
				return (attr in down) ? down[attr] : (def ? def : '');
			}

			let d = new QueueItem();
			d.dbId = dbItem.id;
			let state = get('state'); 
			if (state) {
				d._state = state;
			}					
			d.urlManager = new UrlManager(down.urlManager);
			d.numIstance = get("numIstance");

			let referrer = get('referrer');
			if (referrer) {
				try {
					d.referrer = referrer.toURL();
				}
				catch (ex) {
					// We might have been fed with about:blank or other crap. so ignore.
				}
			}
		
			// only access the setter of the last so that we don't generate stuff trice.
			d._pathName = get('pathName', '');
			d._description = get('description', '');
			d._title = get('title', '');
			d._mask = get('mask');
			d.fileName = get('fileName');
			
			let tmpFile = get('tmpFile');
			if (tmpFile) {
				try {
					tmpFile = new FileFactory(tmpFile);
					if (tmpFile.exists()) {
						d._tmpFile = tmpFile;
					}
					else {
						// Download partfile is gone!
						// XXX find appropriate error message!
						d.fail(_("accesserror"), _("permissions") + " " + _("destpath") + ". " + _("checkperm"), _("accesserror"));
					}
				}
				catch (ex) {
					Debug.log("tried to construct with invalid tmpFile", ex);
					d.cancel();
				}
			}				

			d.startDate = new Date(get("startDate"));
			d.visitors = new VisitorManager(down.visitors);
			
			for each (let e in [
				'contentType',
				'conflicts',
				'postData',
				'destinationName',
				'resumable',
				'compression',
				'fromMetalink',
				'speedLimit',
			].filter(function(e) e in down)) {
				d[e] = down[e];
			}
			
			// don't trigger prealloc!
			d._totalSize = down.totalSize ? down.totalSize : 0;

			if (down.hashCollection) {
				d.hashCollection = DTA.HashCollection.load(down.hashCollection);
			}
			else if (down.hash) {
				d.hashCollection = new DTA.HashCollection(new DTA.Hash(down.hash, down.hashType));
			}
			if ('maxChunks' in down) {
				d._maxChunks = down.maxChunks;
			}

			d.started = d.partialSize != 0;
			switch (d._state) {
				case PAUSED:
				case QUEUED:
				{
					for each (let c in down.chunks) {
						d.chunks.push(new Chunk(d, c.start, c.end, c.written));
					}
					d.refreshPartialSize();
					if (d._state == PAUSED) {
						d.status = TEXT_PAUSED;
					}
					else {
						d.status = TEXT_QUEUED;
					}
				}
				break;
				
				case COMPLETE:
					d.partialSize = d.totalSize;
					d.status = TEXT_COMPLETE;
				break;
				
				case CANCELED:
					d.status = TEXT_CANCELED;
				break;
			}
			
			// XXX better call this only once
			// See above
			d.rebuildDestination();

			d._position = Tree.add(d);
		}
		catch (ex) {
			Debug.log('failed to init download #' + dbItem.id + ' from queuefile', ex);
			this._brokenDownloads.push(dbItem.id);
		}
		return true;
	},
	_loadDownloads_finish: function D__loadDownloads_finish() {
		delete this._loader;
		Tree.endUpdate();
		Tree.invalidate();
		
		if (this._brokenDownloads.length) {
			QueueStore.beginUpdate();
			try {
				for each (let id in this._brokenDownloads) {
					QueueStore.deleteDownload(id);
					Debug.logString("Removed broken download #" + id);
				}
			}
			catch (ex) {
				Debug.log("failed to remove broken downloads", ex);
			}
			QueueStore.endUpdate();
		}
		delete this._brokenDownloads;
		delete this._loading;
		
		this._updTimer = Timers.createRepeating(REFRESH_FREQ, this.checkDownloads, this, true);		
		
		this.start();
	},	
	
	enterPrivateBrowsing: function() {
		this.reinit();
	},
	exitPrivateBrowsing: function() {
		Tree.updateAll(function(download) {
			if (!download.is(COMPLETE)) {
				download.cancel();
			}
			return true;
		});
		this.reinit();
	},
	canEnterPrivateBrowsing: function() {
		if (Tree.some(function(d) { return d.started && !d.resumable && d.isOf(RUNNING); })) {
			var rv = Prompts.confirmYN(
				window,
				_("confpbm"),
				_("nonrespbm")
			);
			if (rv) {
				return false;
			}
		}
		return (this._forceClose = true);
	},
	canExitPrivateBrowsing: function() {
		if (Tree.some(function(d) { return d.isOf(RUNNING, QUEUED, PAUSED, FINISHING); })) {
			var rv = Prompts.confirmYN(
				window,
				_("confleavepbm"),
				_("nonleavepbm")
			);
			if (rv) {
				return false;
			}
		}
		return (this._forceClose = true);
	},
	
	openAdd: function D_openAdd() {
		window.openDialog(
			'chrome://dta/content/dta/addurl.xul',
			'_blank',
			'chrome, centerscreen, dialog=no, dependent=yes'
		);
	},
	
	openDonate: function D_openDonate() {
		try {
			DTA_Mediator.open('http://www.downthemall.net/howto/donate/');
		}
		catch(ex) {
			alert(ex);
		}
	},
	openInfo: function D_openInfo(downloads) {
		let w = window.openDialog(
			"chrome://dta/content/dta/manager/info.xul","_blank",
			"chrome, centerscreen, dialog=no",
			downloads,
			this
			);
		if (w) {
			this._infoWindows.push(w);
		}
	},
	
	start: function D_start() {
		if (this._initialized) {
			return;
		}

		PrivateBrowsing.registerCallbacks(this);
		
		if ("arguments" in window) {
			startDownloads(window.arguments[0], window.arguments[1]);
		}
		this._initialized = true;
		for (let d in Tree.all) {
			if (d.is(FINISHING)) {
				this.run(d);
			}
		}
		Timers.createRepeating(100, this.refreshWritten, this, true);
		Timers.createRepeating(10000, this.saveRunning, this);
		
		$('loadingbox').parentNode.removeChild($('loadingbox'));
	},
	
	reinit: function() {
		if (!this._initialized) {
			return;
		}
		try {
			Debug.logString("reinit initiated");
			let tp = this;
			Timers.createOneshot(10, function() tp.shutdown(tp._continueReinit), this);
		}
		catch (ex) {
			Debug.log("Failed to reload any downloads from queuefile", ex);
		}
	},
	_continueReinit: function() {
		this._running = [];
		delete this._forceQuit;
		this._speeds.clear();
		this.offlineForced = false;
		
		this._loadDownloads();
	},
	
	observe: function D_observe(subject, topic, data) {
		if (topic == 'quit-application-requested') {
			if (!this._canClose()) {
				delete this._forceClose;
				try {
					let cancelQuit = subject.QueryInterface(Ci.nsISupportsPRBool);
					cancelQuit.data = true;
				}
				catch (ex) {
					Debug.log("cannot set cancelQuit", ex);
				}
			}
		}
		else if (topic == 'quit-application-granted') {
			this._forceClose = true;
		}
		else if (topic == 'network:offline-status-changed') {
			this.offline = data == "offline";
		}
		else if (topic == 'DTA:filterschanged') {
			Tree.assembleMenus();
		}
	},
	refresh: function D_refresh() {
		try {
			const now = Utils.getTimestamp();
			for each (let d in this._running) {
				let advanced = d.speeds.add(d.partialSize, now);
				this._sum += advanced;
				
				// Calculate estimated time
				if (advanced != 0 && d.totalSize > 0) {
					let remaining = Math.ceil((d.totalSize - d.partialSize) / d.speeds.avg);
					if (!isFinite(remaining)) {
						d.status = _("unknown");
					}
					else {
						d.status = Utils.formatTimeDelta(remaining);
					}
				}
				d.speed = Utils.formatSpeed(d.speeds.avg);
				if (d.speedLimit > 0) {
					d.speed += " (" + Utils.formatSpeed(d.speedLimit, 0) + ")";
				}
			}
			this._speeds.add(this._sum, now);
			speed = Utils.formatBytes(this._speeds.avg);
			this._maxObservedSpeed = Math.max(this._speeds.avg, this._maxObservedSpeed);
			for each (let e in $('listSpeeds', 'perDownloadSpeedLimitList')) {
				e.hint = this._maxObservedSpeed;
			}

			// Refresh status bar
			$('statusText').label = _("currentdownloads", [this.completed, Tree.rowCount, this._running.length]);
			$('statusSpeed').label = _("currentspeed", [speed]);

			// Refresh window title
			if (this._running.length == 1 && this._running[0].totalSize > 0) {
				document.title =
					this._running[0].percent
					+ ' - '
					+ this.completed + "/" + Tree.rowCount + " - "
					+ $('statusSpeed').label + ' - DownThemAll!';
			}
			else if (this._running.length > 0) {
				document.title =
					Math.floor(this.completed * 100 / Tree.rowCount) + '%'
					+ ' - '				
					+ this.completed + "/" + Tree.rowCount + " - "
					+ $('statusSpeed').label + ' - DownThemAll!';
			}
			else {
				document.title = this.completed + "/" + Tree.rowCount + " - DownThemAll!";
			}
		}
		catch(ex) {
			Debug.log("refresh():", ex);
		}
	},
	refreshWritten: function D_refreshWritten() {
		for each (let d in this._running) {
			d.invalidate(1);
			d.invalidate(2);
			d.invalidate(3);
		}
	},
	saveRunning: function D_saveRunning() {
		if (!this._running.length) {
			return;
		}
		QueueStore.beginUpdate();
		for each (let d in this._running) {
			d.save();
		}
		QueueStore.endUpdate();
	},
	
	_processOfflineChange: function D__processOfflineChange() {
		let de = $('downloads');
		if (this.offline == de.hasAttribute('offline')) {
			return;
		}
		
		if (this.offline) {
			de.setAttribute('offline', true);
			$('netstatus').setAttribute('offline', true);
			for (let d in Tree.all) {
				if (d.is(RUNNING)) {
					d.pause();
					d.queue();
				}
			}		
		}
		else if (de.hasAttribute('offline')) {
			de.removeAttribute('offline');
			$('netstatus').removeAttribute('offline');
		}
		Tree.box.invalidate();		
	},

	checkDownloads: function D_checkDownloads() {
		try {
			this.refresh();
			
			for each (let d in this._running) {
				// checks for timeout
				if (d.is(RUNNING) && (Utils.getTimestamp() - d.timeLastProgress) >= Prefs.timeout * 1000) {
					if (d.resumable || !d.totalSize || !d.partialSize || Prefs.resumeOnError) {
						Dialog.markAutoRetry(d);
						d.pause();
						d.status = _("timeout");
					}
					else {
						d.cancel(_("timeout"));
					}
					Debug.logString(d + " is a timeout");
				}
			}
			
			if (Prefs.autoClearComplete && this._autoClears.length) {
				Tree.remove(this._autoClears);
				this._autoClears = [];
			}

			if (!this.offline) {
				if (Prefs.autoRetryInterval) {
					this._autoRetrying = this._autoRetrying.filter(function(d) !d.autoRetry());
				}
				this.startNext();
			}
		}
		catch(ex) {
			Debug.log("checkDownloads():", ex);
		}
	},
	checkSameName: function D_checkSameName(download, path) {
		for each (let runner in this._running) {
			if (runner == download) {
				continue;
			}
			if (runner.destinationFile == path) {
				return true;
			}
		}
		return false;
	},
	startNext: function D_startNext() {
		try {
			var rv = false;
			// pre-condition, do check prior to loop, or else we'll have the generator cost.
			if (this._running.length >= Prefs.maxInProgress) {
				return false;
			}				
			let gen = Limits.getScheduler(Tree.all, this._running);
			for (let d in gen) {
				if (!d.is(QUEUED)) {
					Debug.logString("FIXME: scheduler returned unqueued download");
					continue;
				}
				this.run(d);
				if (this._running.length >= Prefs.maxInProgress) {
					return true;
				}
				rv = true;
			}
			delete gen;
			return rv;
		}
		catch(ex){
			Debug.log("startNext():", ex);
		}
		return false;
	},
	run: function D_run(download) {
		if (this.offline) {
			return;
		}
		download.status = _("starting");
		if (download.is(FINISHING) || (download.partialSize >= download.totalSize && download.totalSize)) {
			// we might encounter renaming issues;
			// but we cannot handle it because we don't know at which stage we crashed
			download.partialSize = download.totalSize;
			Debug.logString("Download seems to be complete; likely a left-over from a crash, finish it:" + download);
			download.finishDownload();
			return;
		}
		download.timeLastProgress = Utils.getTimestamp();
		download.timeStart = Utils.getTimestamp();
		download.state = RUNNING;
		if (!download.started) {
			download.started = true;
			Debug.logString("Let's start " + download);
		}
		else {
			Debug.logString("Let's resume " + download + " at " + download.partialSize);
		}
		this._running.push(download);
		download.prealloc();
		download.resumeDownload();
	},
	wasStopped: function D_wasStopped(download) {
		this._running = this._running.filter(function (d) d != download);
	},
	signal: function D_signal(download) {
		download.save();
		if (download.is(RUNNING)) {
			this._wasRunning = true;
		}
		else if (Prefs.autoClearComplete && download.is(COMPLETE)) {
			this._autoClears.push(download);
		}
		if (!this._initialized || !this._wasRunning || !download.is(COMPLETE)) {
			return;
		}
		try {
			// check if there is something running or scheduled
			if (this.startNext() || Tree.some(function(d) { return d.isOf(FINISHING, RUNNING, QUEUED); } )) {
				return;
			}
			Debug.logString("signal(): Queue finished");
			Utils.playSound("done");
			
			let dp = Tree.at(0);
			if (dp) {
				dp = dp.destinationPath;
			}
			if (Prefs.alertingSystem == 1) {
				AlertService.show(_("dcom"), _('suc'), function() Utils.launch(dp));
			}
			else if (dp && Prefs.alertingSystem == 0) {
				if (Prompts.confirmYN(window, _('suc'),  _("folder")) == 0) {
					try {
						Utils.launch(dp);
					}
					catch (ex){
						// no-op
					}
				}
			}
			if (Prefs.autoClose) {
				Dialog.close();
			}
		}
		catch(ex) {
			Debug.log("signal():", ex);
		}
	},
	markAutoRetry: function D_markAutoRetry(d) {
		d.initAutoRetry();
		if (this._autoRetrying.indexOf(d) == -1) {
			this._autoRetrying.push(d);
		}
	},
	wasRemoved: function D_wasRemoved(d) {
		this._running = this._running.filter(function(r) r != d);
		this._autoRetrying = this._autoRetrying.filter(function(r) r != d);
	},
	_canClose: function D__canClose() {
		if (Tree.some(function(d) { return d.started && !d.resumable && d.isOf(RUNNING); })) {
			var rv = Prompts.confirmYN(
				window,
				_("confclose"),
				_("nonresclose")
			);
			if (rv) {
				return false;
			}
		}
		return (this._forceClose = true);
	},
	close: function() {
		this.shutdown(this._doneClosing);
	},
	_doneClosing: function() {
		closeWindow(true);
	},
	shutdown: function D_close(callback) {
		Debug.logString("Close request");
		if (!this._initialized) {
			Debug.logString("not initialized. Going down immediately!");
			callback.call(this);
			return true;
		}
		if (!this._forceClose && !this._canClose()) {
			delete this._forceClose;
			Debug.logString("Not going to close!");
			return false;
		}
		this.offlineForced = true;

		// stop everything!
		// enumerate everything we'll have to wait for!
		if (this._updTimer) {
			Timers.killTimer(this._updTimer);
			delete this._updTimer;
		}
		
		let chunks = 0;
		let finishing = 0;
		Debug.logString("Going to close all");
		Tree.updateAll(
			function(d) {
				if (d.isOf(RUNNING, QUEUED)) {
					// enumerate all running chunks
					d.chunks.forEach(
						function(c) {
							if (c.running) {
								++chunks;
							}
						},
						this
					);
					d.pause();
					d.state = QUEUED;				
				}
				else if (d.is(FINISHING)) {
					++finishing;
				}
				d.cancelPreallocation();
				return true;
			},
			this
		);
		Debug.logString("Still running: " + chunks + " Finishing: " + finishing);
		if (chunks || finishing) {
			if (this._safeCloseAttempts < 20) {
				++this._safeCloseAttempts;
				let tp = this;
				Timers.createOneshot(250, function() tp.shutdown(callback), this);				
				return false;
			}
			Debug.logString("Going down even if queue was not probably closed yet!");
		}
		callback.call(this);
		return true;
	},
	_cleanTmpDir: function D__cleanTmpDir() {
		if (!Prefs.tempLocation || Preferences.getExt("tempLocation", '') != '') {
			// cannot perform this action if we don't use a temp file
			// there might be far too many directories containing far too many
			// tmpFiles.
			// or part files from other users.
			return;
		}
		let known = [];
		for (d in Tree.all) {
			known.push(d.tmpFile.leafName);
		}
		let tmpEnum = Prefs.tempLocation.directoryEntries;
		let unknown = [];
		for (let f in new Utils.SimpleIterator(tmpEnum, Ci.nsILocalFile)) {
			if (f.leafName.match(/\.dtapart$/) && known.indexOf(f.leafName) == -1) {
				unknown.push(f);
			}
		}
		unknown.forEach(
			function(f) {
				try {
					f.remove(false);
				}
				catch(ex) {
				}
			}
		);
	},
	_safeCloseAttempts: 0,

	unload: function D_unload() {
		PrivateBrowsing.unregisterCallbacks(this);
		if (GlobalBucket) { 
			GlobalBucket.kill();
		}
		Limits.killServerBuckets();
		
		Timers.killAllTimers();
		if (this._loader) {
			this._loader.cancel();
		}
		Prefs.shutdown();
		try {
			this._cleanTmpDir();
		}
		catch(ex) {
			Debug.log("_safeClose", ex);
		}
		for each (let w in this._infoWindows) {
			if (!w.closed) {
				w.close();
			}
		}
		return true;		
	}
};
addEventListener('load', function() Dialog.init(), false);

const Metalinker = {
 	handleDownload: function ML_handleDownload(download) {
		download.state = CANCELED;
		Tree.remove(download, false);
		let file = new FileFactory(download.destinationFile);
		
		this.handleFile(file, download.referrer);
		
		try {
			file.remove(false);
		}
		catch (ex) {
			Debug.log("failed to remove metalink file!", ex);
		}
	},
	handleFile: function ML_handleFile(aFile, aReferrer) {
		try {
			let res = this.parse(aFile, aReferrer);
			if (!res.downloads.length) {
				throw new Error(_('mlnodownloads'));
			}
			res.downloads.forEach(function(e) {
				e.size = Utils.formatBytes(e.size);
				e.fileName = e.fileName.getUsableFileName();
			});
			window.openDialog(
				'chrome://dta/content/dta/manager/metaselect.xul',
				'_blank',
				'chrome,centerscreen,dialog=yes,modal',
				res.downloads,
				res.info
			);
			res.downloads = res.downloads.filter(function(d) { return d.selected; });
			if (res.downloads.length) {
				startDownloads(res.info.start, res.downloads);
			}
		}
		catch (ex) {
			Debug.log("Metalinker::handleDownload", ex);			
			if (!(ex instanceof Error)) {
				ex = new Error(_('mlerror', [ex.message ? ex.message : (ex.error ? ex.error : ex.toString())]));
			}
			if (ex instanceof Error) {
				AlertService.show(_('mlerrortitle'), ex.message);
			}
		}
	}	
};
module('resource://dta/metalinker.jsm', Metalinker);


function QueueItem(lnk, dir, num, desc, mask, referrer, tmpFile) {

	this.visitors = new VisitorManager();

	this.startDate = new Date();	

	this.chunks = [];
	this.speeds = new SpeedStats(SPEED_COUNT);
}

QueueItem.prototype = {
	_state: QUEUED,
	get state() {
		return this._state;
	},
	set state(nv) {
		if (this._state == nv) {
			return nv;
		}
		if (this._state == RUNNING) {
			// remove ourself from inprogresslist
			Dialog.wasStopped(this);
			// kill the bucket via it's setter
			this.bucket = null;
		}
		this.speed = '';
		this._state = nv;
		if (this._state == RUNNING) {
			// set up the bucket
			this._bucket = new ByteBucket(this.speedLimit, 1.7);
		}		
		Dialog.signal(this);
		this.invalidate();
		Tree.refreshTools();
		return nv;
	},
	
	_bucket: null,
	get bucket() {
		return this._bucket;
	},
	set bucket(nv) {
		if (nv !== null) {
			throw new Exception("Bucket is only nullable");
		}
		if (this._bucket) {
			this._bucket.kill();
			this._bucket = null;
		}
	},
	
	_speedLimit: -1,
	get speedLimit() {
		return this._speedLimit;
	},
	set speedLimit(nv) {
		nv = Math.max(nv, -1);
		if (this._speedLimit == nv) {
			return;
		}
		this._speedLimit = nv;
		if (this.is(RUNNING)) {
			this._bucket.byteRate = this.speedLimit;
		}
		this.save();
	},
	
	postData: null,
	
	fromMetalink: false,
	numIstance: 0,
	
	_fileName: null,
	get fileName() {
		return this._fileName;
	},
	set fileName(nv) {
		if (this._fileName == nv) {
			return nv;
		}
		this._fileName = nv;
		this.rebuildDestination();
		this.invalidate(0);
		return nv;
	},
	_description: null,
	get description() {
		return this._description;
	},
	set description(nv) {
		if (nv == this._description) {
			return nv;
		}
		this._description = nv;
		this.rebuildDestination();
		this.invalidate(0);
		return nv;
	},	
	_title: '',
	get title() {
		return this._title;
	},
	set title(nv) {
		if (nv == this._title) {
			return this._title;
		}
		this._title = nv;
		this.rebuildDestination();
		this.invalidate(0);
		return this._title;
	},
	_pathName: null,
	get pathName() {
		return this._pathName;
	},
	set pathName(nv) {
		nv = nv.toString();
		if (this._pathName == nv) {
			return nv;
		}
		this._pathName = nv;
		this.rebuildDestination();
		this.invalidate(0);
		return nv;
	},	

	_mask: null,
	get mask() {
		return this._mask;
	},
	set mask(nv) {
		if (this._mask == nv) {
			return nv;
		}
		this._mask = nv;
		this.rebuildDestination();
		this.invalidate(7);
		return nv;
	},		
	
	_destinationName: null,
	destinationNameOverride: null,
	_destinationNameFull: null,
	get destinationName() {
		return this._destinationNameFull; 
	},
	set destinationName(nv) {
		if (this.destinationNameOverride == nv) {
			return this._destinationNameFull;
		}
		this.destinationNameOverride = nv;
		this.rebuildDestination();
		this.invalidate(0);
		return this._destinationNameFull;
	},
	
	_destinationFile: null,
	get destinationFile() {
		if (!this._destinationFile) {
			this.rebuildDestination();
		}
		return this._destinationFile;
	},
	
	_conflicts: 0,
	get conflicts() {
		return this._conflicts;
	},
	set conflicts(nv) {
		if (this._conflicts == nv) {
			return nv;
		}
		this._conflicts = nv;
		this.rebuildDestination();
		this.invalidate(0);
		return nv;
	},
	_tmpFile: null,
	get tmpFile() {
		if (!this._tmpFile) {
			var dest = Prefs.tempLocation
				? Prefs.tempLocation.clone()
				: new FileFactory(this.destinationPath);
			let name = this.fileName;
			if (name.length > 60) {
				name = name.substring(0, 60);
			}
			dest.append(name + "-" + Utils.newUUIDString() + '.dtapart');
			this._tmpFile = dest;
		}
		return this._tmpFile;
	},
	_hashCollection: null,
	get hashCollection() {
		return this._hashCollection;
	},
	set hashCollection(nv) {
		if (nv != null && !(nv instanceof DTA.HashCollection)) {
			throw new Exception("Not a hash collection");
		}
		this._hashCollection = nv;
		this._prettyHash = this._hashCollection
			? _('prettyhash', [this._hashCollection.full.type, this._hashCollection.full.sum])
			: _('nas');
	},
	_prettyHash: null,
	get prettyHash() {
		return this._prettyHash;
	},

	/**
	 * Takes one or more state indicators and returns if this download is in state
	 * of any of them
	 */
	is: function QI_is(state) {
		return this._state == state; 
	},
	isOf: function QI_isOf() {
		let state = this._state;
		for (let i = 0, e = arguments.length; i < e; ++i) {
			if (state == arguments[i]) {
				return true;
			}
		}
		return false;		
	},
	
	save: function QI_save() {
		if (
			(Prefs.removeCompleted && this.is(COMPLETE))
			|| (Prefs.removeCanceled && this.is(CANCELED))
			|| (Prefs.removeAborted && this.is(PAUSED))
		) {
			if (this.dbId) {
				this.remove();
			}
			return false;			
		}			
		if (this.dbId) {
			QueueStore.saveDownload(this.dbId, this.toSource());
			return true;
		}

		this.dbId = QueueStore.addDownload(this.toSource(), this.position);
		return true;
	},
	remove: function QI_remove() {
		QueueStore.deleteDownload(this.dbId);
		delete this.dbId;
	},
	_position: -1,
	get position() {
		return this._position;
	},
	set position(nv) {
		if (nv == this._position) {
			return;
		}
		this._position = nv;
		if (this.dbId && this._position != -1) {
			QueueStore.savePosition(this.dbId, this._position);	
		}
	},

	contentType: "",
	visitors: null,
	_totalSize: 0,
	get totalSize() { return this._totalSize; },
	set totalSize(nv) {
		if (nv >= 0 && !isNaN(nv)) {
			this._totalSize = Math.floor(nv);
		}
		this.invalidate(3);
		this.prealloc();
		return this._totalSize;
	},
	partialSize: 0,

	startDate: null,

	compression: null,

	resumable: true,
	started: false,

	_activeChunks: 0,
	get activeChunks() {
		return this._activeChunks;
	},
	set activeChunks(nv) {
		nv = Math.max(0, nv);
		this._activeChunks = nv;
		this.invalidate(6);
		return this._activeChunks;
	},
	_maxChunks: 0,
	get maxChunks() {
		if (!this._maxChunks) {
				this._maxChunks = Prefs.maxChunks;
		}
		return this._maxChunks;
	},
	set maxChunks(nv) {
		this._maxChunks = nv;
		if (this._maxChunks < this._activeChunks) {
			let running = this.chunks.filter(function(c) { return c.running; });
			while (running.length && this._maxChunks < running.length) {
				let c = running.pop();
				if (c.remainder < 10240) {
					continue;
				}
				c.cancel();
			}
		}
		else if (this._maxChunks > this._activeChunks && this.is(RUNNING)) {
			this.resumeDownload();
			
		}
		this.invalidate(6);
		Debug.logString("mc set to " + nv);
		return this._maxChunks;
	},
	timeLastProgress: 0,
	timeStart: 0,

	_icon: null,
	get icon() {
		if (!this._icon) {
			this._icon = getIcon(this.destinationName, 'metalink' in this);
		}
		return this._icon;
	},
	get largeIcon() {
		return getIcon(this.destinationName, 'metalink' in this, 32);
	},
	get size() {
		try {
			let file = null;
			if (!this.isOf(COMPLETE, FINISHING)) {
				file = this._tmpFile || null;	
			}
			else {
				file = new FileFactory(this.destinationFile);
			}
			if (file && file.exists()) {
				return file.fileSize;
			}
		}
		catch (ex) {
			Debug.log("download::getSize(): ", ex);
		}
		return 0;
	},
	get dimensionString() {
		if (this.partialSize <= 0) {
			return _('unknown'); 
		}
		else if (this.totalSize <= 0) {
			return _('transfered', [Utils.formatBytes(this.partialSize), _('nas')]);
		}
		else if (this.is(COMPLETE)) {
			return Utils.formatBytes(this.totalSize);
		}
		return _('transfered', [Utils.formatBytes(this.partialSize), Utils.formatBytes(this.totalSize)]);
	},
	_status : '',
	get status() {
		if (Dialog.offline && this.isOf(QUEUED, PAUSED)) {
			return _('offline');
		}
		return this._status + (this.autoRetrying ? ' *' : '');
	},
	set status(nv) {
		if (nv != this._status) {
			this._status = nv;
			this.invalidate();
		}
		return this._status;
	},
	get parts() {
		if (this.maxChunks) {
			return (this.activeChunks) + '/' + this.maxChunks;
		}
		return '';
	},
	get percent() {
		if (!this.totalSize && this.is(RUNNING)) {
			return _('nas');
		}
		else if (!this.totalSize) {
			return "0%";
		}
		else if (this.is(COMPLETE)) {
			return "100%";
		}
		return Math.floor(this.partialSize / this.totalSize * 100) + "%";
	},
	_destinationPath: '',
	get destinationPath() {
		return this._destinationPath;
	},

	invalidate: function QI_invalidate(cell) {
		Tree.invalidate(this, cell);
	},

	safeRetry: function QI_safeRetry() {
		// reset flags
		this.totalSize = this.partialSize = 0;
		this.compression = null;
		this.activeChunks = this.maxChunks = 0;
		this.chunks.forEach(function(c) { c.cancel(); });
		this.chunks = [];
		this.speeds.clear();
		this.visitors = new VisitorManager();
		this.state = QUEUED;
		Dialog.run(this);
	},

	refreshPartialSize: function QI_refreshPartialSize(){
		let size = 0;
		this.chunks.forEach(function(c) { size += c.written; });
		this.partialSize = size;
	},

	pause: function QI_pause(){
		if (this.chunks) {
			for each (let c in this.chunks) {
				if (c.running) {
					c.cancel();
				}
			}
		}
		this.activeChunks = 0;
		this.state = PAUSED;
		this.speeds.clear();
	},

	moveCompleted: function QI_moveCompleted() {
		if (this.is(CANCELED)) {
			return;
		}
		ConflictManager.resolve(this, 'continueMoveCompleted');
	},
	continueMoveCompleted: function QI_continueMoveCompleted() {
		if (this.is(CANCELED)) {
			return;
		}		
		try {
			// safeguard against some failed chunks.
			this.chunks.forEach(function(c) { c.close(); });
			var destination = new FileFactory(this.destinationPath);
			Debug.logString(this.fileName + ": Move " + this.tmpFile.path + " to " + this.destinationFile);

			if (!destination.exists()) {
				destination.create(Ci.nsIFile.DIRECTORY_TYPE, Prefs.dirPermissions);
			}
			var df = destination.clone();
			df.append(this.destinationName);
			if (df.exists()) {
				df.remove(false);
			}
			// move file
			if (this.compression) {
				this.state = FINISHING;
				this.status =  _("decompress");
				new Decompressor(this);
			}
			else {
				this.tmpFile.clone().moveTo(destination, this.destinationName);
				this.complete();
			}
		}
		catch(ex) {
			Debug.log("continueMoveCompleted encountered an error", ex);
			this.complete(ex);
		}
	},
	handleMetalink: function QI_handleMetaLink() {
		try {
			Metalinker.handleDownload(this);
		}
		catch (ex) {
			Debug.log("handleMetalink", ex);
		}
	},
	verifyHash: function() {
		this.state = FINISHING;
		this.status = _("verify");
		new Verificator(this, this.verifyHashOk, this.verifyHashError);
	},
	verifyHashOk: function() {
		this.complete();
	},
	verifyHashError: function() {
		let file = new FileFactory(this.destinationFile);
		function deleteFile() { 
			try {
				if (file.exists()) {
					file.remove(false);
				}
			}
			catch (ex) {
				Debug.log("Failed to remove file after checksum mismatch", ex);
			}
		}
		let act = Prompts.confirm(window, _('verifyerrortitle'), _('verifyerrortext'), _('retry'), _('delete'), _('keep'));
		switch (act) {
			case 0: deleteFile(); this.safeRetry(); return;
			case 1: deleteFile(); this.cancel(); return;
		}
		this.verifyHashOk();
	},		
	customFinishEvent: function() {
		DTA_include("dta/manager/customevent.js");
		new CustomEvent(this, Prefs.finishEvent);
	},
	setAttributes: function() {
		if (Prefs.setTime) {
			try {
				let time = this.startDate.getTime();
				try {
					time =  this.visitors.time;
				}
				catch (ex) {
					// no-op
				}
				// small validation. Around epoche? More than a month in future?
				if (time < 2 || time > Date.now() + 30 * 86400000) {
					throw new Exception("invalid date encountered: " + time + ", will not set it");
				}
				// have to unwrap
				let file = new FileFactory(this.destinationFile);
				file.lastModifiedTime = time;
			}
			catch (ex) {
				Debug.log("Setting timestamp on file failed: ", ex);
			}
		}
		this.totalSize = this.partialSize = this.size;
		++Dialog.completed;
		
		this.complete();
	},
	finishDownload: function QI_finishDownload(exception) {
		Debug.logString("finishDownload, connections: " + this.sessionConnections);
		this._completeEvents = ['moveCompleted', 'setAttributes'];
		if (this.hashCollection) {
			this._completeEvents.push('verifyHash');
		}
		if ('isMetalink' in this) {
			this._completeEvents.push('handleMetalink');
		}
		if (Prefs.finishEvent) {
			this._completeEvents.push('customFinishEvent');
		}
		this.complete();
	},
	_completeEvents: [],
	complete: function QI_complete(exception) {
		this.chunks = [];
		this.speeds.clear();
		if (exception) {
			this.fail(_("accesserror"), _("permissions") + " " + _("destpath") + ". " + _("checkperm"), _("accesserror"));
			Debug.log("complete: ", exception);
			return;
		}
		if (this._completeEvents.length) {
			var evt = this._completeEvents.shift();
			var tp = this;
			window.setTimeout(
				function() {
					try {
						tp[evt]();
					}
					catch(ex) {
						Debug.log("completeEvent failed: " + evt, ex);
						tp.complete();
					}
				},
				0
			);
			return;
		}
		this.activeChunks = 0;
		this.state = COMPLETE;
		this.status = TEXT_COMPLETE;
		this.visitors = new VisitorManager();
	},
	rebuildDestination: function QI_rebuildDestination() {
		try {
			let uri = this.urlManager.usable.toURL();
			let host = uri.host.toString();

			// normalize slashes
			let mask = this.mask
				.normalizeSlashes()
				.removeLeadingSlash()
				.removeFinalSlash();

			let uripath = uri.path.removeLeadingChar("/");
			if (uripath.length) {
				uripath = uripath.substring(0, uri.path.lastIndexOf("/"))
					.normalizeSlashes()
					.removeFinalSlash();
			}

			let query = '';
			try {
				query = uri.query;
			}
			catch (ex) {
				// no-op
			}

			let description = this.description.removeBadChars().replaceSlashes(' ').trim();
			let title = this.title.removeBadChars().trim();
			
			let name = this.fileName;
			let ext = name.getExtension();
			if (ext) {
				name = name.substring(0, name.length - ext.length - 1);

				if (this.contentType && /htm/.test(this.contentType) && !/htm/.test(ext)) {
					ext += ".html";
				}
			}
			// mime-service method
			else if (this.contentType && /^(?:image|text)/.test(this.contentType)) {
				try {
					let info = MimeService.getFromTypeAndExtension(this.contentType.split(';')[0], "");
					ext = info.primaryExtension;
				} catch (ex) {
					ext = '';
				}
			}
			else {
				name = this.fileName;
				ext = '';
			}
			let ref = this.referrer ? this.referrer.host.toString() : '';
			
			let curl = (uri.host + ((uripath=="") ? "" : (SYSTEMSLASH + uripath))); 
			
			var replacements = {
				"name": name,
				"ext": ext,
				"text": description,
				"flattext": description.replaceSlashes(Prefs.flatReplacementChar).replace(/[\n\r\s]+/g, ' ').trim(),
				'title': title,
				'flattitle': title.replaceSlashes(Prefs.flatReplacementChar).replace(/[\n\r\s]+/g, ' ').trim(),
				"url": host,
				"subdirs": uripath,
				"flatsubdirs": uripath.replaceSlashes(Prefs.flatReplacementChar).trim(),
				"refer": ref,
				"qstring": query,
				"curl": curl,
				"flatcurl": curl.replaceSlashes(Prefs.flatReplacementChar),
				"num": Utils.formatNumber(this.numIstance),
				"hh": Utils.formatNumber(this.startDate.getHours(), 2),
				"mm": Utils.formatNumber(this.startDate.getMinutes(), 2),
				"ss": Utils.formatNumber(this.startDate.getSeconds(), 2),
				"d": Utils.formatNumber(this.startDate.getDate(), 2),
				"m": Utils.formatNumber(this.startDate.getMonth() + 1, 2),
				"y": String(this.startDate.getFullYear())
			}
			function replacer(type) {
				let t = type.substr(1, type.length - 2);
				if (t in replacements) {
					return replacements[t];
				}
				return type;
			}
			
			mask = mask.replace(/\*\w+\*/gi, replacer);

			mask = mask.removeBadChars().removeFinalChar(".").trim().split(SYSTEMSLASH);
			let file = new FileFactory(this.pathName.addFinalSlash());
			while (mask.length) {
				file.append(mask.shift());
			}
			this._destinationName = file.leafName;
			this._destinationPath = file.parent.path;
		}
		catch(ex) {
			this._destinationName = this.fileName;
			this._destinationPath = this.pathName.addFinalSlash();
			Debug.log("rebuildDestination():", ex);
		}
		this._destinationNameFull = Utils.formatConflictName(
			this.destinationNameOverride ? this.destinationNameOverride : this._destinationName,
			this.conflicts
		);
		let file = new FileFactory(this.destinationPath);
		file.append(this.destinationName);
		this._destinationFile = file.path;
		this._icon = null;
	},

	fail: function QI_fail(title, msg, state) {
		Debug.logString("failDownload invoked");

		this.cancel(state);

		Utils.playSound("error");

		switch (Prefs.alertingSystem) {
			case 1:
				AlertService.show(title, msg);
				break;
			case 0:
				alert(msg);
				break;
		}
	},

	cancel: function QI_cancel(message) {
		try {
			if (this.is(CANCELED)) {
				return;
			}
			if (this.is(COMPLETE)) {
				Dialog.completed--;
			}
			else if (this.is(RUNNING)) {
				this.pause();
			}
			this.state = CANCELED;			
			Debug.logString(this.fileName + ": canceled");

			this.visitors = new VisitorManager();

			if (message == "" || !message) {
				message = _("canceled");
			}
			this.status = message;
			
			this.cancelPreallocation();
			
			this.removeTmpFile();

			// gc
			this.chunks = [];
			this.totalSize = this.partialSize = 0;
			this.maxChunks = this.activeChunks = 0;
			this.conflicts = 0;
			this.resumable = true;
			this._autoRetries = 0;
			delete this._autoRetryTime;
			this.save();
		}
		catch(ex) {
			Debug.log("cancel():", ex);
		}
	},
	
	prealloc: function QI_prealloc() {
		let file = this.tmpFile;
		
		if (!this.is(RUNNING)) {
			return false;
		}
		
		if (!this.totalSize) {
			Debug.logString("pa: no totalsize");
			return false;
		}
		if (this.preallocating) {
			Debug.logString("pa: already working");
			return true;
		}
		
		if (!file.exists() || this.totalSize != this.size) {
			if (!file.parent.exists()) {
				file.parent.create(Ci.nsIFile.DIRECTORY_TYPE, Prefs.dirPermissions);
			}
			let pa = Preallocator.prealloc(file, this.totalSize, Prefs.permissions, this._donePrealloc, this);
			if (pa) {
				this.preallocating = true;
				this._preallocator = pa;
				Debug.logString("pa: started");
			}
		}
		else {
			Debug.logString("pa: already allocated");
		}
		return this.preallocating;
	},
	cancelPreallocation: function() {
		if (this._preallocator) {
			Debug.logString("pa: going to cancel");
			this._preallocator.cancel();
			delete this._preallocator;
			this._preallocator = null;
			Debug.logString("pa: cancelled");
		}
		this.preallocating = false;
	},
	
	_donePrealloc: function QI__donePrealloc(res) {
		Debug.logString("pa: done");
		delete this._preallocator;
		this._preallocator = null;
		this.preallocating = false;
		if (this.is(RUNNING)) {
			this.resumeDownload();
		}
	},
	
	
	removeTmpFile: function QI_removeTmpFile() {
		if (!!this._tmpFile && this._tmpFile.exists()) {
			try {
				this._tmpFile.remove(false);
			}
			catch (ex) {
				Debug.log("failed to remove tmpfile: " + this.tmpFile.path, ex);
			}
		}
		this._tmpFile = null;
	},
	
	sessionConnections: 0,
	_autoRetries: 0,
	_autoRetryTime: 0,
	get autoRetrying() {
		return !!this._autoRetryTime;
	},
	initAutoRetry: function QI_markRetry() {
		if (!Prefs.autoRetryInterval || (Prefs.maxAutoRetries && Prefs.maxAutoRetries <= this._autoRetries)) {
			 return;
		}
		this._autoRetryTime = Utils.getTimestamp();
		Debug.logString("marked auto-retry: " + this);
		this.save();
	},
	autoRetry: function QI_autoRetry() {
		if (!this.autoRetrying || Utils.getTimestamp() - (Prefs.autoRetryInterval * 1000) < this._autoRetryTime) {
			return false;
		}

		this._autoRetryTime = 0;
		++this._autoRetries;
		this.queue();
		Debug.logString("Requeued due to auto-retry: " + this);
		return true;
	},
	queue: function QI_queue() {
		this._autoRetryTime = 0;
		this.state = QUEUED;
		this.status = TEXT_QUEUED;
	},
	resumeDownload: function QI_resumeDownload() {
		Debug.logString("resumeDownload: " + this);
		function cleanChunks(d) {
			// merge finished chunks together, so that the scoreboard does not bloat
			// that much
			for (let i = d.chunks.length - 2; i > -1; --i) {
				let c1 = d.chunks[i], c2 = d.chunks[i + 1];
				if (c1.complete && c2.complete) {
					c1.merge(c2);
					d.chunks.splice(i + 1, 1);
				}
			}
		}
		function downloadNewChunk(download, start, end, header) {
			var chunk = new Chunk(download, start, end);
			download.chunks.push(chunk);
			download.chunks.sort(function(a,b) { return a.start - b.start; });
			downloadChunk(download, chunk, header);	
		}
		function downloadChunk(download, chunk, header) {
			chunk.running = true;
			download.state = RUNNING;
			Debug.logString("started: " + chunk);
			chunk.download = new Connection(download, chunk, header);
			++download.activeChunks;
			++download.sessionConnections;
		}
		
		cleanChunks(this);

		try {
			if (Dialog.offline || this.maxChunks <= this.activeChunks) {
				return false;
			}

			var rv = false;

			// we didn't load up anything so let's start the main chunk (which will
			// grab the info)
			if (this.chunks.length == 0) {
				downloadNewChunk(this, 0, 0, true);
				this.sessionConnections = 0;				
				return false;
			}
			
			
			// start some new chunks
			let paused = this.chunks.filter(function (chunk) !(chunk.running || chunk.complete));
			
			while (this.activeChunks < this.maxChunks) {
				if (this.preallocating && this.activeChunks) {
					Debug.logString("not resuming download " + this + " because preallocating");
					return true;
				}
				
				// restart paused chunks
				if (paused.length) {
					downloadChunk(this, paused.shift());
					rv = true;
					continue;
				}

				if (this.chunks.length == 1 && !!Prefs.loadEndFirst && this.chunks[0].remainder > 3 * Prefs.loadEndFirst) {
					// we should download the end first!
					let c = this.chunks[0];
					let end = c.end;
					c.end -= Prefs.loadEndFirst;
					downloadNewChunk(this, c.end + 1, end);					
					rv = true;
					continue;
				}
				
				// find biggest chunk
				let biggest = null;
				for each (let chunk in this.chunks) {
					if (chunk.running && chunk.remainder > MIN_CHUNK_SIZE * 2) {
						if (!biggest || biggest.remainder < chunk.remainder) {
							biggest = chunk;
						}
					}
				}

				// nothing found, break
				if (!biggest) {
					break;
				}
				let end = biggest.end;
				biggest.end = biggest.start + biggest.written + Math.floor(biggest.remainder / 2);
				downloadNewChunk(this, biggest.end + 1, end);
				rv = true;
			}

			return rv;
		}
		catch(ex) {
			Debug.log("resumeDownload():", ex);
		}
		return false;
	},
	dumpScoreboard: function QI_dumpScoreboard() {
		let scoreboard = '';
		let len = this.totalSize.toString().length;
		this.chunks.forEach(
			function(c,i) {
				scoreboard += i
					+ ": "
					+ c
					+ "\n";
			}
		);
		Debug.logString("scoreboard\n" + scoreboard);
	},	
	toString: function() this.urlManager.usable,
	toSource: function() {
		let e = {};
		[
		 	'fileName',
			'postData',
			'numIstance',
			'description',
			'title',
			'resumable',
			'mask',
			'pathName',
			'compression',
			'maxChunks',
			'contentType',
			'conflicts',
			'fromMetalink',
			'speedLimit'
		].forEach(
			function(u) {
				// only save what is changed
				if (this.__proto__[u] !== this[u]) {
					e[u] = this[u];
				}
			},
			this
		);
		if (this.hashCollection) {
			e.hashCollection = this.hashCollection.toSource();
		}
		if (this.autoRetrying || this.is(RUNNING)) {
			e.state = QUEUED;
		}
		else {
			e.state = this.state;
		}
		if (this.destinationNameOverride) {
			e.destinationName = this.destinationNameOverride;
		}
		if (this.referrer) {
			e.referrer = this.referrer.spec;
		}
		// Store this so we can later resume.
		if (!this.isOf(CANCELED, COMPLETE) && this.partialSize) {
			e.tmpFile = this.tmpFile.path;
		}
		e.startDate = this.startDate.getTime();

		e.urlManager = this.urlManager.toSource();
		e.visitors = this.visitors.toSource();

		if (!this.resumable && !this.is(COMPLETE)) {
			e.totalSize = 0;
		}
		else {
			e.totalSize = this.totalSize;
		}
		
		e.chunks = [];

		if (this.isOf(RUNNING, PAUSED, QUEUED) && this.resumable) {
			for each (let c in this.chunks) {
				e.chunks.push({start: c.start, end: c.end, written: c.safeBytes});
			}
		}
		return JSONCompat.stringify(e);
	}
}

function Chunk(download, start, end, written) {
	// saveguard against null or strings and such
	this._written = written > 0 ? written : 0;
	this._buffered = 0;
	this._start = start;
	this._end = end;
	this.end = end;
	this._parent = download;
	this._sessionbytes = 0;
}

Chunk.prototype = {
	running: false,
	get starter() {
		return this.end <= 0;
	},
	get start() {
		return this._start;
	},
	get end() {
		return this._end;
	},
	set end(nv) {
		this._end = nv;
		this._total = this._end - this._start + 1;
	},
	get total() {
		return this._total;
	},
	get written() {
		return this._written;
	},
	get safeBytes() {
		return this.written - this._buffered;
	},
	get remainder() {
		return this._total - this._written;
	},
	get complete() {
		if (this._end == -1) {
			return this.written != 0;
		}
		return this._total == this.written;
	},
	get parent() {
		return this._parent;
	},
	merge: function CH_merge(ch) {
		if (!this.complete && !ch.complete) {
			throw new Error("Cannot merge incomplete chunks this way!");
		}
		this.end = ch.end;
		this._written += ch._written;
	},
	open: function CH_open() {
		this._sessionBytes = 0;
		let file = this.parent.tmpFile;
		if (!file.parent.exists()) {
			file.parent.create(Ci.nsIFile.DIRECTORY_TYPE, Prefs.dirPermissions);
		}		
		let outStream = new FileOutputStream(file, 0x02 | 0x08, Prefs.permissions, 0);
		let seekable = outStream.QueryInterface(Ci.nsISeekableStream);
		seekable.seek(0x00, this.start + this.written);
		this._outStream = new BufferedOutputStream(outStream, CHUNK_BUFFER_SIZE);
		
		this.buckets = new ByteBucketTee(
				this.parent.bucket,
				Limits.getServerBucket(this.parent),
				GlobalBucket
				);
		this.buckets.register(this);
	},
	close: function CH_close() {
		this.running = false;
		if (this._outStream) {
			this._outStream.flush();
			this._outStream.close();
			delete this._outStream;
		}
		this._buffered = 0;
		if (this.parent.is(CANCELED)) {
			this.parent.removeTmpFile();
		}
		if (this.buckets) {
			this.buckets.unregister(this);
		}
		delete this._req;
		this._sessionBytes = 0;
	},
	rollback: function CH_rollback() {
		if (!this._sessionBytes || this._sessionBytes > this._written) {
			return;
		}
		this._written -= this._sessionBytes;
		this._sessionBytes = 0;
	},
	cancel: function CH_cancel() {
		this.running = false;
		this.close();
		if (this.download) {
			this.download.cancel();
		}
	},
	_wnd: 0,
	_written: 0,
	_outStream: null,
	write: function CH_write(aRequest, aInputStream, aCount) {
		try {
			// not running: do not write anything
			if (!this.running) {
				return 0;
			}
			if (!this._outStream) {
				this.open();
				this._wnd = 1024;
			}
			let bytes = this.remainder;
			if (!this.total || aCount < bytes) {
				bytes = aCount;
			}
			if (!bytes) {
				// we got what we wanted
				return -1;
			}
			bytes = Math.min(Math.round(this._wnd), bytes);
			let got = this.buckets.requestBytes(bytes);
			if (got < bytes) {
				this._wnd = Math.max(this._wnd * 0.5, 512);
				this._req = aRequest;
				this._req.suspend();
			}
			else {
				this._wnd += 256;
			}
			bytes = got;
			if (!bytes) {
				return bytes;
			}
			if (bytes < 0) {
				throw new Exception("bytes negative");
			}
			// we're using nsIFileOutputStream
			if (this._outStream.writeFrom(aInputStream, bytes) != bytes) {
				throw ("chunks::write: read/write count mismatch!");
			}
			this._written += bytes;
			this._sessionBytes += bytes;
			this._buffered = Math.min(CHUNK_BUFFER_SIZE, this._buffered + bytes);

			this.parent.timeLastProgress = Utils.getTimestamp();

			return bytes;
		}
		catch (ex) {
			Debug.log('write: ' + this.parent.tmpFile.path, ex);
			throw ex;
		}
		return 0;
	},
	observe: function() {
		if (!this._req) {
			return;
		}
		let req = this._req;
		delete this._req;
		req.resume();
	},
	toString: function() {
		let len = this.parent.totalSize ? String(this.parent.totalSize).length  : 10; 
		return Utils.formatNumber(this.start, len)
			+ "/"
			+ Utils.formatNumber(this.end, len)
			+ "/"
			+ Utils.formatNumber(this.total, len)
			+ " running:"
			+ this.running
			+ " written/remain:"
			+ Utils.formatNumber(this.written, len)
			+ "/"
			+ Utils.formatNumber(this.remainder, len);
	}
}

function Connection(d, c, isInfoGetter) {

	this.d = d;
	this.c = c;
	this.isInfoGetter = isInfoGetter;
	this.url = d.urlManager.getURL();
	let referrer = d.referrer;
	Debug.logString("starting: " + this.url.url.spec);

	this._chan = IOService.newChannelFromURI(this.url.url);
	let r = Ci.nsIRequest;
	let loadFlags = r.LOAD_NORMAL
	if (!Preferences.getExt('useCache', false)) {
		loadFlags = loadFlags | r.LOAD_BYPASS_CACHE;
	}
	else {
		Debug.logString("using cache");
	}
	this._chan.loadFlags = loadFlags;
	this._chan.notificationCallbacks = this;
	try {
		let encodedChannel = this._chan.QueryInterface(Ci.nsIEncodedChannel);
		encodedChannel.applyConversion = false;
	}
	catch (ex) {
		// no-op
	}
	if (this._chan instanceof Ci.nsIHttpChannel) {
		try {
			Debug.logString("http");
			let http = this._chan.QueryInterface(Ci.nsIHttpChannel);
			if (c.start + c.written > 0) {
				http.setRequestHeader('Range', 'bytes=' + (c.start + c.written) + "-", false);
			}
			if (this.isInfoGetter) {
				if (!d.fromMetalink) {
					http.setRequestHeader('Accept', 'application/metalink+xml;q=0.9', true);
				}
				http.setRequestHeader('Want-Digest', DTA.WANT_DIGEST_STRING, false);
			}
			if (referrer instanceof Ci.nsIURI) {
				http.referrer = referrer;
			}
			if (Prefs.noKeepAlive) {
				http.setRequestHeader('Keep-Alive', '', false);
				http.setRequestHeader('Connection', 'close', false);
			}
			if (d.postData) {
				let uc = http.QueryInterface(Ci.nsIUploadChannel);
				uc.setUploadStream(new StringInputStream(d.postData, d.postData.length), null, -1);
				http.requestMethod = 'POST';
			}			 
		}
		catch (ex) {
			Debug.log("error setting up http channel", ex);
			// no-op
		}
	}
	else if (this._chan instanceof Ci.nsIFTPChannel) {
		try {
			let ftp = this._chan.QueryInterface(Ci.nsIFTPChannel);
			if (c.start + c.written > 0) {
					let resumable = ftp.QueryInterface(Ci.nsIResumableChannel);
					resumable.resumeAt(c.start + c.written, '');
			}				
		}
		catch (ex) {
			Debug.log('error setting up ftp channel', ex);
		}
	}
	try {
		let prio = this._chan.QueryInterface(Ci.nsISupportsPriority);
		prio.adjustPriority(Ci.nsISupportsPriority.PRIORITY_LOW);
	}
	catch (ex) {
		Debug.log("Failed setting priority", ex);
	}
	this.c.running = true;
	this._chan.asyncOpen(this, null);
}

Connection.prototype = {
	_interfaces: [
		Ci.nsISupports,
		Ci.nsISupportsWeakReference,
		Ci.nsIWeakReference,
		Ci.nsICancelable,
		Ci.nsIInterfaceRequestor,
		Ci.nsIStreamListener,
		Ci.nsIRequestObserver,
		Ci.nsIProgressEventSink,
		Ci.nsIChannelEventSink,
		Ci.nsIFTPEventSink,
	],
	
	cantCount: false,

	QueryInterface: function DL_QI(iid) {
		if (this._interfaces.some(function(i) { return iid.equals(i); })) {
			return this;
		}
		Debug.log("Interface not implemented " + iid, Components.results.NS_ERROR_NO_INTERFACE);
		throw Components.results.NS_ERROR_NO_INTERFACE;
	},
	// nsISupportsWeakReference
	GetWeakReference: function DL_GWR() {
		return this;
	},
	// nsIWeakReference
	QueryReferent: function DL_QR(uuid) {
		return this.QueryInterface(uuid);
	},
	// nsICancelable
	cancel: function DL_cancel(aReason) {
		try {
			if (this._closed) {
				return;
			}
			Debug.logString("cancel");
			if (!aReason) {
				aReason = NS_ERROR_BINDING_ABORTED;
			}
			this._chan.cancel(aReason);
			this._closed = true;
		}
		catch (ex) {
			Debug.log("cancel", ex);
		}
	},
	// nsIInterfaceRequestor
	_notImplemented: [
		Ci.nsIDocShellTreeItem, // cookie same-origin checks
		Ci.nsIDOMWindow, // cookie same-origin checks
		Ci.nsIWebProgress, 
	],
	getInterface: function DL_getInterface(iid) {
		if (this._notImplemented.some(function(i) { return iid.equals(i); })) {
			// we don't want to implement these
			// and we don't want them to pop up in our logs
			throw Components.results.NS_ERROR_NO_INTERFACE;
		}
		if (iid.equals(Ci.nsIAuthPrompt)) {
			return AuthPrompts.authPrompter;
		}
		if (iid.equals(Ci.nsIPrompt)) {
			return AuthPrompts.prompter;
		}
		if ('nsIAuthPrompt2' in Ci && iid.equals(Ci.nsIAuthPrompt2)) {
			return AuthPrompts.authPrompter.QueryInterface(Ci.nsIAuthPrompt2);
		}
		try {
			return this.QueryInterface(iid);
		}
		catch (ex) {
			Debug.log("interface not implemented: " + iid, ex);
			throw ex;
		}
	},

	// nsIChannelEventSink
	onChannelRedirect: function DL_onChannelRedirect(oldChannel, newChannel, flags) {
		let c = this.c;
		try {
			if (!(oldChannel instanceof Ci.nsIChannel) || !(newChannel instanceof Ci.nsIChannel)) {
				throw new Exception("redirect: requests not channels");
			}
			
			// When we get redirected from, say, http to ftp, we need to explicitly
			// call resumeAt() as this won't be propagated from the old channel.
			if (c.start + c.written > 0 && !(newChannel instanceof Ci.nsIHttpChannel)) {
				let resumable = newChannel.QueryInterface(Ci.nsIResumableChannel);
				resumable.resumeAt(c.start + c.written, '');
				Debug.logString("redirect: set resumeAt on " + newChannel.URI.spec + "/" + newChannel.originalURI.spec + " at " + (c.start + c.written));
			}
		}
		catch (ex) {
			Debug.log("redirect: cannot resumeAt", ex);
			if (!this.handleError()) {
				d.fail(_('servererror'), _('ftperrortext'), _('servererror'));
				return;
			}
		}
			
		this._chan = newChannel;
		
		if (!this.isInfoGetter) {
			return;
		}
		try {
			let newurl = new DTA.URL(newChannel.URI.QueryInterface(Ci.nsIURL), this.url.preference);
			this.d.urlManager.replace(this.url, newurl);
			this.url = newurl;
			this.d.fileName = this.url.usable.getUsableFileName();
		}
		catch (ex) {
			Debug.log("Failed to reset data on channel redirect", ex);
		}
	},
	
	// nsIStreamListener
	onDataAvailable: function DL_onDataAvailable(aRequest, aContext, aInputStream, aOffset, aCount) {
		if (this._closed) {
			throw 0x804b0002; // NS_BINDING_ABORTED;
		}
		try {
			// we want to kill ftp chans as well which do not seem to respond to
			// cancel correctly.
			if (0 > this.c.write(aRequest, aInputStream, aCount)) {
				// we already got what we wanted
				this.cancel();
			}
		}
		catch (ex) {
			Debug.log('onDataAvailable', ex);
			this.d.fail(_("accesserror"), _("permissions") + " " + _("destpath") + ". " + _("checkperm"), _("accesserror"));
		}
	},
	
	// nsIFTPEventSink
	OnFTPControlLog: function(server, msg) {
		/*
		 * Very hacky :p If we don't handle it here, then nsIFTPChannel will + try
		 * to CWD to the file (d'oh) + afterwards ALERT (modally) that the CWD
		 * didn't succeed (double-d'oh)
		 */
		if (!server) {
			this._wasRetr = /^RETR/.test(msg) || /^REST/.test(msg);
		}
	},
	
	handleError: function DL_handleError() {
		let c = this.c;
		let d = this.d;
		
		c.cancel();
		d.dumpScoreboard();
		if (d.chunks.indexOf(c) == -1) {
			// already killed;
			return true;
		}

		Debug.logString("handleError: problem found; trying to recover");
		
		if (d.urlManager.markBad(this.url)) {
			Debug.logString("handleError: fresh urls available, kill this one and use another!");
			d.timeLastProgress = Utils.getTimestamp();
			return true;
		}
		
		Debug.logString("affected: " + c);
		d.dumpScoreboard();
		
		let max = -1, found = null;
		for each (let cmp in d.chunks) {
			if (!cmp.running) {
				continue;
			}
			if (cmp.start < c.start && cmp.start > max) {
				found = cmp;
				max = cmp.start;
			}
		}
		if (found) {
			Debug.logString("handleError: found joinable chunk; recovering suceeded, chunk: " + found);
			found.end = c.end;
			if (--d.maxChunks == 1) {
				// d.resumable = false;
			}
			d.chunks = d.chunks.filter(function(ch) ch != c);
			d.chunks.sort(function(a, b) a.start - b.start);
			
			// check for overlapping ranges we might have created
			// otherwise we'll receive a size mismatch
			// this means that we're gonna redownload an already finished chunk...
			for (let i = d.chunks.length - 2; i > -1; --i) {
				let c1 = d.chunks[i], c2 = d.chunks[i + 1];
				if (c1.end >= c2.end) {
					if (c2.running) {
						// should never ever happen :p
						d.dumpScoreboard();
						Debug.logString("overlapping:\n" + c1 + "\n" + c2);
						d.fail("Internal error", "Please notify the developers that there were 'overlapping chunks'!", "Internal error (please report)");
						return false;
					}
					d.chunks.splice(i + 1, 1);
				}
			}
			let ac = 0;
			d.chunks.forEach(function(c) { if (c.running) { ++ac;	}});
			d.activeChunks = ac;
			c.close();
			
			d.save();
			d.dumpScoreboard();
			return true;
		}
		Debug.logString("recovery failed");
		return false;
	},
	handleHttp: function DL_handleHttp(aChannel) {
		let c = this.c;
		let d = this.d;
		
		let code = 0, status = 'Server returned nothing';
		try {
			code = aChannel.responseStatus;
			status = aChannel.responseStatusText;
		}
		catch (ex) {
			return true;
		}
		 
		if (code >= 400) {
			// any data that we got over this channel should be considered "corrupt"
			c.rollback();
			
			if (c.starter && d.urlManager.markBad(this.url)) {
				Debug.log("caught bad server (Error: " + code + ")", d.toString());
				d.cancel();
				d.safeRetry();
				return false;
			}
			if (!this.handleError()) {
				Debug.log("handleError: Cannot recover from problem!", code);
				if ([401, 402, 407, 500, 502, 503, 504].indexOf(code) != -1 || Prefs.recoverAllHttpErrors) {
					Debug.log("we got temp failure!", code);
					Dialog.markAutoRetry(d);
					d.pause();
					d.status = code >= 500 ? _('temperror') : _('autherror');
				}
				else if (code == 450) {
					d.fail(
						_('pcerrortitle'),
						_('pcerrortext'),
						_('pcerrortitle')
					);
				}
				else {
					var file = d.fileName.length > 50 ? d.fileName.substring(0, 50) + "..." : d.fileName;
					code = Utils.formatNumber(code, 3);
					if (Prefs.resumeOnError) {
						Dialog.markAutoRetry(d);
						d.pause();
						d.status = _('temperror');
					}
					else {
						d.fail(
							_("error", [code]),
							_("failed", [file]) + " " + _("sra", [code]) + ": " + status,
							_("error", [code])
						);
					}
				}
				d.save();
			}
			return false;
		}

		// not partial content altough we are multi-chunk
		if (code != 206 && !this.isInfoGetter) {
			Debug.log(d + ": Server returned a " + aChannel.responseStatus + " response instead of 206", this.isInfoGetter);
			
			if (!this.handleError()) {
				vis = {value: '', visitHeader: function(a,b) { this.value += a + ': ' + b + "\n"; }};
				aChannel.visitRequestHeaders(vis);
				Debug.logString("Request Headers\n\n" + vis.value);
				vis.value = '';
				aChannel.visitResponseHeaders(vis);
				Debug.logString("Response Headers\n\n" + vis.value);
				d.cancel();
				d.resumable = false;
				d.safeRetry();
				return false;
			}
		}

		var visitor = null;
		try {
			visitor = d.visitors.visit(aChannel);
		}
		catch (ex) {
			Debug.log("header failed! " + d, ex);
			// restart download from the beginning
			d.cancel();
			d.resumable = false;
			d.safeRetry();
			return false;
		}
		
		if (!this.isInfoGetter) {
			return false;
		}

		if (visitor.type) {
			d.contentType = visitor.type;
		}

		// compression?
		if (['gzip', 'deflate'].indexOf(visitor.encoding) != -1 && !d.contentType.match(/gzip/i) && !d.fileName.match(/\.gz$/i)) {
			d.compression = visitor.encoding;
		}
		else {
			d.compression = null;
		}
		
		if (visitor.hash && (!d.hashCollection || !d.hashCollection.full || d.hashCollection.full.q < visitor.hash.q)) {
			d.hashCollection = new DTA.HashCollection(visitor.hash);
		}

		// accept range
		d.resumable &= visitor.acceptRanges;

		if (visitor.type && visitor.type.search(/application\/metalink\+xml/) != -1) {
			d.isMetalink = true;
			d.resumable = false;
		}

		if (visitor.contentLength > 0) {
			d.totalSize = visitor.contentLength;
		}
		else {
			d.totalSize = 0;
		}
		
		if (visitor.fileName && visitor.fileName.length > 0) {
			// if content disposition hasn't an extension we use extension of URL
			let newName = visitor.fileName.getUsableFileName();
			let ext = this.url.usable.getExtension();
			if (visitor.fileName.lastIndexOf('.') == -1 && ext) {
				newName += '.' + ext;
			}
			d.fileName = newName.getUsableFileName();
		}

		return false;
	},
	
	// Generic handler for now :p
	handleFtp: function  DL_handleFtp(aChannel) {
		let c = this.c;
		let d = this.d;
		try {
			let pb = aChannel.QueryInterface(Ci.nsIPropertyBag2);
			let totalSize = Math.max(pb.getPropertyAsInt64('content-length'), 0);
			if (d.totalSize && totalSize != this.totalSize && !this.handleError()) {
				Debug.logString("ftp: total size mismatch " + totalSize + " " + this.totalSize);
				d.fail(_('servererror'), _('ftperrortext'), _('servererror')); 
				return false;
			}
			Debug.logString("ftp: total size is: " + totalSize + " for: " + this.url);
			d.totalSize = totalSize;
		}
		catch (ex) {
			Debug.log("ftp: no totalsize", ex);
			if (c.start != 0 && !this.handleError()) {
				d.fail(_('servererror'), _('ftperrortext'), _('servererror')); 
				return false;
			}
			d.totalSize = 0;
			d.resumable = false;
		}
		
		try {
			aChannel.QueryInterface(Ci.nsIResumableChannel).entityID;
		}
		catch (ex) {
			Debug.logString("likely not resumable or connection refused!");
			if (!this.handleError()) {
				// restart download from the beginning
				d.fail(_('servererror'), _('ftperrortext'), _('servererror')); 
				return false;
			}
		}
		
		try {
			let visitor = d.visitors.visit(aChannel.QueryInterface(Ci.nsIChannel));
		}
		catch (ex) {
			Debug.log("header failed! " + d, ex);
			// restart download from the beginning
			d.cancel();
			d.resumable = false;
			d.safeRetry();
			return false;
		}
		return false;
	},
	
	handleGeneric: function DL_handleGeneric(aChannel) {
		var c = this.c;
		var d = this.d;
		
		// hack: determine if we are a multi-part chunk,
		// if so something bad happened, 'cause we aren't supposed to be multi-part
		if (c.start != 0 && d.is(RUNNING)) {
			if (!this.handleError()) {
				Debug.log(d + ": Server error or disconnection", "(type 1)");
				Dialog.markAutoRetry(d);
				d.status = _("servererror");
				d.pause();
			}
			return false;
		}			
			
		// try to get the size anyway ;)
		try {
			let pb = aChannel.QueryInterface(Ci.nsIPropertyBag2);
			d.totalSize = Math.max(pb.getPropertyAsInt64('content-length'), 0);
		}
		catch (ex) {
			try {
				d.totalSize = Math.max(aChannel.contentLength, 0);
			}
			catch (ex) {
				d.totalSize = 0;
			}
		}
		d.resumable = false;
		return false;
	},
	
	// nsIRequestObserver,
	_supportedChannels: [
		{i:Ci.nsIHttpChannel, f:'handleHttp'},
		{i:Ci.nsIFTPChannel, f:'handleFtp'},
		{i:Ci.nsIChannel, f:'handleGeneric'}
	],
	onStartRequest: function DL_onStartRequest(aRequest, aContext) {
		let c = this.c;
		let d = this.d;
		Debug.logString('StartRequest: ' + c);
	
		this.started = true;
		try {
			for each (let sc in this._supportedChannels) {
				let chan = null;
				try {
					chan = aRequest.QueryInterface(sc.i);
					if ((this.rexamine = this[sc.f](chan))) {
						 return;
					}
					break;
				}
				catch (ex) {
					// continue
				}
			}

			if (this.isInfoGetter) {
				if (d.fileName.getExtension() == 'metalink') {
					d.isMetalink = true;
					d.resumable = false;
				}				
				
				// Checks for available disk space.
				var tsd = d.totalSize;
				try {
					if (tsd) {
						let tmp = Prefs.tempLocation, vtmp = 0;
						if (tmp) {
							vtmp = Utils.validateDir(tmp);
							if (!vtmp && Utils.getFreeDisk(vtmp) < tsd) {
								d.fail(_("ndsa"), _("spacetemp"), _("freespace"));
								return;
							}
						}
						let realDest = Utils.validateDir(d.destinationPath);
						if (!realDest) {
							throw new Error("invalid destination folder");
						}
						var nsd = Utils.getFreeDisk(realDest);
						// Same save path or same disk (we assume that tmp.avail ==
						// dst.avail means same disk)
						// simply moving should succeed
						if (d.compression && (!tmp || Utils.getFreeDisk(vtmp) == nsd)) {
							// we cannot know how much space we will consume after
							// decompressing.
							// so we assume factor 1.0 for the compressed and factor 1.5 for
							// the decompressed file.
							tsd *= 2.5;
						}
						if (nsd < tsd) {
							Debug.logString("nsd: " +  nsd + ", tsd: " + tsd);
							d.fail(_("ndsa"), _("spacedir"), _("freespace"));
							return;
						}
					}
				}
				catch (ex) {
					Debug.log("size check threw", ex);
					d.fail(_("accesserror"), _("permissions") + " " + _("destpath") + ". " + _("checkperm"), _("accesserror"));
					return;
				}
				
				if (!d.totalSize) {
					d.resumable = false;					
					this.cantCount = true;
				}
				
				if (!d.resumable) {
					d.maxChunks = 1;
				}
				c.end = d.totalSize - 1;
				delete this.isInfoGetter;
				
				// Explicitly trigger rebuildDestination here, as we might have received
				// a html content type and need to rewrite the file
				d.rebuildDestination();
				ConflictManager.resolve(d);
			}
			
			if (d.resumable && !d.is(CANCELED)) {
				d.resumeDownload();
			}
		}
		catch (ex) {
			Debug.log("onStartRequest", ex);
		}
	},
	onStopRequest: function DL_onStopRequest(aRequest, aContext, aStatusCode) {
		try {
			Debug.logString('StopRequest');
		}
		catch (ex) {
			return;
		}
		
		// shortcuts
		let c = this.c;
		let d = this.d;
		c.close();
		
		if (d.chunks.indexOf(c) == -1) {
			return;
		}

		// update flags and counters
		d.refreshPartialSize();
		--d.activeChunks;

		// check if we're complete now
		if (d.is(RUNNING) && d.chunks.every(function(e) { return e.complete; })) {
			if (!d.resumeDownload()) {
				d.state = FINISHING;
				Debug.logString(d + ": Download is complete!");
				d.finishDownload();
				return;
			}
		}
		
		if (c.starter && -1 != [
			NS_ERROR_CONNECTION_REFUSED,
			NS_ERROR_UNKNOWN_HOST,
			NS_ERROR_NET_TIMEOUT,
			NS_ERROR_NET_RESET
		].indexOf(aStatusCode)) {
			if (!d.urlManager.markBad(this.url)) {
				Debug.log(d + ": Server error or disconnection", "(type 3)");
				Dialog.markAutoRetry(d);
				d.pause();
				d.status = _("servererror");
			}
			else {
				Debug.log("caught bad server", d.toString());
				d.cancel();
				d.safeRetry();
			}
			return;			
		}
		
		// work-around for ftp crap
		// nsiftpchan for some reason assumes that if RETR fails it is a directory
		// and tries to advance into said directory
		if (aStatusCode == NS_ERROR_FTP_CWD) {
			Debug.logString("Cannot change to directory :p", aStatusCode);
			if (!this.handleError()) {
				d.fail(_('servererror'), _('ftperrortext'), _('servererror'));
			}
			return;
		}
			
		// routine for normal chunk
		Debug.logString(this.url + ": Chunk " + c.start + "-" + c.end + " finished.");
		
		// rude way to determine disconnection: if connection is closed before
		// download is started we assume a server error/disconnection
		if (c.starter && d.is(RUNNING)) {
			if (!d.urlManager.markBad(this.url)) {
				Debug.log(d + ": Server error or disconnection", "(type 2)");
				Dialog.markAutoRetry(d);
				d.pause();
				d.status = _("servererror");
			}
			else {
				Debug.log("caught bad server", d.toString());
				d.cancel();
				d.safeRetry();
			}
			return;			
		}
		
		// Server did not return any data.
		// Try to mark the URL bad
		// else pause + autoretry
		if (!c.written  && !!c.remainder) {
			if (!d.urlManager.markBad(this.url)) {
				Debug.log(d + ": Server error or disconnection", "(type 1)");
				Dialog.markAutoRetry(d);
				d.pause();
				d.status = _("servererror");
			}
			return;
		}

		if (!d.isOf(PAUSED, CANCELED, FINISHING) && d.chunks.length == 1 && d.chunks[0] == c) {
			if (d.resumable || Prefs.resumeOnError) {
				Dialog.markAutoRetry(d);
				d.pause();
				d.status = _('errmismatchtitle');
			}
			else {
				d.fail(
					_('errmismatchtitle'),
					_('errmismatchtext', [d.partialSize, d.totalSize]),
					_('errmismatchtitle')
				);
			}
			return;			
		}
		if (!d.isOf(PAUSED, CANCELED)) {
			d.resumeDownload();
		}
	},

	// nsIProgressEventSink
  onProgress: function DL_onProgress(aRequest, aContext, aProgress, aProgressMax) {
		try {
			// shortcuts
			let c = this.c;
			let d = this.d;
			
			if (this.reexamine) {
				Debug.logString(d + ": reexamine");
				this.onStartRequest(aRequest, aContext);
				if (this.reexamine) {
					return;
				}
			}

			// update download tree row
			if (d.is(RUNNING)) {
				d.refreshPartialSize();

				if (!this.resumable && d.totalSize) {
					// basic integrity check
					if (d.partialSize > d.totalSize) {
						d.dumpScoreboard();
						Debug.logString(d + ": partialSize > totalSize" + "(" + d.partialSize + "/" + d.totalSize + "/" + ( d.partialSize - d.totalSize) + ")");
						d.fail(
							_('errmismatchtitle'),
							_('errmismatchtext', [d.partialSize, d.totalSize]),
							_('errmismatchtitle')
						);
						return;
					}
				}
				else {
					d.status = _("downloading");
				}
			}
		}
		catch(ex) {
			Debug.log("onProgressChange():", e);
		}
	},
	onStatus: function  DL_onStatus(aRequest, aContext, aStatus, aStatusArg) {}
};

function startDownloads(start, downloads) {

	var numbefore = Tree.rowCount - 1;
	
	let g = downloads;
	if ('length' in downloads) {
		g = (i for each (i in downloads));
	}

	let added = 0;
	let removeableTabs = {};
	Tree.beginUpdate();
	QueueStore.beginUpdate();
	for (let e in g) {
		let qi = new QueueItem();
		let lnk = e.url;
		if (typeof lnk == 'string') {
			qi.urlManager = new UrlManager([new DTA.URL(IOService.newURI(lnk, null, null))]);
		}
		else if (lnk instanceof UrlManager) {
			qi.urlManager = lnk;
		}
		else {
			qi.urlManager = new UrlManager([lnk]);
		}
		qi.numIstance = e.numIstance;
	
		if (e.referrer) {
			try {
				qi.referrer = e.referrer.toURL();
			}
			catch (ex) {
				// We might have been fed with about:blank or other crap. so ignore.
			}
		}
		// only access the setter of the last so that we don't generate stuff trice.
		qi._pathName = e.dirSave.addFinalSlash().toString();
		qi._description = !!e.description ? e.description : '';
		qi._title = !!e.title ? e.title : '';
		qi._mask = e.mask;
		qi.fromMetalink = !!e.fromMetalink;
		qi.fileName = qi.urlManager.usable.getUsableFileName();
		if (e.fileName) {
			qi.fileName = e.fileName.getUsableFileName();
		}
		if (e.destinationName) {
			qi.destinationName = e.destinationName.getUsableFileName();
		}
		if (e.startDate) {
			qi.startDate = e.startDate;
		}
		
		// hash?
		if (e.hashCollection) {
			qi.hashCollection = e.hashCollection;
		}
		else if (e.url.hashCollection) {
			qi.hashCollection = e.url.hashCollection;
		}
		else if (e.hash) {
			qi.hashCollection = new DTA.HashCollection(e.hash);
		}
		else if (e.url.hash) {
			qi.hashCollection = new DTA.HashCollection(e.url.hash);
		}
		else {
			qi.hashCollection = null; // to initialize prettyHash
		}

		let postData = ContentHandling.getPostDataFor(qi.urlManager.url);
		if (e.url.postData) {
			postData = e.url.postData;
		}
		if (postData) {
			qi.postData = postData;
		}		

		qi.state = start ? QUEUED : PAUSED;
		if (qi.is(QUEUED)) {
			qi.status = TEXT_QUEUED;
		}
		else {
			qi.status = TEXT_PAUSED;
		}
		qi._position = Tree.add(qi);
		qi.save();		
		++added;
	}
	QueueStore.endUpdate();
	Tree.endUpdate();

	var boxobject = Tree._box;
	boxobject.QueryInterface(Ci.nsITreeBoxObject);
	if (added <= boxobject.getPageLength()) {
		boxobject.scrollToRow(Tree.rowCount - boxobject.getPageLength());
	}
	else {
		boxobject.scrollToRow(numbefore);
	}
}

var ConflictManager = {
	_items: [],
	resolve: function CM_resolve(download, reentry) {
		if (!this._check(download)) {
			if (reentry) {
				download[reentry]();
			}
			return;
		}
		for each (let item in this._items.length) {
			if (item.download == download) {
				Debug.logString("conflict resolution updated to: " + reentry);
				item.reentry = reentry;
				return;
			}
		}
		Debug.logString("conflict resolution queued to: " + reentry);
		this._items.push({download: download, reentry: reentry});
		this._process();
	},
	_check: function CM__check(download) {
		let dest = new FileFactory(download.destinationFile);
		let sn = false;
		if (download.is(RUNNING)) {
			sn = Dialog.checkSameName(download, download.destinationFile);
		}
		Debug.logString("conflict check: " + sn + "/" + dest.exists() + " for " + download.destinationFile);
		return dest.exists() || sn;
	},
	_process: function CM__process() {
		if (this._processing) {
			return;
		}
		let cur;
		while (this._items.length) {
			cur = this._items[0];
			if (!this._check(cur.download)) {
				if (cur.reentry) {
					cur.download[cur.reentry]();
				}
				this._items.shift();
				continue;
			}
			break;
		}
		if (!this._items.length) {
			return;
		}
	
		if (Prefs.conflictResolution != 3) {
			this._return(Prefs.conflictResolution);
			return;
		}
		if ('_sessionSetting' in this) {
			this._return(this._sessionSetting);
			return;
		}
		if (cur.download.shouldOverwrite) {
			this._return(1);
			return;
		}
		
		this._computeConflicts(cur);

		var options = {
			url: cur.download.urlManager.usable.cropCenter(45),
			fn: cur.download.destinationName.cropCenter(45),
			newDest: cur.newDest.cropCenter(45)
		};
		
		this._processing = true;
		
		window.openDialog(
			"chrome://dta/content/dta/manager/conflicts.xul",
			"_blank",
			"chrome,centerscreen,resizable=no,dialog,close=no,dependent",
			options, this
		);
	},
	_computeConflicts: function CM__computeConflicts(cur) {
		let download = cur.download;
		download.conflicts = 0;
		let basename = download.destinationName;
		let newDest = new FileFactory(download.destinationFile);
		let i = 1;
		for (;; ++i) {
			newDest.leafName = Utils.formatConflictName(basename, i);
			if (!newDest.exists() && (!download.is(RUNNING) || !Dialog.checkSameName(this, newDest.path))) {
				break;
			}
		}
		cur.newDest = newDest.leafName;
		cur.conflicts = i;	
	},
	_returnFromDialog: function CM__returnFromDialog(option, type) {
		if (type == 1) {
			this._sessionSetting = option;
		}
		if (type == 2) {
			Preferences.setExt('conflictresolution', option);
		}		
		this._return(option);
	},
	_return: function CM__return(option) {
		let cur = this._items[0];
		switch (option) {
			/* rename */    case 0: this._computeConflicts(cur); cur.download.conflicts = cur.conflicts; break;
			/* overwrite */ case 1: cur.download.shouldOverwrite = true; break;
			/* skip */      default: cur.download.cancel(_('skipped')); break;
		}
		if (cur.reentry) {
			cur.download[cur.reentry]();
		}
		this._items.shift();
		this._processing = false;
		this._process();
	}
};

addEventListener(
	"load",
	function() {
		removeEventListener("load", arguments.callee, false);
		if (!Preferences.getExt('startminimized', false)) {
			return;
		}
		// Only start minimized if invoked with new downloads
		if (!window.arguments || !window.arguments.length) {
			return;
		}
		setTimeout(
			function() {
				try {
					window.QueryInterface(Ci.nsIDOMChromeWindow).minimize();
					if (window.opener) {
						window.opener.focus();
					}
				}
				catch (ex) {
				}
			},
			0
		);
	},
	false
);
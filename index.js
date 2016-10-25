'use strict';

var browserifyBundleFn = arguments[3];
var browserifySources = arguments[4];
var browserifyCache = arguments[5];

module.exports = createWorkerPool;

function nativeWorkerFn(self) {
    var workersidePooledWorkers = {};

    function send(type, data) {
        self.postMessage({
            type: type,
            data: data,
            workerId: this.workerId
        });
    }

    function createWorkersidePooledWorker(moduleId, workerId) {
        var WorkerClass = self.require(moduleId);

        function Worker() {
            WorkerClass.call(this);
        }
        Worker.prototype = Object.create(WorkerClass.prototype);
        if (Worker.prototype.send) {
            throw new Error('Pooled worker class should not have a send property.');
        }
        if (Worker.prototype.workerId) {
            throw new Error('Pooled worker class should not have a workerId property.');
        }
        Worker.prototype.send = send;
        Worker.prototype.workerId = workerId;

        workersidePooledWorkers[workerId] = new Worker();
    }

    self.onmessage = function (e) {
        var data = e.data;
        var worker;

        if (data.bundle) { // add missing dependencies
            self.importScripts(data.bundle);
            URL.revokeObjectURL(data.bundle); // the url won't be needed after importing
        }
        if (data.moduleId) { // create workerside pooled worker
            createWorkersidePooledWorker(data.moduleId, data.workerId);
        }
        if (data.type) { // process message to the worker
            worker = workersidePooledWorkers[data.workerId];
            if (worker.onmessage) {
                worker.onmessage(data.type, data.data);
            }
        }
        if (data.terminate) { // terminate the worker
            worker = workersidePooledWorkers[data.workerId];
            delete workersidePooledWorkers[data.workerId];
            if (worker.onterminate) {
                worker.onterminate();
            }
        }
    };
}

function createWorkerPool(workerCount) {
    var pooledWorkers = {}; // a pool-wide set of PooledWorker instances
    var nativeWorkers = []; // a pool of native web workers
    var nativeWorkerSources = []; // a set of module deps every native worker already has
    var lastWorkerId = 0;

    workerCount = workerCount || 4;

    function PooledWorker(moduleFn) {
        if (nativeWorkers.length === 0) {
            createNativeWorkers(workerCount);
        }

        this.id = lastWorkerId++;
        pooledWorkers[this.id] = this;

        var moduleId = findModuleId(moduleFn);

        // pick one of the native workers
        var nativeWorkerIndex = this.id % workerCount;
        this.worker = nativeWorkers[nativeWorkerIndex];

        // broadcast bundle changes to the native worker
        broadcastBundle(moduleId, nativeWorkerSources[nativeWorkerIndex], this.worker);

        // create workerside pooled worker
        this.worker.postMessage({
            workerId: this.id,
            moduleId: moduleId
        });
    }

    PooledWorker.prototype = {

        send: function (type, data) {
            this.worker.postMessage({
                workerId: this.id,
                type: type,
                data: data
            });
        },

        terminate: function () {
            this.worker.postMessage({
                workerId: this.id,
                terminate: true
            });
            delete pooledWorkers[this.id];
        }
    };

    function createNativeWorkers() {
        var nativeWorkerUrl = createURL('(' + nativeWorkerFn + ')(self)');

        for (var i = 0; i < workerCount; i++) {
            var nativeWorker = new Worker(nativeWorkerUrl);
            nativeWorker.onmessage = handleWorkerMessage;
            nativeWorkers.push(nativeWorker);
            nativeWorkerSources.push({});
        }
    }

    function handleWorkerMessage(e) {
        var worker = pooledWorkers[e.data.workerId];
        if (worker) {
            worker.onmessage(e.data.type, e.data.data);
        }
    }

    return PooledWorker;
}

// make a blob URL out of any worker bundle additions and propagate it to the native worker
function broadcastBundle(moduleId, workerSources, nativeWorker) {
    var addedSources = {};
    resolveSources(workerSources, addedSources, moduleId);
    var deps = Object.keys(addedSources);

    if (deps.length) {
        var src = generateWorkerBundle(deps);
        var url = createURL(src);

        nativeWorker.postMessage({bundle: url});
    }
}

// find the Browserify id of the required module
function findModuleId(moduleFn) {
    for (var id in browserifyCache) {
        if (browserifyCache[id].exports === moduleFn) {
            return id;
        }
    }
    throw new Error('Module not found in Browserify bundle.');
}

// generate a bundle from a set of Browserify deps
function generateWorkerBundle(deps) {
    return 'self.require=(' + browserifyBundleFn + ')({' + deps.map(function (key) {
        var source = browserifySources[key];
        return JSON.stringify(key) + ':[' + source[0] + ',' + JSON.stringify(source[1]) + ']';
    }).join(',') + '},{},[])';
}

// resolve Browserify deps and find all modules that are not yet on the worker side
function resolveSources(workerSources, addedSources, key) {
    if (workerSources[key]) return;

    workerSources[key] = true;
    addedSources[key] = true;

    var deps = browserifySources[key][1];
    for (var depPath in deps) {
        resolveSources(workerSources, addedSources, deps[depPath]);
    }
}

// create an Blob object URL from code
function createURL(src) {
    var URL = window.URL || window.webkitURL;
    var blob = new Blob([src], {type: 'text/javascript'});
    return URL.createObjectURL(blob);
}

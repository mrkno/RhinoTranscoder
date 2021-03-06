const path = require('path');
const request = require('request');
const childProcess = require('child_process');
const pad = require('../utils/pad');
const sleep = require('../utils/sleep');
const { deleteDirectory, fileExists, mkdir } = require('../utils/files');

class Transcoder {
    constructor(config, websocket, universal, sessionId, req, streamOffset) {
        this._alive = true;
        this._ffmpeg = null;
        this._transcoding = true;
        this._sessionId = sessionId;
        this._timeout = null;
        this._sessionTimeout = null;
        this._streamOffset = streamOffset;
        this._transcoderArgs = null;
        this._transcoderEnv = null;
        this._plexRequest = null;
        this._config = config;
        this._ws = websocket;
        this._universal = universal;

        this._plexTranscoderDir = this._config.plex.transcoder;
        this._plexTranscoderCache = path.join(this._plexTranscoderDir, 'Cache');
        this._plexTranscoderResources = path.join(this._config.plex.transcoderResources || this._plexTranscoderDir, 'Resources');
        this._plexTranscoderBinaries = path.join(this._config.plex.transcoderBin || this._plexTranscoderResources, 'Plex Transcoder');
        const exeName = this._config.plex.transcoderExe || (process.platform === 'win32' ? 'PlexTranscoder.exe' : 'Plex Transcoder');
        this._plexTranscoderBinaries = path.join(this._config.plex.transcoderBin || this._plexTranscoderResources, exeName);
        this._init(req);
    }

    async _init(req) {
        if (req !== void (0) && this._streamOffset === void(0)) {
            console.log(`Create session ${this._sessionId}`);
            this._timeout = setTimeout(this._pmsTimeout.bind(this), 20000);

            this._ws.once(`session-${this._sessionId}`, async () => {
                console.log(`Callback ${this._sessionId}`);
                clearTimeout(this._timeout);
                this._timeout = null;
                await this._ws.updateKey(`${this._sessionId}:last`, 0);
                const session = await this._ws.getByKey(this._sessionId);
                await this._transcoderStarter(session);
            });

            this._plexRequest = request(`${this._config.server.loadBalancer}/${req.url}`, err => console.error(err));
        }
        else {
            console.log(`Restarting session ${this._sessionId}`);
            await this._ws.updateKey(`${this._sessionId}:last`, 0);
            const session = await this._ws.getByKey(this._sessionId);
            await this._transcoderStarter(session);
        }
    }

    async _transcoderStarter(reply) {
        let keys = await this._ws.getByKeyPattern(`${this._sessionId}:*`);
        if (keys !== void (0)) {
            keys = keys.filter(k => !k.endsWith('last'));
            if (keys.length > 0) {
                await this._ws.deleteKeys(keys);
            }
        }
        const sessionCache = path.join(this._plexTranscoderCache, this._sessionId);
        await deleteDirectory(sessionCache);
        try {
            await mkdir(sessionCache);
        }
        catch (e) {
            console.error(`Cannot create transcoder cache directory (${sessionCache}).`);
            process.exit(-4);
        }

        if (!reply) {
            console.log(reply);
            return;
        }

        this._transcoderArgs = reply.args.map(arg => arg
            .replace('{URL}', `http://127.0.0.1:${this._config.server.port}`)
            .replace('{SEGURL}', `http://127.0.0.1:${this._config.server.port}`)
            .replace('{PROGRESSURL}', this._config.server.loadBalancer)
            .replace('{PATH}', this._config.plex.mount)
            .replace('{SRTSRV}', `${this._config.server.loadBalancer}/rhino/sessions`)
            .replace(/\{USRPLEX\}/g, this._plexTranscoderResources));

        if (this._chunkOffset !== void (0) || this._streamOffset !== void (0)) {
            this._patchArgs(this._chunkOffset);
        }

        this._transcoderEnv = Object.create(process.env);
        this._transcoderEnv.LD_LIBRARY_PATH = this._plexTranscoderDir;
        this._transcoderEnv.FFMPEG_EXTERNAL_LIBS = path.join(this._plexTranscoderDir, 'Codecs/');
        this._transcoderEnv.XDG_CACHE_HOME = this._plexTranscoderCache;
        this._transcoderEnv.XDG_DATA_HOME = path.join(this._plexTranscoderResources, 'Resources/');
        this._transcoderEnv.EAE_ROOT = this._plexTranscoderCache;
        this._transcoderEnv.X_PLEX_TOKEN = reply.env.X_PLEX_TOKEN;

        await this._startFFMPEG();
    }

    async _startFFMPEG() {
        if (!(await fileExists(this._plexTranscoderBinaries))) {
            console.error('Cannot find Plex ffmpeg binaries.');
            process.exit(-3);
        }

        console.log(`Spawn ${this._sessionId}`);
        this._transcoding = true;
        try {
            this._ffmpeg = childProcess.spawn(this._plexTranscoderBinaries, this._transcoderArgs, {
                env: this._transcoderEnv,
                cwd: path.join(this._plexTranscoderCache, this._sessionId)
            });
            this._ffmpeg.on('exit', () => {
                console.log(`FFMPEG stopped ${this._sessionId}`);
                this._transcoding = false;
            });
            await this._updateLastChunk();
        }
        catch (e) {
            console.log(`Failed to start FFMPEG for session ${this._sessionId}`);
            console.log(e.toString());
        }
    }

    async _pmsTimeout() {
        console.log(`Timeout ${this._sessionId}`);
        this._timeout = null;
        await this.killInstance();
    }

    async _cleanFiles(fullClean) {
        await deleteDirectory(path.join(this._plexTranscoderCache, this._sessionId));
        const keys = await this._ws.getByKeyPattern(this._sessionId + (fullClean ? '*' : ':*'));
        if ((keys !== void (0)) && keys.length > 0) {
            await this._ws.deleteKeys.del(keys);
        }
        this._universal.deleteCache(this._sessionId);
    }

    async killInstance(fullClean = false) {
        console.log(`Killing ${this._sessionId}`);
        this._alive = false;

        if (this._plexRequest !== void(0) && this._plexRequest !== null) {
            this._plexRequest.abort();
        }

        if (this._timeout !== null) {
            clearTimeout(this._timeout);
        }

        if (this._sessionTimeout !== void (0)) {
            clearTimeout(this._sessionTimeout);
        }

        if (this._ffmpeg !== null && this._transcoding) {
            this._ffmpeg.kill('SIGKILL');
            await sleep(500);
        }
        await this._cleanFiles(fullClean);
    }

    async _updateLastChunk() {
        let last = 0;
        let prev = null;

        for (let i = 0; i < this._transcoderArgs.length; i++) {
            if (prev === '-segment_start_number' || prev === '-skip_to_segment') {
                last = parseInt(this._transcoderArgs[i]);
                break;
            }
            prev = this._transcoderArgs[i];
        }

        await this._ws.updateKey(`${this._sessionId}:last`, (last > 0 ? last - 1 : last));
    }

    _patchArgs(chunkId) {
        if (this._transcoderArgs.includes('chunk-%05d')) {
            console.log('Patching long polling SS');
            this._patchSS(this._streamOffset);
            return;
        }

        console.log(`jumping to segment ${chunkId} for ${this._sessionId}`);

        let prev = '';
        for (let i = 0; i < this._transcoderArgs.length; i++) {
            if (prev === '-segment_start_number' || prev === '-skip_to_segment') {
                this._transcoderArgs[i] = parseInt(chunkId);
                break;
            }
            prev = this._transcoderArgs[i];
        }

        prev = '';
        let offset = 0;
        let segmentDuration = 5;
        for (let i = 0; i < this._transcoderArgs.length; i++) {
            if (prev === '-segment_time') {
                segmentDuration = this._transcoderArgs[i];
                break;
            }
            if (prev === '-min_seg_duration') {
                offset = -1;
                segmentDuration = this._transcoderArgs[i] / 1000000;
                break;
            }
            prev = this._transcoderArgs[i];
        }

        prev = '';
        for (let i = 0; i < this._transcoderArgs.length; i++) {
            if (prev.toString().startsWith('-force_key_frames')) {
                this._transcoderArgs[i] = `expr:gte(t,${(parseInt(chunkId) + offset) * segmentDuration}+n_forced*${segmentDuration})`;
            }
            prev = this._transcoderArgs[i];
        }

        if (this._transcoderArgs.indexOf('-vsync') !== -1) {
            this._transcoderArgs.splice(this._transcoderArgs.indexOf('-vsync'), 2);
        }

        this._patchSS((parseInt(chunkId) + offset) * segmentDuration);
    }

    _patchSS(time, accurate) {
        let prev = '';

        if (this._transcoderArgs.indexOf('-ss') === -1) {
            if (accurate) {
                this._transcoderArgs.splice(this._transcoderArgs.indexOf('-i'), 0, '-ss', time, '-noaccurate_seek');
            }
            else {
                this._transcoderArgs.splice(this._transcoderArgs.indexOf('-i'), 0, '-ss', time);
            }
        }
        else {
            prev = '';
            for (let i = 0; i < this._transcoderArgs.length; i++) {
                if (prev === '-ss') {
                    this._transcoderArgs[i] = time;
                    break;
                }
                prev = this._transcoderArgs[i];
            }
        }
    }

    async _segmentJumper(chunkId, streamId) {
        const chunkIdNum = parseInt(chunkId);
        const key = `${this._sessionId}:last`;
        try {
            const last = await this._ws.getByKey(key);
            const lastNum = parseInt(last);
            if (last === null || lastNum > chunkIdNum || lastNum < chunkIdNum - 10) {
                throw new Error();
            }
            await this._waitChunk(chunkId, streamId);
        }
        catch (e) {
            this._ws.updateKey(key, chunkId);

            if (this._ffmpeg !== null) {
                this._ffmpeg.removeAllListeners('exit');
                this._ffmpeg.kill('SIGKILL');

                this._patchArgs(chunkId);
                await this._startFFMPEG();
            }
            else {
                this._chunkOffset = chunkIdNum;
            }
        }
    }

    async getChunk(chunkId, streamId = '0', noJump = false) {
        const chunk = await this._ws.getByKey(`${this._sessionId}:${streamId}:${chunkId === 'init' ? chunkId : pad(chunkId, 5)}`);
        if (chunk === null) {
            if (streamId === '0' && noJump === false) {
                await this._segmentJumper(chunkId, streamId);
            }
            else {
                await this._waitChunk(chunkId, streamId);
            }
            return null;
        }
        else {
            return this._alive ? chunkId : -1;
        }
    }

    _waitChunk(chunkId, streamId) {
        return new Promise(resolve => {
            if (this._transcoding) {
                const timeout = setTimeout(() => resolve(this._alive ? -2 : -1), 10000);
                const handler = data => {
                    if (data.streamId === streamId && data.chunkId === chunkId === 'init' ? chunkId : pad(chunkId, 5)) {
                        clearTimeout(timeout);
                        resolve(this._alive ? chunkId : -1);
                    }
                    else {
                        this._ws.once(`session-${this._sessionId}`, handler);
                    }
                };
                this._ws.once(`session-${this._sessionId}`, handler);
            }
            else {
                resolve(-1);
            }
        });
    }
}

module.exports = Transcoder;

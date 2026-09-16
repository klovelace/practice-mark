(() => {
  if (window.__practiceMarkLoaded) return;
  window.__practiceMarkLoaded = true;

  const STORAGE_PREFIX = 'pm_video_';
  const SETTINGS_KEY = 'pm_settings';
  const ENGAGEMENT_KEY = 'pm_engagement';
  const CHROME_WEB_STORE_SLUG = 'practice-mark-for-youtube';
  const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  const state = {
    videoId: null,
    marks: [],
    loops: [],
    activeLoopId: null,
    looping: false,
    panelVisible: true,
    recognition: null,
    listening: false,
    lastTranscript: '',
    voiceMode: 'cloud',
    voiceStartPending: false,
    voiceRecognizing: false,
    voiceRetryCount: 0,
    voiceRestartTimer: null,
    voiceHealthTimer: null,
    voiceLastSignalAt: 0,
    voiceWatchdogRestarting: false,
    voiceWatchdogRestarts: 0,
    voicePreparing: false,
    voiceWakeUntil: 0,
    voiceWakeTimer: null,
    voiceDuckPreviousVolume: null,
    voicePhrasesEnabled: false,
    voiceGeneration: 0,
    voiceRecognitionSnapshot: { recognitionId: null, cycle: 0, seenIndexes: new Set() },
    voiceCancelPending: null,
    voiceDuckVideo: null,
    voiceHistory: [],
    voiceLog: new PMVoiceSessionLog({ product: 'Practice Mark', version: chrome.runtime.getManifest().version }),
    suspendPersistence: false,
    settings: { preRoll: 0 },
    engagement: { uses: 0, marks: 0, reviewPromptShown: false },
    engagementSessionCounted: false,
    reviewPromptVisible: false
  };

  let root;
  let toastEl;
  let timeTimer;
  let loopTimer;
  let lastUrl = location.href;
  let lastRenderedActiveLoopId = null;
  let engagementReady = null;

  function getVideo() {
    return document.querySelector('video.html5-main-video') || document.querySelector('video');
  }

  function getVideoId() {
    const url = new URL(location.href);
    if (url.pathname === '/watch') return url.searchParams.get('v');
    if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/')[2] || null;
    return null;
  }

  function uid(prefix) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  function fmt(seconds) {
    if (seconds == null || Number.isNaN(seconds)) return '--:--';
    seconds = Math.max(0, seconds);
    const whole = Math.floor(seconds);
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = whole % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[c]));
  }

  function storageKey() {
    return state.videoId ? STORAGE_PREFIX + state.videoId : null;
  }

  function getMark(id) {
    return state.marks.find(mark => mark.id === id) || null;
  }

  function markIndex(id) {
    const index = state.marks.findIndex(mark => mark.id === id);
    return index >= 0 ? index + 1 : null;
  }

  function getLoop(id) {
    return state.loops.find(loop => loop.id === id) || null;
  }

  function loopIndex(id) {
    const index = state.loops.findIndex(loop => loop.id === id);
    return index >= 0 ? index + 1 : null;
  }

  function activeLoop() {
    return getLoop(state.activeLoopId);
  }

  function loopRange(loop) {
    if (!loop) return null;
    const start = getMark(loop.startMarkId);
    const end = getMark(loop.endMarkId);
    if (!start || !end) return null;
    return { start: start.time, end: end.time, startMark: start, endMark: end };
  }

  function isValidLoop(loop) {
    const range = loopRange(loop);
    return !!range && range.end > range.start + 0.05;
  }

  function completeLoops() {
    return state.loops.filter(isValidLoop);
  }

  function defaultLoopName(loop) {
    return `Loop ${loopIndex(loop.id) || '?'}`;
  }

  function displayLoopName(loop) {
    return (loop?.name || '').trim() || defaultLoopName(loop);
  }

  function migrateSavedState(saved) {
    const marks = Array.isArray(saved.marks) ? saved.marks.slice() : [];
    marks.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    let loops = Array.isArray(saved.loops) ? saved.loops.slice() : [];
    let activeLoopId = saved.activeLoopId || null;

    // Migrate v0.1/v0.2 global A/B points into real marks + a loop.
    if (!loops.length && typeof saved.start === 'number') {
      let startMark = marks.find(m => Math.abs(Number(m.time) - saved.start) < 0.08);
      if (!startMark) {
        startMark = { id: uid('mark'), time: saved.start, createdAt: Date.now() - 2, legacy: true };
        marks.push(startMark);
      }
      let endMark = null;
      if (typeof saved.end === 'number') {
        endMark = marks.find(m => Math.abs(Number(m.time) - saved.end) < 0.08);
        if (!endMark) {
          endMark = { id: uid('mark'), time: saved.end, createdAt: Date.now() - 1, legacy: true };
          marks.push(endMark);
        }
      }
      loops = [{
        id: uid('loop'),
        name: '',
        startMarkId: startMark.id,
        endMarkId: endMark?.id || null,
        playbackRate: 1,
        createdAt: Date.now()
      }];
      activeLoopId = loops[0].id;
    }

    marks.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    loops = loops.map(loop => ({
      id: loop.id || uid('loop'),
      name: typeof loop.name === 'string' ? loop.name : '',
      startMarkId: loop.startMarkId || null,
      endMarkId: loop.endMarkId || null,
      playbackRate: Number(loop.playbackRate) || 1,
      createdAt: loop.createdAt || Date.now()
    }));

    return { marks, loops, activeLoopId };
  }

  async function loadStateForVideo() {
    voiceLog('video_navigation', { nextVideoId: getVideoId() });
    clearPracticeWake();
    state.voiceCancelPending?.();
    state.videoId = getVideoId();
    state.looping = false;
    state.activeLoopId = null;

    if (!state.videoId) {
      state.marks = [];
      state.loops = [];
      render();
      return;
    }

    const key = storageKey();
    const result = await chrome.storage.local.get([key, SETTINGS_KEY]);
    const saved = result[key] || {};
    const migrated = migrateSavedState(saved);
    state.marks = migrated.marks;
    state.loops = migrated.loops;
    state.activeLoopId = migrated.activeLoopId && getLoop(migrated.activeLoopId)
      ? migrated.activeLoopId
      : (completeLoops().at(-1)?.id || state.loops.at(-1)?.id || null);
    state.settings = { preRoll: 0, ...(result[SETTINGS_KEY] || {}) };

    await ensureEngagementSession();
    await saveVideoState();
    render();
    refreshRecognitionPhrases();
  }

  async function saveVideoState() {
    if (state.suspendPersistence) return;
    const key = storageKey();
    if (!key) return;
    await chrome.storage.local.set({
      [key]: {
        version: 3,
        marks: state.marks,
        loops: state.loops,
        activeLoopId: state.activeLoopId,
        updatedAt: Date.now()
      }
    });
  }

  async function loadEngagement() {
    if (!engagementReady) {
      engagementReady = (async () => {
        const result = await chrome.storage.local.get(ENGAGEMENT_KEY);
        state.engagement = { uses: 0, marks: 0, reviewPromptShown: false, ...(result[ENGAGEMENT_KEY] || {}) };
        return state.engagement;
      })();
    }
    return engagementReady;
  }

  async function saveEngagement() {
    await chrome.storage.local.set({ [ENGAGEMENT_KEY]: state.engagement });
  }

  async function ensureEngagementSession() {
    if (!state.videoId || state.engagementSessionCounted) return;
    await loadEngagement();
    if (state.engagementSessionCounted) return;
    state.engagementSessionCounted = true;
    state.engagement.uses = Math.max(0, Number(state.engagement.uses) || 0) + 1;
    state.engagement.lastUseAt = Date.now();
    await saveEngagement();
  }

  async function recordEngagementMark() {
    await loadEngagement();
    state.engagement.marks = Math.max(0, Number(state.engagement.marks) || 0) + 1;
    state.engagement.lastMarkAt = Date.now();
    await saveEngagement();
    await maybeShowReviewPrompt();
  }

  function chromeWebStoreUrl() {
    return `https://chromewebstore.google.com/detail/${CHROME_WEB_STORE_SLUG}/${chrome.runtime.id}`;
  }

  async function maybeShowReviewPrompt() {
    await loadEngagement();
    if (state.reviewPromptVisible || state.engagement.reviewPromptShown) return false;
    if ((Number(state.engagement.uses) || 0) < 2 || (Number(state.engagement.marks) || 0) < 2) return false;

    // One lifetime impression: once it appears, it never nags the user again.
    state.engagement.reviewPromptShown = true;
    state.engagement.reviewPromptShownAt = Date.now();
    state.reviewPromptVisible = true;
    await saveEngagement();
    renderReviewPrompt();
    return true;
  }

  function renderReviewPrompt() {
    const slot = root?.querySelector('.pm-review-slot');
    if (!slot) return;
    if (!state.reviewPromptVisible) {
      slot.innerHTML = '';
      slot.classList.add('pm-hidden');
      return;
    }
    slot.classList.remove('pm-hidden');
    slot.innerHTML = `
      <div class="pm-review-card">
        <button class="pm-review-close" data-action="dismiss-review" aria-label="Dismiss review request">×</button>
        <div class="pm-review-stars">★★★★★</div>
        <div class="pm-review-copy"><strong>Enjoying Practice Mark?</strong><span>If this extension saved you time, a quick review would really help.</span></div>
        <button class="pm-mini-btn primary pm-review-button" data-action="rate-extension">Rate us on Chrome</button>
      </div>`;
  }

  function dismissReviewPrompt() {
    state.reviewPromptVisible = false;
    renderReviewPrompt();
  }

  function openReviewPage() {
    const url = chromeWebStoreUrl();
    try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (_) { location.href = url; }
    dismissReviewPrompt();
  }

  function currentTime() {
    return getVideo()?.currentTime ?? null;
  }

  function seek(time, autoplay = true) {
    const video = getVideo();
    if (!video || typeof time !== 'number') return false;
    video.currentTime = Math.max(0, time);
    if (autoplay) video.play().catch(() => {});
    updateTimeUI();
    return true;
  }

  function toast(text) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastEl._hideTimer);
    toastEl._hideTimer = setTimeout(() => toastEl.classList.remove('show'), 1500);
  }

  function status(text, kind = '') {
    if (kind === 'warn') voiceLog('notice', { message: text });
    if (kind === 'warn' && state.listening) recordVoiceHistory({ transcript: '', command: 'Notice', outcome: text });
    const el = root?.querySelector('.pm-status');
    if (!el) return;
    el.textContent = text;
    el.className = `pm-status ${kind}`;
  }

  function diagnosticContext() {
    const video = getVideo();
    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform || null,
      online: navigator.onLine,
      visibilityState: document.visibilityState,
      documentHasFocus: document.hasFocus(),
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      deviceMemoryGB: navigator.deviceMemory ?? null,
      videoMuted: video?.muted ?? null,
      videoVolume: video?.volume ?? null,
      videoReadyState: video?.readyState ?? null,
      videoNetworkState: video?.networkState ?? null
    };
  }

  function voiceLog(type, details = {}, session = state.voiceLog.active) {
    const video = getVideo();
    return state.voiceLog.add(type, { videoId: state.videoId,
      videoTime: video?.currentTime ?? null, paused: video?.paused ?? null,
      playbackRate: video?.playbackRate ?? null,
      ...details }, session);
  }

  function transcriptBlendTelemetry(transcript) {
    const words = String(transcript || '').trim().split(/\s+/).filter(Boolean);
    return {
      transcriptWordCount: words.length,
      possiblePlaybackBlend: words.length >= 14
    };
  }

  function summarizeVoiceSnapshot(snapshot) {
    const summary = {
      generatedAt: new Date().toISOString(),
      sessions: snapshot.sessions.length,
      events: 0,
      recognitionErrors: {},
      recognizerStarts: 0,
      recognitionResults: 0,
      commandsDispatched: {},
      commandsCompleted: {},
      commandsFailed: {},
      networkErrors: 0,
      watchdogStalls: 0,
      watchdogRestarts: 0,
      possiblePlaybackBlendCommands: 0
    };
    for (const session of snapshot.sessions) {
      for (const event of session.events || []) {
        summary.events++;
        const d = event.details || {};
        if (event.type === 'recognition_started') summary.recognizerStarts++;
        if (event.type === 'recognition_result') summary.recognitionResults++;
        if (event.type === 'recognition_watchdog_stall') summary.watchdogStalls++;
        if (event.type === 'recognition_watchdog_restart') summary.watchdogRestarts++;
        if (event.type === 'recognition_error') {
          const key = d.error || 'unknown';
          summary.recognitionErrors[key] = (summary.recognitionErrors[key] || 0) + 1;
          if (key === 'network') summary.networkErrors++;
        }
        if (event.type === 'command_dispatch') {
          const key = d.command || 'unknown';
          summary.commandsDispatched[key] = (summary.commandsDispatched[key] || 0) + 1;
          if (d.possiblePlaybackBlend) summary.possiblePlaybackBlendCommands++;
        }
        if (event.type === 'command_completed') {
          const key = d.command || 'unknown';
          summary.commandsCompleted[key] = (summary.commandsCompleted[key] || 0) + 1;
        }
        if (event.type === 'command_failed' || event.type === 'command_rejected') {
          const key = d.command || 'unknown';
          summary.commandsFailed[key] = (summary.commandsFailed[key] || 0) + 1;
        }
      }
    }
    return summary;
  }

  function exportVoiceLog() {
    if (!state.voiceLog.sessions.length) { status('Click Listen first to begin a voice log.'); return; }
    voiceLog('export_requested');
    const snapshot = state.voiceLog.snapshot();
    snapshot.diagnosticSummary = summarizeVoiceSnapshot(snapshot);
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `practice-mark-voice-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.documentElement.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    status('Voice log export requested. Check your browser downloads.');
  }

  function recordVoiceHistory(entry, existing = null) {
    // Async completion must not resurrect entries the user cleared or aged out.
    if (existing && !state.voiceHistory.includes(existing)) return existing;
    if (existing && state.voiceHistory.includes(existing)) Object.assign(existing, entry);
    else {
      existing = { time: new Date().toLocaleTimeString(), ...entry };
      state.voiceHistory.unshift(existing);
      state.voiceHistory.length = Math.min(state.voiceHistory.length, 20);
    }
    renderVoiceHistory();
    return existing;
  }

  function renderVoiceHistory() {
    const el = root?.querySelector('.pm-voice-history');
    if (!el) return;
    el.innerHTML = state.voiceHistory.length ? state.voiceHistory.map(item =>
      `<div class="pm-voice-entry"><strong>${escapeHtml(item.time)} · ${escapeHtml(item.command || 'No command')}</strong><div>${escapeHtml(item.transcript || '(No transcript returned)')}</div>${item.triggerTranscript ? `<div>Acted on: ${escapeHtml(item.triggerTranscript)}</div>` : ''}${item.previousAction ? `<div>Earlier action: ${escapeHtml(item.previousAction)}</div>` : ''}<div>${escapeHtml(item.outcome)}</div></div>`
    ).join('') : '<div class="pm-empty">Recent voice results appear here while Voice is on. Kept only in this page; no audio recorded.</div>';
  }

  function makeMark(time = currentTime()) {
    if (time == null) return null;
    return { id: uid('mark'), time, createdAt: Date.now() };
  }

  async function addStandaloneMark() {
    const mark = makeMark();
    if (!mark) return status('No YouTube video found.', 'warn');
    state.marks.push(mark);
    await saveVideoState();
    await recordEngagementMark();
    render();
    const number = markIndex(mark.id);
    toast(`Saved M${number} · ${fmt(mark.time)}`);
    status(`Saved M${number} as a free mark.`, 'good');
  }

  async function addSequentialMark() {
    const mark = makeMark();
    if (!mark) return status('No YouTube video found.', 'warn');
    state.marks.push(mark);

    const openLoop = [...state.loops].reverse().find(loop => loop.startMarkId && !loop.endMarkId);
    let loop;
    let message;

    if (openLoop) {
      loop = openLoop;
      loop.endMarkId = mark.id;
      state.activeLoopId = loop.id;
      const loopNo = loopIndex(loop.id);
      const range = loopRange(loop);
      message = `Loop ${loopNo} complete: ${fmt(range?.start)} → ${fmt(range?.end)}`;
      toast(`M${markIndex(mark.id)} → Loop ${loopNo} end`);
    } else {
      loop = {
        id: uid('loop'),
        name: '',
        startMarkId: mark.id,
        endMarkId: null,
        playbackRate: getVideo()?.playbackRate || 1,
        createdAt: Date.now()
      };
      state.loops.push(loop);
      state.activeLoopId = loop.id;
      const loopNo = loopIndex(loop.id);
      message = `Loop ${loopNo} start set at ${fmt(mark.time)}. Keep watching; the next mark will finish it.`;
      toast(`M${markIndex(mark.id)} → Loop ${loopNo} start`);
    }

    await saveVideoState();
    await recordEngagementMark();
    render();
    status(message, 'good');
  }

  async function markExplicitStart() {
    const mark = makeMark();
    if (!mark) return;
    state.marks.push(mark);
    const loop = {
      id: uid('loop'),
      name: '',
      startMarkId: mark.id,
      endMarkId: null,
      playbackRate: getVideo()?.playbackRate || 1,
      createdAt: Date.now()
    };
    state.loops.push(loop);
    state.activeLoopId = loop.id;
    await saveVideoState();
    await recordEngagementMark();
    render();
    toast(`Loop ${loopIndex(loop.id)} start`);
    status(`Started Loop ${loopIndex(loop.id)} at ${fmt(mark.time)}.`, 'good');
  }

  async function markExplicitEnd() {
    const target = [...state.loops].reverse().find(loop => loop.startMarkId && !loop.endMarkId) || activeLoop();
    if (!target?.startMarkId) {
      status('No open loop. Say “mark start” first.', 'warn');
      return;
    }
    const mark = makeMark();
    if (!mark) return;
    state.marks.push(mark);
    target.endMarkId = mark.id;
    state.activeLoopId = target.id;
    await saveVideoState();
    await recordEngagementMark();
    render();
    toast(`Loop ${loopIndex(target.id)} end`);
    status(`${displayLoopName(target)} is ${isValidLoop(target) ? 'ready' : 'set, but its end is before its start'}.`, isValidLoop(target) ? 'good' : 'warn');
  }

  async function createEmptyLoop() {
    const loop = {
      id: uid('loop'),
      name: '',
      startMarkId: null,
      endMarkId: null,
      playbackRate: 1,
      createdAt: Date.now()
    };
    state.loops.push(loop);
    state.activeLoopId = loop.id;
    await saveVideoState();
    render();
    status(`Created Loop ${loopIndex(loop.id)}. Assign any two marks below.`, 'good');
  }

  async function assignLoopMark(loopId, field, markId) {
    const loop = getLoop(loopId);
    if (!loop || !['startMarkId', 'endMarkId'].includes(field)) return;
    loop[field] = markId || null;
    state.activeLoopId = loop.id;
    if (state.looping && !isValidLoop(loop)) state.looping = false;
    await saveVideoState();
    render();
    status(`${displayLoopName(loop)} ${field === 'startMarkId' ? 'start' : 'end'} updated.`, isValidLoop(loop) ? 'good' : '');
  }

  async function renameLoop(loopId, name) {
    const loop = getLoop(loopId);
    if (!loop) return;
    loop.name = String(name || '').trim().slice(0, 40);
    await saveVideoState();
    renderLoops();
    refreshRecognitionPhrases();
    if (loop.name) {
      const normalized = normalizeVoice(loop.name);
      const duplicates = state.loops.filter(item => item.id !== loop.id && normalizeVoice(item.name) === normalized);
      if (duplicates.length) {
        status(`“${loop.name}” is also used by another loop. Voice commands will be ambiguous; use a unique name or the loop number.`, 'warn');
      } else {
        status(`Voice name updated: say “${loop.name} again”, “${loop.name} slower”, or “practice ${loop.name}”.`, 'good');
      }
    }
  }

  async function deleteLoop(loopId) {
    state.loops = state.loops.filter(loop => loop.id !== loopId);
    if (state.activeLoopId === loopId) {
      state.looping = false;
      state.activeLoopId = completeLoops().at(-1)?.id || state.loops.at(-1)?.id || null;
    }
    await saveVideoState();
    render();
    toast('Loop deleted');
  }

  async function deleteMark(markId) {
    state.marks = state.marks.filter(mark => mark.id !== markId);
    for (const loop of state.loops) {
      if (loop.startMarkId === markId) loop.startMarkId = null;
      if (loop.endMarkId === markId) loop.endMarkId = null;
    }
    if (state.looping && !isValidLoop(activeLoop())) state.looping = false;
    await saveVideoState();
    render();
  }

  async function clearAll() {
    state.marks = [];
    state.loops = [];
    state.activeLoopId = null;
    state.looping = false;
    await saveVideoState();
    render();
    toast('All marks and loops cleared');
  }

  function getPreferredActiveLoop() {
    return activeLoop() || completeLoops().at(-1) || null;
  }

  function applyPlaybackRate(rate) {
    const video = getVideo();
    if (!video) return false;
    const safe = Math.max(SPEED_STEPS[0], Math.min(SPEED_STEPS.at(-1), Number(rate) || 1));
    video.defaultPlaybackRate = safe;
    video.playbackRate = safe;
    updateSpeedUI();
    return true;
  }

  function applyLoopSpeed(loop) {
    if (!loop) return false;
    return applyPlaybackRate(Number(loop.playbackRate) || 1);
  }

  function playVideo({ announce = true } = {}) {
    const video = getVideo();
    if (!video) {
      status('Could not find the YouTube video player.', 'warn');
      return false;
    }
    const promise = video.play();
    if (promise?.catch) {
      promise.catch(() => {
        status('Chrome blocked playback. Click the video once, then voice Play will work.', 'warn');
      });
    }
    if (announce) toast('Play');
    return true;
  }

  function pauseVideo({ announce = true } = {}) {
    const video = getVideo();
    if (!video) {
      status('Could not find the YouTube video player.', 'warn');
      return false;
    }
    video.pause();
    if (announce) toast('Pause');
    return true;
  }

  function activateLoop(loopId, { restart = true, enableLoop = true, play = false } = {}) {
    const loop = getLoop(loopId);
    if (!loop) return false;
    if (!isValidLoop(loop)) {
      status(`${displayLoopName(loop)} needs a valid start and end.`, 'warn');
      return false;
    }
    state.activeLoopId = loop.id;
    state.looping = enableLoop;
    applyLoopSpeed(loop);
    if (restart) {
      const range = loopRange(loop);
      const preRoll = Math.max(0, Number(state.settings.preRoll) || 0);
      seek(range.start - preRoll, false);
    }
    if (play) playVideo({ announce: false });
    render();
    status(`${displayLoopName(loop)} · ${loop.playbackRate || 1}×${state.looping ? ' · looping' : ''}${play ? ' · playing' : ''}.`, 'good');
    return true;
  }

  function activateLoopByNumber(number, options) {
    const loop = state.loops[number - 1];
    if (!loop) {
      status(`Loop ${number} does not exist.`, 'warn');
      return false;
    }
    return activateLoop(loop.id, options);
  }

  function again(loopId = state.activeLoopId) {
    let loop = loopId ? getLoop(loopId) : null;
    if (!loop || !isValidLoop(loop)) loop = completeLoops().at(-1) || null;
    if (loop) {
      state.activeLoopId = loop.id;
      applyLoopSpeed(loop);
      const range = loopRange(loop);
      const preRoll = Math.max(0, Number(state.settings.preRoll) || 0);
      seek(range.start - preRoll);
      render();
      toast(`${displayLoopName(loop)} again`);
      return;
    }
    const latestMark = state.marks.at(-1);
    if (latestMark) {
      seek(latestMark.time);
      toast(`Back to M${markIndex(latestMark.id)}`);
      return;
    }
    status('Create a mark or loop first.', 'warn');
  }

  function toggleLoop(force) {
    const loop = getPreferredActiveLoop();
    if (!loop || !isValidLoop(loop)) {
      status('Create or select a complete loop first.', 'warn');
      return;
    }
    state.activeLoopId = loop.id;
    state.looping = typeof force === 'boolean' ? force : !state.looping;
    if (state.looping) applyLoopSpeed(loop);
    render();
    toast(state.looping ? `${displayLoopName(loop)} looping` : 'Loop stopped');
  }

  function nearestSpeedIndex(rate) {
    let best = 0;
    let distance = Infinity;
    SPEED_STEPS.forEach((step, index) => {
      const nextDistance = Math.abs(step - rate);
      if (nextDistance < distance) { best = index; distance = nextDistance; }
    });
    return best;
  }

  async function changeLoopSpeed(delta, loop = null, { restart = false } = {}) {
    const video = getVideo();
    const targetLoop = loop || (() => {
      const selected = activeLoop();
      return selected && isValidLoop(selected) ? selected : null;
    })();
    if (!video && !targetLoop) return false;

    // Global/voice speed controls follow what the viewer is actually hearing.
    // Per-loop +/- controls follow that loop's stored speed.
    const current = loop
      ? (Number(loop.playbackRate) || 1)
      : (Number(video?.playbackRate) || Number(targetLoop?.playbackRate) || 1);
    const currentIndex = nearestSpeedIndex(current);
    const nextIndex = delta > 0
      ? Math.min(SPEED_STEPS.length - 1, currentIndex + 1)
      : Math.max(0, currentIndex - 1);
    const rate = SPEED_STEPS[nextIndex];

    if (targetLoop) {
      targetLoop.playbackRate = rate;
      state.activeLoopId = targetLoop.id;
      await saveVideoState();
    }
    applyPlaybackRate(rate);

    if (restart && targetLoop && isValidLoop(targetLoop)) {
      activateLoop(targetLoop.id, { restart: true, enableLoop: true, play: true });
    } else {
      render();
    }
    const targetName = targetLoop ? ` · ${displayLoopName(targetLoop)}` : '';
    toast(`${rate}×`);
    status(`Speed ${rate}×${targetName}.`, 'good');
    return true;
  }

  async function normalSpeed(loop = null, { restart = false } = {}) {
    const targetLoop = loop || (() => {
      const selected = activeLoop();
      return selected && isValidLoop(selected) ? selected : null;
    })();
    if (targetLoop) {
      targetLoop.playbackRate = 1;
      state.activeLoopId = targetLoop.id;
      await saveVideoState();
    }
    applyPlaybackRate(1);
    if (restart && targetLoop && isValidLoop(targetLoop)) {
      activateLoop(targetLoop.id, { restart: true, enableLoop: true, play: true });
    } else {
      render();
    }
    toast('1×');
    status(`Speed 1×${targetLoop ? ` · ${displayLoopName(targetLoop)}` : ''}.`, 'good');
    return true;
  }

  function jumpRelative(seconds) {
    const video = getVideo();
    if (!video) return;
    seek(video.currentTime + seconds);
    toast(`${seconds > 0 ? '+' : ''}${seconds}s`);
  }

  function cycleLoop(direction) {
    const loops = completeLoops();
    if (!loops.length) {
      status('No complete loops yet.', 'warn');
      return;
    }
    let index = loops.findIndex(loop => loop.id === state.activeLoopId);
    if (index < 0) index = direction > 0 ? -1 : 0;
    index = (index + direction + loops.length) % loops.length;
    activateLoop(loops[index].id, { restart: true, enableLoop: true, play: true });
  }

  function normalizeVoice(raw) {
    return String(raw || '')
      .toLowerCase()
      .replace(/[’']/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeSpeedModifier(modifier) {
    const value = normalizeVoice(modifier);
    if (value === 'slow down' || value === 'slow it down') return 'slower';
    if (value === 'speed up' || value === 'speed it up') return 'faster';
    return value || null;
  }

  function parseLoopNumber(token) {
    const words = {
      one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4,
      five: 5, fifth: 5, six: 6, sixth: 6, seven: 7, seventh: 7, eight: 8, eighth: 8,
      nine: 9, ninth: 9, ten: 10, tenth: 10, eleven: 11, twelve: 12
    };
    if (/^\d+$/.test(token)) return Number(token);
    return words[token] || null;
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function namedLoopIntent(text) {
    const groups = new Map();
    for (const loop of state.loops) {
      const voiceName = normalizeVoice(loop.name);
      if (!voiceName) continue;
      if (!groups.has(voiceName)) groups.set(voiceName, []);
      groups.get(voiceName).push(loop);
    }

    // Prefer the longest loop name first so names such as "chorus" and
    // "big chorus" cannot steal each other's commands.
    const aliases = [...groups.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [voiceName, loops] of aliases) {
      const escaped = escapeRegExp(voiceName).replace(/\\ /g, '\\s+');
      let modifier = null;
      let matched = false;
      let shouldPlay = false;

      // Natural forms: "practice chorus", "play chorus again", "loop chorus slower".
      const prefixed = text.match(new RegExp(`\\b(practice|play|start|loop)\\s+${escaped}(?:\\s+(again|slower|slow down|faster|speed up|normal(?:\\s+speed)?))?\\b`));
      if (prefixed) {
        matched = true;
        shouldPlay = /^(?:practice|play|start)$/.test(prefixed[1]);
        modifier = normalizeSpeedModifier(prefixed[2]);
      }

      // Fast hands-free forms: "chorus again", "chorus slower", etc.
      if (!matched) {
        const suffixed = text.match(new RegExp(`\\b${escaped}\\s+(again|slower|slow down|faster|speed up|normal(?:\\s+speed)?)\\b`));
        if (suffixed) {
          matched = true;
          modifier = normalizeSpeedModifier(suffixed[1]);
        }
      }

      // An exact loop name by itself is also accepted, but only when it is the
      // whole utterance. This avoids triggering a loop merely because the video
      // happens to contain the word "chorus" in ordinary speech.
      if (!matched && (text === voiceName || (practiceWakeActive() && new RegExp(`\\b${escaped}\\b`).test(text)))) matched = true;

      if (matched) {
        return {
          type: 'loop-name',
          name: voiceName,
          loopIds: loops.map(loop => loop.id),
          modifier,
          play: shouldPlay,
          text
        };
      }
    }
    return null;
  }

  function voicePhraseSpecs() {
    const specs = [
      ['practice', 4.0],
      ['mark that', 5.0],
      ['mark start', 7.0],
      ['mark end', 7.0],
      ['save that', 6.5],
      ['pause', 8.5],
      ['pause it', 8.0],
      ['pause video', 8.0],
      ['hold it', 7.5],
      ['play', 7.2],
      ['resume', 7.2],
      ['play video', 7.0],
      ['again', 7.2],
      ['go again', 7.0],
      ['repeat that', 7.5],
      ['once more', 7.0],
      ['one more time', 6.8],
      ['next loop', 5.5],
      ['previous loop', 5.5],
      ['stop looping', 5.5],
      ['slower', 5.0],
      ['slow down', 5.0],
      ['faster', 5.0],
      ['speed up', 5.0],
      ['wait', 5.0],
      ['hold on', 5.0]
    ];

    const numberWords = ['one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve'];
    numberWords.forEach(word => {
      specs.push([`loop ${word}`, 5.5], [`practice loop ${word}`, 6.0]);
    });

    for (const loop of state.loops) {
      const name = String(loop.name || '').trim();
      if (!name) continue;
      specs.push([name, 6.5], [`practice ${name}`, 6.5], [`${name} again`, 5.5], [`${name} slower`, 5.5], [`${name} slow down`, 5.5], [`${name} faster`, 5.5], [`${name} speed up`, 5.5]);
    }

    // De-duplicate phrases, keeping the largest boost.
    const best = new Map();
    for (const [phrase, boost] of specs) {
      const key = normalizeVoice(phrase);
      if (!key) continue;
      best.set(key, Math.max(boost, best.get(key) || 0));
    }
    return [...best.entries()].slice(0, 80).map(([phrase, boost]) => ({ phrase, boost }));
  }

  function refreshRecognitionPhrases(recognition = state.recognition) {
    if (!recognition || !state.voicePhrasesEnabled) return false;
    const Phrase = window.SpeechRecognitionPhrase;
    if (!Phrase || !('phrases' in recognition)) return false;
    try {
      recognition.phrases = voicePhraseSpecs().map(({ phrase, boost }) => new Phrase(phrase, Math.min(boost, 5)));
      return true;
    } catch (_) {
      return false;
    }
  }

  function restoreVoiceDuck() {
    const video = state.voiceDuckVideo;
    if (video && state.voiceDuckPreviousVolume != null) {
      video.volume = Math.max(0, Math.min(1, state.voiceDuckPreviousVolume));
    }
    state.voiceDuckPreviousVolume = null;
    state.voiceDuckVideo = null;
  }

  function clearPracticeWake() {
    state.voiceWakeUntil = 0;
    if (state.voiceWakeTimer) clearTimeout(state.voiceWakeTimer);
    state.voiceWakeTimer = null;
    restoreVoiceDuck();
  }

  function armPracticeWake(needsLoop = false) {
    clearPracticeWake();
    state.voiceWakeUntil = Date.now() + 5000;

    // Once the wake word is heard, reduce competing YouTube audio for a few
    // seconds. This makes the actual command much easier to recognize from a
    // laptop microphone without pausing the lesson.
    const video = getVideo();
    if (video && !video.muted && video.volume > 0.28) {
      state.voiceDuckVideo = video;
      state.voiceDuckPreviousVolume = video.volume;
      video.volume = 0.22;
    }

    state.voiceWakeTimer = setTimeout(() => {
      state.voiceWakeTimer = null;
      state.voiceWakeUntil = 0;
      restoreVoiceDuck();
      if (state.listening) {
        status('Loop request timed out. Say “practice two” or “practice” followed by a loop name.', 'warn');
      }
    }, 5000);
    status(needsLoop ? 'Which loop? Say its number or name…' : 'Listening for a loop… say its number or name.', 'good');
    toast(needsLoop ? 'Which loop?' : 'Practice ready');
  }

  function practiceWakeActive() {
    return state.voiceWakeUntil > Date.now();
  }

  function pauseOccurrences(text) {
    const matches = [];

    // “pause” and the common Chrome homophone “paws” can appear inside a
    // longer interim transcript. Keep the negation/animal guards from the
    // original parser so ordinary narration does not become a transport action.
    for (const match of text.matchAll(/\b(?:pause|paws)\b/g)) {
      const before = text.slice(0, match.index);
      if (match[0] === 'paws' && /\b(?:his|her|its|their|four|two|dog|cat)\s+$/.test(before)) continue;
      if (/\b(?:dont|do not|not|never|without|no)(?:\s+(?:please|ever|actually|just)){0,2}\s+$/.test(before)) continue;
      matches.push({ index: match.index, phrase: match[0] });
    }

    // Treat Wait and Hold on exactly like Pause, but only when they are the
    // current tail of Chrome's evolving hypothesis. This gives them immediate
    // response without spotting an instructor's earlier “wait” in a long sentence.
    const tail = text.match(/\b(wait|hold on)(?:\s+please)?$/);
    if (tail) matches.push({ index: tail.index, phrase: tail[1] });

    return matches;
  }

  function voiceOccurrences(raw) {
    const text = normalizeVoice(raw);
    const spans = [];
    for (const match of text.matchAll(/\bmark that\b/g)) spans.push({ at: match.index, phrase: match[0], kind: 'mark' });
    for (const match of pauseOccurrences(text)) spans.push({ at: match.index, phrase: match.phrase, kind: 'pause' });
    const numbers = '(?:\\d+|one|first|two|second|three|third|four|fourth|five|fifth|six|sixth|seven|seventh|eight|eighth|nine|ninth|ten|tenth|eleven|twelve)';
    const loopPattern = new RegExp('\\b(?:(?:play|practice|start)\\s+(?:(?:loop|luke|loot|league|loom|lo|loo)\\s*)?|loop\\s*)' + numbers + '(?:\\s+(?:again|slower|slow down|faster|speed up|normal(?:\\s+speed)?))?\\b', 'g');
    for (const match of text.matchAll(loopPattern)) spans.push({ at: match.index, phrase: match[0], kind: 'loop' });
    spans.sort((a, b) => a.at - b.at);
    const counts = {};
    return spans.map(span => ({ ...span, ordinal: counts[span.kind] = (counts[span.kind] || 0) + 1 }));
  }

  function fallbackLoopForIncompleteVoice() {
    const complete = completeLoops();
    const active = activeLoop();
    if (active && loopRange(active)) return active;
    if (complete.length === 1) return complete[0];
    return null;
  }

  function detectVoiceIntent(raw) {
    const text = normalizeVoice(raw)
      // Only repair Luke in an explicit command prefix; preserve custom names.
      .replace(/^(play|practice|start) (?:luke|loot|league|loom|lo|loo)(?=\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b|$)/, '$1 loop');
    if (!text) return null;

    const compactPlay = text.match(/^play\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s+(again|slower|slow down|faster|speed up|normal(?:\s+speed)?))?$/);
    if (compactPlay) return { type: 'loop-number', number: parseLoopNumber(compactPlay[1]), modifier: normalizeSpeedModifier(compactPlay[2]), play: true, text };

    // Specific loop commands must win over generic words such as “practice”
    // and “play”. This lets an evolving interim result go from “practice” to
    // “practice loop one” without the wake word stealing the final command.
    if (/\b(?:stop loop|stop looping|loop off|end loop)\b/.test(text)) return { type: 'stop-loop', text };
    if (/\b(?:next loop|loop next)\b/.test(text)) return { type: 'next-loop', text };
    if (/\b(?:previous loop|prior loop|last loop)\b/.test(text)) return { type: 'previous-loop', text };
    if (/\b(?:new loop|add loop|create loop)\b/.test(text)) return { type: 'new-loop', text };

    const loopMatch = text.match(/\b(?:(practice|play|start)\s+)?loop\s*(\d+|one|first|two|second|three|third|four|fourth|five|fifth|six|sixth|seven|seventh|eight|eighth|nine|ninth|ten|tenth|eleven|twelve)(?:\s+(again|slower|slow down|faster|speed up|normal(?:\s+speed)?))?\b/);
    if (loopMatch) {
      return {
        type: 'loop-number',
        number: parseLoopNumber(loopMatch[2]),
        modifier: normalizeSpeedModifier(loopMatch[3]),
        play: !!loopMatch[1],
        text
      };
    }

    // Also accept the compact wake form “practice one” in a single breath.
    const practiceNumber = text.match(/\bpractice\s+(\d+|one|first|two|second|three|third|four|fourth|five|fifth|six|sixth|seven|seventh|eight|eighth|nine|ninth|ten|tenth|eleven|twelve)(?:\s+(again|slower|slow down|faster|speed up|normal(?:\s+speed)?))?\b/);
    if (practiceNumber) {
      return { type: 'loop-number', number: parseLoopNumber(practiceNumber[1]), modifier: normalizeSpeedModifier(practiceNumber[2]), play: true, text };
    }

    const namedIntent = namedLoopIntent(text);
    if (namedIntent) return namedIntent;

    // If Chrome hears only “play loop” / “play luke” / “play loom” and there is one
    // unambiguous current loop, recover instead of forcing a second utterance.
    const incompleteLoop = text.match(/^(?:play|start|practice)\s+loop(?:\s+(again|slower|slow down|faster|speed up|normal(?:\s+speed)?))?$/);
    if (incompleteLoop) {
      const fallback = fallbackLoopForIncompleteVoice();
      if (fallback) {
        return { type: 'loop-number', number: loopIndex(fallback.id), modifier: normalizeSpeedModifier(incompleteLoop[1]), play: true, text, recovered: true };
      }
      return { type: 'need-loop', text };
    }

    // Other partial targets remain questions, never generic Play/Loop actions.
    if (/^(?:(?:play|start|practice)\s+loop(?:\s+.*)?|practice\s+.+)$/.test(text)) {
      return { type: 'need-loop', text };
    }

    // A follow-up can arrive in a separate result after “play loop”/“practice”.
    if (practiceWakeActive()) {
      const target = text.match(/^(\d+|one|first|two|second|three|third|four|fourth|five|fifth|six|sixth|seven|seventh|eight|eighth|nine|ninth|ten|tenth|eleven|twelve)(?:\s+(again|slower|slow down|faster|speed up|normal(?:\s+speed)?))?$/);
      if (target) return { type: 'loop-number', number: parseLoopNumber(target[1]), modifier: normalizeSpeedModifier(target[2]), play: true, text };
    }

    // Capture commands are intentionally spotted anywhere in an interim
    // transcript. YouTube audio may be mixed into the microphone transcript,
    // so requiring an exact whole-utterance match made “mark that” feel slow.
    if (/\b(?:mark start|set start|start mark)\b/.test(text)) return { type: 'mark-start', text };
    if (/\b(?:mark end|set end|end mark)\b/.test(text)) return { type: 'mark-end', text };
    if (/\b(?:save that|save mark|free mark)\b/.test(text)) return { type: 'save-mark', text };
    if (/\bmark that\b|^mark$/.test(text)) return { type: 'mark', text };

    // Fast transport spotting. These commands fire from INTERIM recognition
    // as soon as the keyword appears, rather than waiting for Chrome to decide
    // the complete sentence. “paws” is accepted because it is a common speech
    // recognition substitution for the spoken word “pause”.
    if (pauseOccurrences(text).length || /^(?:please\s+)?(?:wait|hold on|hold it|pause|pause it|pause video|stop video|stop playback)(?:\s+please)?$/.test(text)) {
      return { type: 'pause', text };
    }
    if (/^(?:please )?(?:play|resume|continue)(?: (?:it|the video|video|playback))?(?: please)?$/.test(text)) {
      return { type: 'play', text };
    }

    if (/\b(?:loop it|start loop|loop on)\b|^loop$/.test(text)) return { type: 'loop-on', text };
    if (/\b(?:back five|back 5|go back five|rewind five)\b/.test(text)) return { type: 'back5', text };
    if (/\b(?:forward five|forward 5|go forward five)\b/.test(text)) return { type: 'forward5', text };
    if (/^(?:please )?(?:normal speed|one x|1x|one times)(?: please)?$/.test(text)) return { type: 'normal', text };
    if (/(?:^|\s)(?:slower|slow down|slow it down)$/.test(text)) return { type: 'slower', text };
    if (/(?:^|\s)(?:faster|speed up|speed it up)$/.test(text)) return { type: 'faster', text };
    if (/\b(?:again|go again|do that again|play that again|back to start|once more|one more time|repeat that|repeat it|repeat)\b/.test(text)) return { type: 'again', text };

    // “Practice” is deliberately last. Any transcript that already contains a
    // specific loop/name/transport command should execute that command instead.
    // As a wake word it may appear inside a longer mixed transcript.
    if (/\bpractice\b/.test(text)) return { type: 'wake-practice', text };

    // During the short wake window, a bare number can select a loop without
    // requiring the recognizer to hear the word “loop”.
    if (practiceWakeActive()) {
      const bareNumber = text.match(/^(\d+|one|first|two|second|three|third|four|fourth|five|fifth|six|sixth|seven|seventh|eight|eighth|nine|ninth|ten|tenth|eleven|twelve)$/);
      if (bareNumber) return { type: 'loop-number', number: parseLoopNumber(bareNumber[1]), modifier: null, play: true, text };
    }

    return null;
  }

  function voiceIntentKey(intent) {
    if (!intent) return '';
    if (intent.type === 'loop-number') return `${intent.type}:${intent.number}:${intent.modifier || ''}`;
    if (intent.type === 'loop-name') return `${intent.type}:${intent.name}:${intent.modifier || ''}`;
    return intent.type;
  }

  async function executeVoiceIntent(intent) {
    if (!intent) return false;
    switch (intent.type) {
      case 'wake-practice': armPracticeWake(); return 'wake';
      case 'need-loop': armPracticeWake(true); return 'wake';
      case 'mark': await addSequentialMark(); break;
      case 'save-mark': await addStandaloneMark(); break;
      case 'mark-start': await markExplicitStart(); break;
      case 'mark-end': await markExplicitEnd(); break;
      case 'new-loop': await createEmptyLoop(); break;
      case 'loop-on': toggleLoop(true); break;
      case 'stop-loop': toggleLoop(false); break;
      case 'next-loop': cycleLoop(1); break;
      case 'previous-loop': cycleLoop(-1); break;
      case 'again': again(); playVideo({ announce: false }); break;
      case 'play': {
        const video = getVideo();
        if (!video) { status('No YouTube video found.', 'warn'); return false; }
        try {
          await video.play();
          toast('Play');
        } catch (_) {
          status('Playback blocked. Click the video once, then try Play again.', 'warn');
          return false;
        }
        break;
      }
      case 'pause': pauseVideo(); break;
      case 'slower': await changeLoopSpeed(-1); break;
      case 'faster': await changeLoopSpeed(1); break;
      case 'normal': await normalSpeed(); break;
      case 'back5': jumpRelative(-5); break;
      case 'forward5': jumpRelative(5); break;
      case 'loop-name': {
        if (intent.loopIds.length !== 1) {
          status(`More than one loop is named “${intent.name}”. Rename one or use its loop number.`, 'warn');
          break;
        }
        const loop = getLoop(intent.loopIds[0]);
        if (!loop) {
          status(`Could not find “${intent.name}”.`, 'warn');
          break;
        }
        if (intent.modifier === 'slower') {
          if (!activateLoop(loop.id, { restart: false, enableLoop: true, play: false })) break;
          await changeLoopSpeed(-1, loop, { restart: true });
        } else if (intent.modifier === 'faster') {
          if (!activateLoop(loop.id, { restart: false, enableLoop: true, play: false })) break;
          await changeLoopSpeed(1, loop, { restart: true });
        } else if (intent.modifier?.startsWith('normal')) {
          if (!activateLoop(loop.id, { restart: false, enableLoop: true, play: false })) break;
          await normalSpeed(loop, { restart: true });
        } else {
          activateLoop(loop.id, { restart: true, enableLoop: true, play: true });
        }
        break;
      }
      case 'loop-number': {
        const loop = state.loops[intent.number - 1];
        if (!loop) {
          status(`Loop ${intent.number} does not exist.`, 'warn');
          break;
        }
        if (intent.modifier === 'slower') {
          if (!activateLoop(loop.id, { restart: false, enableLoop: true, play: false })) break;
          await changeLoopSpeed(-1, loop, { restart: true });
        } else if (intent.modifier === 'faster') {
          if (!activateLoop(loop.id, { restart: false, enableLoop: true, play: false })) break;
          await changeLoopSpeed(1, loop, { restart: true });
        } else if (intent.modifier?.startsWith('normal')) {
          if (!activateLoop(loop.id, { restart: false, enableLoop: true, play: false })) break;
          await normalSpeed(loop, { restart: true });
        } else {
          activateLoop(loop.id, { restart: true, enableLoop: true, play: true });
        }
        break;
      }
      default: return false;
    }
    clearPracticeWake();
    return true;
  }

  function clearVoiceRestartTimer() {
    if (state.voiceRestartTimer) clearTimeout(state.voiceRestartTimer);
    state.voiceRestartTimer = null;
  }

  function scheduleVoiceRestart(delayMs = 600) {
    voiceLog('restart_scheduled', { delayMs, listening: state.listening });
    clearVoiceRestartTimer();
    if (!state.listening) return;
    state.voiceRestartTimer = setTimeout(() => {
      state.voiceRestartTimer = null;
      startRecognitionSafely();
    }, delayMs);
  }

  function clearVoiceHealthWatchdog() {
    if (state.voiceHealthTimer) clearInterval(state.voiceHealthTimer);
    state.voiceHealthTimer = null;
  }

  function touchVoiceHealth(source = 'signal') {
    state.voiceLastSignalAt = performance.now();
    if (state.voiceWatchdogRestarting && source === 'recognition_started') {
      state.voiceWatchdogRestarting = false;
      voiceLog('recognition_watchdog_recovered', { source, watchdogRestarts: state.voiceWatchdogRestarts });
    }
  }

  function forceVoiceRecognitionRecycle(reason = 'watchdog_stall', thresholdMs = null) {
    if (!state.listening || state.voiceWatchdogRestarting) return false;
    const now = performance.now();
    const silentMs = Math.max(0, now - (state.voiceLastSignalAt || now));
    const oldRecognition = state.recognition;
    state.voiceWatchdogRestarting = true;
    state.voiceWatchdogRestarts += 1;
    voiceLog('recognition_watchdog_stall', {
      reason,
      silentMs,
      thresholdMs,
      watchdogRestarts: state.voiceWatchdogRestarts,
      recognizerLive: state.voiceRecognizing,
      startPending: state.voiceStartPending,
      diagnosticContext: diagnosticContext()
    });
    status('Chrome voice stalled. Reconnecting automatically…', 'warn');
    state.voiceCancelPending?.();
    clearVoiceRestartTimer();
    state.recognition = null;
    state.voiceRecognizing = false;
    state.voiceStartPending = false;
    try { oldRecognition?.abort(); } catch (_) {}
    setTimeout(() => {
      if (!state.listening) {
        state.voiceWatchdogRestarting = false;
        return;
      }
      state.recognition = createRecognition({ preferLocal: false });
      state.voiceLastSignalAt = performance.now();
      voiceLog('recognition_watchdog_restart', {
        reason,
        watchdogRestarts: state.voiceWatchdogRestarts,
        diagnosticContext: diagnosticContext()
      });
      startRecognitionSafely();
    }, 300);
    return true;
  }

  function startVoiceHealthWatchdog() {
    clearVoiceHealthWatchdog();
    state.voiceLastSignalAt = performance.now();
    state.voiceHealthTimer = setInterval(() => {
      if (!state.listening || !state.voiceRecognizing || state.voiceStartPending || state.voiceWatchdogRestarting) return;
      const video = getVideo();
      const audiblePlayback = !!(video && !video.paused && !video.muted && video.volume > 0.02);
      const thresholdMs = audiblePlayback ? 18000 : 30000;
      const silentMs = performance.now() - (state.voiceLastSignalAt || performance.now());
      if (silentMs >= thresholdMs) forceVoiceRecognitionRecycle('no_recognition_callbacks', thresholdMs);
    }, 1500);
  }

  function createRecognition({ preferLocal = false } = {}) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return null;

    const recognition = new SpeechRecognition();
    const logSession = state.voiceLog.active;
    const recognitionId = uid('recognition');
    let cycle = 0;
    const trace = (type, details = {}) => voiceLog(type, { recognitionId, cycle, ...details }, logSession);
    recognition._pmTrace = trace;
    trace('recognizer_created', { engine: 'Chrome cloud', maxAlternatives: 5, diagnosticContext: diagnosticContext() });
    for (const name of ['audiostart', 'audioend', 'soundstart', 'soundend', 'speechstart', 'speechend', 'nomatch']) {
      recognition['on' + name] = event => {
        touchVoiceHealth(name);
        trace(name, { browserEventTimestamp: event?.timeStamp ?? null });
      };
    }
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 5;
    recognition.lang = 'en-US';
    // Contextual phrase boosting is disabled on this Chrome build; it reports phrases-not-supported.
    if (preferLocal && 'processLocally' in recognition) {
      try {
        recognition.processLocally = true;
        state.voiceMode = 'local';
      } catch (_) {
        state.voiceMode = 'cloud';
      }
    } else {
      state.voiceMode = 'cloud';
    }

    recognition.onstart = () => {
      cycle++;
      state.voiceRecognitionSnapshot = { recognitionId, cycle, seenIndexes: new Set() };
      state.voiceRecognizing = true;
      touchVoiceHealth('recognition_started');
      trace('recognition_started', { diagnosticContext: diagnosticContext() });
      if (!state.listening || state.recognition !== recognition) {
        try { recognition.abort(); } catch (_) {}
        return;
      }
      state.voiceStartPending = false;
      renderMicState();
      status(`Listening${state.voiceMode === 'local' ? ' on-device' : ''}: try “mark that”, “pause”, “wait”, “hold on”, “again”, or “play loop one”.`, 'good');
    };

    // These records belong to this recognition session, not the global state.
    // Latch synchronously before storage/playback promises can yield.
    const executed = new Map();
    const woken = new Set();
    const pending = new Map();
    const history = new Map();
    const cancelPending = () => {
      for (const [index, item] of pending) { trace('pending_cancelled', { index, reason: 'session_or_page_changed' }); clearTimeout(item.timer); }
      pending.clear();
    };
    state.voiceCancelPending = cancelPending;
    const current = () => state.listening && state.recognition === recognition;

    const dispatch = (index, candidate) => {
      const executionKey = candidate.occurrenceKey || index;
      if (!current() || executed.has(executionKey)) { trace('command_ignored', { index, occurrence: candidate.occurrenceKey, reason: !current() ? 'stale_recognizer' : 'already_executed' }); return; }
      const { intent, transcript } = candidate;
      if (intent.type === 'wake-practice' || intent.type === 'need-loop') {
        if (woken.has(index)) { trace('command_ignored', { index, reason: 'wake_already_armed' }); return; }
        woken.add(index);
      } else {
        if (candidate.occurrenceKey && executed.get(index) === 'play' && intent.type === 'loop-number') {
          recordVoiceHistory({ previousAction: 'play' }, history.get(index));
          trace('command_refined', { index, from: 'play', to: voiceIntentKey(intent) });
        }
        executed.set(executionKey, intent.type);
        executed.set(index, intent.type);
      }
      const commandKey = voiceIntentKey(intent);
      trace('command_dispatch', { index, transcript, occurrence: candidate.occurrenceKey, command: commandKey, ...transcriptBlendTelemetry(transcript) });
      state.lastTranscript = normalizeVoice(transcript);
      const row = recordVoiceHistory({ transcript, triggerTranscript: transcript, command: voiceIntentKey(intent), outcome: 'Sent to controls' }, history.get(index));
      history.set(index, row);
      if (['loop-number', 'loop-name'].includes(intent.type)) {
        const loop = intent.type === 'loop-number' ? state.loops[intent.number - 1]
          : intent.loopIds.length === 1 ? getLoop(intent.loopIds[0]) : null;
        const failure = !loop ? 'Loop not found or name is ambiguous.' : !isValidLoop(loop) ? 'Loop needs a valid start and end.' : null;
        if (failure) {
          trace('command_rejected', { index, command: voiceIntentKey(intent), reason: failure });
          recordVoiceHistory({ outcome: failure }, row);
          clearPracticeWake();
          status(failure + ' Say “practice” followed by another loop number or name.', 'warn');
          return;
        }
      }
      // Do not overwrite action-specific errors or mark timestamps afterward.
      status(`Command heard: “${transcript}”`, 'good');
      void executeVoiceIntent(intent).then(outcome => {
        trace('command_completed', { index, occurrence: candidate.occurrenceKey, command: voiceIntentKey(intent), outcome: outcome === 'wake' ? 'waiting_for_loop' : outcome === false ? 'not_executed' : 'completed' });
        if (row.triggerTranscript !== transcript) return;
        recordVoiceHistory({ outcome: outcome === 'wake' ? 'Waiting for a loop (5 seconds)' : outcome === false ? 'Not executed; see notice' : 'Executed' }, row);
      }).catch(error => {
        trace('command_failed', { index, occurrence: candidate.occurrenceKey, command: voiceIntentKey(intent), error: String(error?.message || error) });
        if (row.triggerTranscript !== transcript) return;
        recordVoiceHistory({ outcome: 'Command failed' }, row);
        if (current()) status('Command could not finish. Check the marks before retrying.', 'warn');
      });
    };

    recognition.onresult = event => {
      touchVoiceHealth('recognition_result');
      const results = Array.from(event.results).slice(event.resultIndex).map((result, offset) => ({
        index: event.resultIndex + offset, isFinal: result.isFinal,
        alternatives: Array.from(result).map(alt => ({ transcript: alt.transcript, confidence: alt.confidence ?? null }))
      }));
      trace('recognition_result', { resultIndex: event.resultIndex, resultCount: event.results.length,
        browserEventTimestamp: event.timeStamp ?? null, results });
      if (state.voiceRecognitionSnapshot?.recognitionId === recognitionId && state.voiceRecognitionSnapshot?.cycle === cycle) {
        for (let i = event.resultIndex; i < event.results.length; i++) state.voiceRecognitionSnapshot.seenIndexes.add(i);
      }
      if (!current()) { trace('result_ignored', { reason: 'stale_recognizer' }); return; }
      state.voiceRetryCount = 0;
      // Chrome may remove trailing interim results. Cancel their pending work.
      for (const [index, item] of pending) {
        if ((item.index ?? index) >= event.results.length) {
          trace('pending_cancelled', { index, reason: 'interim_result_removed' });
          clearTimeout(item.timer);
          pending.delete(index);
        }
      }
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const candidates = [];
        const firstTranscript = result[0]?.transcript?.trim() || '';
        // Empty service results should not push useful diagnostics out of history.
        if (!firstTranscript && !history.has(i) && !Array.from(result).some(item => item?.transcript?.trim())) { trace('result_ignored', { index: i, reason: 'empty_transcript' }); continue; }
        const row = recordVoiceHistory({ transcript: firstTranscript || history.get(i)?.transcript || '',
          ...(executed.has(i) ? {} : { command: '', outcome: result.isFinal ? 'No command matched' : 'Interim; listening' }) }, history.get(i));
        history.set(i, row);
        if (history.size > 20) history.delete(history.keys().next().value);
        // Track explicit occurrences, not one action for the entire transcript.
        // Ordinals stay consumed across rewrites/shrinking interim hypotheses.
        // Pick one alternative; never add together commands from alternatives.
        let observed = [];
        let observedAlternative = 0;
        for (let a = 0; a < Math.min(result.length, 5); a++) {
          const spans = voiceOccurrences(result[a]?.transcript);
          if (spans.length) { observed = spans; observedAlternative = a; break; }
        }
        const visibleKeys = new Set(observed.map(span => `${i}:${span.kind}:${span.ordinal}`));
        for (const [key, item] of pending) {
          if (item.index === i && !visibleKeys.has(key)) {
            clearTimeout(item.timer); pending.delete(key);
            trace('pending_cancelled', { index: i, occurrence: key, reason: 'occurrence_revised_away' });
          }
        }
        if (observed.length) {
          // A prior generic Play timer must not race a newly heard loop request.
          if (pending.has(i)) { clearTimeout(pending.get(i).timer); pending.delete(i); }
          for (const span of observed) {
            const key = `${i}:${span.kind}:${span.ordinal}`;
            if (executed.has(key)) {
              trace('result_ignored', { index: i, occurrence: key, reason: 'occurrence_already_executed' });
              continue;
            }
            const intent = detectVoiceIntent(span.phrase);
            if (!intent) continue;
            const candidate = { intent, transcript: result[observedAlternative].transcript.trim(), occurrenceKey: key };
            trace('occurrence_selected', { index: i, occurrence: key, alternative: observedAlternative,
              phrase: span.phrase, command: voiceIntentKey(intent), isFinal: result.isFinal });
            const previous = pending.get(key);
            if (result.isFinal || span.kind !== 'loop') {
              if (previous) clearTimeout(previous.timer);
              pending.delete(key);
              dispatch(i, candidate);
            } else {
              const signature = voiceIntentKey(intent);
              if (previous?.signature === signature) continue;
              if (previous) clearTimeout(previous.timer);
              trace('command_scheduled', { index: i, occurrence: key, command: signature, delayMs: 800 });
              pending.set(key, { index: i, signature, timer: setTimeout(() => {
                pending.delete(key); dispatch(i, candidate);
              }, 800) });
            }
          }
          continue;
        }
        for (let a = 0; a < Math.min(result.length, 5); a++) {
          const transcript = result[a]?.transcript?.trim();
          const intent = detectVoiceIntent(transcript);
          trace('candidate_parsed', { index: i, alternative: a, transcript: transcript || '', command: intent ? voiceIntentKey(intent) : null });
          if (!intent) continue;
          // A partial “mark” could still become “mark start” or “mark end”.
          if (!result.isFinal && intent.type === 'mark' && normalizeVoice(transcript) === 'mark') { trace('candidate_waiting', { index: i, reason: 'partial_mark_needs_completion' }); continue; }
          candidates.push({ intent, transcript });
        }
        // Complete loop requests beat a generic play/wake alternative.
        const rank = ({ intent }) => ['loop-number', 'loop-name'].includes(intent.type)
          ? 4 : intent.type === 'need-loop' ? 3 : intent.type === 'wake-practice' ? 0 : intent.type === 'play' ? 1 : 2;
        candidates.sort((a, b) => rank(b) - rank(a));
        const candidate = candidates[0];
        if (executed.has(i)) {
          // Chrome can finalize a longer request after interim Play resumed the
          // video. Permit one final target refinement, never another mark/play.
          if (executed.get(i) === 'play' && result.isFinal && candidate &&
              ['loop-number', 'loop-name'].includes(candidate.intent.type) &&
              /^play\b/.test(normalizeVoice(candidate.transcript))) {
            recordVoiceHistory({ previousAction: 'play' }, row);
            trace('command_refined', { index: i, from: 'play', to: voiceIntentKey(candidate.intent) });
            executed.delete(i);
          } else { trace('result_ignored', { index: i, reason: 'utterance_already_executed', command: executed.get(i) }); continue; }
        }
        const previous = pending.get(i);
        if (!candidate) {
          trace('result_unmatched', { index: i, final: result.isFinal, pendingCancelled: !!previous });
          if (previous) clearTimeout(previous.timer);
          pending.delete(i);
          if (firstTranscript) status(`Listening… “${firstTranscript.slice(-80)}”`);
          continue;
        }
        const { intent } = candidate;
        trace('candidate_selected', { index: i, command: voiceIntentKey(intent), transcript: candidate.transcript, isFinal: result.isFinal });
        recordVoiceHistory({ command: voiceIntentKey(intent), outcome: woken.has(i) && ['need-loop', 'wake-practice'].includes(intent.type)
          ? 'Waiting for a loop (5 seconds)' : 'Waiting for request to finish' }, row);
        const immediate = ['mark', 'mark-start', 'mark-end', 'save-mark', 'pause', 'wake-practice', 'need-loop'].includes(intent.type);
        if (result.isFinal || immediate) {
          if (previous) clearTimeout(previous.timer);
          pending.delete(i);
          dispatch(i, candidate);
        } else {
          // Let “play” become “play loop two”, and “loop two” gain “slower”.
          // Repeated identical hypotheses do not push the deadline back.
          const key = voiceIntentKey(intent) + ':' + normalizeVoice(candidate.transcript);
          if (previous?.key === key) { trace('candidate_waiting', { index: i, reason: 'unchanged_hypothesis_keeps_deadline' }); continue; }
          if (previous) clearTimeout(previous.timer);
          const delayMs = intent.type === 'play' ? (completeLoops().length ? 1400 : 900) : ['loop-number', 'loop-name'].includes(intent.type) ? 800 : 450;
          trace('command_scheduled', { index: i, command: voiceIntentKey(intent), delayMs, replacedPending: !!previous });
          pending.set(i, { key, timer: setTimeout(() => {
            pending.delete(i);
            dispatch(i, candidate);
          }, delayMs) });
        }
      }
    };

    recognition.onerror = event => {
      touchVoiceHealth('recognition_error');
      state.voiceRecognizing = false;
      trace('recognition_error', { error: event.error, message: event.message || '', diagnosticContext: diagnosticContext() });
      if (!current()) return;
      cancelPending();
      state.voiceStartPending = false;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        status('Microphone/speech permission was blocked. Allow it for YouTube and try again.', 'warn');
        state.listening = false;
        state.voiceLog.end('permission_error', logSession);
        clearPracticeWake();
        clearVoiceRestartTimer();
        renderMicState();
        return;
      }

      if (event.error === 'network') {
        state.voiceRetryCount += 1;
        const delay = Math.min(5000, 700 * Math.pow(1.7, Math.max(0, state.voiceRetryCount - 1)));
        status(`Speech service network error. Retrying${state.voiceMode === 'cloud' ? ' (cloud)' : ''}…`, 'warn');
        // onend will perform the actual delayed restart. Keeping restart in one
        // place avoids the InvalidStateError that caused “could not start”.
        state._voiceNextRetryDelay = delay;
        return;
      }

      if (event.error === 'phrases-not-supported') {
        state.voicePhrasesEnabled = false;
        status('Voice phrase boosting is unavailable here; continuing without it…', 'warn');
        state._replaceVoiceRecognition = true;
        return;
      }

      if (event.error === 'language-not-supported' && state.voiceMode === 'local') {
        // Local pack was not usable after all. Recreate in cloud mode.
        state.voiceMode = 'cloud';
        state._replaceVoiceRecognition = true;
        state._forceCloudVoice = true;
        status('On-device English was unavailable. Falling back to cloud voice…', 'warn');
        return;
      }

      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        status(`Voice error: ${event.error}. Retrying…`, 'warn');
      }
    };

    recognition.onend = () => {
      touchVoiceHealth('recognition_ended');
      state.voiceRecognizing = false;
      trace('recognition_ended', { willRetry: current() });
      cancelPending();
      executed.clear();
      woken.clear();
      history.clear();
      if (state.recognition !== recognition) return;
      state.voiceStartPending = false;
      if (!state.listening) return;

      const delay = state._voiceNextRetryDelay || 500;
      state._voiceNextRetryDelay = null;

      if (state._replaceVoiceRecognition || state._forceCloudVoice) {
        const preferLocal = state.voiceMode === 'local' && !state._forceCloudVoice;
        state._replaceVoiceRecognition = false;
        state._forceCloudVoice = false;
        state.recognition = createRecognition({ preferLocal });
      }
      scheduleVoiceRestart(delay);
    };

    return recognition;
  }

  function startRecognitionSafely() {
    if (!state.listening || state.voiceStartPending) return;
    if (!state.recognition) {
      state.recognition = createRecognition({ preferLocal: state.voiceMode === 'local' });
      if (!state.recognition) {
        state.listening = false;
        renderMicState();
        status('Voice recognition is not available in this Chrome context.', 'warn');
        return;
      }
    }

    state.voiceStartPending = true;
    try {
      state.recognition._pmTrace?.('start_requested');
      state.recognition.start();
    } catch (error) {
      state.recognition?._pmTrace?.('start_failed', { name: error?.name, message: error?.message });
      state.voiceStartPending = false;
      // InvalidStateError means Chrome is still closing the prior recognition
      // session. Wait for it rather than treating this as a fatal startup error.
      if (error?.name === 'InvalidStateError') {
        scheduleVoiceRestart(650);
      } else {
        state.voiceRetryCount += 1;
        status('Voice could not start. Retrying…', 'warn');
        scheduleVoiceRestart(Math.min(4000, 700 * state.voiceRetryCount));
      }
    }
  }

  async function toggleVoice() {
    if (state.listening || state.voicePreparing) {
      voiceLog('stop_clicked');
      state.voiceGeneration += 1;
      state.voiceCancelPending?.();
      const oldRecognition = state.recognition;
      state.recognition = null;
      state.listening = false;
      state.voiceRecognizing = false;
      state.voicePreparing = false;
      state.voiceStartPending = false;
      clearVoiceRestartTimer();
      clearVoiceHealthWatchdog();
      state.voiceWatchdogRestarting = false;
      clearPracticeWake();
      try { oldRecognition?.abort(); } catch (_) {}
      renderMicState();
      state.voiceLog.end('stop_clicked');
      status('Listening stopped. Export the voice log before refreshing.');
      return;
    }

    state.voiceLog.start({ videoId: state.videoId, engine: 'Chrome cloud', language: 'en-US',
      mode: 'normal-use', diagnosticContext: diagnosticContext() });
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      status('Voice recognition is not available in this Chrome context.', 'warn');
      return;
    }

    const generation = ++state.voiceGeneration;
    state.voicePreparing = true;
    renderMicState();
    status('Preparing voice recognition…', '');

    const useLocal = false; // Explicit Chrome service baseline; no local engine or language-pack install.

    if (!state.voicePreparing || generation !== state.voiceGeneration) return;
    state.voicePreparing = false;
    state.voiceMode = useLocal ? 'local' : 'cloud';
    state.recognition = createRecognition({ preferLocal: useLocal });
    if (!state.recognition) {
      state.listening = false;
      renderMicState();
      status('Voice recognition is not available in this Chrome context.', 'warn');
      return;
    }

    state.listening = true;
    state.voiceRetryCount = 0;
    state.voiceWatchdogRestarts = 0;
    state.voiceWatchdogRestarting = false;
    startVoiceHealthWatchdog();
    renderMicState();
    startRecognitionSafely();
  }

  function renderMicState() {
    const btn = root?.querySelector('[data-action="voice"]');
    if (!btn) return;
    const active = state.listening || state.voicePreparing;
    btn.classList.toggle('active', active);
    btn.textContent = state.voicePreparing ? '… Preparing voice' : (state.listening ? '● Listening · Stop' : '🎙 Listen');
    const label = root?.querySelector('.pm-voice-start-label');
    if (label) label.textContent = state.voicePreparing ? 'STARTING' : (state.listening ? 'VOICE ON' : 'START HERE');
  }

  function renderLoopState() {
    const btn = root?.querySelector('[data-action="loop"]');
    if (!btn) return;
    btn.classList.toggle('active', state.looping);
    btn.textContent = state.looping ? '⟳ Looping' : '⟳ Loop';
  }

  function updateSpeedUI() {
    const el = root?.querySelector('.pm-speed');
    const video = getVideo();
    if (el && video) el.textContent = `${video.playbackRate}×`;
  }

  function updateTimeUI() {
    const el = root?.querySelector('.pm-video-time');
    const video = getVideo();
    if (el && video) el.textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
  }

  function renderMarks() {
    const wrap = root?.querySelector('.pm-marks');
    if (!wrap) return;
    if (!state.marks.length) {
      wrap.innerHTML = '<div class="pm-empty">No marks yet. Say “mark that” as the video plays.</div>';
      return;
    }

    wrap.innerHTML = state.marks.map((mark, index) => {
      const usedBy = state.loops
        .map((loop, loopIdx) => ({
          number: loopIdx + 1,
          start: loop.startMarkId === mark.id,
          end: loop.endMarkId === mark.id
        }))
        .filter(x => x.start || x.end)
        .map(x => `L${x.number}${x.start ? 'A' : 'B'}`)
        .join(' · ');

      return `
        <div class="pm-mark" draggable="true" data-mark-id="${mark.id}" title="Drag this mark onto any loop Start/End slot">
          <div class="pm-mark-number">M${index + 1}</div>
          <div class="pm-mark-main">
            <div class="pm-mark-time">${fmt(mark.time)}</div>
            <div class="pm-mark-used">${usedBy || 'free mark'}</div>
          </div>
          <button class="pm-delete" data-delete-mark="${mark.id}" title="Delete mark">×</button>
        </div>`;
    }).join('');
  }

  function markOptions(selectedId) {
    const none = '<option value="">— choose mark —</option>';
    return none + state.marks.map((mark, index) => `
      <option value="${mark.id}" ${mark.id === selectedId ? 'selected' : ''}>M${index + 1} · ${fmt(mark.time)}</option>
    `).join('');
  }

  function renderLoops() {
    const wrap = root?.querySelector('.pm-loops');
    if (!wrap) return;
    const activeChanged = state.activeLoopId && state.activeLoopId !== lastRenderedActiveLoopId;
    if (!state.loops.length) {
      wrap.innerHTML = '<div class="pm-empty">Loops appear automatically in pairs: M1→M2, M3→M4…</div>';
      lastRenderedActiveLoopId = null;
      return;
    }

    wrap.innerHTML = state.loops.map((loop, index) => {
      const active = loop.id === state.activeLoopId;
      const valid = isValidLoop(loop);
      const range = loopRange(loop);
      const open = loop.startMarkId && !loop.endMarkId;
      return `
        <div class="pm-loop-card ${active ? 'active' : ''} ${!valid && !open ? 'invalid' : ''}" data-loop-id="${loop.id}">
          <div class="pm-loop-head">
            <div class="pm-loop-title-row">
              <button class="pm-loop-number ${active ? 'active' : ''}" data-activate-loop="${loop.id}" title="Practice this loop">${active && state.looping ? '▶' : 'L'}${index + 1}</button>
              <input class="pm-loop-name" data-loop-name="${loop.id}" value="${escapeHtml(loop.name || '')}" placeholder="Loop ${index + 1}" maxlength="40" aria-label="Loop ${index + 1} name" title="Rename it, then say the name: e.g. Chorus again or Practice chorus">
            </div>
            <button class="pm-delete-loop" data-delete-loop="${loop.id}" title="Delete loop">×</button>
          </div>

          <div class="pm-loop-slots">
            <label class="pm-slot" data-drop-loop="${loop.id}" data-drop-field="startMarkId">
              <span>START</span>
              <select data-loop-select="${loop.id}" data-loop-field="startMarkId">${markOptions(loop.startMarkId)}</select>
            </label>
            <div class="pm-loop-arrow">→</div>
            <label class="pm-slot" data-drop-loop="${loop.id}" data-drop-field="endMarkId">
              <span>END</span>
              <select data-loop-select="${loop.id}" data-loop-field="endMarkId">${markOptions(loop.endMarkId)}</select>
            </label>
          </div>

          <div class="pm-loop-meta ${valid ? '' : 'warn'}">
            ${valid ? `${fmt(range.start)} → ${fmt(range.end)} · ${(range.end - range.start).toFixed(1)}s` : (open ? 'Waiting for the next mark…' : 'Assign a valid start and end')}
          </div>

          <div class="pm-loop-actions">
            <button class="pm-mini-btn primary" data-practice-loop="${loop.id}" ${valid ? '' : 'disabled'}>▶ Practice</button>
            <button class="pm-mini-btn" data-again-loop="${loop.id}" ${valid ? '' : 'disabled'}>↶ Again</button>
            <button class="pm-mini-btn" data-slower-loop="${loop.id}">−</button>
            <span class="pm-loop-speed">${Number(loop.playbackRate || 1)}×</span>
            <button class="pm-mini-btn" data-faster-loop="${loop.id}">+</button>
          </div>
        </div>`;
    }).join('');

    if (activeChanged && state.loops.length > 2) {
      requestAnimationFrame(() => {
        const card = wrap.querySelector('.pm-loop-card.active');
        if (!card) return;
        // The panel itself is the only vertical scroller. Keep the selected/new
        // loop visible without creating a second scrollbar inside Loops.
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      });
    }
    lastRenderedActiveLoopId = state.activeLoopId;
  }

  function render() {
    if (!root) return;
    root.classList.toggle('pm-hidden', !state.panelVisible);
    renderMarks();
    renderLoops();
    renderLoopState();
    renderMicState();
    renderReviewPrompt();
    updateSpeedUI();
    updateTimeUI();

    const count = root.querySelector('.pm-capture-count');
    if (count) {
      const openLoop = [...state.loops].reverse().find(loop => loop.startMarkId && !loop.endMarkId);
      count.textContent = openLoop
        ? `Next mark finishes Loop ${loopIndex(openLoop.id)}`
        : `Next mark starts Loop ${state.loops.length + 1}`;
    }
  }

  async function handleAction(action) {
    switch (action) {
      case 'mark': return addSequentialMark();
      case 'free-mark': return addStandaloneMark();
      case 'start': return markExplicitStart();
      case 'end': return markExplicitEnd();
      case 'new-loop': return createEmptyLoop();
      case 'again': return again();
      case 'play': return playVideo();
      case 'pause': return pauseVideo();
      case 'loop': return toggleLoop();
      case 'voice': return toggleVoice();
      case 'export-voice-log': return exportVoiceLog();
      case 'clear-voice-history': state.voiceHistory = []; return renderVoiceHistory();
      case 'slower': return changeLoopSpeed(-1);
      case 'faster': return changeLoopSpeed(1);
      case 'normal': return normalSpeed();
      case 'back5': return jumpRelative(-5);
      case 'forward5': return jumpRelative(5);
      case 'next-loop': return cycleLoop(1);
      case 'prev-loop': return cycleLoop(-1);
      case 'close': state.panelVisible = false; return render();
      case 'clear': return clearAll();
      case 'dismiss-review': return dismissReviewPrompt();
      case 'rate-extension': return openReviewPage();
    }
  }

  function mount() {
    if (document.getElementById('pm-root')) return;
    root = document.createElement('div');
    root.id = 'pm-root';
    root.innerHTML = `
      <div class="pm-card">
        <div class="pm-topbar">
          <div class="pm-brand"><span class="pm-dot"></span><span>Practice Mark</span><span class="pm-version">v${chrome.runtime.getManifest().version}</span></div>
          <div class="pm-top-actions">
            <span class="pm-video-time">--:--</span>
            <button class="pm-icon-btn" data-action="close" title="Hide panel">×</button>
          </div>
        </div>

        <div class="pm-section pm-capture-section">
          <div class="pm-capture-label">CAPTURE</div>
          <div class="pm-row">
            <button class="pm-btn primary" data-action="mark">＋ Mark</button>
            <button class="pm-btn" data-action="again">↶ Again</button>
            <button class="pm-btn" data-action="loop">⟳ Loop</button>
          </div>
          <div class="pm-capture-count">Next mark starts Loop 1</div>
          <div class="pm-status">Say “mark that” as the video plays. Two marks make a loop automatically. Voice works best when your voice is clearer than the video audio.</div>
        </div>

        <div class="pm-section pm-transport">
          <div class="pm-row five">
            <button class="pm-btn compact" data-action="prev-loop">‹ Loop</button>
            <button class="pm-btn compact" data-action="back5">−5s</button>
            <button class="pm-btn compact" data-action="normal"><span class="pm-speed">1×</span></button>
            <button class="pm-btn compact" data-action="forward5">+5s</button>
            <button class="pm-btn compact" data-action="next-loop">Loop ›</button>
          </div>
          <div class="pm-voice-start pm-gap-top">
            <div class="pm-voice-start-label">START HERE</div>
            <button class="pm-btn mic pm-full" data-action="voice">🎙 Listen</button>
            <div class="pm-voice-start-help">Turn on voice controls, then keep watching. Practice Mark does not record audio.</div>
          </div>
        </div>

        <div class="pm-review-slot pm-hidden"></div>

        <div class="pm-section">
          <div class="pm-section-head">
            <div>
              <div class="pm-section-title">Loops</div>
              <div class="pm-section-sub">Change dropdowns or drag marks onto Start / End.</div>
            </div>
            <button class="pm-text-btn" data-action="new-loop">+ New loop</button>
          </div>
          <div class="pm-loops"></div>
        </div>

        <div class="pm-section">
          <div class="pm-section-head">
            <div>
              <div class="pm-section-title">Marks</div>
              <div class="pm-section-sub">Click to jump · drag to assign.</div>
            </div>
            <div class="pm-head-actions">
              <button class="pm-text-btn" data-action="free-mark">+ Free mark</button>
              <button class="pm-text-btn danger" data-action="clear">Clear</button>
            </div>
          </div>
          <div class="pm-marks"></div>
        </div>

        <details class="pm-section pm-diagnostics">
          <summary>Diagnostics</summary>
          <div class="pm-section-sub">If a voice command fails, export diagnostics before refreshing and send the JSON with your support request. Practice Mark does not record audio.</div>
          <button class="pm-text-btn" data-action="export-voice-log">Export voice diagnostics</button>
        </details>
        <div class="pm-footer">
          <div>Voice: “mark that” · “wait / pause / hold on” · “slower / slow down” · “faster / speed up” · “play loop one” · “again”</div>
          <a class="pm-made-by" href="https://glyphanalytics.com/" target="_blank" rel="noopener noreferrer" title="Glyph Analytics">
            <img class="pm-glyph-logo" src="${chrome.runtime.getURL('glyph-mark.png')}" alt="" aria-hidden="true"><span>Made by <strong>GLYPH</strong></span>
          </a>
        </div>
      </div>`;

    toastEl = document.createElement('div');
    toastEl.className = 'pm-toast';
    document.documentElement.append(root, toastEl);

    root.addEventListener('click', event => {
      const deleteMarkBtn = event.target.closest('[data-delete-mark]');
      if (deleteMarkBtn) {
        event.stopPropagation();
        deleteMark(deleteMarkBtn.dataset.deleteMark);
        return;
      }

      const deleteLoopBtn = event.target.closest('[data-delete-loop]');
      if (deleteLoopBtn) {
        event.stopPropagation();
        deleteLoop(deleteLoopBtn.dataset.deleteLoop);
        return;
      }

      const practice = event.target.closest('[data-practice-loop]');
      if (practice) return activateLoop(practice.dataset.practiceLoop, { restart: true, enableLoop: true, play: true });

      const againBtn = event.target.closest('[data-again-loop]');
      if (againBtn) return again(againBtn.dataset.againLoop);

      const slower = event.target.closest('[data-slower-loop]');
      if (slower) return changeLoopSpeed(-1, getLoop(slower.dataset.slowerLoop));

      const faster = event.target.closest('[data-faster-loop]');
      if (faster) return changeLoopSpeed(1, getLoop(faster.dataset.fasterLoop));

      const activate = event.target.closest('[data-activate-loop]');
      if (activate) return activateLoop(activate.dataset.activateLoop, { restart: true, enableLoop: true, play: true });

      const mark = event.target.closest('[data-mark-id]');
      if (mark && !event.target.closest('button')) {
        const item = getMark(mark.dataset.markId);
        if (item) seek(item.time);
        return;
      }

      const button = event.target.closest('[data-action]');
      if (button) handleAction(button.dataset.action);
    });

    root.addEventListener('change', event => {
      const select = event.target.closest('[data-loop-select]');
      if (select) {
        assignLoopMark(select.dataset.loopSelect, select.dataset.loopField, select.value);
      }
    });

    root.addEventListener('blur', event => {
      const input = event.target.closest('[data-loop-name]');
      if (input) renameLoop(input.dataset.loopName, input.value);
    }, true);

    root.addEventListener('keydown', event => {
      const input = event.target.closest('[data-loop-name]');
      if (input && event.key === 'Enter') input.blur();
    });

    root.addEventListener('dragstart', event => {
      const mark = event.target.closest('[data-mark-id]');
      if (!mark) return;
      event.dataTransfer.setData('text/practice-mark-id', mark.dataset.markId);
      event.dataTransfer.effectAllowed = 'copy';
      mark.classList.add('dragging');
    });

    root.addEventListener('dragend', event => {
      event.target.closest('[data-mark-id]')?.classList.remove('dragging');
      root.querySelectorAll('.pm-slot.drag-over').forEach(el => el.classList.remove('drag-over'));
    });

    root.addEventListener('dragover', event => {
      const slot = event.target.closest('[data-drop-loop]');
      if (!slot) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      root.querySelectorAll('.pm-slot.drag-over').forEach(el => el.classList.remove('drag-over'));
      slot.classList.add('drag-over');
    });

    root.addEventListener('dragleave', event => {
      event.target.closest('[data-drop-loop]')?.classList.remove('drag-over');
    });

    root.addEventListener('drop', event => {
      const slot = event.target.closest('[data-drop-loop]');
      if (!slot) return;
      event.preventDefault();
      slot.classList.remove('drag-over');
      const markId = event.dataTransfer.getData('text/practice-mark-id');
      if (markId && getMark(markId)) {
        assignLoopMark(slot.dataset.dropLoop, slot.dataset.dropField, markId);
      }
    });

    render();
    renderVoiceHistory();
  }

  function startTimers() {
    clearInterval(timeTimer);
    clearInterval(loopTimer);
    timeTimer = setInterval(updateTimeUI, 500);
    loopTimer = setInterval(() => {
      if (!state.looping) return;
      const loop = activeLoop();
      const range = loopRange(loop);
      if (!loop || !range || range.end <= range.start) return;
      const video = getVideo();
      if (!video || video.paused) return;
      if (video.currentTime >= range.end - 0.035 || video.currentTime < range.start - 0.2) {
        video.currentTime = range.start;
      }
    }, 55);
  }

  function handleCommand(command) {
    if (command === 'mark') addSequentialMark();
    if (command === 'again') again();
    if (command === 'toggle-loop') toggleLoop();
    if (command === 'next-loop') cycleLoop(1);
  }

  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'PM_TOGGLE_PANEL') {
      state.panelVisible = !state.panelVisible;
      render();
    }
    if (message?.type === 'PM_COMMAND') handleCommand(message.command);
  });

  // YouTube is a SPA: reload the correct marks/loops when the video changes.
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      const id = getVideoId();
      if (id !== state.videoId) {
        state.looping = false;
        loadStateForVideo();
      }
    }
  }, 600);

  mount();
  startTimers();
  loadEngagement();
  loadStateForVideo();
})();

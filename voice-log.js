/* Full, append-only text diagnostics. No audio capture and no network calls. */
(() => {
  class VoiceSessionLog {
    constructor(metadata = {}, clock = () => ({ wall: Date.now(), monotonic: globalThis.performance?.now?.() ?? Date.now() })) {
      this.metadata = metadata;
      this.clock = clock;
      this.sessions = [];
      this.active = null;
    }
    start(metadata = {}) {
      if (this.active) this.end('new_listen_click');
      const now = this.clock();
      const session = { id: this.sessions.length + 1, startedAt: new Date(now.wall).toISOString(),
        timezoneOffsetMinutes: new Date(now.wall).getTimezoneOffset(), originMs: now.monotonic,
        metadata, endedAt: null, events: [] };
      this.sessions.push(session);
      this.active = session;
      this.add('listen_clicked', {}, session);
      return session;
    }
    add(type, details = {}, session = this.active) {
      if (!session) return null;
      const now = this.clock();
      const entry = { sequence: session.events.length + 1, at: new Date(now.wall).toISOString(),
        elapsedMs: Math.round((now.monotonic - session.originMs) * 10) / 10, type,
        details: JSON.parse(JSON.stringify(details)) };
      session.events.push(entry);
      return entry;
    }
    end(reason, session = this.active) {
      if (!session || session.endedAt) return;
      const entry = this.add('session_ended', { reason }, session);
      session.endedAt = entry.at;
      if (this.active === session) this.active = null;
    }
    snapshot() {
      return JSON.parse(JSON.stringify({ schemaVersion: 2, exportedAt: new Date(this.clock().wall).toISOString(),
        metadata: this.metadata,
        timingNote: 'Timestamps describe browser events. Guided-test latency is measured from the Arm click to command dispatch and therefore includes human reaction time; no audio is recorded.',
        sessions: this.sessions.map(({ originMs, ...session }) => session) }));
    }
  }
  globalThis.PMVoiceSessionLog = VoiceSessionLog;
})();

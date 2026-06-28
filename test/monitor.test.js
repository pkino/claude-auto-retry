import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorState, processOneTick } from '../src/monitor.js';
import { DEFAULT_CONFIG } from '../src/config.js';

function mockTmux(paneContent = '', paneCommand = 'node', claudeForeground = true) {
  const t = {
    _sent: [],
    _escapes: 0,
    capturePane: async () => paneContent,
    getPaneCommand: async () => paneCommand,
    sendKeys: async (_p, text) => { t._sent.push(text); },
    sendEscape: async () => { t._escapes++; },
    isClaudeForeground: async () => claudeForeground,
  };
  return t;
}

describe('processOneTick', () => {
  it('returns monitoring when no rate limit', async () => {
    const t = mockTmux('Normal output');
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'monitoring');
    assert.equal(t._sent.length, 0);
  });
  it('enters waiting on rate limit', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)');
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'waiting');
    assert.ok(s.waitUntil > Date.now());
  });
  it('exits when PID dead', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => false), 'exit');
  });
  it('sends retry when wait expired and rate limit visible', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'retried');
    assert.equal(t._sent.length, 1);
    assert.equal(s.attempts, 1);
    // Should stay in 'waiting' with a cooldown to let Claude process
    assert.equal(s.status, 'waiting');
    assert.ok(s.waitUntil > Date.now());
  });
  it('detects multi-line TUI rate limit', async () => {
    const t = mockTmux('⚠ You\'ve hit your limit\n· resets 3pm (UTC)');
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'waiting');
    assert.ok(s.waitUntil > Date.now());
  });
  it('retries when Claude process is in foreground (fixes macOS zsh issue)', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)', 'zsh', true);
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'retried');
    assert.equal(t._sent.length, 1);
  });
  it('falls back to pane_current_command when process state is false', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)', 'vim', false);
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'skipped-not-claude');
    assert.equal(t._sent.length, 0);
    assert.equal(s._lastForeground, 'vim');
  });
  it('falls back to pane_current_command when process state is null', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)', 'vim', null);
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'skipped-not-claude');
    assert.equal(t._sent.length, 0);
    assert.equal(s._lastForeground, 'vim');
  });
  it('accepts custom foregroundCommands in fallback path', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)', 'my-claude-wrapper', null);
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    const config = { ...DEFAULT_CONFIG, foregroundCommands: ['my-claude-wrapper'] };
    assert.equal(await processOneTick(s, t, '%0', config, () => true), 'retried');
    assert.equal(t._sent.length, 1);
  });
  it('matches npx in fallback path', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)', 'npx', null);
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'retried');
  });
  it('resets counter when Claude has actually resumed (busy)', async () => {
    // "Banner gone" alone is NOT enough (see Issue #21) — Claude must look busy.
    const t = mockTmux('Claude is working normally\n(esc to interrupt)');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting'; s.attempts = 2;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(s.attempts, 0);
  });
  it('stops retrying after max attempts and stays in waiting', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting'; s.attempts = 5;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'max-retries');
    // Should stay in 'waiting' to avoid re-detection loop
    assert.equal(s.status, 'waiting');
    assert.ok(s.waitUntil > Date.now());
  });
  it('resets from max-retries when Claude has resumed (busy)', async () => {
    const t = mockTmux('Claude is working normally\n(esc to interrupt)');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting'; s.attempts = 10;
    // Claude resumed → should detect user-continued before max-retries check
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(s.attempts, 0);
  });

  // --- Issue #21: banner clears at reset time but session is idle ---
  it('sends retry when banner cleared but session is idle (Issue #21)', async () => {
    // After the limit resets, Claude clears the banner; the session sits idle
    // at the prompt. The old code wrongly concluded "user-continued" and never
    // resumed. Now it must send the retry to wake the idle session.
    const t = mockTmux('\n  Claude Code\n  > \n');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'retried');
    assert.equal(t._sent.length, 1);
    assert.equal(s.attempts, 1);
    assert.ok(s._sigBeforeSend, 'pane signature snapshotted before send');
  });
  it('stops resending once the pane changes after a retry (Claude resumed)', async () => {
    const t = mockTmux('different output now\nmodel is responding');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting'; s.attempts = 1;
    s._sigBeforeSend = 'old pane signature that no longer matches';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(t._sent.length, 0);
    assert.equal(s.attempts, 0);
  });
  it('honors retryOnExpiryWhenCleared:false (legacy behavior)', async () => {
    const t = mockTmux('\n  idle prompt\n  > \n');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    const config = { ...DEFAULT_CONFIG, retryOnExpiryWhenCleared: false };
    assert.equal(await processOneTick(s, t, '%0', config, () => true), 'user-continued');
    assert.equal(t._sent.length, 0);
  });
  // --- Issue #19: interactive /rate-limit-options menu ---
  it('dismisses the /rate-limit-options menu with Escape (never confirms upgrade)', async () => {
    const text = [
      "⎿  You've hit your session limit · resets 12:10am (Europe/Dublin)",
      '/rate-limit-options',
      'What do you want to do?',
      '❯ 1. Upgrade your plan',          // upgrade highlighted as default!
      '  2. Stop and wait for limit to reset',
      'Enter to confirm · Esc to cancel',
    ].join('\n');
    const t = mockTmux(text);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'dismissed-rate-limit-menu');
    assert.equal(t._escapes, 1, 'sent Escape');
    assert.equal(t._sent.length, 0, 'never pressed Enter into the menu');
    assert.equal(s.status, 'waiting');
    assert.ok(s.waitUntil > Date.now());
  });
  it('does not re-dismiss the same menu every tick', async () => {
    const text = [
      "You've hit your session limit · resets 12:10am (Europe/Dublin)",
      '/rate-limit-options',
      'What do you want to do?',
      '❯ 1. Stop and wait for limit to reset',
      'Enter to confirm · Esc to cancel',
    ].join('\n');
    const t = mockTmux(text);
    const s = createMonitorState();
    await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true);
    const r2 = await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true);
    assert.equal(t._escapes, 1, 'Escape sent only once for the same menu');
    assert.equal(r2, 'waiting');
  });

  // --- busy detection (stale rate-limit text while Claude is working) ---
  it('ignores stale rate-limit text while Claude is visibly thinking', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)\n· Herding… (3m · thinking with xhigh effort)');
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'monitoring');
    assert.equal(t._sent.length, 0);
  });
  it('clears waiting state when Claude is visibly busy after a retry', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)\n✽ Booping… (1m 43s · ↓ 5.6k tokens)');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting'; s.attempts = 1;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(s.status, 'monitoring');
    assert.equal(s.attempts, 0);
    assert.equal(t._sent.length, 0);
  });

  it('does not over-wait ~24h on a stale past reset time', async () => {
    // A lingering "resets 12:20am" line whose time already passed would make
    // calculateWaitMs add 24h. The guard keeps us monitoring instead.
    const past = new Date(Date.now() - 60_000);
    let hh = past.getHours();
    const ampm = hh >= 12 ? 'pm' : 'am';
    hh = hh % 12; if (hh === 0) hh = 12;
    const mm = String(past.getMinutes()).padStart(2, '0');
    const t = mockTmux(`You've hit your limit · resets ${hh}:${mm}${ampm}`);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'monitoring');
  });
});

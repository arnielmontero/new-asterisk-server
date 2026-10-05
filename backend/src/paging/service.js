'use strict';
const { EventEmitter } = require('node:events');
const { HttpError, conflict } = require('../errors');
const { PAGING_GROUPS, pagingTargets, isExtension } = require('../extensions/registry');

const AUTH_FAMILY = 'page_auth';

/**
 * Live paging coordinator.
 *
 * The microphone audio comes from the operator's own browser SIP client (a normal
 * call from their registered extension to 700/701/702). This service is the
 * authorisation + audit step in front of that call: it writes a short-lived,
 * single-use authorisation into Asterisk's AstDB (via AMI) keyed by the operator's
 * extension. The dialplan refuses any page call that has no matching, unexpired
 * authorisation, so a SIP login alone cannot page.
 *
 * Lifecycle is driven by UserEvents emitted from the dialplan:
 *   PageStarted / PageEnded / PageDenied.
 *
 * Emits: 'started', 'ended', 'failed'.
 */
class PagingService extends EventEmitter {
  constructor({ ami, state, audit, logger, authTtlSeconds = 20 }) {
    super();
    this.ami = ami;
    this.state = state;
    this.audit = audit;
    this.logger = logger;
    this.authTtlSeconds = authTtlSeconds;
    this.active = null; // { group, username, userId, extension, targets, status, requestedAt, startedAt }
    this.timer = null;

    ami.on('event', (evt) => {
      if (evt.Event === 'UserEvent') this.onUserEvent(evt).catch((err) => logger.error({ err: err.message }, 'paging event error'));
    });
    ami.on('disconnected', () => {
      if (this.active) this.finish('ami_disconnected');
    });
  }

  current() {
    if (!this.active) return null;
    const { group, username, extension, targets, status, requestedAt, startedAt } = this.active;
    return { group, name: PAGING_GROUPS[group].name, username, extension, targets, status, requestedAt, startedAt };
  }

  /** Authorise a page. Throws HttpError with a meaningful status on every refusal. */
  async request(user, group, ip) {
    const fail = async (err, reason) => {
      await this.audit.log({ user, action: 'paging.request', target: group, ip, status: 'failure', details: { reason } });
      throw err;
    };

    if (!user.extension) return fail(new HttpError(409, 'no_extension', 'No SIP extension is assigned to your account'), 'no_extension');
    const targets = pagingTargets(group, user.extension);
    if (targets.length === 0) {
      return fail(new HttpError(422, 'no_targets', 'There is nobody to page: you are the only member of that group'), 'no_targets');
    }
    if (!this.ami.isConnected()) return fail(new HttpError(503, 'ami_unavailable', 'The telephony system is unavailable'), 'ami_unavailable');
    if (this.active) return fail(conflict(`A page to ${PAGING_GROUPS[this.active.group].name} is already in progress`, 'page_in_progress'), 'page_in_progress');
    const mine = this.state.get(user.extension);
    if (!mine?.registered) {
      return fail(conflict('Your SIP client is not registered. Enable audio and wait for it to register, then try again.', 'sip_not_registered'), 'sip_not_registered');
    }

    // Claim the slot synchronously so two simultaneous requests cannot both pass.
    const active = {
      group,
      username: user.username,
      userId: user.id,
      extension: user.extension,
      targets,
      status: 'authorized',
      requestedAt: new Date(),
      startedAt: null,
    };
    this.active = active;

    try {
      const expires = Math.floor(Date.now() / 1000) + this.authTtlSeconds;
      const res = await this.ami.action({ Action: 'DBPut', Family: AUTH_FAMILY, Key: user.extension, Val: `${group}:${expires}` });
      if (res.response !== 'Success') throw new Error(res.message || 'DBPut refused');
    } catch (err) {
      this.active = null;
      this.logger.error({ err: err.message }, 'could not record page authorisation in Asterisk');
      return fail(new HttpError(502, 'ami_error', 'Could not authorise the page with the telephony system'), 'ami_error');
    }

    this.timer = setTimeout(() => {
      if (this.active === active && active.status === 'authorized') this.finish('no_call_received', { notify: true });
    }, (this.authTtlSeconds + 2) * 1000);
    this.timer.unref?.();

    await this.audit.log({
      user,
      action: 'paging.request',
      target: group,
      ip,
      details: { group, name: PAGING_GROUPS[group].name, targets },
    });
    this.logger.info({ user: user.username, group, targets }, 'page authorised');
    return { group, name: PAGING_GROUPS[group].name, extension: user.extension, targets, authorizedForSeconds: this.authTtlSeconds };
  }

  /** Force-end the current page (hang up the operator's channels and drop any unused authorisation). */
  async cancel(user, ip) {
    const active = this.active;
    if (!active) throw new HttpError(404, 'no_page', 'No page is in progress');
    try {
      await this.ami.action({ Action: 'DBDel', Family: AUTH_FAMILY, Key: active.extension });
    } catch { /* may already be consumed */ }
    for (const channel of this.state.channelsFor(active.extension)) {
      try {
        await this.ami.action({ Action: 'Hangup', Channel: channel, Cause: 16 });
      } catch (err) {
        this.logger.warn({ err: err.message, channel }, 'hangup during page cancel failed');
      }
    }
    await this.audit.log({ user, action: 'paging.cancel', target: active.group, ip, details: { pageOwner: active.username } });
    if (active.status === 'authorized') this.finish('cancelled', { notify: true });
  }

  async onUserEvent(evt) {
    const name = evt.UserEvent;
    if (!['PageStarted', 'PageEnded', 'PageDenied'].includes(name)) return;
    const group = String(evt.Group || '');
    const caller = String(evt.Caller || '');
    if (!PAGING_GROUPS[group] || !isExtension(caller)) return;

    if (name === 'PageStarted') {
      let active = this.active;
      if (!active || active.extension !== caller || active.group !== group) {
        // Page we did not authorise in this process (e.g. backend restarted mid-request): still reflect reality.
        active = { group, username: null, userId: null, extension: caller, targets: pagingTargets(group, caller), requestedAt: new Date() };
        this.active = active;
      }
      clearTimeout(this.timer);
      active.status = 'live';
      active.startedAt = new Date();
      this.state.setPaging({ group, caller, targets: active.targets });
      await this.audit.log({
        username: active.username,
        user: active.userId ? { id: active.userId } : undefined,
        action: 'paging.success',
        target: group,
        details: { group, extension: caller, targets: active.targets },
      });
      this.emit('started', this.current());
      return;
    }

    const active = this.active;
    if (!active || active.extension !== caller) return;

    if (name === 'PageEnded') {
      const seconds = active.startedAt ? Math.round((Date.now() - active.startedAt.getTime()) / 1000) : 0;
      await this.audit.log({
        username: active.username,
        user: active.userId ? { id: active.userId } : undefined,
        action: 'paging.end',
        target: group,
        details: { group, durationSeconds: seconds },
      });
      this.finish('ended', { seconds });
      return;
    }

    // PageDenied: dialplan refused the call (no/expired authorisation, no targets).
    await this.audit.log({
      username: active.username,
      user: active.userId ? { id: active.userId } : undefined,
      action: 'paging.failure',
      target: group,
      status: 'failure',
      details: { group, reason: evt.Reason || 'denied' },
    });
    this.finish(`denied:${evt.Reason || 'denied'}`, { notify: true, alreadyAudited: true });
  }

  /** Clear the active page and tell listeners how it ended. */
  finish(reason, { notify = false, seconds = 0, alreadyAudited = false } = {}) {
    const active = this.active;
    if (!active) return;
    clearTimeout(this.timer);
    this.active = null;
    this.state.setPaging(null);
    if (reason === 'no_call_received' && !alreadyAudited) {
      this.audit
        .log({
          username: active.username,
          user: active.userId ? { id: active.userId } : undefined,
          action: 'paging.failure',
          target: active.group,
          status: 'failure',
          details: { group: active.group, reason },
        })
        .catch(() => {});
    }
    const payload = { group: active.group, name: PAGING_GROUPS[active.group].name, extension: active.extension, username: active.username, reason, durationSeconds: seconds };
    if (notify) this.emit('failed', payload);
    else this.emit('ended', payload);
  }
}

module.exports = { PagingService, AUTH_FAMILY };

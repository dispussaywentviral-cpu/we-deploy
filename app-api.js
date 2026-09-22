/* ============================================================
   We Deploy — app-api.js (backend bridge)
   Connects Sign In / Create Account to the real server (D1).
   Falls back to the original local system if server unreachable.
   Mirrors server accounts into localStorage so every existing
   feature keeps working unchanged.
   ============================================================ */
(function(){
  'use strict';

  var TOKEN_KEY = 'wd_srv_token';
  var busy = false;

  function aerr(f, msg){ busy = false; authErr(f, msg); }

  // ---------- server token helpers ----------
  function tokenGet(){
    try{
      var raw = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
      return raw ? JSON.parse(raw) : null;
    }catch(e){ return null; }
  }
  function tokenSet(obj, remember){
    try{ (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, JSON.stringify(obj)); }catch(e){}
  }
  function tokenClear(){
    try{ localStorage.removeItem(TOKEN_KEY); }catch(e){}
    try{ sessionStorage.removeItem(TOKEN_KEY); }catch(e){}
  }

  // When the app logs out it deletes 'wd_session' — clear server token too
  try{
    var _rm = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function(k){
      if(k === 'wd_session'){ tokenClear(); }
      return _rm.call(this, k);
    };
  }catch(e){}

  // ---------- API helper (8s timeout) ----------
  function api(action, opts){
    opts = opts || {};
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function(){ ctrl.abort(); }, 8000) : null;
    if(opts.body && typeof opts.body !== 'string'){ opts.body = JSON.stringify(opts.body); }
    if(opts.body){ opts.headers = Object.assign({'Content-Type':'application/json'}, opts.headers || {}); }
    return fetch('/api/auth/' + action, opts)
      .then(function(r){ return r.json().catch(function(){ return {}; }); })
      .then(function(data){ if(timer) clearTimeout(timer); return data; },
            function(err){ if(timer) clearTimeout(timer); throw err; });
  }

  // ---------- local helpers (reuse the site's own functions) ----------
  function localLogin(email, pw){
    try{
      var u = getUsers()[email];
      if(!u || u.hash !== hashPass(pw, u.salt)) return null;
      return u;
    }catch(e){ return null; }
  }

  function mirrorUser(email, pw, serverUser, fallbackBiz){
    try{
      var users = getUsers();
      var old = users[email];
      var salt = Math.random().toString(36).slice(2,10);
      users[email] = {
        id: (serverUser && serverUser.id) || (old && old.id) || ('u' + Date.now()),
        name: (serverUser && serverUser.name) || (old && old.name) || '',
        email: email,
        biz: (serverUser && serverUser.biz) || (old && old.biz) || fallbackBiz || '',
        salt: salt,
        hash: hashPass(pw, salt),
        created: (old && old.created) || Date.now()
      };
      saveUsers(users);
      return users[email];
    }catch(e){ return null; }
  }

  // Silently create this account on the server (migrates old local-only users)
  function backgroundSync(email, pw, name, biz){
    api('signup', { method:'POST', body:{ name:name, email:email, biz:biz, password:pw } })
      .then(function(res){
        if(res && res.ok && res.session){ tokenSet({ session:res.session, email:email }, true); }
      })
      .catch(function(){});
  }

  /* ================= OVERridden Sign In ================= */
  window.doLogin = function(){
    if(busy) return;
    clearAuthErr('li');
    try{
      var emailEl = el('li-email'), pwEl = el('li-pw');
      if(!emailEl || !pwEl) return aerr('li','Sign-in form is unavailable — please refresh the page');
      var email = emailEl.value.trim().toLowerCase(), pw = pwEl.value;
      if(!email || !pw) return aerr('li','Please fill in your email and password');
      var remember = !!(el('li-remember') && el('li-remember').checked);
      busy = true;

      api('login', { method:'POST', body:{ email:email, password:pw } }).then(function(res){
        if(res && res.ok && res.user && res.session){
          var u = mirrorUser(email, pw, res.user);
          tokenSet({ session:res.session, email:email }, remember);
          createSession(u || { email:email }, remember);
          busy = false;
          window.__startApp(u || { email:email, name:(res.user.name||''), biz:(res.user.biz||'') }, false);
          return;
        }
        var lu = localLogin(email, pw);
        if(lu){
          createSession(lu, remember);
          busy = false;
          window.__startApp(lu, false);
          backgroundSync(email, pw, lu.name, lu.biz);
          return;
        }
        aerr('li', (res && res.error) ? res.error : 'Incorrect email or password — or use "Forgot password?"');
      }).catch(function(){
        var lu = localLogin(email, pw);
        if(lu){
          createSession(lu, remember);
          busy = false;
          window.__startApp(lu, false);
          return;
        }
        aerr('li','Incorrect email or password — or use "Forgot password?"');
      });
    }catch(err){ aerr('li','Unexpected error: ' + (typeof errMsg==='function' ? errMsg(err) : err)); }
  };

  /* ================= OVERridden Create Account ================= */
  window.doSignup = function(){
    if(busy) return;
    clearAuthErr('su');
    try{
      var nameEl = el('su-name'), emailEl = el('su-email'), bizEl = el('su-biz'), pwEl = el('su-pw'), pw2El = el('su-pw2');
      if(!nameEl || !emailEl || !bizEl || !pwEl || !pw2El) return aerr('su','Sign-up form is unavailable — please refresh the page');
      var name = nameEl.value.trim(), email = emailEl.value.trim().toLowerCase(), biz = bizEl.value.trim(), pw = pwEl.value, pw2 = pw2El.value;
      if(!name) return aerr('su','Please enter your full name');
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return aerr('su','Please enter a valid email address (like you@gmail.com)');
      if(pw.length < 6) return aerr('su','Password must be at least 6 characters');
      if(pw !== pw2) return aerr('su','Passwords don\'t match — tap the 👁 button to double-check');
      var fallbackBiz = biz || (name.split(' ')[0] + "'s Agency");
      busy = true;

      var ex = getUsers()[email];
      if(ex && ex.hash === hashPass(pw, ex.salt)){
        createSession(ex, true);
        busy = false;
        window.__startApp(ex, false);
        showToast('👋 That account already existed — signed you in automatically','info');
        backgroundSync(email, pw, ex.name, ex.biz);
        return;
      }

      api('signup', { method:'POST', body:{ name:name, email:email, biz:biz, password:pw } }).then(function(res){
        if(res && res.ok && res.user && res.session){
          var u = mirrorUser(email, pw, res.user, fallbackBiz);
          tokenSet({ session:res.session, email:email }, true);
          createSession(u, true);
          busy = false;
          window.__startApp(u, true);
          return;
        }
        if(res && res.error === 'Email already registered'){
          api('login', { method:'POST', body:{ email:email, password:pw } }).then(function(lres){
            if(lres && lres.ok && lres.user && lres.session){
              var u2 = mirrorUser(email, pw, lres.user, fallbackBiz);
              tokenSet({ session:lres.session, email:email }, true);
              createSession(u2, true);
              busy = false;
              window.__startApp(u2, false);
              showToast('👋 Welcome back — signed you in','info');
            } else {
              aerr('su', (lres && lres.error) ? lres.error : 'This email already has an account. Use the Sign In tab.');
            }
          }).catch(function(){
            aerr('su','This email already has an account. Use the Sign In tab.');
          });
          return;
        }
        if(ex) return aerr('su','This email already has an account with a different password. Use the Sign In tab, or "Forgot password?"');
        aerr('su', (res && res.error) ? res.error : 'Sign-up failed — please try again');
      }).catch(function(){
        if(ex) return aerr('su','This email already has an account with a different password. Use the Sign In tab, or "Forgot password?"');
        try{
          var salt = Math.random().toString(36).slice(2,10);
          var users = getUsers();
          users[email] = { id:'u'+Date.now(), name:name, email:email, biz:fallbackBiz, salt:salt, hash:hashPass(pw, salt), created:Date.now() };
          saveUsers(users);
          createSession(users[email], true);
          busy = false;
          window.__startApp(users[email], true);
        }catch(err){ aerr('su','Unexpected error: ' + (typeof errMsg==='function' ? errMsg(err) : err)); }
      });
    }catch(err){ aerr('su','Unexpected error: ' + (typeof errMsg==='function' ? errMsg(err) : err)); }
  };

})();

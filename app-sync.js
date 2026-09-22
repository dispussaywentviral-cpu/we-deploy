/* ============================================================
   We Deploy — app-sync.js
   Syncs the user's data blob (leads, invoices, pipeline, CRM,
   notes, payments) to the server. Downloads on login, uploads
   whenever anything is saved. Falls back silently when offline.
   ============================================================ */
(function(){
  'use strict';

  var TOKEN_KEY = 'wd_srv_token';
  var TS_PREFIX = 'wd_sync_ts_';
  var timer = null, uploading = false;

  function getToken(){
    try{
      var raw = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
      return raw ? JSON.parse(raw) : null;
    }catch(e){ return null; }
  }
  function hasToken(){ var t = getToken(); return !!(t && t.session); }
  function authHeaders(){
    var t = getToken();
    return (t && t.session) ? { 'Authorization': 'Bearer ' + t.session } : {};
  }
  function getLocalTs(uid){ try{ return parseInt(localStorage.getItem(TS_PREFIX + uid)) || 0; }catch(e){ return 0; } }
  function setLocalTs(uid, ts){ try{ localStorage.setItem(TS_PREFIX + uid, String(ts)); }catch(e){} }

  // ---------- UPLOAD ----------
  function uploadNow(){
    if(uploading) return;
    if(typeof CUR === 'undefined' || !CUR || !CUR.id) return;
    var uid = CUR.id, raw = null;
    try{ raw = localStorage.getItem('wd_data_' + uid); }catch(e){}
    if(raw == null) return;
    if(!hasToken()) return;
    var payload;
    try{ payload = JSON.parse(raw); }catch(e){ return; }
    uploading = true;
    fetch('/api/data/blob', {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ data: payload })
    }).then(function(r){ return r.json().catch(function(){ return {}; }); })
      .then(function(res){
        uploading = false;
        if(res && res.ok) setLocalTs(uid, Date.now());
      })
      .catch(function(){ uploading = false; });
  }
  function scheduleUpload(){
    if(timer) clearTimeout(timer);
    timer = setTimeout(function(){ timer = null; uploadNow(); }, 4000);
  }

  // ---------- DOWNLOAD (before app renders) ----------
  function downloadThen(uid, cb){
    if(!hasToken() || !uid){ cb(); return; }
    var done = false;
    function finish(data, updated){
      if(done) return; done = true;
      try{
        if(data && typeof data === 'object'){
          var localTs = getLocalTs(uid);
          if(!updated || !localTs || updated >= localTs){
            localStorage.setItem('wd_data_' + uid, JSON.stringify(data));
          }
        }
      }catch(e){}
      cb();
    }
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var kill = setTimeout(function(){ if(ctrl) ctrl.abort(); else finish(null, null); }, 5000);
    fetch('/api/data/blob', { method: 'GET', headers: authHeaders(), signal: ctrl ? ctrl.signal : undefined })
      .then(function(r){ return r.json().catch(function(){ return {}; }); })
      .then(function(res){
        clearTimeout(kill);
        if(res && res.ok) finish(res.data || null, res.updated || null);
        else finish(null, null);
      })
      .catch(function(){ clearTimeout(kill); finish(null, null); });
  }

  // ---------- wrap app start: download first, then boot ----------
  try{
    var origStart = window.__startApp;
    if(typeof origStart === 'function'){
      window.__startApp = function(u, isNew){
        try{
          if(u && u.id && hasToken()){
            downloadThen(u.id, function(){ origStart(u, isNew); });
            return;
          }
        }catch(e){}
        origStart(u, isNew);
      };
    }
  }catch(e){}

  // ---------- wrap saveUD: every save triggers a synced upload ----------
  try{
    var origSave = window.saveUD;
    if(typeof origSave === 'function'){
      window.saveUD = function(){
        var r = origSave.apply(this, arguments);
        try{
          if(typeof CUR !== 'undefined' && CUR && CUR.id) setLocalTs(CUR.id, Date.now());
        }catch(e){}
        scheduleUpload();
        return r;
      };
    }
  }catch(e){}

  // ---------- flush pending upload when leaving the page ----------
  function flush(){
    if(timer){ clearTimeout(timer); timer = null; }
    uploadNow();
  }
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', function(){
    if(document.visibilityState === 'hidden') flush();
  });
})();

// Independent page-entry tracking. Does not change widget state, Tour authority or intake.
(function () {
  var query = new URLSearchParams(location.search);
  var ref = query.get('ref');
  var path = location.pathname.replace(/\/$/, '') || '/';
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(ref || '') || !['/', '/demo'].includes(path)) return;
  // Tour opening is already recorded by its authoritative backend event.
  if (query.has('tour') || query.get('tour-entry') === '1') return;
  if (navigator.globalPrivacyControl || navigator.doNotTrack === '1') return;
  var key = 'liveask_campaign_visit:' + path + ':' + ref;
  var state;
  try { state = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch (_) {}
  if (state && state.sent) return;
  if (!state) state = { visitId: crypto.randomUUID(), sent: false };
  try { sessionStorage.setItem(key, JSON.stringify(state)); } catch (_) {}
  fetch('https://ask-liveask.chriscarroll-promptworkx.workers.dev/campaign/visit', {
    method: 'POST', credentials: 'omit', keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: ref, landingPath: path, visitId: state.visitId })
  }).then(function (response) {
    if (!response.ok) return;
    state.sent = true;
    try { sessionStorage.setItem(key, JSON.stringify(state)); } catch (_) {}
  }).catch(function () {});
})();

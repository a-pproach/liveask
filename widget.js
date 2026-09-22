// LiveAsk Platform — stable public loader.
//
// This is the permanent customer-facing installation contract:
//   <script src="https://liveask.au/widget.js" data-liveask-site="customer_001" async></script>
//
// This file is deliberately thin and should change rarely, if ever. Its
// only job is: read the tenant identity off its own script tag, create
// the mount point and shadow root, hand off configuration, then load and
// execute the actual runtime. Every ordinary platform upgrade happens by
// changing what this loader fetches internally — never by asking a
// customer or reseller to edit their installed snippet.
//
// data-liveask-site is identification/routing information only. It is
// never treated as proof of authorization here or anywhere in this
// file — that validation is strictly a backend responsibility (matching
// the requesting Origin against a configured tenant/origin relationship)
// and is intentionally out of scope for this frontend loader.
(function () {
  'use strict';

  var thisScript = document.currentScript;
  if (!thisScript) {
    console.error('LiveAsk loader: document.currentScript unavailable — cannot read installation config. Aborting.');
    return;
  }

  var tenantId = thisScript.dataset.liveaskSite || null;
  if (!tenantId) {
    console.error('LiveAsk loader: data-liveask-site is required on the installation script tag. Aborting.');
    return;
  }

  // ---- Stage A transitional configuration ----
  // No live tenant-config resolution service exists yet (see
  // LiveAsk_Deployment_Handover.md) — until it does, a deployment may
  // optionally set data-worker-url and data-company-name directly on
  // this same script tag as a transitional bridge. Neither is part of
  // the intended permanent public contract; both are read here, not
  // assumed to be a customer's ongoing responsibility.
  var workerUrl = thisScript.dataset.workerUrl || null;
  var companyName = thisScript.dataset.companyName || null;

  // Base URL this loader was itself served from, used to resolve the
  // runtime bundle and widget.css relative to the same origin rather
  // than hardcoding a second absolute URL here.
  var baseUrl = thisScript.src.replace(/[^/]*$/, '');

  // ---- Mount point + Shadow Root ----
  // Created here, unconditionally — the customer website is never
  // responsible for constructing LiveAsk DOM. An optional
  // data-liveask-mount attribute may name an existing host-page element
  // id to mount inside; absent that, the mount is appended at the end
  // of <body>.
  var mountEl = document.createElement('div');
  mountEl.setAttribute('data-liveask-root', tenantId);

  // ---- Defending the mount element's own critical geometry ----
  // Confirmed by direct browser testing (30 August 2026): Shadow DOM does
  // not, and cannot, protect the shadow HOST element itself — it is an
  // ordinary light-DOM node. A host-page rule as broad as
  // `* { all: unset !important; }` reaches it and collapses its display
  // to inline, even though the shadow tree's own contents remain fully
  // isolated. This is not a gap in the isolation claim being made — no
  // claim of protecting the host element's own box was ever made — but
  // it does mean the mount would silently fail to render as a block-level
  // container under a sufically hostile page without an explicit defence.
  //
  // Fix: set the one property that actually failed (display) via the
  // mount's own inline style, with !important. Per CSS cascade rules, an
  // inline !important declaration sits in the same "author, important"
  // tier as a stylesheet !important rule, and an inline style's
  // specificity exceeds any selector-based rule, including the universal
  // selector — so this should survive even the nuclear case. This is
  // intentionally narrow: only `display` is defended this way, since
  // that's the specific, demonstrated failure. Size and exact position
  // are deliberately left cooperative with normal page layout — that's
  // what makes the optional data-liveask-mount anchor attribute usable at
  // all, and turning every geometry property into an inline !important
  // fight against the host page is not a battle this loader should try
  // to win piecemeal.
  //
  // The honest claim this makes, not overstated: the mount's block-level
  // rendering is defended against hostile host CSS. Its size and exact
  // screen position remain, by design, cooperative with the host page's
  // own layout.
  mountEl.style.setProperty('display', 'block', 'important');

  var mountTargetId = thisScript.dataset.liveaskMount;
  var mountTarget = mountTargetId ? document.getElementById(mountTargetId) : null;
  (mountTarget || document.body).appendChild(mountEl);

  var shadowRoot = mountEl.attachShadow({ mode: 'open' });

  // ---- Handoff to the runtime ----
  // Not document.currentScript-based, deliberately — that returns null
  // for scripts executing inside a shadow tree per spec, and would in
  // any case no longer reliably identify "this script" once loader and
  // runtime are two separately-loaded files. The runtime script tag
  // below is appended to the ordinary document (not the shadow root),
  // so it always executes in a normal, unambiguous scope; it reads its
  // configuration from this global the instant it runs, synchronously,
  // before any other script has a chance to overwrite it.
  window.__liveAskPendingConfig = {
    tenantId: tenantId,
    workerUrl: workerUrl,
    companyName: companyName,
    baseUrl: baseUrl,
    shadowRoot: shadowRoot,
    mountEl: mountEl
  };

  var runtimeScript = document.createElement('script');
  runtimeScript.src = baseUrl + 'runtime.js?v=20260922-autodemo-guide-1';
  runtimeScript.async = false; // preserve load-then-execute ordering relative to the config handoff above
  document.body.appendChild(runtimeScript);
})();

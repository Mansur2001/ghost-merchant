// Operator console: the panels added with the full customer app (2026-11-11). Loaded after
// app.js and uses its helpers (api, $, escapeHtml, money, timeAgo, twoTap, toast, backBtn,
// bindBack, showDetail, markSelected, selected, setCount, me, token).
//
//   Suggestions  customers' photos of items to sell: any operator forwards or rejects; an
//                ADMIN prices and publishes (catalog prices stay an admin decision).
//   Top-ups      wallet money sent over USSD: checked on the merchant phone and confirmed with
//                the telecom reference, exactly like an order payment.
//   Promo        the free-delivery switch (admins).

// ═══════════════ Suggestions ═══════════════
const SUG_CHIP = { new: ['To review', 'pending'], forwarded: ['To price', 'gold'], published: ['Published', 'ok'], rejected: ['Rejected', 'fail'] };
let suggestions = [];
async function loadSuggestions() {
  const res = await api('/operator/submissions');
  if (res.error) return toast(res.error);
  suggestions = res.submissions || [];
  const open = suggestions.filter((x) => x.status === 'new' || (me?.is_admin && x.status === 'forwarded'));
  setCount('suggestions', open.length);
  $('suggestionsCount').textContent = `${open.length} open`;
  $('suggestions').innerHTML = suggestions.length ? suggestions.map((x) => {
    const [chip, tone] = SUG_CHIP[x.status] || [x.status, ''];
    return `<button class="lrow" type="button" data-open="${x.id}">
      <span class="l1"><span>💡</span><span class="t">${escapeHtml(x.name)}</span></span>
      <span class="l2">${escapeHtml(x.service || '—')} · ${timeAgo(x.created_at)}${x.has_photo ? ' · 📷' : ' · no photo yet'}</span>
      <span class="side"><span class="badge ${tone}">${chip}</span></span></button>`;
  }).join('') : '<div class="pane-empty"><div class="big">💡</div>No suggestions yet.</div>';
  $('suggestions').querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openSuggestion(Number(b.dataset.open))));
  markSelected($('suggestions'), selected.suggestions);
  return null;
}
async function openSuggestion(id) {
  selected.suggestions = String(id);
  markSelected($('suggestions'), String(id));
  const x = suggestions.find((s) => s.id === id);
  if (!x) return;
  const el = $('suggestionDetail');
  const openNow = x.status === 'new' || x.status === 'forwarded';
  // Prices are an admin decision; any operator can sift the queue.
  const cats = me?.is_admin && openNow ? (await api('/operator/catalog')).categories || [] : [];
  const svcCats = cats.filter((c) => !x.service || c.service === x.service);
  el.innerHTML = `
    <div class="pane-head">${backBtn('suggestionsWs')}<strong>${escapeHtml(x.name)}</strong><span class="badge ${(SUG_CHIP[x.status] || [])[1] || ''}">${(SUG_CHIP[x.status] || [x.status])[0]}</span></div>
    <div class="pane-body">
      <div class="dsec"><h4>Suggestion</h4><dl class="kv">
        <dt>Item</dt><dd>${escapeHtml(x.name)}</dd><dt>Shop</dt><dd>${escapeHtml(x.service || '—')}</dd>
        <dt>Note</dt><dd>${escapeHtml(x.note || '—')}</dd><dt>Sent</dt><dd>${timeAgo(x.created_at)}</dd>
        ${x.reviewed_by ? `<dt>Reviewed</dt><dd>${escapeHtml(x.reviewed_by)} · ${timeAgo(x.reviewed_at)}${x.review_note ? ` — ${escapeHtml(x.review_note)}` : ''}</dd>` : ''}
        ${x.published_item_id ? `<dt>Item</dt><dd>#${x.published_item_id} by ${escapeHtml(x.published_by || '')}</dd>` : ''}
      </dl>
      <div class="op-pic" id="sugPhoto">${x.has_photo ? '<span class="muted">Loading photo…</span>' : '<span class="muted">No photo (rejected photos are deleted).</span>'}</div></div>
      ${openNow && x.status === 'new' ? `<div class="dsec"><h4>Review</h4>
        <p class="muted" style="margin:0 0 8px;">Forward it if we can source it at a fair price. Rejecting deletes the photo; the customer sees your reason.</p>
        <button class="secondary" id="sugForward" type="button">Forward to admins</button>
        <label for="sugWhy">Reason (for a rejection)</label><input id="sugWhy" maxlength="300" placeholder="We can't get this in Mogadishu yet" />
        <button class="danger-ghost" id="sugReject" type="button">Reject</button></div>` : ''}
      ${openNow && me?.is_admin ? `<div class="dsec"><h4>Price and publish</h4>
        <label for="pCat">Category</label><select id="pCat">${(svcCats.length ? svcCats : cats).map((c) => `<option value="${c.id}">${escapeHtml(c.name_en)}</option>`).join('')}</select>
        <label for="pNameEn">Name (English)</label><input id="pNameEn" value="${escapeHtml(x.name)}" />
        <label for="pNameSo">Name (Somali — plain words)</label><input id="pNameSo" value="${escapeHtml(x.name)}" />
        <div class="btn-row"><div><label for="pUnitEn">Unit (English)</label><input id="pUnitEn" placeholder="1 kg" /></div>
          <div><label for="pUnitSo">Unit (Somali)</label><input id="pUnitSo" placeholder="1 kg" /></div></div>
        <label for="pPrice">Price (USD)</label><input id="pPrice" type="number" step="0.01" min="0.01" />
        <button id="sugPublish" type="button">Publish with this photo</button>
        <p class="muted" style="margin:8px 0 0;">Recorded in the audit log. The customer is told it is in the shop.</p></div>` : ''}
    </div>`;
  bindBack(el);
  showDetail('suggestionsWs', true);
  if (x.has_photo) {
    fetch(GMConfig.api(`/operator/submissions/${x.id}/photo`), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.blob() : null)).then((b) => {
        if (!b || !$('sugPhoto')) return;
        const img = document.createElement('img');
        img.src = URL.createObjectURL(b);
        img.alt = x.name;
        $('sugPhoto').replaceChildren(img);
      }).catch(() => {});
  }
  const review = async (decision) => {
    const out = await api(`/operator/submissions/${x.id}/review`, { method: 'POST', body: JSON.stringify({ decision, note: $('sugWhy')?.value.trim() }) });
    if (out.error) return toast(out.error);
    toast(decision === 'forward' ? 'Forwarded ✓' : 'Rejected — photo deleted');
    await loadSuggestions();
    return openSuggestion(x.id);
  };
  if ($('sugForward')) $('sugForward').addEventListener('click', () => review('forward'));
  if ($('sugReject')) twoTap($('sugReject'), 'Tap again to reject', () => review('reject'));
  if ($('sugPublish')) $('sugPublish').addEventListener('click', async () => {
    const item = {
      category_id: Number($('pCat').value), name_en: $('pNameEn').value.trim(), name_so: $('pNameSo').value.trim(),
      unit_en: $('pUnitEn').value.trim(), unit_so: $('pUnitSo').value.trim(), price: Number($('pPrice').value),
    };
    if (!(item.price > 0)) return toast('Set the price.');
    const out = await api(`/operator/submissions/${x.id}/publish`, { method: 'POST', body: JSON.stringify(item) });
    if (out.error) return toast(out.error);
    toast('Published ✓ — it is in the shop now');
    await loadSuggestions();
    return openSuggestion(x.id);
  });
}

// ═══════════════ Wallet top-ups (USSD) ═══════════════
let topups = [];
async function loadTopups() {
  const res = await api('/operator/topups');
  if (res.error) return toast(res.error);
  topups = res.topups || [];
  const open = topups.filter((x) => x.status === 'claimed');
  setCount('topups', open.length);
  $('topupsCount').textContent = `${open.length} to check`;
  const chip = { claimed: ['To check', 'pending'], approved: ['Added', 'ok'], rejected: ['Rejected', 'fail'] };
  $('topups').innerHTML = topups.length ? topups.map((x) => `
    <button class="lrow" type="button" data-open="${x.id}">
      <span class="l1"><span>👛</span><span class="t">${money(x.amount)} · ${escapeHtml(x.wallet)}</span></span>
      <span class="l2">${x.claim_ref ? `Ref ${escapeHtml(x.claim_ref)} · ` : ''}${timeAgo(x.created_at)}</span>
      <span class="side"><span class="badge ${(chip[x.status] || [])[1] || ''}">${(chip[x.status] || [x.status])[0]}</span></span></button>`).join('')
    : '<div class="pane-empty"><div class="big">👛</div>No top-ups to check.</div>';
  $('topups').querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openTopup(b.dataset.open)));
  markSelected($('topups'), selected.topups);
  return null;
}
function openTopup(id) {
  selected.topups = id;
  markSelected($('topups'), id);
  const x = topups.find((a) => a.id === id);
  if (!x) return;
  const el = $('topupDetail');
  el.innerHTML = `
    <div class="pane-head">${backBtn('topupsWs')}<strong>${money(x.amount)} top-up</strong></div>
    <div class="pane-body">
      <div class="dsec"><h4>Claim</h4><dl class="kv">
        <dt>Amount</dt><dd>${money(x.amount)}</dd><dt>Wallet</dt><dd>${escapeHtml(x.wallet)}</dd>
        <dt>Customer's reference</dt><dd class="mono">${escapeHtml(x.claim_ref || '—')}</dd><dt>Account</dt><dd>${escapeHtml(x.account || '—')}</dd>
        <dt>Sent</dt><dd>${timeAgo(x.created_at)}</dd>
        ${x.status !== 'claimed' ? `<dt>Outcome</dt><dd>${escapeHtml(x.status)}${x.reference ? ` · ref ${escapeHtml(x.reference)}` : ''}${x.detail ? ` — ${escapeHtml(x.detail)}` : ''}</dd>` : ''}
      </dl></div>
      ${x.status === 'claimed' ? `<div class="dsec"><h4>Confirm</h4>
        <p class="muted" style="margin:0 0 8px;">Find ${money(x.amount)} on the ${escapeHtml(x.wallet)} merchant phone. Type ITS transaction number — not just the customer's.</p>
        <label for="tuRef">Transaction number (required)</label><input id="tuRef" value="${escapeHtml(x.claim_ref || '')}" autocapitalize="characters" spellcheck="false" />
        <button id="tuConfirm" type="button">Add ${money(x.amount)} to the wallet</button>
        <label for="tuWhy">Not there? Say why (the customer is told)</label><input id="tuWhy" maxlength="200" />
        <button class="danger-ghost" id="tuReject" type="button">Reject</button></div>` : ''}
    </div>`;
  bindBack(el);
  showDetail('topupsWs', true);
  if ($('tuConfirm')) $('tuConfirm').addEventListener('click', async () => {
    const out = await api(`/operator/topups/${x.id}/confirm`, { method: 'POST', body: JSON.stringify({ reference: $('tuRef').value.trim() }) });
    if (out.error) return toast(out.error);
    toast('Added ✓ — recorded with your name');
    await loadTopups();
    return openTopup(x.id);
  });
  if ($('tuReject')) twoTap($('tuReject'), 'Tap again to reject', async () => {
    const out = await api(`/operator/topups/${x.id}/reject`, { method: 'POST', body: JSON.stringify({ note: $('tuWhy').value.trim() }) });
    if (out.error) return toast(out.error);
    toast('Rejected');
    await loadTopups();
    return openTopup(x.id);
  });
}

// ═══════════════ Promo (admins) ═══════════════
async function loadSettings() {
  const res = await api('/operator/settings');
  if (res.error) return toast(res.error);
  const fd = res.settings.free_delivery;
  $('promoOn').checked = fd.enabled;
  $('promoMin').value = fd.minSubtotal;
  $('promoNow').textContent = fd.enabled
    ? `On now — ${Number(fd.minSubtotal) > 0 ? `orders of ${money(fd.minSubtotal)} or more` : 'every food and shopping order'}.`
    : 'Off — every delivery pays its fee.';
  return null;
}
$('promoSave').addEventListener('click', async () => {
  const out = await api('/operator/settings/free_delivery', {
    method: 'PUT', body: JSON.stringify({ enabled: $('promoOn').checked, minSubtotal: Number($('promoMin').value || 0) }),
  });
  if (out.error) return toast(out.error);
  toast('Saved ✓ — recorded in the audit log');
  loadSettings();
  return null;
});

// The badges on the nav should be right from the first screen.
setTimeout(() => { if (token) { loadSuggestions(); loadTopups(); } }, 1500);

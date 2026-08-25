// Member Purchase quick-log — lets a purchase made on a member's behalf
// (e.g. groceries) get logged straight to their account in the Finance
// Dashboard, without it also becoming part of this app's own stock. Pure
// pass-through spend: the company never keeps/uses the goods itself, so it
// deliberately does NOT touch food_purchases/food_items or this app's
// usage/COGS math at all — it only ever writes to member_charges, the same
// shared table the Finance Dashboard's Member Accounts tab reads from
// (same Supabase project, so this just works — see that app's
// memberBilling.js for the full feature).
//
// Only relevant when companies.member_billing_enabled is true for the
// current company (see CompanyContext.jsx's memberBillingEnabled) — off
// for every real lodge today, on for the Demo company only.

import { supabase } from './supabaseClient.js'

export async function listMembers({ companyId }) {
  const { data, error } = await supabase
    .from('members')
    .select('id, name')
    .eq('company_id', companyId)
    .eq('active', true)
    .order('name')
  if (error) throw error
  return data || []
}

export async function logMemberPurchase({ companyId, memberId, locationId, chargeDate, description, amount }) {
  const { error } = await supabase.from('member_charges').insert([
    {
      company_id: companyId,
      member_id: memberId,
      location_id: locationId || null,
      charge_date: chargeDate,
      description: description.trim(),
      amount: Number(amount),
    },
  ])
  if (error) throw error
}

// --- "Bill to Member" pending queue (2026-08-25) ---------------------------
// A slip-scan line ticked "Bill to Member" doesn't bill anyone immediately —
// it drops into member_pending_charges (staged here, shown as a checkbox
// list in MemberPurchaseCard) until a person picks a member and bills the
// selected lines as a batch. Point: a slip with both lodge items and
// member items can be scanned once, nothing gets forgotten, and nothing
// attaches to the wrong member before someone's actually reviewed it.
// amount here is always VAT-INCLUSIVE (see SlipScanCard's
// vatInclusiveAmount) — member purchases are never stripped of VAT.

export async function listPendingCharges({ companyId }) {
  const { data, error } = await supabase
    .from('member_pending_charges')
    .select('*')
    .eq('company_id', companyId)
    .eq('source_app', 'food')
    .order('created_at')
  if (error) throw error
  return data || []
}

export async function addPendingCharges({ companyId, locationId, slipId, rows }) {
  if (!rows.length) return
  const payload = rows.map((r) => ({
    company_id: companyId,
    source_app: 'food',
    location_id: locationId || null,
    charge_date: r.chargeDate,
    description: r.description,
    qty: r.qty ?? null,
    amount: Number(r.amount),
    slip_id: slipId || null,
  }))
  const { error } = await supabase.from('member_pending_charges').insert(payload)
  if (error) throw error
}

export async function billPendingCharges({ companyId, memberId, locationId, pendingIds }) {
  if (!pendingIds.length) return
  const { data: pending, error: fetchErr } = await supabase
    .from('member_pending_charges')
    .select('*')
    .in('id', pendingIds)
  if (fetchErr) throw fetchErr

  const charges = (pending || []).map((p) => ({
    company_id: companyId,
    member_id: memberId,
    location_id: p.location_id || locationId || null,
    charge_date: p.charge_date,
    description: p.description,
    amount: p.amount,
  }))
  if (charges.length) {
    const { error: insertErr } = await supabase.from('member_charges').insert(charges)
    if (insertErr) throw insertErr
  }

  const { error: deleteErr } = await supabase.from('member_pending_charges').delete().in('id', pendingIds)
  if (deleteErr) throw deleteErr
}

export async function deletePendingCharge({ id }) {
  const { error } = await supabase.from('member_pending_charges').delete().eq('id', id)
  if (error) throw error
}

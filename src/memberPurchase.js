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

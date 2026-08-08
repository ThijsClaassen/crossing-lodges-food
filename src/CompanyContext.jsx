// Resolves "which companies can this logged-in user access, and with what
// role" and exposes the currently-selected one app-wide. Same logic as the
// Finance Dashboard's CompanyContext.jsx (2026-08-08) — this is the SAME
// Supabase project, so companies/user_companies/platform_admins already
// exist and mean the same thing here; copied over rather than shared as a
// package since each app is its own deploy.
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { supabase } from './supabaseClient.js'

const CompanyContext = createContext(null)
const STORAGE_KEY = 'food_company_id'

export function CompanyProvider({ children }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [availableCompanies, setAvailableCompanies] = useState([])
  const [companyId, setCompanyId] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const {
        data: { session },
        error: sessionErr,
      } = await supabase.auth.getSession()
      if (sessionErr) throw sessionErr
      const user = session?.user
      if (!user) throw new Error('No active session.')

      const [
        { data: companies, error: compErr },
        { data: memberships, error: memErr },
        { data: adminRow, error: adminErr },
      ] = await Promise.all([
        supabase.from('companies').select('id, slug, name, status').order('name'),
        supabase.from('user_companies').select('company_id, role').eq('user_id', user.id),
        supabase.from('platform_admins').select('user_id').eq('user_id', user.id).maybeSingle(),
      ])
      if (compErr) throw compErr
      if (memErr) throw memErr
      if (adminErr) throw adminErr

      const isPlatformAdmin = !!adminRow
      const roleByCompany = Object.fromEntries((memberships || []).map((m) => [m.company_id, m.role]))

      const available = (companies || [])
        .map((c) => ({
          id: c.id,
          slug: c.slug,
          name: c.name,
          status: c.status,
          role: roleByCompany[c.id] || (isPlatformAdmin ? 'admin' : null),
        }))
        .filter((c) => c.role)

      setAvailableCompanies(available)
      const stored = localStorage.getItem(STORAGE_KEY)
      const stillValid = available.find((c) => c.id === stored)
      const next = stillValid ? stored : available[0]?.id || null
      setCompanyId(next)
      if (next) localStorage.setItem(STORAGE_KEY, next)
      else localStorage.removeItem(STORAGE_KEY)
    } catch (err) {
      setError(err.message || 'Could not load your company access.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const switchCompany = useCallback((id) => {
    setCompanyId(id)
    localStorage.setItem(STORAGE_KEY, id)
  }, [])

  const current = availableCompanies.find((c) => c.id === companyId) || null
  const value = {
    loading,
    error,
    availableCompanies,
    companyId,
    companyName: current?.name || '',
    companySlug: current?.slug || '',
    role: current?.role || null,
    switchCompany,
    reload: load,
  }
  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>
}

export function useCompany() {
  const ctx = useContext(CompanyContext)
  if (!ctx) throw new Error('useCompany() must be used inside a <CompanyProvider>')
  return ctx
}

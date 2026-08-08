import { useState } from 'react'
import { supabase } from './supabaseClient.js'
import { colors, fonts } from './theme.js'

// Real Supabase Auth login, replacing the old shared admin/staff password
// checked against food_access (2026-08-08 — Food Stock 3b of the
// multi-tenant rebuild). No onLogin callback needed: a successful sign-in
// fires Supabase's own onAuthStateChange event, which App.jsx already
// listens for. Which company/companies the signed-in user can access is
// resolved separately, after login, by CompanyContext.jsx.
const styles = {
  screen: {
    fontFamily: fonts.body,
    background: colors.bg,
    minHeight: '100vh',
    color: colors.cream,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    background: colors.panel,
    border: `1px solid ${colors.border}`,
    borderRadius: 12,
    padding: 20,
    width: 280,
    boxSizing: 'border-box',
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 20,
    fontWeight: 600,
    marginBottom: 14,
    textAlign: 'center',
    color: colors.goldLt,
  },
  label: { fontSize: 11, color: colors.muted, marginBottom: 3, display: 'block' },
  input: {
    width: '100%',
    padding: '7px 9px',
    borderRadius: 8,
    border: `1px solid ${colors.border}`,
    background: colors.bg,
    color: colors.cream,
    fontSize: 13,
    boxSizing: 'border-box',
    marginBottom: 10,
  },
  button: {
    width: '100%',
    padding: '9px 14px',
    borderRadius: 8,
    border: 'none',
    background: colors.navy,
    color: colors.cream,
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
    marginTop: 4,
  },
  error: { color: colors.danger, fontSize: 12, marginTop: 8 },
}

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)

    const { error: authError } = await supabase.auth.signInWithPassword({ email, password })

    setLoading(false)

    if (authError) {
      setError(authError.message === 'Invalid login credentials' ? 'Incorrect email or password.' : authError.message)
    }
  }

  return (
    <div style={styles.screen}>
      <form onSubmit={handleSubmit} style={styles.card}>
        <img
          src="/logo.png"
          alt=""
          style={{ height: 56, width: 'auto', display: 'block', margin: '0 auto 12px' }}
          onError={(e) => (e.target.style.display = 'none')}
        />
        <div style={styles.title}>Crossing Lodges — Food Stock</div>
        <label style={styles.label}>Email</label>
        <input
          type="email"
          style={styles.input}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
          autoComplete="username"
        />
        <label style={styles.label}>Password</label>
        <input
          type="password"
          style={styles.input}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        {error && <div style={styles.error}>{error}</div>}
        <button type="submit" style={styles.button} disabled={loading}>
          {loading ? 'Checking…' : 'Log in'}
        </button>
      </form>
    </div>
  )
}

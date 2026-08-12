import { useState } from 'react'
import { supabase } from './supabaseClient.js'
import { colors, fonts } from './theme.js'

// Shown once, right after someone lands back in the app from an invite or
// password-reset email link — same component/purpose as the Finance
// Dashboard's (2026-08-08). Without this, a freshly-invited user would land
// on the dashboard with a valid session but no password they could actually
// log back in with next time.
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
    width: 300,
    boxSizing: 'border-box',
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 20,
    fontWeight: 600,
    marginBottom: 8,
    textAlign: 'center',
    color: colors.goldLt,
  },
  message: { fontSize: 12, color: colors.muted, marginBottom: 14, textAlign: 'center' },
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

export default function SetPassword({ onDone }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')

    if (password.length < 6) {
      setError('Use at least 6 characters.')
      return
    }
    if (password !== confirm) {
      setError("Passwords don't match.")
      return
    }

    setSaving(true)
    const { error: updateErr } = await supabase.auth.updateUser({ password })
    setSaving(false)

    if (updateErr) {
      setError(updateErr.message)
      return
    }

    onDone()
  }

  return (
    <div style={styles.screen}>
      <form onSubmit={handleSubmit} style={styles.card}>
        <div style={styles.title}>Set your password</div>
        <div style={styles.message}>Choose a password for your account — you'll use this to log in from now on.</div>
        <input
          type="password"
          placeholder="New password"
          style={styles.input}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          autoComplete="new-password"
        />
        <input
          type="password"
          placeholder="Confirm password"
          style={styles.input}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
        />
        {error && <div style={styles.error}>{error}</div>}
        <button type="submit" style={styles.button} disabled={saving}>
          {saving ? 'Saving…' : 'Set password and continue'}
        </button>
      </form>
    </div>
  )
}

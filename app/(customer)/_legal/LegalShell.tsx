import type { ReactNode } from 'react'
import GlobalHeader from '../../components/GlobalHeader'

// Shared chrome + typography for the legal pages (Terms, Privacy). Server
// component — GlobalHeader is the only client piece. Typography is driven by a
// single scoped <style> block (`.legal-doc`) so the page content stays clean
// semantic HTML with proper list indentation and readable line-height.

const LEGAL_CSS = `
.legal-doc { max-width: 800px; margin: 0 auto; padding: 48px 24px; font-family: 'DM Sans', sans-serif; color: #333; }
.legal-doc h1 { font-size: 32px; font-weight: 700; color: #1A1028; margin: 0 0 6px; line-height: 1.2; letter-spacing: -0.01em; }
.legal-doc .updated { font-size: 14px; color: #888; margin: 0 0 28px; }
.legal-doc .intro { font-size: 15px; line-height: 1.7; color: #333; margin: 0 0 20px; }
.legal-doc h2 { font-size: 18px; font-weight: 700; color: #1A1028; border-bottom: 1px solid #e8e8e8; padding-bottom: 8px; margin: 36px 0 14px; }
.legal-doc h3 { font-size: 15px; font-weight: 700; color: #1A1028; margin: 22px 0 8px; }
.legal-doc p { font-size: 15px; line-height: 1.7; color: #333; margin: 0 0 14px; }
.legal-doc ul, .legal-doc ol { font-size: 15px; line-height: 1.7; color: #333; padding-left: 26px; margin: 0 0 14px; }
.legal-doc li { margin-bottom: 8px; }
.legal-doc strong { color: #1A1028; font-weight: 700; }
.legal-doc .warn { background: #f8f8f8; border-radius: 8px; padding: 16px; font-size: 14px; line-height: 1.6; color: #555; margin: 0 0 18px; }
.legal-doc a { color: #6B6EF9; text-decoration: none; }
.legal-doc a:hover { text-decoration: underline; }
.legal-footer { border-top: 1px solid #f0f0f0; padding: 24px 24px max(24px, env(safe-area-inset-bottom)); display: flex; align-items: center; justify-content: center; gap: 16px; flex-wrap: wrap; font-family: 'DM Sans', sans-serif; }
.legal-footer a { font-size: 13px; color: #6B6EF9; text-decoration: none; }
.legal-footer span { font-size: 13px; color: #ddd; }
.legal-footer .copy { color: #ccc; }
@media (max-width: 600px) {
  .legal-doc { padding: 40px 20px; }
  .legal-doc h1 { font-size: 26px; }
}
`

export default function LegalShell({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: LEGAL_CSS }} />
      <GlobalHeader />
      <main className="legal-doc">
        <h1>{title}</h1>
        <p className="updated">{updated}</p>
        {children}
      </main>
      <footer className="legal-footer">
        <a href="/become-a-partner">For Restaurants</a>
        <span>·</span>
        <a href="/privacy">Privacy Policy</a>
        <span>·</span>
        <a href="/terms">Terms</a>
        <span>·</span>
        <a href="mailto:concierge@discocater.com">Contact</a>
        <span>·</span>
        <span className="copy">© 2026 Disco Cater</span>
      </footer>
    </>
  )
}

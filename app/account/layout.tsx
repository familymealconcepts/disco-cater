import AccountLayoutClient from './components/AccountLayoutClient'

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return <AccountLayoutClient>{children}</AccountLayoutClient>
}

import type { Metadata } from 'next'
import LegalShell from '../_legal/LegalShell'
import PrivacyChoicesSwitch, { ConsentSwitch } from './PrivacyChoicesSwitch'

export const metadata: Metadata = {
  title: 'Your Privacy Choices — Disco Cater',
  description: 'Opt out of advertising and visitor identification on Disco Cater.',
  alternates: { canonical: 'https://www.discocater.com/privacy-choices' },
}

export default function PrivacyChoicesPage() {
  return (
    <LegalShell title="Your Privacy Choices" updated="">
      <p className="intro">Use these switches to opt out of advertising and visitor identification on Disco Cater.</p>

      <PrivacyChoicesSwitch />

      <p>
        When this is on, we don&rsquo;t load the Meta Pixel, the LinkedIn Insight Tag or RB2B and
        Apollo.io&rsquo;s website tracker, and we tell Google not to use your visit for advertising. Google
        Analytics keeps running to help us understand how the site is used.
      </p>

      <ConsentSwitch />

      <p>
        When this is on, we run Microsoft Clarity, which records how visitors use our pages, and RB2B and
        Apollo.io&rsquo;s website tracker, which may identify the business you visit from. This is the same
        choice as Accept or Decline in the banner.
      </p>
      <p>
        Your choice is saved in this browser. If you clear your browser data or use another browser or
        device, set it again.
      </p>
      <p>
        To remove your email address from the customer lists we share with advertising partners, email{' '}
        <a href="mailto:concierge@discocater.com">concierge@discocater.com</a>. More in our{' '}
        <a href="/privacy">Privacy Policy</a>.
      </p>
    </LegalShell>
  )
}

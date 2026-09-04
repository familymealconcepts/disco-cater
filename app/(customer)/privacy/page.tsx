import type { Metadata } from 'next'
import LegalShell from '../_legal/LegalShell'

export const metadata: Metadata = {
  title: 'Privacy Policy — Disco Cater',
  description:
    'How Disco Cater collects, uses, shares, stores, and protects your information when you use the Disco Cater catering marketplace and services.',
  alternates: { canonical: 'https://www.discocater.com/privacy' },
}

export default function PrivacyPage() {
  return (
    <LegalShell title="Privacy Policy" updated="Effective June 2026">
      <p className="intro">
        This Privacy Policy describes how FamilyMeal Concepts Inc. (d/b/a Disco Cater) (&ldquo;Disco
        Cater,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;) collects, uses, shares, and
        protects information about you when you visit Disco Cater, use our websites, applications, and
        services, or otherwise interact with us (collectively, the &ldquo;Services&rdquo;). By using the
        Services, you agree to the practices described in this Policy.
      </p>

      {/* I */}
      <h2>I. Information We Collect and Use</h2>
      <p>We collect information in the following ways:</p>
      <h3>Information you provide to us</h3>
      <ul>
        <li><strong>Account information</strong> — such as your name, email address, phone number, and password when you create an account.</li>
        <li><strong>Order information</strong> — such as the items you order, delivery or pickup address, scheduled date and time, special instructions, and headcount.</li>
        <li><strong>Payment information</strong> — payment-card or other payment details, which are collected and processed by our third-party payment processors; we do not store full card numbers.</li>
        <li><strong>Communications</strong> — information you provide when you contact us for support, respond to surveys, or otherwise communicate with us.</li>
      </ul>
      <h3>Information we collect automatically</h3>
      <ul>
        <li><strong>Usage data</strong> — pages viewed, features used, search queries, and other actions taken within the Services.</li>
        <li><strong>Device and log data</strong> — IP address, browser type, device identifiers, operating system, referring URLs, and timestamps.</li>
        <li><strong>Location data</strong> — approximate location derived from your IP address or, with your permission, more precise location to help you find nearby restaurants.</li>
        <li><strong>Cookies and similar technologies</strong> — as described in Section V.</li>
      </ul>
      <h3>Information from third parties</h3>
      <p>
        We may receive information about you from partner restaurants, payment processors, mapping and
        analytics providers, and other service providers that help us operate the Services.
      </p>

      {/* II */}
      <h2>II. How We Use Your Information</h2>
      <p>We use the information we collect to:</p>
      <ul>
        <li>Provide, operate, and maintain the Services, including processing and fulfilling your orders.</li>
        <li>Facilitate payments and send order confirmations, receipts, and service-related communications.</li>
        <li>Personalize your experience and provide recommendations, including through Disco AI.</li>
        <li>Provide customer support and respond to your inquiries.</li>
        <li>Improve, troubleshoot, and develop new features for the Services.</li>
        <li>Detect, prevent, and address fraud, security incidents, and abuse.</li>
        <li>Send you marketing and promotional communications, where permitted, from which you can opt out.</li>
        <li>Comply with legal obligations and enforce our terms and policies.</li>
      </ul>

      {/* III */}
      <h2>III. How We Share Your Information</h2>
      <p>We do not sell your personal information. We may share information as follows:</p>
      <ul>
        <li><strong>With partner restaurants</strong> — to fulfill your orders, including your name, contact details, delivery address, and order contents.</li>
        <li><strong>With service providers</strong> — payment processors, delivery and logistics providers, hosting, mapping, analytics, and communications vendors that perform services on our behalf.</li>
        <li><strong>For legal reasons</strong> — when we believe disclosure is necessary to comply with applicable law, legal process, or governmental request, or to protect the rights, property, or safety of Disco Cater, our users, or others.</li>
        <li><strong>In a business transaction</strong> — in connection with a merger, acquisition, financing, reorganization, or sale of assets, information may be transferred as part of that transaction.</li>
        <li><strong>With your consent</strong> — when you direct us to share your information.</li>
      </ul>

      {/* IV */}
      <h2>IV. How We Store and Protect Your Information</h2>
      <p>
        We retain your information for as long as necessary to provide the Services, comply with our legal
        obligations, resolve disputes, and enforce our agreements. We implement reasonable administrative,
        technical, and physical safeguards designed to protect your information against unauthorized access,
        loss, misuse, or alteration. However, no method of transmission or storage is completely secure, and
        we cannot guarantee absolute security. You are responsible for keeping your account credentials
        confidential.
      </p>

      {/* V */}
      <h2>V. Cookies</h2>
      <p>
        We and our partners use cookies and similar technologies (such as web beacons and local storage) to
        operate and secure the Services, remember your preferences, understand how the Services are used, and
        deliver and measure marketing. You can control cookies through your browser settings; disabling some
        cookies may affect the functionality of the Services.
      </p>

      {/* VI */}
      <h2>VI. Links to Other Websites</h2>
      <p>
        The Services may contain links to third-party websites or services that are not operated by us. This
        Policy does not apply to those third-party sites. We encourage you to review the privacy policies of
        any third-party site you visit, as we are not responsible for their content or practices.
      </p>

      {/* VII */}
      <h2>VII. Changes to This Policy</h2>
      <p>
        We may update this Privacy Policy from time to time. When we do, we will revise the effective date at
        the top of this page and, where appropriate, provide additional notice. Your continued use of the
        Services after an update becomes effective constitutes your acceptance of the updated Policy.
      </p>

      <p style={{ marginTop: 32, color: '#727272', fontSize: 14 }}>
        Questions about this Policy or your information? Contact us at{' '}
        <a href="mailto:concierge@discocater.com">concierge@discocater.com</a>.
      </p>
    </LegalShell>
  )
}

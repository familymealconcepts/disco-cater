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
    <LegalShell title="Privacy Policy" updated="Effective October 2026">
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
        <li><strong>Advertising partners.</strong> We may share hashed (scrambled) contact information, such as your email address, with advertising partners to show you relevant Disco Cater ads. You can opt out at any time by emailing concierge@discocater.com.</li>
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

      {/* VIII */}
      <h2>VIII. Disco Cater CRM Extension</h2>
      <p>
        Disco Cater staff use a Chrome browser extension, &ldquo;Disco Cater CRM,&rdquo; to record
        restaurants and other business prospects in our internal customer-relationship management
        (&ldquo;CRM&rdquo;) system. The extension is available only to Disco Cater staff. This section
        describes what it collects, both from the web pages staff view with it and about the people whose
        details are recorded with it.
      </p>
      <h3>What the extension reads from web pages</h3>
      <p>
        When a staff member opens the extension&rsquo;s side panel, it reads information from the page they
        are viewing to fill in a form: the business name (from the page title, the site&rsquo;s name, or the
        site&rsquo;s structured data) and, where the page shows them, a person&rsquo;s name, job title,
        company, and email address. On LinkedIn and Apollo.io it reads the profile being viewed. In Gmail it
        reads the name and email address of the sender of the open message, but not the message itself.
      </p>
      <h3>Information sent automatically while the panel is open</h3>
      <p>
        While the side panel is open, each time a page loads the extension sends that page&rsquo;s website
        address (the domain only, such as example.com, not the full web address) and the business name it
        read from the page to our CRM, to check whether that business is already recorded. These lookups
        are not saved to the CRM, though they may appear in our hosting provider&rsquo;s routine request
        logs. Nothing else read from a page is sent until a staff member chooses to save it or to look up
        contact details (described below).
      </p>
      <h3>Information saved to the CRM</h3>
      <p>
        When a staff member saves a record, the CRM stores the person&rsquo;s name, job title, company, email
        address, phone number, and LinkedIn profile address where available, together with the website where
        they were found and the staff member&rsquo;s categorization of the record. Staff can also create
        follow-up tasks, with notes, against a record.
      </p>
      <h3>Contact details from Apollo.io</h3>
      <p>
        If a staff member chooses to look up a person&rsquo;s contact details, we send that person&rsquo;s
        first name, last name, and company name to Apollo.io, a business-contact data provider, which
        returns the business email address, phone number, job title, and LinkedIn profile it holds for that
        person, if any. These requests and Apollo.io&rsquo;s responses may appear in our hosting
        provider&rsquo;s routine request logs.
      </p>
      <h3>Information stored in the browser</h3>
      <p>
        The extension stores a Disco Cater access token, entered by the staff member, in the browser&rsquo;s
        storage for the extension, along with whether its side panel is open. Removing the extension clears
        this information.
      </p>
      <h3>How we use this information</h3>
      <p>
        We use information recorded with the extension only for Disco Cater&rsquo;s sales and account
        management: deciding which businesses to contact, contacting them about Disco Cater, including by
        email sent through Apollo.io, and keeping records of those conversations. We do not sell this
        information.
      </p>
      <p>We do not use information recorded with the extension for advertising.</p>
      <h3>How long we keep it</h3>
      <p>
        We keep CRM records for as long as they are useful for our sales and account management, and we
        delete them on request.
      </p>
      <h3>Asking us to remove your details</h3>
      <p>
        If your details have been recorded in our CRM and you would like them removed, or would like us to
        stop contacting you, email{' '}
        <a href="mailto:concierge@discocater.com">concierge@discocater.com</a>. We will delete your details
        from the CRM and keep only your email address on a do-not-contact list, so that you are not added
        or contacted again.
      </p>

      <p style={{ marginTop: 32, color: '#727272', fontSize: 14 }}>
        Questions about this Policy or your information? Contact us at{' '}
        <a href="mailto:concierge@discocater.com">concierge@discocater.com</a>.
      </p>
    </LegalShell>
  )
}

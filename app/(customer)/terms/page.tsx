import type { Metadata } from 'next'
import LegalShell from '../_legal/LegalShell'

export const metadata: Metadata = {
  title: 'Merchant Agreement Terms & Conditions — Disco Cater',
  description:
    'The Merchant Agreement Terms & Conditions governing restaurants and merchants that use the Disco Cater catering marketplace, software, and payment-processing services.',
  alternates: { canonical: 'https://www.discocater.com/terms' },
}

export default function TermsPage() {
  return (
    <LegalShell title="Merchant Agreement Terms & Conditions" updated="Updated June 2026">
      <div className="warn">
        IF MERCHANT DOES NOT AGREE WITH THESE TERMS AND CONDITIONS, MERCHANT MAY NOT USE, AND/OR SHALL
        CEASE USING, ANY DISCO CATER SERVICES OR SOFTWARE.
      </div>

      <p className="intro">
        These Merchant Agreement Terms &amp; Conditions (the &ldquo;Terms&rdquo;) are entered into by and
        between FamilyMeal Concepts Inc. (d/b/a Disco Cater) (&ldquo;Disco Cater,&rdquo; &ldquo;we,&rdquo;
        &ldquo;us,&rdquo; or &ldquo;our&rdquo;) and the restaurant, caterer, or other food-service business
        that registers for or uses the Services (&ldquo;Merchant,&rdquo; &ldquo;you,&rdquo; or
        &ldquo;your&rdquo;). By accepting these Terms, by signing a Merchant Order Form that references these
        Terms, or by accessing or using the Services, Merchant agrees to be bound by these Terms.
      </p>

      {/* 1 */}
      <h2>1. Definitions</h2>
      <p>As used in these Terms, the following capitalized terms have the meanings set forth below:</p>
      <ul>
        <li><strong>&ldquo;Services&rdquo;</strong> means the Disco Cater catering marketplace, websites, mobile and web applications, merchant dashboard, ordering and menu-management tools, payment-processing facilitation, and related software and services made available by Disco Cater.</li>
        <li><strong>&ldquo;Software&rdquo;</strong> means any software, application programming interfaces, widgets, or code provided or made accessible by Disco Cater as part of the Services.</li>
        <li><strong>&ldquo;Merchant Data&rdquo;</strong> means menus, pricing, descriptions, images, hours, locations, and other content or information that Merchant submits to or makes available through the Services.</li>
        <li><strong>&ldquo;Customer&rdquo;</strong> means an end user who places, or seeks to place, a catering order through the Services.</li>
        <li><strong>&ldquo;Customer Data&rdquo;</strong> means information relating to a Customer that is collected or processed in connection with an order, including name, contact details, delivery address, and order history.</li>
        <li><strong>&ldquo;Order&rdquo;</strong> means a request by a Customer to purchase catering products or services from Merchant through the Services.</li>
        <li><strong>&ldquo;Fees&rdquo;</strong> means the amounts payable in connection with the Services as described in Section 5 and in any applicable Merchant Order Form.</li>
      </ul>

      {/* 2 */}
      <h2>2. Scope</h2>
      <p>
        These Terms govern Merchant&rsquo;s access to and use of the Services. Disco Cater operates a
        marketplace and technology platform that enables Merchant to list catering offerings, receive and
        manage Orders, and accept payment from Customers. Disco Cater is not a restaurant, caterer, or
        food-service provider, and does not prepare, handle, or deliver food. Merchant is solely responsible
        for the preparation, quality, packaging, fulfillment, and—where applicable—delivery of all products
        ordered through the Services.
      </p>

      {/* 3 -> Right to Use */}
      <h2>3. Right to Use the Services</h2>
      <p>
        <strong>2.1.</strong> Subject to Merchant&rsquo;s continued compliance with these Terms, Disco Cater
        grants Merchant a limited, non-exclusive, non-transferable, non-sublicensable, revocable right to
        access and use the Services solely for Merchant&rsquo;s internal business purpose of offering and
        fulfilling catering Orders.
      </p>
      <p>
        <strong>2.2.</strong> Disco Cater may update, modify, enhance, or discontinue any part of the Services
        at any time. Disco Cater will use commercially reasonable efforts to provide notice of material changes
        that adversely affect Merchant&rsquo;s use of the Services.
      </p>
      <p>
        <strong>2.3.</strong> Merchant is responsible for obtaining and maintaining all equipment, devices,
        and internet connectivity needed to access the Services, and for the security of Merchant&rsquo;s
        account credentials and all activity that occurs under Merchant&rsquo;s account.
      </p>

      {/* 4 -> Usage Restrictions */}
      <h2>4. Usage Restrictions</h2>
      <p>Merchant shall not, and shall not permit any third party to:</p>
      <p><strong>3.1.</strong> Copy, modify, translate, or create derivative works of the Services or Software.</p>
      <p><strong>3.2.</strong> Reverse engineer, decompile, disassemble, or otherwise attempt to derive the source code, structure, or underlying ideas of the Software, except to the extent expressly permitted by applicable law.</p>
      <p><strong>3.3.</strong> Sell, resell, rent, lease, sublicense, distribute, or otherwise commercially exploit the Services except as expressly authorized.</p>
      <p><strong>3.4.</strong> Use the Services to transmit any unlawful, infringing, defamatory, deceptive, or harmful content, or any malware or malicious code.</p>
      <p><strong>3.5.</strong> Interfere with or disrupt the integrity or performance of the Services, or attempt to gain unauthorized access to the Services or related systems or networks.</p>
      <p><strong>3.6.</strong> Use the Services to solicit Customers away from the Services in a manner that misappropriates Disco Cater&rsquo;s legitimate interests, or to circumvent applicable Fees.</p>
      <p><strong>3.7.</strong> List products that Merchant is not legally authorized to sell, or that violate any applicable law, regulation, or third-party right.</p>
      <p><strong>3.8.</strong> Use the Services in violation of any applicable law, including food-safety, labeling, health, licensing, tax, consumer-protection, and data-protection laws.</p>

      {/* 5 -> Ownership */}
      <h2>5. Ownership: Merchant Data, Customer Data &amp; Trademarks</h2>
      <p>
        <strong>4.1.</strong> As between the parties, Merchant retains all right, title, and interest in and to
        Merchant Data. Merchant grants Disco Cater a worldwide, non-exclusive, royalty-free license to host,
        store, reproduce, modify (for formatting), display, and distribute Merchant Data as necessary to
        operate, promote, and improve the Services and to fulfill Orders.
      </p>
      <p>
        <strong>4.2.</strong> As between the parties, Disco Cater owns all right, title, and interest in and to
        the Services, the Software, and all related intellectual property, including all improvements,
        enhancements, and derivative works thereof. No rights are granted to Merchant other than as expressly
        set forth in these Terms.
      </p>
      <p>
        <strong>4.3.</strong> Customer Data collected through the Services is processed in accordance with the
        Disco Cater <a href="https://discocater.com/privacy">Privacy Policy</a>. Merchant may use Customer Data
        solely to fulfill Orders and provide related customer service, and may not use Customer Data for
        independent marketing or any other purpose without the Customer&rsquo;s consent and compliance with
        applicable law.
      </p>
      <p>
        <strong>4.4.</strong> Merchant grants Disco Cater a non-exclusive, royalty-free license to use
        Merchant&rsquo;s name, logos, and trademarks (&ldquo;Merchant Marks&rdquo;) to identify Merchant and
        market its offerings on and in connection with the Services. Disco Cater grants Merchant no right to use
        the Disco Cater name, logos, or trademarks except as expressly authorized in writing.
      </p>
      <p>
        <strong>4.5.</strong> Each party&rsquo;s use of the other party&rsquo;s marks shall be consistent with
        any brand guidelines provided, and all goodwill arising from such use inures to the benefit of the
        owner of the marks.
      </p>
      <p>
        <strong>4.6.</strong> Disco Cater may collect and use aggregated and de-identified data derived from
        use of the Services for analytics, benchmarking, and improvement of the Services, provided such data
        does not identify Merchant or any Customer.
      </p>

      {/* 6 -> Billing and Payment */}
      <h2>6. Billing and Payment</h2>
      <p>
        <strong>5.1.</strong> Merchant shall pay all Fees applicable to its use of the Services as set forth in
        the applicable Merchant Order Form or as otherwise communicated by Disco Cater. Unless otherwise
        stated, Fees are exclusive of taxes, and Merchant is responsible for all taxes associated with its
        sales other than taxes based on Disco Cater&rsquo;s net income. Disco Cater may deduct or net Fees from
        amounts collected on Merchant&rsquo;s behalf. Undisputed amounts not paid when due may accrue interest
        at the lesser of 1.5% per month or the maximum rate permitted by law.
      </p>

      {/* 7 -> Payment Processing */}
      <h2>7. Payment Processing</h2>
      <p>
        <strong>6.1.</strong> Payment-processing services for Orders are provided by one or more third-party
        payment processors and are subject to those processors&rsquo; terms and conditions. By using the
        Services to accept payment, Merchant agrees to the applicable payment-processor terms.
      </p>
      <p>
        <strong>6.2.</strong> Disco Cater, directly or through its payment processor, will facilitate the
        collection of Customer payments and the remittance of net proceeds to Merchant, less applicable Fees,
        refunds, chargebacks, and adjustments.
      </p>
      <p>
        <strong>6.3.</strong> Merchant is responsible for the accuracy of its payout account information.
        Disco Cater is not liable for delays or losses resulting from inaccurate or outdated account details
        provided by Merchant.
      </p>
      <p>
        <strong>6.4.</strong> Merchant is responsible for refunds, chargebacks, and disputes arising from its
        Orders. Disco Cater may offset or recover such amounts, together with associated fees, from amounts
        otherwise payable to Merchant.
      </p>
      <p>
        <strong>6.5.</strong> Disco Cater may place a reserve on, delay, or withhold payouts to the extent
        reasonably necessary to cover anticipated refunds, chargebacks, disputed amounts, or suspected
        fraudulent or unlawful activity.
      </p>
      <p>
        <strong>6.6.</strong> Merchant shall comply with all applicable rules of the payment-card networks and
        with applicable laws relating to the processing of payments, including the Payment Card Industry Data
        Security Standard (PCI-DSS) to the extent applicable to Merchant.
      </p>

      {/* 8 -> Term and Termination */}
      <h2>8. Term and Termination</h2>
      <p>
        <strong>7.1.</strong> These Terms commence on the date Merchant first accepts them or first uses the
        Services and continue until terminated. Either party may terminate these Terms for convenience upon
        notice to the other party. Disco Cater may suspend or terminate Merchant&rsquo;s access immediately if
        Merchant breaches these Terms, poses a risk to Customers or the Services, or engages in fraudulent or
        unlawful activity.
      </p>
      <p>
        <strong>7.2.</strong> Upon termination, Merchant&rsquo;s right to use the Services ceases. Termination
        does not relieve Merchant of obligations to fulfill Orders accepted before termination or to pay
        amounts accrued before termination. Sections that by their nature should survive termination
        (including Sections 4, 5, 6, 8, 9, 10, 11, 12, and 15) will survive.
      </p>

      {/* 9 -> Representations; Disclaimer of Warranties */}
      <h2>9. Representations; Disclaimer of Warranties</h2>
      <p>
        <strong>8.1.</strong> Merchant represents and warrants that it has the full right, power, and authority
        to enter into and perform under these Terms; that it holds all licenses, permits, and registrations
        required to operate its business and to prepare and sell the products it lists; and that its products
        and Merchant Data comply with all applicable laws.
      </p>
      <p>
        <strong>8.2.</strong> Merchant represents and warrants that all menus, pricing, allergen and
        ingredient information, and other Merchant Data are accurate and not misleading.
      </p>
      <div className="warn">
        8.3. EXCEPT AS EXPRESSLY PROVIDED IN THESE TERMS, THE SERVICES AND SOFTWARE ARE PROVIDED &ldquo;AS
        IS&rdquo; AND &ldquo;AS AVAILABLE,&rdquo; AND DISCO CATER DISCLAIMS ALL WARRANTIES, WHETHER EXPRESS,
        IMPLIED, STATUTORY, OR OTHERWISE, INCLUDING ANY IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
        PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT. DISCO CATER DOES NOT WARRANT THAT THE SERVICES WILL
        BE UNINTERRUPTED, ERROR-FREE, OR SECURE.
      </div>

      {/* 10 -> Limitation of Liability */}
      <h2>10. Limitation of Liability</h2>
      <div className="warn">
        9.1. TO THE MAXIMUM EXTENT PERMITTED BY LAW, NEITHER PARTY WILL BE LIABLE FOR ANY INDIRECT, INCIDENTAL,
        SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, REVENUE, DATA, OR
        GOODWILL, ARISING OUT OF OR RELATING TO THESE TERMS OR THE SERVICES, WHETHER BASED ON CONTRACT, TORT,
        OR ANY OTHER THEORY, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
      </div>
      <div className="warn">
        9.2. TO THE MAXIMUM EXTENT PERMITTED BY LAW, DISCO CATER&rsquo;S TOTAL AGGREGATE LIABILITY ARISING OUT
        OF OR RELATING TO THESE TERMS OR THE SERVICES WILL NOT EXCEED THE TOTAL FEES RETAINED BY DISCO CATER
        FROM MERCHANT IN THE THREE (3) MONTHS IMMEDIATELY PRECEDING THE EVENT GIVING RISE TO THE CLAIM.
      </div>

      {/* 11 -> Indemnification */}
      <h2>11. Indemnification</h2>
      <p>
        <strong>10.1.</strong> Merchant shall defend, indemnify, and hold harmless Disco Cater and its
        affiliates, and their respective officers, directors, employees, and agents, from and against any
        third-party claims, damages, liabilities, costs, and expenses (including reasonable attorneys&rsquo;
        fees) arising out of or relating to: (a) Merchant&rsquo;s products, including food safety, quality,
        allergens, and fulfillment; (b) Merchant Data; (c) Merchant&rsquo;s breach of these Terms or violation
        of law; or (d) Merchant&rsquo;s acts or omissions.
      </p>
      <p>
        <strong>10.2.</strong> The indemnifying party&rsquo;s obligations are conditioned on the indemnified
        party providing prompt notice of the claim, reasonable cooperation, and sole control of the defense and
        settlement (provided that any settlement that imposes liability or obligations on the indemnified party
        requires its prior written consent).
      </p>

      {/* 12 -> Confidential Information */}
      <h2>12. Confidential Information</h2>
      <p>
        <strong>11.1.</strong> &ldquo;Confidential Information&rdquo; means non-public information disclosed by
        one party to the other that is designated as confidential or that reasonably should be understood to be
        confidential. Each party shall use the other&rsquo;s Confidential Information solely to perform under
        these Terms and shall protect it using at least reasonable care.
      </p>
      <p>
        <strong>11.2.</strong> Confidential Information does not include information that is or becomes public
        through no fault of the receiving party, is rightfully known without restriction, is independently
        developed, or is rightfully obtained from a third party. A party may disclose Confidential Information
        if required by law, provided it gives reasonable advance notice where permitted.
      </p>

      {/* 13 -> Data Privacy & Security */}
      <h2>13. Data Privacy &amp; Security</h2>
      <p><strong>12.1.</strong> Each party shall comply with all applicable data-protection and privacy laws in connection with the Services.</p>
      <p><strong>12.2.</strong> Disco Cater processes Customer Data in accordance with the Disco Cater <a href="https://discocater.com/privacy">Privacy Policy</a>.</p>
      <p><strong>12.3.</strong> Merchant shall access and use Customer Data only as necessary to fulfill Orders and provide related customer service, and shall not retain, disclose, or use Customer Data for any other purpose without a lawful basis.</p>
      <p><strong>12.4.</strong> Merchant shall maintain reasonable administrative, technical, and physical safeguards designed to protect Customer Data against unauthorized access, use, or disclosure.</p>
      <p><strong>12.5.</strong> Merchant shall promptly notify Disco Cater of any actual or suspected security incident involving Customer Data obtained through the Services and shall reasonably cooperate in the investigation and response.</p>
      <p><strong>12.6.</strong> Upon termination, Merchant shall cease using and, except as required by law, delete Customer Data in its possession that was obtained through the Services.</p>
      <p><strong>12.7.</strong> Merchant shall not sell Customer Data and shall honor applicable Customer rights requests as required by law.</p>

      {/* 14 -> Arbitration */}
      <h2>14. Arbitration</h2>
      <p>
        <strong>13.1.</strong> Except for claims for injunctive relief or claims relating to intellectual
        property, any dispute arising out of or relating to these Terms or the Services shall be resolved by
        binding arbitration administered by a recognized arbitration body under its applicable commercial
        rules. The arbitration shall be conducted by a single arbitrator, and judgment on the award may be
        entered in any court of competent jurisdiction.
      </p>
      <div className="warn">
        13.2. THE PARTIES AGREE THAT EACH MAY BRING CLAIMS AGAINST THE OTHER ONLY IN AN INDIVIDUAL CAPACITY AND
        NOT AS A PLAINTIFF OR CLASS MEMBER IN ANY PURPORTED CLASS OR REPRESENTATIVE PROCEEDING. THE PARTIES
        WAIVE ANY RIGHT TO A JURY TRIAL.
      </div>

      {/* 15 -> Force Majeure */}
      <h2>15. Force Majeure</h2>
      <p>
        Neither party will be liable for any failure or delay in performance (other than payment obligations)
        to the extent caused by events beyond its reasonable control, including acts of God, natural disasters,
        epidemics or pandemics, labor disputes, governmental action, utility or internet failures, or other
        force majeure events. The affected party shall use commercially reasonable efforts to resume
        performance.
      </p>

      {/* 16 -> General Provisions */}
      <h2>16. General Provisions</h2>
      <p><strong>15.1. Entire Agreement; Order of Precedence.</strong> These Terms, together with any applicable Merchant Order Form and the Disco Cater Privacy Policy, constitute the entire agreement between the parties regarding the Services and supersede all prior agreements on the subject. In the event of a conflict, a signed Merchant Order Form controls over these Terms with respect to its specific subject matter.</p>
      <p><strong>15.2. Amendments.</strong> Disco Cater may update these Terms from time to time. Updated Terms become effective upon posting or upon the effective date stated. Merchant&rsquo;s continued use of the Services after an update constitutes acceptance of the updated Terms.</p>
      <p><strong>15.3. Assignment.</strong> Merchant may not assign or transfer these Terms without Disco Cater&rsquo;s prior written consent. Disco Cater may assign these Terms in connection with a merger, acquisition, reorganization, or sale of assets. These Terms bind and inure to the benefit of the parties&rsquo; permitted successors and assigns.</p>
      <p><strong>15.4. Notices.</strong> Notices to Disco Cater may be sent to <a href="mailto:concierge@discocater.com">concierge@discocater.com</a>. Notices to Merchant may be sent to the contact information associated with Merchant&rsquo;s account.</p>
      <p><strong>15.5. Miscellaneous.</strong> If any provision of these Terms is held unenforceable, the remaining provisions remain in effect. No waiver is effective unless in writing. Nothing in these Terms creates a partnership, joint venture, agency, or employment relationship between the parties; the parties are independent contractors. Section headings are for convenience only.</p>

      <p style={{ marginTop: 32, color: '#888', fontSize: 14 }}>
        Questions about these Terms? Contact us at{' '}
        <a href="mailto:concierge@discocater.com">concierge@discocater.com</a>.
      </p>
    </LegalShell>
  )
}

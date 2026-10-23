import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css"
import { AuthProvider } from './context/AuthContext'
import AcquisitionCapture from './components/AcquisitionCapture'
import VisitorIdentification from './components/VisitorIdentification'
import ClarityLoader from './components/ClarityLoader'
import ConsentBanner from './components/ConsentBanner'
import { OPT_OUT_EXPR } from '../lib/privacy-choices'

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Disco Cater",
  description: "Discover and order premium catering from the best local restaurants. Corporate, holiday, and event catering — delivered or picked up.",
  icons: {
    icon: [
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-16.png', sizes: '16x16', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
};

const ORG_SCHEMA = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://www.discocater.com/#organization",
      "name": "Disco Cater",
      "legalName": "FamilyMeal Concepts Inc.",
      "url": "https://www.discocater.com",
      "logo": "https://www.discocater.com/disco-cater-logo.png",
      "description": "Disco Cater is a nationwide premium restaurant catering marketplace specializing in recurring office catering programs, holiday and social event menus, and AI-powered catering discovery.",
      "email": "concierge@discocater.com",
      "foundingLocation": "New Jersey, USA",
      "areaServed": "United States",
      "sameAs": [],
    },
    {
      "@type": "SoftwareApplication",
      "@id": "https://www.discocater.com/#app",
      "name": "Disco Cater",
      "applicationCategory": "Food & Beverage",
      "operatingSystem": "Web",
      "url": "https://www.discocater.com",
      "description": "AI-powered catering marketplace connecting customers with premium restaurant catering nationwide. Features Disco AI for personalized catering recommendations.",
      "provider": {
        "@id": "https://www.discocater.com/#organization",
      },
    },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        {/* Organization + SoftwareApplication JSON-LD (knowledge-graph / GEO) */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(ORG_SCHEMA) }}
        />

        {/* Google Analytics */}
        <Script
          src="https://www.googletagmanager.com/gtag/js?id=G-KQV7RLHXTH"
          strategy="afterInteractive"
        />
        <Script id="google-analytics" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            if (${OPT_OUT_EXPR}) {
              gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
            }
            gtag('config', 'G-KQV7RLHXTH');
          `}
        </Script>
        <Script id="ga-internal-traffic" strategy="afterInteractive">
          {`
            if (document.cookie.includes('disco_internal=true')) {
              gtag('set', { 'traffic_type': 'internal' });
            }
          `}
        </Script>

        {/* Microsoft Clarity loads from <ClarityLoader /> below, only after the visitor accepts
            optional cookies — see lib/privacy-choices.ts. */}

        {/* RB2B and Apollo load from <VisitorIdentification /> below, on allowed pages only —
            see lib/visitor-identification.ts. */}

        {/* LinkedIn Insight Tag */}
        <Script id="linkedin-insight" strategy="afterInteractive">{`
          if (!document.cookie.includes('disco_internal=true') && !${OPT_OUT_EXPR}) {
            _linkedin_partner_id = "539930009";
            window._linkedin_data_partner_ids = window._linkedin_data_partner_ids || [];
            window._linkedin_data_partner_ids.push(_linkedin_partner_id);
            (function(l) {
              if (!l){window.lintrk = function(a,b){window.lintrk.q.push([a,b])};
              window.lintrk.q=[]}
              var s = document.getElementsByTagName("script")[0];
              var b = document.createElement("script");
              b.type = "text/javascript";b.async = true;
              b.src = "https://snap.licdn.com/li.lms-analytics/insight.min.js";
              s.parentNode.insertBefore(b, s);
            })(window.lintrk);
          }
        `}</Script>

        {/* Meta Pixel */}
        <Script id="meta-pixel" strategy="afterInteractive">{`
          if (!document.cookie.includes('disco_internal=true') && !${OPT_OUT_EXPR}) {
            !function(f,b,e,v,n,t,s)
            {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
            n.callMethod.apply(n,arguments):n.queue.push(arguments)};
            if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
            n.queue=[];t=b.createElement(e);t.async=!0;
            t.src=v;s=b.getElementsByTagName(e)[0];
            s.parentNode.insertBefore(t,s)}(window, document,'script',
            'https://connect.facebook.net/en_US/fbevents.js');
            fbq('init', '1734678397757599');
            fbq('track', 'PageView');
          }
        `}</Script>
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <AuthProvider>
          <AcquisitionCapture />
          <VisitorIdentification />
          <ClarityLoader />
          {children}
          <ConsentBanner />
        </AuthProvider>
      </body>
    </html>
  );
}
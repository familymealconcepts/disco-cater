import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css"
import { AuthProvider } from './context/AuthContext'

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
      "offers": {
        "@type": "Offer",
        "price": "0",
        "priceCurrency": "USD",
        "description": "Free for customers. No commission fees.",
      },
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

        {/* Microsoft Clarity */}
        <Script id="microsoft-clarity" strategy="afterInteractive">
          {`
            (function(c,l,a,r,i,t,y){
              c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
              t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
              y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
            })(window, document, "clarity", "script", "vv8ibgkwby");
          `}
        </Script>

        {/* RB2B */}
        <Script id="reb2b-tracking" strategy="afterInteractive">{`
          if (!document.cookie.includes('disco_internal=true')) {
            !function(key) {
              if (window.reb2b) return;
              window.reb2b = {loaded: true};
              var s = document.createElement("script");
              s.async = true;
              s.src = "https://ddwl4m2hdecbv.cloudfront.net/b/" + key + "/" + key + ".js.gz";
              document.getElementsByTagName("script")[0].parentNode.insertBefore(s, document.getElementsByTagName("script")[0]);
            }("GNLKQH7D136Q");
          }
        `}</Script>

        {/* LinkedIn Insight Tag */}
        <Script id="linkedin-insight" strategy="afterInteractive">{`
          if (!document.cookie.includes('disco_internal=true')) {
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
          if (!document.cookie.includes('disco_internal=true')) {
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

        {/* Apollo Pixel */}
        <Script id="apollo-pixel" strategy="afterInteractive">
          {`
            if (!document.cookie.includes('disco_internal=true')) {
              function initApollo(){
                var n=Math.random().toString(36).substring(7),o=document.createElement("script");
                o.src="https://assets.apollo.io/micro/website-tracker/tracker.iife.js?nocache="+n;
                o.async=!0;o.defer=!0;
                o.onload=function(){window.trackingFunctions.onLoad({appId:"698b7a4f08b116001d87b092"})};
                document.head.appendChild(o);
              }
              initApollo();
            }
          `}
        </Script>
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <AuthProvider>
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
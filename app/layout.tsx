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

        {/* Apollo Pixel */}
        <Script id="apollo-pixel" strategy="afterInteractive">
          {`
            function initApollo(){
              var n=Math.random().toString(36).substring(7),o=document.createElement("script");
              o.src="https://assets.apollo.io/micro/website-tracker/tracker.iife.js?nocache="+n;
              o.async=!0;o.defer=!0;
              o.onload=function(){window.trackingFunctions.onLoad({appId:"698b7a4f08b116001d87b092"})};
              document.head.appendChild(o);
            }
            initApollo();
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
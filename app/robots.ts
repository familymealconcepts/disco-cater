import type { MetadataRoute } from 'next'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: '*', allow: '/' },
      { userAgent: '*', disallow: ['/admin/', '/api/', '/restaurant/'] },
    ],
    sitemap: 'https://www.discocater.com/sitemap.xml',
  }
}

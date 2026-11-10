import type { MetadataRoute } from 'next'

// The private areas no crawler should fetch. /restaurant/ is the restaurant portal; the public
// menu pages live under /restaurants/ and are NOT matched by this prefix.
const PRIVATE = ['/admin/', '/api/', '/restaurant/']

// AI search and answer-engine crawlers, named explicitly so it is unambiguous that they are
// welcome (GEO). A crawler that matches a named group ignores the '*' group, so each named
// group repeats the same private-area rules. Google-Extended is a robots.txt token only (it
// controls Gemini use of Google's crawl), not a separate crawler.
const AI_CRAWLERS = [
  'GPTBot', 'OAI-SearchBot', 'ChatGPT-User',
  'ClaudeBot', 'Claude-SearchBot', 'Claude-User',
  'PerplexityBot', 'Perplexity-User',
  'Google-Extended', 'Applebot-Extended',
]

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: '*', allow: '/', disallow: PRIVATE },
      { userAgent: AI_CRAWLERS, allow: '/', disallow: PRIVATE },
    ],
    sitemap: 'https://www.discocater.com/sitemap.xml',
  }
}

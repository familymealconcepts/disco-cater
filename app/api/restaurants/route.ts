import { NextResponse } from 'next/server'
import { client } from '@/sanity/lib/client'

export async function GET() {
  const data = await client.fetch(`
    *[_type == "restaurant"] {
      _id,
      name,
      "location": coalesce(location, city->name + ", " + city->slug.current),
      "cuisine": coalesce(cuisines[0], cuisine),
      cuisines,
      lat,
      lng,
      isDisco,
      orderUrl,
      description,
      "image": image.asset->url,
    }
  `)
  return NextResponse.json(data)
}
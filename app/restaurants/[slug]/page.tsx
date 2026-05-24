import { createClient } from '@sanity/client'
import { notFound } from 'next/navigation'
import RestaurantClient from './RestaurantClient'

const client = createClient({
  projectId: '0j4eqnmw',
  dataset: 'production',
  useCdn: true,
  apiVersion: '2024-01-01',
})

export default async function RestaurantPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const restaurant = await client.fetch(
    `*[_type=="restaurant" && slug.current==$slug][0]{
      name, slug, address, cuisine, cuisines, description,
      image, orderUrl, isDisco, location, tags, lat, lng
    }`,
    { slug }
  )

  if (!restaurant) return notFound()

  // Extract restaurant reference from orderUrl
  // e.g. https://www.familymeal.com/disco/twohandsfranklin/catering → twohandsfranklin
  const ref = restaurant.orderUrl
    ? restaurant.orderUrl.replace(/.*\/disco\//, '').replace(/\/.*/, '')
    : null

  return <RestaurantClient restaurant={restaurant} restaurantRef={ref} slug={slug} />
}

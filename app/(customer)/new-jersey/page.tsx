import type { Metadata } from 'next'
import CityLanding, { CITIES, buildCityMetadata } from '../_city/CityLanding'

export const revalidate = 3600

export const metadata: Metadata = buildCityMetadata(CITIES['new-jersey'])

export default function NewJerseyPage() {
  return <CityLanding city={CITIES['new-jersey']} />
}

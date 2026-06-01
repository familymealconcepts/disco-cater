import type { Metadata } from 'next'
import CityLanding, { CITIES, buildCityMetadata } from '../_city/CityLanding'

export const revalidate = 3600

export const metadata: Metadata = buildCityMetadata(CITIES['chicago'])

export default function ChicagoPage() {
  return <CityLanding city={CITIES['chicago']} />
}

import type { Metadata } from 'next'
import CityLanding, { CITIES, buildCityMetadata } from '../_city/CityLanding'

export const revalidate = 3600

export const metadata: Metadata = buildCityMetadata(CITIES['los-angeles'])

export default function LosAngelesPage() {
  return <CityLanding city={CITIES['los-angeles']} />
}

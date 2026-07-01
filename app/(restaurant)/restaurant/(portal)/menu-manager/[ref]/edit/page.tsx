import MenuForm from '../../_MenuForm'

// Edit a Disco-native menu's settings (name, category, url, image, availability,
// pickup window, visibility).
export default async function EditMenuPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  return <MenuForm menuRef={ref} />
}

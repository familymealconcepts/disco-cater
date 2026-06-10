export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Tabler Icons webfont — powers `ti ti-*` glyphs (e.g. the info icons on
          the Ordering page) across the whole admin portal. Next hoists this
          <link> into <head>. */}
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css" />
      {children}
    </>
  )
}

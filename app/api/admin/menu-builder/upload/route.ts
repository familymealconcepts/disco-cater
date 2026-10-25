// Browser → Blob direct upload for Menu Builder files (a serverless request
// body is capped near 4.5 MB; menu PDFs and phone photos often aren't). This
// route only issues the upload token, and only to Peter/Kealoha; the files land
// under menu-builder-uploads/ with a random suffix and are deleted as soon as
// the builder has read them (lib/menu-builder/files.ts).
import { NextRequest, NextResponse } from 'next/server'
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { requireMenuBuilderAccess } from '../../../../../lib/menu-builder/access'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const access = await requireMenuBuilderAccess()
  if (!access.ok) return access.response
  const body = (await req.json()) as HandleUploadBody
  try {
    const json = await handleUpload({
      body, request: req,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith('menu-builder-uploads/')) throw new Error('bad upload path')
        return { addRandomSuffix: true, maximumSizeInBytes: 50 * 1024 * 1024, validUntil: Date.now() + 30 * 60 * 1000 }
      },
    })
    return NextResponse.json(json)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'upload failed' }, { status: 400 })
  }
}
